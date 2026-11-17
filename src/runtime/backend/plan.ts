import type { NodeId } from "../../domain/types/ids.ts";
import { TEXTURE_FORMATS } from "../../domain/types/node-definition.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { BackendDiagnosticCode, backendDiagnostic } from "./diagnostics.ts";
import { bufferWriteDiagnostics, readBufferWritePass } from "./buffer-write.ts";
import type { EmittedWgsl } from "./wgsl.ts";
import { wgslFromPlan } from "./wgsl.ts";
import type { WgslSourceMap } from "./wgsl-source-map.ts";
import { readSourceMap } from "./wgsl-source-map.ts";

/**
 * The backend's view of a `LogicalExecutionPlan`.
 *
 * `LogicalExecutionPlan.passes` / `.resources` are `unknown[]` in the frozen contract —
 * the compiler track owns their production, this module owns their consumption. These
 * descriptors are that consumption contract, and `readExecutionPlan` narrows the unknowns
 * into them, reporting a structured diagnostic instead of throwing on malformed input.
 */

export type UniformValue = number | boolean | readonly number[];

/** A uniform block's values. Deliberately cannot express shader source or structure (§V5). */
export type UniformValues = Readonly<Record<string, UniformValue>>;

export interface TargetResourceDescriptor {
  readonly kind: "target";
  readonly id: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /**
   * T295: attach a depth buffer (depth24plus). Structural — a target gaining or losing
   * depth is a different render signature. Draw passes into a depth target get vgpu's
   * default depth state (write, less-equal); passes into a plain target are unchanged.
   */
  readonly depth?: boolean;
  /** T939: allocate 4x multisampled attachments; samples persist across preserve passes
   *  and resolve into the sampleable color every pass (patched vgpu). */
  readonly msaa?: boolean;
  readonly label?: string;
}

/**
 * A stable read/write pair for a temporal (feedback) edge. The pair is allocated once and
 * swapped after every current-frame consumer has been encoded (§V22).
 */
export interface PingPongResourceDescriptor {
  readonly kind: "pingPong";
  readonly id: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  readonly label?: string;
}

export interface SamplerResourceDescriptor {
  readonly kind: "sampler";
  readonly id: string;
  readonly filter?: "nearest" | "linear";
  readonly addressMode?: "clamp-to-edge" | "repeat" | "mirror-repeat";
}

/**
 * Storage buffer. Declared now, emitted from the P3a point slice onward (§V58, §V75).
 *
 * Point storage is structure-of-arrays, and since T1076 every attribute of one producer is
 * a REGION of one buffer rather than a buffer of its own: the same contiguous runs in the
 * same order, addressed by `BufferBindingDescriptor.offset`. WGSL struct alignment stays
 * out of it, and a kernel's binding count stops growing with the schema.
 */
export interface BufferResourceDescriptor {
  readonly kind: "buffer";
  readonly id: string;
  /** Element stride in bytes; the attribute's WGSL type decides it. */
  readonly stride: number;
  readonly capacity: number;
  readonly usage: "storage" | "storage-read" | "indirect" | "uniform";
  readonly label?: string;
  /**
   * T1353b — WHO supplies this buffer's bytes, when they come from outside the GPU: a
   * decoded mesh's packed vertex attributes, its index list. The same registry and the
   * same frame-ready contract an `externalTexture` uses (§V135/§V136): the plan carries
   * the key, never the bytes; the backend writes `MediaSourceFrame.bytes` from offset 0
   * when — and only when — the source's frameId advances, and again after a clear zeroed
   * the buffer. No source, or no frame yet: the buffer stays zero, which a consumer must
   * read as "nothing" (an all-zero index list is degenerate triangles, never a shape).
   */
  readonly sourceId?: string;
}

/** Ping-pong pair of storage buffers, for a simulation that reads last frame (§V22). */
export interface BufferPairResourceDescriptor {
  readonly kind: "bufferPair";
  readonly id: string;
  readonly stride: number;
  readonly capacity: number;
  readonly label?: string;
}

/**
 * A sampleable texture whose CONTENTS come from outside the GPU — a decoded video
 * frame, a webcam, a screen capture, a still image (T229, T231).
 *
 * §V135: the plan carries a `sourceId`, never pixels. The backend holds a
 * `sourceId → MediaSource` registry and uploads on frame-ready (§V136). Pixels in the
 * plan would break structured-clone safety (§V63) and with it the renderer-in-worker
 * migration, silently, months before anyone noticed.
 */
export interface ExternalTextureResourceDescriptor {
  readonly kind: "externalTexture";
  readonly id: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /** WHO supplies frames. The registry key; the descriptor's whole link to the media. */
  readonly sourceId: string;
  readonly label?: string;
}

/**
 * A RING of N textures, one written per frame, older ones readable by tap (T237).
 *
 * §V226: this is `pingPong` generalised from 2 slots to N, not a new concept. The swap
 * pass rotates it, a binding reads a slice `tap` frames back, and everything a ping-pong
 * already settled — carry-over keeping contents (§V62b), reset semantics (§V22), no
 * allocation in the frame loop (§V8), resize invalidating the whole thing — applies
 * unchanged because it IS the same mechanism with a bigger modulus.
 *
 * §V227, the question this answers before it is asked: the alternative is N targets and a
 * chain of copies to shift them along, which costs N FULL-FRAME COPIES PER FRAME —
 * roughly a gigabyte per frame of write bandwidth at 60 slices of 1080p. Rotating an
 * index costs an integer. That difference is the reason the kind exists.
 *
 * §V228: the memory is `size × bytesPerPixel × frames` and it is the user's to spend —
 * 15.8 MiB per frame at 1080p rgba16float, so 60 frames is 949 MiB, 93% of the default
 * project budget. `estimateResourceBytes` counts it and the compiler's budget warning
 * reports it like any other resource.
 */
export interface RingResourceDescriptor {
  readonly kind: "ring";
  readonly id: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /** Slice count, >= 2. The deepest readable tap is `frames - 1`. */
  readonly frames: number;
  readonly label?: string;
}

/**
 * A LAYERED TARGET (T1623b slice 4): ONE texture of N layers. A draw renders into the layer
 * it names (`DrawPassDescriptor.layer`), and a shader reads all of them through one binding,
 * `texture_2d_array<f32>` (`TextureBindingDescriptor.array`), picking the layer itself,
 * or one of them through a binding of its own, `texture_2d<f32>` (`TextureBindingDescriptor.layer`).
 *
 * It is what a shader needs to INDEX: N targets are N bindings, and a shader cannot index
 * its bindings, so a text that reads "the map of light i" from N targets holds N names.
 * A Render's shadow maps are the first use: a layer a casting light.
 *
 * It shares the ring's two ideas (a view a layer, one `2d-array` view to bind) and none of
 * its mechanism. A ring's layers are written by ONE copy a frame out of a single write
 * target, and it rotates; here every layer is a render attachment drawn into directly, and
 * which layer is which is the plan's to say. So this is a kind of its own and not a flag on
 * `ring`: nothing rotates, nothing is copied, there is no `written` count and no per-frame
 * uniform, and the things a ring has no use for are here: `depth`, and a draw's `layer`.
 *
 * `depth` is ONE depth attachment shared by every layer. Draws into different layers are
 * different render passes, encoded one after the other, so a layer's draws depth-test
 * against what that layer's own passes left there PROVIDED its first pass clears; a layer
 * whose first pass does not clear would test against another layer's depth. The reader
 * refuses that (`layeredTargetDiagnostics`).
 *
 * `layers` is structural, as a ring's `frames` is: more layers is another allocation. A
 * node that wants to add a layer rarely allocates in steps.
 */
export interface LayeredTargetResourceDescriptor {
  readonly kind: "layers";
  readonly id: string;
  /** The size of every layer. */
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /** Layer count, >= 1. A draw's `layer` is 0 to `layers - 1`. */
  readonly layers: number;
  /** One depth buffer (depth24plus) shared by the layers: see above. */
  readonly depth?: boolean;
  readonly label?: string;
}

export type ResourceDescriptor =
  | TargetResourceDescriptor
  | PingPongResourceDescriptor
  | SamplerResourceDescriptor
  | BufferResourceDescriptor
  | BufferPairResourceDescriptor
  | ExternalTextureResourceDescriptor
  | RingResourceDescriptor
  | LayeredTargetResourceDescriptor;

export interface TextureBindingDescriptor {
  /** WGSL binding name in the pass shader. */
  readonly binding: string;
  /** Id of a `target` or `pingPong` resource. A ping-pong binds its read half. */
  readonly resourceId: string;
  /**
   * How the shader reads this texture (T150/B5). "filtered" (the default) means the
   * shader samples it through a sampler, which requires a filterable format — r32float
   * needs the float32-filterable feature for that. "unfiltered" means the shader uses
   * `textureLoad` and pairs NO sampler, which any renderable format supports; data
   * textures (§V57) declare it so an unfilterable field renders on baseline Tier B.
   * Part of the pass structure key: a change here changes the pipeline (§V5, T143).
   */
  readonly sampled?: "filtered" | "unfiltered";
  /**
   * How many frames BACK to read, on a `ring` resource (T237). 1 is the previous frame —
   * exactly what a ping-pong read half gives — and `frames - 1` is the deepest slice the
   * ring holds. Absent everywhere else.
   *
   * There is no tap 0. Slice 0 is the one this frame is being written into, so binding it
   * would be a read of the texture a pass upstream is still filling — the hazard the
   * ping-pong read/write split exists to prevent. The floor is a rule the plan reader
   * enforces rather than a convention each node is trusted to remember.
   */
  readonly tap?: number;
  /**
   * T321: bind the ring's WHOLE history as `texture_2d_array<f32>` — per-pixel time.
   * The shader picks the layer per fragment; a per-frame `ringLatest`/`ringWritten`/
   * `ringFrames` uniform merge tells it where "now" is. Mutually exclusive with `tap`
   * (one binding is one WGSL type), enforced by the reader. Part of the pass structure
   * key: array vs single-layer is a different pipeline.
   *
   * T1623b: and one of the two ways a `layers` resource is bound: every layer, as
   * `texture_2d_array<f32>`, with no uniform merged (which layer is which is the plan's).
   * The other is `layer`.
   */
  readonly array?: boolean;
  /**
   * T1623b slice 4: bind ONE LAYER of a `layers` resource, as a plain `texture_2d<f32>`: the
   * shader does not know the texture is a layer of anything. This is how a Render's lit
   * draws read their casting lights' shadow maps, a binding a light. It is not a
   * convenience: on Apple's GPUs a read through a `texture_2d_array` binding costs one and
   * a half to nearly two times a read of a `texture_2d`, and a read through a view of one
   * layer costs what a texture costs (measured: docs/light-cost-investigation-2026-10-06.md,
   * section 15). Mutually exclusive with `array`, `tap` and `live`; only on a `layers`
   * resource and inside its layers, all enforced by the reader. Part of the pass structure
   * key where it is set: another layer is another texture bound.
   */
  readonly layer?: number;
  /**
   * B160: bind the ring's WRITE TARGET — the frame being composed RIGHT NOW, already
   * rendered by this node's own earlier write pass. This is what makes §V229's "never
   * black" true on FRAME 0, where the history holds nothing at all: the shader branches
   * to this binding while `ringWritten` is zero, so an empty cache is a zero-delay
   * passthrough instead of a flash of a never-written layer. NOT tap 0 — a tap indexes
   * the HISTORY, and slice 0 of the history mid-rotation is the hazard the tap floor
   * exists for; the write target after its own pass has completed is ordered and whole.
   * Mutually exclusive with `tap` and `array`, enforced by the reader.
   */
  readonly live?: boolean;
}

export interface SamplerBindingDescriptor {
  readonly binding: string;
  readonly resourceId: string;
}

/**
 * A storage-buffer binding (T121). For a `bufferPair`, `half` selects which side this
 * binding sees: a stateful kernel reads the pair's "read" half and writes its "write"
 * half, and the pair swaps as ONE resource with ONE identity — so T143 carry-over keeps
 * simulation state across unrelated edits exactly as it does for texture ping-pongs.
 * Ignored (and defaulted to "read") for plain buffers. Part of the pass structure key.
 */
export interface BufferBindingDescriptor {
  readonly binding: string;
  readonly resourceId: string;
  readonly half?: "read" | "write";
  /**
   * T1076: byte offset of the REGION this binding sees inside `resourceId`. Point storage
   * is packed — every attribute of one producer in one buffer per half — so a consumer
   * that still declares `array<vec3f>` binds one region rather than a whole buffer, and its
   * WGSL is unchanged. Absent = the whole buffer from byte 0, which is every non-point
   * binding.
   *
   * The offset is STATIC per compile (it comes from the schema and the capacity, both
   * `compileTime`), which is what makes it safe to leave out of the bind-group cache key:
   * vgpu identifies a `{buffer, offset, size}` binding by its BUFFER, so an offset that
   * could change without the buffer changing would not invalidate the cache. Nothing here
   * changes one without a recompile — but the structure key below carries it anyway, so a
   * changed offset rebuilds the pass rather than relying on that argument holding.
   */
  readonly offset?: number;
  /** T1076: bytes of the region, i.e. `stride × capacity`. Required whenever `offset` is. */
  readonly bytes?: number;
}

export interface EffectPassDescriptor {
  readonly kind: "effect";
  readonly id: string;
  /**
   * WGSL fragment source. Part of the structural signature — editing it recompiles.
   *
   * ⚑ `EmittedWgsl`, NOT `string` (§T1335b). §T259 compiles every frame, so a pass that
   * builds its own text rebuilds it sixty times a second from bytes that did not change —
   * measured at 39.4% of all main-thread script time on E32 Pasture. The type is the fix:
   * only `wgsl.ts` beside this file can produce this, and everything it produces is cached by
   * construction, so an uncached emitter does not typecheck rather than being caught later
   * by a gate or a reviewer.
   */
  readonly shader: EmittedWgsl;
  /** Id of a `target` (or a `pingPong`, whose write half is rendered into). */
  readonly target: string;
  readonly clear?: boolean;
  readonly textures?: ReadonlyArray<TextureBindingDescriptor>;
  readonly samplers?: ReadonlyArray<SamplerBindingDescriptor>;
  /**
   * Per-pass uniform block. Values only — a change here updates the buffer in place and
   * never reaches the compile key (§V5).
   */
  readonly uniforms?: UniformValues;
  /** WGSL binding name of the per-pass uniform block. Required when `uniforms` is present. */
  readonly uniformBinding?: string;
  /**
   * WGSL binding name of the shared frame uniform block (time / frame / pointer / resolution).
   * Omit when the shader does not declare it — vgpu rejects a set value with no binding.
   */
  readonly sharedBinding?: string;
  readonly nodeId?: NodeId;
  readonly label?: string;
  /**
   * T1523b: where the author's code parameters sit inside `shader`, so a device position is
   * reported on the author's line. Absent for a pass with no authored text.
   */
  readonly sourceMap?: WgslSourceMap;
}

/** Swaps a ping-pong pair. Emitted after the last consumer of its read half (§V22). */
export interface SwapPassDescriptor {
  readonly kind: "swap";
  readonly id: string;
  readonly resourceId: string;
}

/**
 * SUBSTEPS (T387): the passes between `begin` and `end` are encoded `count` times inside
 * ONE displayed frame.
 *
 * WHY THE PLAN CARRIES THIS AT ALL. A simulation that advances once per displayed frame
 * advances at the display's rate, and Gray-Scott needs on the order of 10-50 iterations
 * per visible frame to evolve at a watchable speed. Before this existed there was no
 * parameter anywhere that could buy those iterations — the shipped reaction-diffusion was
 * structurally slow, not tuned wrong.
 *
 * WHY MARKERS RATHER THAN N COPIES OF THE PASSES. A substepped loop allocates NOTHING: the
 * ping-pong pair, the pipelines and the uniform buffers are the ones the single-step plan
 * already built, and an iteration is one more encode of the same pass objects. Emitting N
 * copies would instead make the substep count STRUCTURAL — every drag of the slider would
 * rebuild N pipelines and, worse, reallocate the pair and wipe the simulation state the
 * user was watching.
 *
 * WHY FLAT MARKERS RATHER THAN A NESTED BODY. Every consumer in the backend walks
 * `plan.passes` to build its resources. A pass hidden inside a container would be invisible
 * to all of them — built, never wired, which is this project's dominant failure mode
 * (§V220). Flat markers keep every existing walker seeing every real pass; only the
 * ENCODER, which calls `expandLoops`, knows a loop is there.
 *
 * WELL-FORMEDNESS, enforced by `readExecutionPlan` rather than trusted: one `begin` per
 * `end`, matched by `loopId`, in order, never nested. A malformed loop is a refused plan,
 * not a frame that silently runs its body once.
 */
export interface LoopPassDescriptor {
  readonly kind: "loop";
  readonly id: string;
  readonly edge: "begin" | "end";
  /** Links `begin` to its `end`. Unique within a plan. */
  readonly loopId: string;
  /** On `begin`: how many times the enclosed passes run. Integer in [1, MAX_SUBSTEPS]. */
  readonly count?: number;
  readonly nodeId?: NodeId;
  /** T1583b: on `begin`, this region is a kernel stepping its own buffer pair. */
  readonly steps?: KernelStepsDescriptor;
}

/**
 * KERNEL STEPS (T1583b): a loop region whose body is ONE dispatch that reads the read half
 * of its own buffer pair and writes the write half, run `count` times inside one displayed
 * frame, each run reading what the run before it wrote.
 *
 * `count` on the marker is the number of dispatches: substeps × iterations. A SUBSTEP
 * divides the frame's time (the pass's `deltaSeconds` is the frame's divided by the substep
 * count); an ITERATION repeats inside a substep at the same time step, which is what a
 * constraint solver relaxes with. That is the Flex / Blender XPBD pair, and TouchDesigner's
 * GLSL POP `Passes` when iterations is all that is turned up.
 *
 * WHY THE SWAP IS NOT IN THE PASS LIST. A texture feedback loop's region holds its own swap
 * pass, because its consumers read the READ half. A kernel's consumers bind the WRITE half
 * (the edge payload names it, §V231), so a `[dispatch, swap] × N` region would leave them
 * on the half written by run N−2. The encoder therefore swaps `pair` BETWEEN runs only, and
 * the pair's one swap pass stays where §V22 put it, after the last consumer. It also keeps
 * the direct path's segmenting unchanged: N dispatches in a row are one segment.
 */
export interface KernelStepsDescriptor {
  /** STRUCTURE: the buffer pair the region's dispatch steps. Part of the structure key. */
  readonly pair: string;
  /**
   * VALUE: runs per substep, in [1, count]; `count` is a whole multiple of it. Per frame
   * like `count`, and written the same way (`updateUniforms` on the `begin` pass).
   */
  readonly iterations: number;
  /**
   * VALUE, per compile and never per frame: how many runs to have uniform slots ready for.
   * Every run reads its own uniform block, and a block is a buffer, which may not be
   * created while a frame is being encoded (§V8). A count that an expression drives arrives
   * INSIDE the frame, so the compiler says here how far it can go and the backend allocates
   * that many when the plan is installed. At least `count`.
   */
  readonly prepare: number;
  /**
   * VALUE, T1585b: present when the SUBSTEP count follows the frame it renders rather than
   * a parameter — Notch's Update Frame Rate with its Min and Max Update Steps. The backend
   * derives each render's count from that render's own `deltaSeconds` (`rateSubsteps`), so
   * a frame that covers two project frames runs twice the steps at the same step size,
   * and every host that renders a frame gets it without evaluating anything itself.
   * `count` on the marker is then what the frame the plan was compiled at asks for.
   */
  readonly rate?: KernelStepRate;
}

/** T1585b: the three numbers a rate-driven kernel region's substep count comes from. */
export interface KernelStepRate {
  /** Solver steps per second of the piece. */
  readonly perSecond: number;
  /** Fewest and most substeps one displayed frame may run. */
  readonly min: number;
  readonly max: number;
}

/**
 * T1585b — the SUBSTEPS one frame runs under a rate: `clamp(round(delta × rate), min, max)`.
 *
 * The one place that rule is written. The compiler states the count of the frame it compiled
 * at with it, and the backend the count of the frame it is rendering, so the two cannot
 * disagree about rounding or the clamps. `round`, not `ceil`: a live delta is a whole number
 * of project frames (`k ÷ fps`), and `(1 ÷ 60) × 240` must be 4 whichever side of 4 its
 * last bit lands on. Min wins over a Max below it, and both stay inside what a region may
 * run; a delta that is not a number runs the minimum.
 */
export function rateSubsteps(deltaSeconds: number, rate: KernelStepRate): number {
  const { min, max } = rateStepBounds(rate);
  const asked = deltaSeconds * rate.perSecond;
  return Math.min(max, Math.max(min, Number.isFinite(asked) ? Math.round(asked) : min));
}

/**
 * T1585b: the fewest and the most substeps a rate can ever ask for — its Min and Max as
 * whole numbers a region may run. `max` is what uniform blocks are prepared for (§V8).
 */
export function rateStepBounds(rate: KernelStepRate): { readonly min: number; readonly max: number } {
  const whole = (raw: number, floor: number): number =>
    Math.min(MAX_KERNEL_SUBSTEPS, Math.max(floor, Number.isFinite(raw) ? Math.round(raw) : floor));
  const min = whole(rate.min, 1);
  return { min, max: whole(rate.max, min) };
}

/**
 * The ceiling on one loop's iteration count.
 *
 * Not a performance opinion — 256 iterations of a 512² pass is a slideshow and the user is
 * entitled to ask for it — but a bound on what one frame can encode. The GPU pass timer
 * holds 2048 spans per frame (vgpu's query-set limit), so a loop body of a few passes stays
 * inside it and the substep cost stays MEASURABLE, which is the point of the feature.
 */
export const MAX_SUBSTEPS = 256;

/**
 * The spans the GPU pass timer can hold in ONE frame: WebGPU caps a query set at 4096
 * queries and a span is a begin/end pair. vgpu throws on span 2049, so the encoder counts
 * (T1583b): past this, repeats of looped passes run untimed and the frame says so, rather
 * than a frame that encodes more work than the timer can measure failing to render at all.
 */
export const MAX_TIMED_SPANS_PER_FRAME = 2048;

/**
 * T1583b: the most dispatches one kernel runs per displayed frame, substeps × iterations.
 * The loop ceiling, because a kernel's region IS a loop region and the encoder clamps
 * every region to it. One kernel at the ceiling is an eighth of the timer's 2048 spans.
 */
export const MAX_KERNEL_STEPS = MAX_SUBSTEPS;

/**
 * T1583b: the most SUBSTEPS a kernel may ask for. Lower than the dispatch ceiling on
 * purpose: at 60 fps, 64 substeps is a 1/3840 s step, and the room above it belongs to
 * iterations (64 substeps × 4 iterations is the ceiling).
 */
export const MAX_KERNEL_SUBSTEPS = 64;

/**
 * Compute dispatch. Declared now so scheduling, pruning and resource assignment are
 * written against the union rather than against a texture-only assumption (§V58) —
 * adding compute later would otherwise mean rewriting all three.
 */
export interface DispatchPassDescriptor {
  readonly kind: "dispatch";
  readonly id: string;
  readonly nodeId?: string;
  readonly shader: EmittedWgsl;
  /**
   * T1523b: where the author's code parameters sit inside `shader`, so a device position is
   * reported on the author's line. Absent for a pass with no authored text.
   */
  readonly sourceMap?: WgslSourceMap;
  readonly entryPoint: string;
  /** Literal workgroup counts, or a counter resource read on the GPU (indirect). */
  readonly workgroups: readonly [number, number, number] | { readonly indirect: string };
  readonly buffers?: ReadonlyArray<BufferBindingDescriptor>;
  readonly textures?: ReadonlyArray<TextureBindingDescriptor>;
  readonly uniforms?: Readonly<Record<string, number | readonly number[]>>;
  /**
   * WGSL binding name of the pass's uniform block (T172). CONVENTION: when present,
   * the backend writes `timeSeconds`, `deltaSeconds` and `frameIndex` into this block
   * every frame, merged over the static values — which is exactly the KernelFrame
   * struct the point codegen generates, fed from FrameInputs and nothing else (§V44).
   * Static members (seed, count) stay updatable through updateUniforms (§V5).
   */
  readonly uniformBinding?: string;
}

/** Instanced or indirect draw — the sprites → instances → mesh render spine. */
export interface DrawPassDescriptor {
  readonly kind: "draw";
  readonly id: string;
  readonly nodeId?: string;
  readonly shader: EmittedWgsl;
  /**
   * T1523b: where the author's code parameters sit inside `shader`, so a device position is
   * reported on the author's line. Absent for a pass with no authored text.
   */
  readonly sourceMap?: WgslSourceMap;
  readonly target: string;
  /** Pure environment preparation owned by this Render, with an explicit source dependency. */
  readonly preparation?: { readonly kind: "environment"; readonly source: string };
  /**
   * T1623b: WHICH LAYER of a `layers` target this draw renders into. Required there, and
   * refused anywhere else. Structural: it is part of where the draw goes.
   */
  readonly layer?: number;
  readonly topology: "point-list" | "line-list" | "triangle-list" | "triangle-strip";
  /** A literal count, or a counter resource so the GPU decides how much to draw. */
  readonly instances: number | { readonly indirect: string };
  readonly vertexCount?: number;
  readonly buffers?: ReadonlyArray<BufferBindingDescriptor>;
  readonly textures?: ReadonlyArray<TextureBindingDescriptor>;
  /** Per-pass uniform values (sprite size, tint). Values only, never structure (§V5). */
  readonly uniforms?: UniformValues;
  readonly uniformBinding?: string;
  /** Binding name of the shared frame block, when the shader declares it. */
  readonly sharedBinding?: string;
  /** Blend applied to the color target. Sprites usually want "additive" or "alpha". */
  readonly blend?: "alpha" | "additive" | "premultiplied";
  /**
   * T917: set false to stop this draw WRITING depth (it still tests against it). The
   * additive-light case: light does not occlude light, so overlapping beams must sum
   * instead of z-fighting. Default (absent) keeps vgpu's write-enabled depth state.
   */
  readonly depthWrite?: boolean;
  /**
   * Clear the target before drawing (T180). Default true. `false` accumulates over the
   * target's existing contents — the trails pattern. Honored for literal-instance
   * draws; an INDIRECT draw currently always clears (vgpu's standalone draw pass has
   * no clear hook yet — documented gap, not a decision).
   */
  readonly clear?: boolean;
  /**
   * T1598b: true = NOTHING IS DRAWN THIS FRAME (a pass that clears still clears). A VALUE,
   * never structure, exactly as a loop's count is (T425): it is outside the structure key,
   * the per-frame compile carries it, and `updateUniforms` moves it. The pass, its pipeline
   * and its bindings stay built, so flipping it costs nothing.
   *
   * Set only where the draw is PROVABLY EMPTY — a shadow caster wholly outside the light's
   * reach, whose every fragment the sweep would discard — so a path that ignores it draws
   * the same picture. It is an optimisation that cannot be wrong by being missed, and it
   * must stay one: never use it to hide something that would have been visible.
   */
  readonly skip?: boolean;
}

/**
 * Counter reset / prefix-sum scan for GPU-driven lifecycle.
 *
 * Spawn and kill compact via scan, never via atomics: atomic ordering is not
 * deterministic, which would break seeded reproducibility (§V45) and browser/headless
 * parity (§V47) — the whole reason the point system can be tested at all. The cost is
 * two or three extra passes and nothing else.
 */
export interface CounterPassDescriptor {
  readonly kind: "counter";
  readonly id: string;
  readonly nodeId?: string;
  readonly op: "reset" | "scan" | "compact";
  readonly resourceId: string;
  readonly outputResourceId?: string;
}

/** T1623b: the type of one 32-bit word of a row a `write` pass carries. */
export type BufferWord = "f32" | "u32" | "i32";

/**
 * T1623b: a region's values. `rows` is the live rows, row after row, one number a word;
 * `count` is how many rows that is. A type and not an interface, so it is a `UniformValues`
 * and travels every road a uniform block's values travel.
 */
export type BufferRegionValues = { readonly rows: readonly number[]; readonly count: number };

/**
 * T1623b slice 2 — VALUES FOR A REGION OF A BUFFER (`docs/light-cost-investigation-2026-10-06.md`
 * section 13).
 *
 * A table of rows whose values are known on the CPU: a named Light's row of the Render's
 * light table, a Ramp's stops. A uniform block cannot hold one without its length in the
 * shader's text (`UniformValue` is a scalar or one flat vector, so tables became numbered
 * members and numbered code, §B260, §T1640b). This pass is the table as VALUES: the backend
 * writes `values.rows` into the region when the plan is installed and whenever they change,
 * and the count beside them, exactly as it writes a uniform block.
 *
 * It is a pass and not a field of the buffer so that it has an id: `updateUniforms` addresses
 * it, the uniform animator diffs and pushes it, and a values-only frame re-emits it, all by
 * the roads a uniform block already takes. It encodes nothing: its bytes are in the buffer
 * before the frame's first pass runs, wherever it stands in the list. It still ends a run of
 * draws, as every pass that is not a draw does (`renderPassRuns`), so a node emits it ahead
 * of its draws.
 *
 * STRUCTURE: the buffer, the offset, the row's words, the capacity, where the count goes.
 * VALUES, never structure (§V5): the rows and how many of them are live. A count within the
 * capacity is a write; a count over it is refused by name and the rows already there stay.
 *
 * A shader reads the region through an ordinary buffer binding (`offset` and `bytes`, T1076).
 * WHAT A READER MUST KNOW: only the live rows are written. Rows past the count keep whatever
 * they last held (a shrunken table's old rows, or zeros), so a reader walks `count` rows and
 * never the capacity. Only this region's bytes are written, and only when its values move,
 * so a dispatch may own other bytes of the same buffer.
 */
export interface BufferWritePassDescriptor {
  readonly kind: "write";
  readonly id: string;
  readonly nodeId?: string;
  /** A plain storage `buffer`: not a pair, not fed by a source. */
  readonly resourceId: string;
  /** Byte offset of the first row inside the buffer. A multiple of 4. */
  readonly offset: number;
  /** One row: the type of each of its 32-bit words, in order. A row is four bytes a word. */
  readonly row: ReadonlyArray<BufferWord>;
  /** Rows the region holds: what the buffer has room for, not what is live. */
  readonly capacity: number;
  /** Byte offset in the buffer where the live row count is written as one u32. Absent: it is not written. */
  readonly countOffset?: number;
  readonly values: BufferRegionValues;
}

export type PassDescriptor =
  | EffectPassDescriptor
  | SwapPassDescriptor
  | LoopPassDescriptor
  | DispatchPassDescriptor
  | DrawPassDescriptor
  | CounterPassDescriptor
  | BufferWritePassDescriptor;

export interface PlanReadResult {
  readonly resources: ReadonlyArray<ResourceDescriptor>;
  readonly passes: ReadonlyArray<PassDescriptor>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /** False when at least one entry was malformed; the backend refuses to build such a plan. */
  readonly ok: boolean;
}

// TEXTURE_FORMATS is imported from the domain contract — see the import above.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSize(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] > 0 &&
    value[1] > 0
  );
}

function isFormat(value: unknown): value is TextureFormat {
  return typeof value === "string" && (TEXTURE_FORMATS as ReadonlyArray<string>).includes(value);
}

/** One uniform value as the plan reader accepts it; also what a value function's block is held to (T1719b). */
export function isUniformValue(value: unknown): value is UniformValue {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function readUniformValues(value: unknown): UniformValues | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, UniformValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isUniformValue(entry)) return undefined;
    out[key] = entry;
  }
  return out;
}

function readBindings(value: unknown): ReadonlyArray<TextureBindingDescriptor> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: TextureBindingDescriptor[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const { binding, resourceId, sampled, tap, array, live, layer } = entry;
    if (typeof binding !== "string" || typeof resourceId !== "string") return undefined;
    if (sampled !== undefined && sampled !== "filtered" && sampled !== "unfiltered") return undefined;
    // T237: a tap is a whole number of frames back, and there is no tap 0 — slice 0 is
    // the one being written this frame.
    if (tap !== undefined && (!Number.isInteger(tap) || (tap as number) < 1)) return undefined;
    // T321: array and tap are one binding claiming two WGSL types.
    if (array !== undefined && typeof array !== "boolean") return undefined;
    if (array === true && tap !== undefined) return undefined;
    // B160: `live` is the ring's write target — a third thing, not a history read.
    if (live !== undefined && typeof live !== "boolean") return undefined;
    if (live === true && (tap !== undefined || array === true)) return undefined;
    // T1623b: one layer of a layered target is a fourth thing: a whole number, and nothing else beside it.
    if (layer !== undefined && (!Number.isInteger(layer) || (layer as number) < 0 || tap !== undefined || array === true || live === true)) return undefined;
    out.push({
      binding,
      resourceId,
      ...(sampled === undefined ? {} : { sampled }),
      ...(tap === undefined ? {} : { tap: tap as number }),
      ...(array === true ? { array: true } : {}),
      ...(live === true ? { live: true } : {}),
      ...(layer === undefined ? {} : { layer: layer as number }),
    });
  }
  return out;
}

function readResource(value: unknown): ResourceDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, id } = value;
  if (typeof id !== "string" || id.length === 0) return undefined;

  if (kind === "target" || kind === "pingPong") {
    if (!isSize(value["size"]) || !isFormat(value["format"])) return undefined;
    const label = value["label"];
    const base = { id, size: value["size"], format: value["format"] } as const;
    const withLabel = typeof label === "string" ? { ...base, label } : base;
    if (kind === "target") {
      const depth = value["depth"];
      const msaa = value["msaa"];
      return {
        kind: "target",
        ...withLabel,
        ...(depth === true ? { depth: true } : {}),
        ...(msaa === true ? { msaa: true } : {}),
      };
    }
    return { kind: "pingPong", ...withLabel };
  }

  if (kind === "externalTexture") {
    const sourceId = value["sourceId"];
    if (!isSize(value["size"]) || !isFormat(value["format"])) return undefined;
    if (typeof sourceId !== "string" || sourceId.length === 0) return undefined;
    const label = value["label"];
    return {
      kind: "externalTexture",
      id,
      size: value["size"],
      format: value["format"],
      sourceId,
      ...(typeof label === "string" ? { label } : {}),
    };
  }

  if (kind === "layers") {
    const layers = value["layers"];
    if (!isSize(value["size"]) || !isFormat(value["format"])) return undefined;
    if (!Number.isInteger(layers) || (layers as number) < 1) return undefined;
    const label = value["label"];
    return {
      kind: "layers",
      id,
      size: value["size"],
      format: value["format"],
      layers: layers as number,
      ...(value["depth"] === true ? { depth: true } : {}),
      ...(typeof label === "string" ? { label } : {}),
    };
  }

  if (kind === "ring") {
    const frames = value["frames"];
    if (!isSize(value["size"]) || !isFormat(value["format"])) return undefined;
    // Two slices is the floor, because a one-slice ring is a target and would make
    // "the previous frame" mean "the one being written".
    if (!Number.isInteger(frames) || (frames as number) < 2) return undefined;
    const label = value["label"];
    return {
      kind: "ring",
      id,
      size: value["size"],
      format: value["format"],
      frames: frames as number,
      ...(typeof label === "string" ? { label } : {}),
    };
  }

  if (kind === "sampler") {
    const filter = value["filter"];
    const addressMode = value["addressMode"];
    const okFilter = filter === undefined || filter === "nearest" || filter === "linear";
    const okAddress =
      addressMode === undefined ||
      addressMode === "clamp-to-edge" ||
      addressMode === "repeat" ||
      addressMode === "mirror-repeat";
    if (!okFilter || !okAddress) return undefined;
    return {
      kind: "sampler",
      id,
      ...(filter === undefined ? {} : { filter }),
      ...(addressMode === undefined ? {} : { addressMode }),
    };
  }

  if (kind === "buffer" || kind === "bufferPair") {
    const stride = value["stride"];
    const capacity = value["capacity"];
    if (!(Number.isInteger(stride) && (stride as number) >= 1)) return undefined;
    if (!(Number.isInteger(capacity) && (capacity as number) >= 1)) return undefined;
    const label = value["label"];
    const base = {
      id,
      stride: stride as number,
      capacity: capacity as number,
      ...(typeof label === "string" ? { label } : {}),
    };
    if (kind === "bufferPair") return { kind: "bufferPair", ...base };
    const usage = value["usage"];
    if (usage !== "storage" && usage !== "storage-read" && usage !== "indirect" && usage !== "uniform") {
      return undefined;
    }
    const sourceId = value["sourceId"];
    if (sourceId !== undefined && (typeof sourceId !== "string" || sourceId.length === 0)) return undefined;
    return { kind: "buffer", usage, ...base, ...(sourceId === undefined ? {} : { sourceId }) };
  }

  return undefined;
}

/**
 * Narrows one raw pass into a backend descriptor, or `undefined` when it is not one.
 * Exported for the compiler's per-frame values-only path (T1182), which narrows the
 * passes it re-emits through the SAME reader `readExecutionPlan` uses, so a spliced pass
 * is byte-for-byte what a full compile would have carried.
 */
export function readPass(value: unknown): PassDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, id } = value;
  if (typeof id !== "string" || id.length === 0) return undefined;

  if (kind === "swap") {
    const resourceId = value["resourceId"];
    if (typeof resourceId !== "string") return undefined;
    return { kind: "swap", id, resourceId };
  }

  if (kind === "loop") {
    const edge = value["edge"];
    const loopId = value["loopId"];
    const count = value["count"];
    const nodeId = value["nodeId"];
    if (edge !== "begin" && edge !== "end") return undefined;
    if (typeof loopId !== "string" || loopId.length === 0) return undefined;
    // A count on the `end` marker would be a second place to state the same fact, and the
    // two could disagree. The `begin` states it; the `end` only closes the region.
    if (edge === "end" && count !== undefined) return undefined;
    if (edge === "begin") {
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_SUBSTEPS) {
        return undefined;
      }
    }
    // T1583b: like the count, the step facts are stated once, on the `begin`.
    const rawSteps = value["steps"];
    if (edge === "end" && rawSteps !== undefined) return undefined;
    const steps = rawSteps === undefined ? undefined : readKernelSteps(rawSteps, count as number);
    if (rawSteps !== undefined && steps === undefined) return undefined;
    return {
      kind: "loop",
      id,
      edge,
      loopId,
      ...(edge === "begin" ? { count: count as number } : {}),
      ...(typeof nodeId === "string" ? { nodeId: nodeId as NodeId } : {}),
      ...(steps === undefined ? {} : { steps }),
    };
  }

  if (kind === "dispatch") return readDispatchPass(id, value);
  if (kind === "draw") return readDrawPass(id, value);
  if (kind === "write") return readBufferWritePass(id, value);
  if (kind !== "effect") return undefined;

  const shader = value["shader"];
  const target = value["target"];
  if (typeof shader !== "string" || shader.length === 0) return undefined;
  if (typeof target !== "string" || target.length === 0) return undefined;

  const textures = readBindings(value["textures"]);
  const samplers = readBindings(value["samplers"]);
  if (textures === undefined || samplers === undefined) return undefined;

  const rawUniforms = value["uniforms"];
  const uniforms = rawUniforms === undefined ? undefined : readUniformValues(rawUniforms);
  if (rawUniforms !== undefined && uniforms === undefined) return undefined;

  const uniformBinding = value["uniformBinding"];
  if (uniforms !== undefined && typeof uniformBinding !== "string") return undefined;

  const sharedBinding = value["sharedBinding"];
  if (sharedBinding !== undefined && typeof sharedBinding !== "string") return undefined;

  const clear = value["clear"];
  if (clear !== undefined && typeof clear !== "boolean") return undefined;

  const nodeId = value["nodeId"];
  const label = value["label"];
  const sourceMap = readSourceMap(value["sourceMap"]);
  if (sourceMap === null) return undefined;

  return {
    kind: "effect",
    id,
    shader: wgslFromPlan(shader),
    target,
    textures,
    samplers,
    ...(clear === undefined ? {} : { clear }),
    ...(uniforms === undefined ? {} : { uniforms, uniformBinding: uniformBinding as string }),
    ...(typeof sharedBinding === "string" ? { sharedBinding } : {}),
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(typeof label === "string" ? { label } : {}),
    ...(sourceMap === undefined ? {} : { sourceMap }),
  };
}

/**
 * T1583b: a kernel region's step facts, or `undefined` when they contradict the count —
 * `count` is substeps × iterations, so iterations must divide it, and slots prepared for
 * fewer runs than the plan itself asks for would be a plan that cannot run as written.
 */
function readKernelSteps(value: unknown, count: number): KernelStepsDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const { pair, iterations, prepare } = value;
  if (typeof pair !== "string" || pair.length === 0) return undefined;
  if (!Number.isInteger(iterations) || (iterations as number) < 1 || count % (iterations as number) !== 0) {
    return undefined;
  }
  if (!Number.isInteger(prepare) || (prepare as number) < count || (prepare as number) > MAX_KERNEL_STEPS) {
    return undefined;
  }
  // T1585b: a rate is three finite numbers or it is not there. A region whose rate did not
  // read would run its declared count every frame, whatever the frame's length: a plausible
  // simulation at the wrong step, so it is refused rather than dropped.
  const rawRate = value["rate"];
  if (rawRate === undefined) return { pair, iterations: iterations as number, prepare: prepare as number };
  if (!isRecord(rawRate)) return undefined;
  const { perSecond, min, max } = rawRate;
  const finite = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry);
  if (!finite(perSecond) || perSecond < 0 || !finite(min) || !finite(max)) return undefined;
  return { pair, iterations: iterations as number, prepare: prepare as number, rate: { perSecond, min, max } };
}

function readBufferBindings(value: unknown): ReadonlyArray<BufferBindingDescriptor> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: BufferBindingDescriptor[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const { binding, resourceId, half, offset, bytes } = entry;
    if (typeof binding !== "string" || typeof resourceId !== "string") return undefined;
    if (half !== undefined && half !== "read" && half !== "write") return undefined;
    // T1076: a REGION binding carries both numbers or neither — an offset with no size
    // would bind to the end of the packed buffer and read the next attribute past its own
    // range, which is exactly the plausible-wrong answer this refuses to construct.
    if (offset !== undefined || bytes !== undefined) {
      if (!Number.isInteger(offset) || (offset as number) < 0) return undefined;
      if (!Number.isInteger(bytes) || (bytes as number) < 1) return undefined;
    }
    out.push({
      binding,
      resourceId,
      ...(half === undefined ? {} : { half }),
      ...(offset === undefined ? {} : { offset: offset as number, bytes: bytes as number }),
    });
  }
  return out;
}

function readDispatchPass(id: string, value: Record<string, unknown>): DispatchPassDescriptor | undefined {
  const shader = value["shader"];
  const entryPoint = value["entryPoint"];
  if (typeof shader !== "string" || shader.length === 0) return undefined;
  if (typeof entryPoint !== "string" || entryPoint.length === 0) return undefined;

  const rawWorkgroups = value["workgroups"];
  let workgroups: DispatchPassDescriptor["workgroups"] | undefined;
  if (Array.isArray(rawWorkgroups) && rawWorkgroups.length === 3 && rawWorkgroups.every((n) => Number.isInteger(n) && n >= 1)) {
    workgroups = [rawWorkgroups[0], rawWorkgroups[1], rawWorkgroups[2]];
  } else if (isRecord(rawWorkgroups) && typeof rawWorkgroups["indirect"] === "string") {
    workgroups = { indirect: rawWorkgroups["indirect"] };
  }
  if (workgroups === undefined) return undefined;

  const buffers = readBufferBindings(value["buffers"]);
  const textures = readBindings(value["textures"]);
  if (buffers === undefined || textures === undefined) return undefined;

  const rawUniforms = value["uniforms"];
  const uniforms = rawUniforms === undefined ? undefined : readUniformValues(rawUniforms);
  if (rawUniforms !== undefined && uniforms === undefined) return undefined;
  const uniformBinding = value["uniformBinding"];
  if (uniforms !== undefined && typeof uniformBinding !== "string") return undefined;

  const nodeId = value["nodeId"];
  const sourceMap = readSourceMap(value["sourceMap"]);
  if (sourceMap === null) return undefined;
  return {
    kind: "dispatch",
    id,
    shader: wgslFromPlan(shader),
    entryPoint,
    workgroups,
    buffers,
    textures,
    ...(uniforms === undefined
      ? {}
      : { uniforms: uniforms as NonNullable<DispatchPassDescriptor["uniforms"]>, uniformBinding: uniformBinding as string }),
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(sourceMap === undefined ? {} : { sourceMap }),
  };
}

function readDrawPass(id: string, value: Record<string, unknown>): DrawPassDescriptor | undefined {
  const shader = value["shader"];
  const target = value["target"];
  const topology = value["topology"];
  if (typeof shader !== "string" || shader.length === 0) return undefined;
  if (typeof target !== "string" || target.length === 0) return undefined;
  if (
    topology !== "point-list" &&
    topology !== "line-list" &&
    topology !== "triangle-list" &&
    topology !== "triangle-strip"
  ) {
    return undefined;
  }

  const rawInstances = value["instances"];
  let instances: DrawPassDescriptor["instances"] | undefined;
  if (typeof rawInstances === "number" && Number.isInteger(rawInstances) && rawInstances >= 0) {
    instances = rawInstances;
  } else if (isRecord(rawInstances) && typeof rawInstances["indirect"] === "string") {
    instances = { indirect: rawInstances["indirect"] };
  }
  if (instances === undefined) return undefined;

  const vertexCount = value["vertexCount"];
  if (vertexCount !== undefined && !(Number.isInteger(vertexCount) && (vertexCount as number) >= 1)) return undefined;

  const buffers = readBufferBindings(value["buffers"]);
  const textures = readBindings(value["textures"]);
  if (buffers === undefined || textures === undefined) return undefined;

  const rawUniforms = value["uniforms"];
  const uniforms = rawUniforms === undefined ? undefined : readUniformValues(rawUniforms);
  if (rawUniforms !== undefined && uniforms === undefined) return undefined;
  const uniformBinding = value["uniformBinding"];
  if (uniforms !== undefined && typeof uniformBinding !== "string") return undefined;
  const sharedBinding = value["sharedBinding"];
  if (sharedBinding !== undefined && typeof sharedBinding !== "string") return undefined;
  const blend = value["blend"];
  if (blend !== undefined && blend !== "alpha" && blend !== "additive" && blend !== "premultiplied") return undefined;
  const depthWrite = value["depthWrite"];
  if (depthWrite !== undefined && typeof depthWrite !== "boolean") return undefined;
  const clear = value["clear"];
  if (clear !== undefined && typeof clear !== "boolean") return undefined;
  const skip = value["skip"];
  if (skip !== undefined && typeof skip !== "boolean") return undefined;
  const layer = value["layer"];
  if (layer !== undefined && !(Number.isInteger(layer) && (layer as number) >= 0)) return undefined;
  const rawPreparation = value["preparation"];
  if (rawPreparation !== undefined && (!isRecord(rawPreparation) || rawPreparation["kind"] !== "environment" ||
    typeof rawPreparation["source"] !== "string" || rawPreparation["source"].length === 0 ||
    Object.keys(rawPreparation).some(key => key !== "kind" && key !== "source") || typeof value["nodeId"] !== "string")) return undefined;

  const nodeId = value["nodeId"];
  const sourceMap = readSourceMap(value["sourceMap"]);
  if (sourceMap === null) return undefined;
  return {
    kind: "draw",
    id,
    shader: wgslFromPlan(shader),
    target,
    ...(rawPreparation === undefined ? {} : { preparation: { kind: "environment" as const, source: (rawPreparation as { source: string }).source } }),
    // T1623b: kept only where it is said, so a draw into a plain target has the bytes it had.
    ...(layer === undefined ? {} : { layer: layer as number }),
    topology,
    instances,
    ...(vertexCount === undefined ? {} : { vertexCount: vertexCount as number }),
    buffers,
    textures,
    ...(uniforms === undefined ? {} : { uniforms, uniformBinding: uniformBinding as string }),
    ...(typeof sharedBinding === "string" ? { sharedBinding } : {}),
    ...(blend === undefined ? {} : { blend }),
    ...(depthWrite === undefined ? {} : { depthWrite }),
    ...(clear === undefined ? {} : { clear }),
    // T1598b: only `true` is kept, so a pass that is drawn has the bytes it always had.
    ...(skip === true ? { skip: true } : {}),
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(sourceMap === undefined ? {} : { sourceMap }),
  };
}

/** Narrows a compiler-produced plan into backend descriptors, reporting rather than throwing. */
export function readExecutionPlan(plan: LogicalExecutionPlan): PlanReadResult {
  const resources: ResourceDescriptor[] = [];
  const passes: PassDescriptor[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];

  const seenResourceIds = new Set<string>();
  plan.resources.forEach((entry, index) => {
    const parsed = readResource(entry);
    if (!parsed) {
      diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Resource #${index} is not a valid backend resource descriptor.`,
          { suggestion: "Expected { kind: 'target' | 'pingPong' | 'sampler', id, ... }." },
        ),
      );
      return;
    }
    if (seenResourceIds.has(parsed.id)) {
      diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Duplicate resource id "${parsed.id}".`,
        ),
      );
      return;
    }
    seenResourceIds.add(parsed.id);
    resources.push(parsed);
  });

  const seenPassIds = new Set<string>();
  plan.passes.forEach((entry, index) => {
    const parsed = readPass(entry);
    if (!parsed) {
      diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Pass #${index} is not a valid backend pass descriptor.`,
          { suggestion: "Expected { kind: 'effect' | 'swap', id, ... }." },
        ),
      );
      return;
    }
    if (seenPassIds.has(parsed.id)) {
      diagnostics.push(
        backendDiagnostic("error", BackendDiagnosticCode.planInvalid, `Duplicate pass id "${parsed.id}".`),
      );
      return;
    }
    seenPassIds.add(parsed.id);
    passes.push(parsed);
  });

  // Reference integrity: every id a pass names must exist. Written per kind rather than
  // as "swap vs everything else", so a new pass kind is a compile error here instead of
  // silently skipping validation for whatever it references.
  function referencedResourceIds(pass: PassDescriptor): string[] {
    switch (pass.kind) {
      case "swap":
        return [pass.resourceId];
      // T387: a loop marker names no resource — it delimits passes that name their own.
      // T1583b: except a kernel region's, which names the pair the encoder swaps.
      case "loop":
        return pass.steps === undefined ? [] : [pass.steps.pair];
      case "effect":
        return [
          pass.target,
          ...(pass.textures ?? []).map((t) => t.resourceId),
          ...(pass.samplers ?? []).map((s) => s.resourceId),
        ];
      case "dispatch":
        return [
          ...(typeof pass.workgroups === "object" && "indirect" in pass.workgroups
            ? [pass.workgroups.indirect]
            : []),
          ...(pass.buffers ?? []).map((b) => b.resourceId),
          ...(pass.textures ?? []).map((t) => t.resourceId),
        ];
      case "draw":
        return [
          pass.target,
          ...(typeof pass.instances === "object" ? [pass.instances.indirect] : []),
          ...(pass.buffers ?? []).map((b) => b.resourceId),
          ...(pass.textures ?? []).map((t) => t.resourceId),
        ];
      case "counter":
        return [pass.resourceId, ...(pass.outputResourceId === undefined ? [] : [pass.outputResourceId])];
      case "write":
        return [pass.resourceId];
    }
  }


  for (const pass of passes) {
    const referenced = referencedResourceIds(pass);
    for (const resourceId of referenced) {
      if (!seenResourceIds.has(resourceId)) {
        diagnostics.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.unknownResource,
            `Pass "${pass.id}" references unknown resource "${resourceId}".`,
            pass.kind === "effect" && pass.nodeId !== undefined ? { nodeId: pass.nodeId } : {},
          ),
        );
      }
    }
  }

  diagnostics.push(...loopStructureDiagnostics(passes));
  diagnostics.push(...kernelStepsDiagnostics(passes, resources));
  diagnostics.push(...bufferWriteDiagnostics(passes, resources));
  diagnostics.push(...layeredTargetDiagnostics(passes, resources));

  const ok = diagnostics.every((diagnostic) => diagnostic.severity !== "error");
  return { resources, passes, diagnostics, ok };
}

/**
 * T1623b: a layered target is drawn into a layer at a time and bound whole, or the plan is
 * refused. Each of these renders a plausible picture when it is wrong (§V147): a draw with
 * no layer would land in layer 0, a layer past the end in nothing, a binding without
 * `array` would be handed a texture of another dimension than its shader declares, and a
 * layer whose first pass does not clear would depth-test against another layer's depth.
 */
function layeredTargetDiagnostics(passes: ReadonlyArray<PassDescriptor>, resources: ReadonlyArray<ResourceDescriptor>): RuntimeDiagnostic[] {
  const layered = new Map<string, LayeredTargetResourceDescriptor>();
  for (const resource of resources) if (resource.kind === "layers") layered.set(resource.id, resource);
  const out: RuntimeDiagnostic[] = [];
  const refuse = (pass: PassDescriptor, message: string): void => {
    out.push(backendDiagnostic("error", BackendDiagnosticCode.planInvalid, message, "nodeId" in pass && pass.nodeId !== undefined ? { nodeId: pass.nodeId } : {}));
  };
  /** The layers of each depth-sharing target that a pass has cleared so far, in plan order. */
  const cleared = new Map<string, Set<number>>();
  for (const pass of passes) {
    if (pass.kind === "effect" && layered.has(pass.target)) {
      refuse(pass, `Pass "${pass.id}" is an effect into the layered target "${pass.target}"; only a draw names a layer to render into.`);
    }
    if (pass.kind === "draw") {
      const target = layered.get(pass.target);
      if (target === undefined) {
        if (pass.layer !== undefined) refuse(pass, `Draw pass "${pass.id}" names layer ${pass.layer} of "${pass.target}", which is not a layered target.`);
      } else if (pass.layer === undefined || pass.layer >= target.layers) {
        refuse(pass, `Draw pass "${pass.id}" renders into the layered target "${pass.target}" and names ${pass.layer === undefined ? "no layer" : `layer ${pass.layer}`}; it has layers 0 to ${target.layers - 1}.`);
      } else if (target.depth === true) {
        const seen = cleared.get(target.id) ?? new Set<number>();
        cleared.set(target.id, seen);
        if (pass.clear ?? true) seen.add(pass.layer);
        else if (!seen.has(pass.layer)) {
          refuse(pass, `Draw pass "${pass.id}" is the first into layer ${pass.layer} of "${pass.target}" and does not clear: the layers share one depth buffer, so it would test against another layer's depth.`);
        }
      }
    }
    if (pass.kind === "effect" || pass.kind === "dispatch" || pass.kind === "draw") {
      for (const binding of pass.textures ?? []) {
        const bound = layered.get(binding.resourceId);
        if (bound === undefined) {
          if (binding.layer !== undefined) refuse(pass, `Pass "${pass.id}" binds layer ${binding.layer} of "${binding.resourceId}" as "${binding.binding}", which is not a layered target.`);
        } else if (binding.array !== true && binding.layer === undefined) {
          refuse(pass, `Pass "${pass.id}" binds the layered target "${binding.resourceId}" as "${binding.binding}" with neither \`array\` nor \`layer\`: it is bound whole, as texture_2d_array, or a layer of it as texture_2d.`);
        } else if (binding.layer !== undefined && binding.layer >= bound.layers) {
          refuse(pass, `Pass "${pass.id}" binds layer ${binding.layer} of the layered target "${binding.resourceId}" as "${binding.binding}"; it has layers 0 to ${bound.layers - 1}.`);
        }
      }
    }
  }
  return out;
}

/**
 * T387: loop markers are well-formed, or the plan is refused.
 *
 * An unmatched or nested marker has exactly the failure mode §V147 is about — the frame
 * still renders a plausible picture, with the substeps silently not happening. So it is an
 * ERROR here rather than something `expandLoops` quietly tolerates.
 */
function loopStructureDiagnostics(passes: ReadonlyArray<PassDescriptor>): RuntimeDiagnostic[] {
  const out: RuntimeDiagnostic[] = [];
  let open: LoopPassDescriptor | undefined;
  for (const pass of passes) {
    if (pass.kind !== "loop") continue;
    if (pass.edge === "begin") {
      if (open !== undefined) {
        out.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.planInvalid,
            `Loop "${pass.loopId}" opens inside loop "${open.loopId}"; substep regions do not nest.`,
            { suggestion: "Emit one region per feedback pair, and never one inside another." },
          ),
        );
      }
      open = pass;
      continue;
    }
    if (open === undefined || open.loopId !== pass.loopId) {
      out.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Loop end "${pass.loopId}" closes nothing${open === undefined ? "" : ` (loop "${open.loopId}" is open)`}.`,
        ),
      );
    }
    open = undefined;
  }
  if (open !== undefined) {
    out.push(
      backendDiagnostic(
        "error",
        BackendDiagnosticCode.planInvalid,
        `Loop "${open.loopId}" is never closed; its body would run once instead of ${open.count ?? 1} times.`,
      ),
    );
  }
  return out;
}

/**
 * T1583b: a kernel region is ONE dispatch that reads and writes the pair it names.
 *
 * The encoder swaps that pair between runs and nothing else. A region holding a second
 * pass would run it N times against halves it does not expect, and a dispatch that does
 * not read the pair's read half would compute the same thing N times — both render a
 * plausible picture (§V147), so both are refused here.
 */
function kernelStepsDiagnostics(
  passes: ReadonlyArray<PassDescriptor>,
  resources: ReadonlyArray<ResourceDescriptor>,
): RuntimeDiagnostic[] {
  const out: RuntimeDiagnostic[] = [];
  const pairs = new Set(resources.filter((resource) => resource.kind === "bufferPair").map((resource) => resource.id));
  passes.forEach((pass, index) => {
    if (pass.kind !== "loop" || pass.edge !== "begin" || pass.steps === undefined) return;
    const pair = pass.steps.pair;
    const body = passes[index + 1];
    const closing = passes[index + 2];
    const closed = closing !== undefined && closing.kind === "loop" && closing.edge === "end" && closing.loopId === pass.loopId;
    const halves = body !== undefined && body.kind === "dispatch"
      ? new Set((body.buffers ?? []).filter((binding) => binding.resourceId === pair).map((binding) => binding.half ?? "read"))
      : new Set<string>();
    if (closed && pairs.has(pair) && halves.has("read") && halves.has("write")) return;
    out.push(
      backendDiagnostic(
        "error",
        BackendDiagnosticCode.planInvalid,
        `Kernel steps "${pass.loopId}" must enclose exactly one dispatch that binds both halves of the buffer pair "${pair}".`,
        pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
      ),
    );
  });
  return out;
}

/**
 * The order the ENCODER walks: every loop region repeated `count` times, markers dropped.
 *
 * Returns the SAME pass objects, repeated — that is what makes a substep free of new GPU
 * objects: the pipeline, the uniform buffer and the render target for `pass.id` are looked
 * up once and encoded again. A plan with no loops returns its own array, so the common case
 * pays nothing.
 */
export function expandLoops(
  passes: ReadonlyArray<PassDescriptor>,
  /**
   * T425: the LIVE iteration count for a loop, overriding the declared one — how an
   * audio-driven substep value reaches the encoder without a recompile. Clamped to
   * [1, MAX_SUBSTEPS] and rounded here, so no caller can encode an unbounded frame.
   */
  countOf?: (loopId: string, declared: number) => number,
): ReadonlyArray<PassDescriptor> {
  if (!passes.some((pass) => pass.kind === "loop")) return passes;
  const out: PassDescriptor[] = [];
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index] as PassDescriptor;
    if (pass.kind !== "loop") {
      out.push(pass);
      continue;
    }
    if (pass.edge === "end") continue;
    let end = index + 1;
    while (end < passes.length) {
      const candidate = passes[end] as PassDescriptor;
      if (candidate.kind === "loop" && candidate.edge === "end" && candidate.loopId === pass.loopId) break;
      end += 1;
    }
    const body = passes.slice(index + 1, Math.min(end, passes.length));
    const declared = pass.count ?? 1;
    const live = countOf === undefined ? declared : countOf(pass.loopId, declared);
    const count = Math.min(MAX_SUBSTEPS, Math.max(1, Math.round(live)));
    for (let iteration = 0; iteration < count; iteration += 1) out.push(...body);
    index = end;
  }
  return out;
}

/**
 * The GPU timer span name for the `iteration`-th encode of a pass (T387, T163, §V86).
 *
 * vgpu REFUSES a duplicate span name inside one frame, so the iterations cannot all be
 * called `pass.id`. They are suffixed instead of dropped, because dropping them would make
 * a 50-substep loop report the cost of one substep — a node that looks cheap and is not,
 * which is the failure this feature is supposed to make visible. `aggregate` sums the
 * suffixed spans back onto the base pass id.
 */
export function iterationSpanName(passId: string, iteration: number): string {
  return iteration === 0 ? passId : `${passId}${SPAN_ITERATION_SEPARATOR}${iteration}`;
}

/** Separator between a pass id and its substep iteration index in a timer span name. */
export const SPAN_ITERATION_SEPARATOR = "~";

/**
 * T1604b — WHERE THE DEVICE'S RENDER PASSES ARE.
 *
 * A plan pass of kind `draw` is one draw: its own id, shader, bindings, uniforms and node.
 * The device does not need a render pass for each. Opening one costs encode and submit time
 * on the CPU and, on a tile-based GPU, a store and a load of the target (and a resolve, when
 * it is multisampled), so two hundred draws into twenty targets were two hundred passes.
 *
 * A RUN is the draws one device render pass holds: consecutive `draw` passes of ONE NODE
 * into ONE TARGET (T1623b: and one LAYER of it, where it has layers: a layer is what a
 * render pass attaches), of which only the first may clear. Anything else ends it — an effect, a
 * dispatch, a swap, a loop marker, another target, another node, a draw that clears. So a
 * run is passes that were already adjacent and already drew over one another in this
 * order: grouping them moves nothing and changes no pixel.
 *
 * One node, because the run has ONE GPU timer span and the per-node figure must stay a
 * measurement: a span that covered two nodes' draws could only be divided between them by
 * invention. Inside the node the span belongs to the run, and its passes share it
 * (`runSpanName`); a person who wants each pass's own figure gets one pass per draw again
 * (`LoomBackend.setExactPassTiming`).
 *
 * A loop marker ends a run, so a substep region keeps its boundary: read off the plan as it
 * is written, never off the expanded order, where the body's last draw would sit next to
 * its own first.
 *
 * A MULTISAMPLED target is the exception: its draws stay a pass each. MEASURED, not
 * reasoned: with them grouped, sentinel-bot's colour (Dawn on Metal, rgba16float, 4× MSAA,
 * 640 × 360) differed from one pass per draw on 0 to 8 of 230,400 pixels a frame, each by
 * one unit in the last place of one channel, where two mesh-instanced geometries meet (the
 * claws on the last rings). Every single-sampled target was byte-identical. The cause was
 * NOT established: it did not need the document's own materials (the stock one showed it
 * too), and a built scene of 8,192 interpenetrating instanced meshes under three casting
 * lights did not show it at all. So this is a rule about what was seen, on the safe side of
 * it. Nobody could see
 * one unit in the last place; but the frame would then depend on `setExactPassTiming`,
 * that is on whether someone had the performance panel open, and every byte-exact gate
 * assumes it does not. Pass the plan's resources to have the rule applied; without them no
 * target is known to be multisampled.
 *
 * Pure, and the ONE definition: the encoder groups by it, and anything that describes what
 * the device does (the telemetry hub, the pipeline inspector) reads it rather than
 * restating the rule.
 */
export interface RenderPassRun {
  /** The run's passes in plan order. The first is its HEAD: its `clear` is the pass's, and its id names the span. */
  readonly passIds: ReadonlyArray<string>;
  readonly target: string;
  /** T1623b: the layer of a layered target the run draws into; absent for any other target. */
  readonly layer?: number;
  readonly nodeId: string | undefined;
}

export function renderPassRuns(
  passes: ReadonlyArray<PassDescriptor>,
  resources: ReadonlyArray<ResourceDescriptor> = [],
): ReadonlyArray<RenderPassRun> {
  const multisampled = new Set<string>();
  for (const resource of resources) {
    if (resource.kind === "target" && resource.msaa === true) multisampled.add(resource.id);
  }
  const runs: Array<{ passIds: string[]; target: string; layer?: number; nodeId: string | undefined }> = [];
  let open: (typeof runs)[number] | undefined;
  for (const pass of passes) {
    if (pass.kind !== "draw") {
      open = undefined;
      continue;
    }
    if (open !== undefined && pass.clear === false && pass.target === open.target && pass.layer === open.layer && pass.nodeId === open.nodeId && !multisampled.has(pass.target)) {
      open.passIds.push(pass.id);
      continue;
    }
    open = { passIds: [pass.id], target: pass.target, ...(pass.layer === undefined ? {} : { layer: pass.layer }), nodeId: pass.nodeId };
    runs.push(open);
  }
  return runs;
}

/** Separator between a run head's pass id and how many OTHER passes share its span. */
export const SPAN_RUN_SEPARATOR = "+";

/**
 * T1604b: the timer span name of a RUN — its head's pass id and the number of passes after
 * it that the span also covers (`head+13`). A run of one is just the pass id, so a draw on
 * its own has the name it always had. The name says what the number is: a reader that knows
 * nothing of runs bills it to the head (`spanBasePassId`), which is the right node, and one
 * that does can say which passes share it (`spanSharedPasses`).
 */
export function runSpanName(headPassId: string, sharedPasses: number): string {
  return sharedPasses <= 0 ? headPassId : `${headPassId}${SPAN_RUN_SEPARATOR}${sharedPasses}`;
}

/** How many passes AFTER its head a span covers: 0 for a pass's own span. Takes a name with or without its iteration suffix. */
export function spanSharedPasses(spanName: string): number {
  const name = withoutIteration(spanName);
  const at = name.lastIndexOf(SPAN_RUN_SEPARATOR);
  if (at === -1) return 0;
  const suffix = name.slice(at + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix) ? Number(suffix) : 0;
}

function withoutIteration(spanName: string): string {
  const at = spanName.lastIndexOf(SPAN_ITERATION_SEPARATOR);
  if (at === -1) return spanName;
  // Only a trailing all-digit suffix is an iteration index. A pass id that happens to
  // contain the separator keeps its own name rather than being silently truncated onto a
  // pass that does not exist.
  const suffix = spanName.slice(at + 1);
  return suffix.length === 0 || !/^\d+$/.test(suffix) ? spanName : spanName.slice(0, at);
}

/**
 * The base pass id a span name belongs to — the inverse of `iterationSpanName`, and of
 * `runSpanName` (T1604b): a run's span is billed to its head.
 */
export function spanBasePassId(spanName: string): string {
  const name = withoutIteration(spanName);
  const run = name.lastIndexOf(SPAN_RUN_SEPARATOR);
  if (run !== -1 && /^\d+$/.test(name.slice(run + 1))) return name.slice(0, run);
  return name;
}


/**
 * Identity of everything that requires GPU objects to be (re)built: resources, shader
 * sources, bindings, uniform block *names*.
 *
 * Uniform *values* are excluded by construction. A parameter change therefore cannot
 * produce a different signature, so it cannot reach the resource-building path at all —
 * §V5 is enforced by what this function reads, not by a rule someone has to remember.
 */
/**
 * Per-resource structural identity (T143). Two descriptors with equal keys are
 * interchangeable at the GPU level, so the backend may keep the existing allocation —
 * including a feedback pair's CONTENTS — across a recompile (§V22).
 */
export function resourceStructureKey(resource: ResourceDescriptor): string {
  switch (resource.kind) {
    case "sampler":
      return JSON.stringify(["sampler", resource.id, resource.filter ?? "nearest", resource.addressMode ?? "clamp-to-edge"]);
    case "target":
      return JSON.stringify([resource.kind, resource.id, resource.size[0], resource.size[1], resource.format, resource.depth === true]);
    case "pingPong":
      return JSON.stringify([resource.kind, resource.id, resource.size[0], resource.size[1], resource.format]);
    case "buffer":
      // T1353b: a fed buffer keys on its source like an external texture does — re-pointed
      // at a different source is new contents, never a carry. Absent, the key is unchanged.
      return JSON.stringify([
        resource.kind,
        resource.id,
        resource.stride,
        resource.capacity,
        resource.usage,
        ...(resource.sourceId === undefined ? [] : [resource.sourceId]),
      ]);
    case "bufferPair":
      return JSON.stringify([resource.kind, resource.id, resource.stride, resource.capacity]);
    case "externalTexture":
      // sourceId is structural: rebinding a texture to a different media source is a new
      // resource (fresh contents), not a carried one.
      return JSON.stringify([resource.kind, resource.id, resource.size[0], resource.size[1], resource.format, resource.sourceId]);
    case "ring":
      // `frames` is structural like size and format are: a deeper ring is a different
      // allocation, so it cannot be carried and its history starts again (§V62b) — the
      // same rule a resized ping-pong already lives under, at a bigger scale.
      return JSON.stringify([resource.kind, resource.id, resource.size[0], resource.size[1], resource.format, resource.frames]);
    case "layers":
      // T1623b: the layer count is structural as a ring's depth is; one more layer is another allocation.
      return JSON.stringify([resource.kind, resource.id, resource.size[0], resource.size[1], resource.format, resource.layers, resource.depth === true]);
  }
}

/** Per-pass structural identity. Uniform NAMES only, never values (§V5). */
export function passStructureKey(pass: PassDescriptor): string {
  return JSON.stringify(passKeyParts(pass));
}

/**
 * T1603b: whether two passes have the same structure — exactly
 * `passStructureKey(a) === passStructureKey(b)`, without building either key.
 *
 * The per-frame verifier (`frame-compile.ts`) asks this of every pass a frame re-emits,
 * against the base plan's. The key serialises the pass, SHADER TEXT INCLUDED, so asking it
 * by key escaped ten to twenty kilobytes per pass per frame to compare two strings that
 * are, on a values-only frame, the same object (the generators remember their text). This
 * walks the same parts the key is made of — one source for what "structure" means — and
 * compares them where they stand.
 */
export function samePassStructure(a: PassDescriptor, b: PassDescriptor): boolean {
  return a === b || sameKeyParts(passKeyParts(a), passKeyParts(b));
}

function sameKeyParts(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!sameKeyParts(a[index], b[index])) return false;
  }
  return true;
}

/**
 * Field separators for the whole-plan signature (T1176).
 *
 * The per-entry keys are `JSON.stringify` output, and `JSON.stringify` NEVER emits a raw
 * control character — U+0000 comes out as the six characters `\u0000` — so no key can
 * contain either of these and no join can forge a boundary between two of them.
 * `plan-structure-keys.test.ts` checks that on every shipped example's real keys rather
 * than taking the argument on trust.
 */
const KEY_SEPARATOR = "\u0000";
const SECTION_SEPARATOR = "\u0001";

/**
 * The whole-plan key, JOINED from the per-entry keys rather than re-serialised (T1176).
 *
 * This used to be `JSON.stringify({ resourceKeys, passKeys })` over the key PARTS, which
 * walked and serialised every descriptor a second time — and a plan carries the per-entry
 * keys anyway, so the second walk produced nothing the first had not. Measured on the
 * three shipped documents in one process, in rotating order, against the pre-T1176 body
 * restored beside it: the key block goes 0.250 -> 0.139 ms on E55 (0.255 -> 0.142 on E33,
 * 0.335 -> 0.191 on E13), which is 12.8–14.5% OF AN ENTIRE `compileGraph` — and
 * `compileGraph` runs on every commit and on every animated frame.
 *
 * §V5 is unaffected, and that is checked rather than argued: the signature is built from
 * exactly the keys `passStructureKey` and `resourceStructureKey` produce, and those
 * exclude uniform VALUES by construction. The bytes are new; nothing persists a
 * signature, and every comparison in the tree is between two signatures from this same
 * function.
 */
function joinStructureKeys(
  resourceKeys: ReadonlyArray<string>,
  passKeys: ReadonlyArray<string>,
): string {
  return `${resourceKeys.join(KEY_SEPARATOR)}${SECTION_SEPARATOR}${passKeys.join(KEY_SEPARATOR)}`;
}

export function planStructureSignature(
  resources: ReadonlyArray<ResourceDescriptor>,
  passes: ReadonlyArray<PassDescriptor>,
): string {
  return joinStructureKeys(resources.map(resourceStructureKey), passes.map(passStructureKey));
}

/** The separators, so a gate can assert no real key contains one. */
export const STRUCTURE_KEY_SEPARATORS: readonly string[] = [KEY_SEPARATOR, SECTION_SEPARATOR];

/** One entry's structural identity, as `CompiledGraph` carries it. */
export interface StructureSignature {
  readonly id: string;
  readonly signature: string;
}

export interface PlanStructureKeys {
  /** Per-resource, sorted by id. */
  readonly resourceSignatures: ReadonlyArray<StructureSignature>;
  /** Per-pass, sorted by id. */
  readonly passSignatures: ReadonlyArray<StructureSignature>;
  /** The whole-plan key `isUniformOnlyChange` compares. */
  readonly signature: string;
}

/**
 * All three of a plan's structure keys, from ONE pass over the descriptors (T1176).
 *
 * Every `CompiledGraph` carries per-entry signatures AND a whole-plan signature, and
 * `planStructureSignature` derives the whole-plan one from exactly the same per-entry
 * keys — so a compiler that asks for both, as `compileGraph` does at the end of every
 * commit, keyed every resource and every pass TWICE. That is pure duplication: the keys
 * are pure functions of the descriptors, and the descriptors do not move between the two
 * calls.
 *
 * The whole-plan signature is `joinStructureKeys` over those same per-entry keys, so
 * every key in a plan is now built exactly once — see that function for why the join is
 * unforgeable and why re-serialising was the larger half of the cost.
 */
export function planStructureKeys(
  resources: ReadonlyArray<ResourceDescriptor>,
  passes: ReadonlyArray<PassDescriptor>,
): PlanStructureKeys {
  const resourceKeys = resources.map(resourceStructureKey);
  const passKeys = passes.map(passStructureKey);
  return {
    resourceSignatures: resources
      .map((resource, index) => ({ id: resource.id, signature: resourceKeys[index] as string }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    passSignatures: passes
      .map((pass, index) => ({ id: pass.id, signature: passKeys[index] as string }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    signature: joinStructureKeys(resourceKeys, passKeys),
  };
}

function passKeyParts(pass: PassDescriptor): unknown[] {
  switch (pass.kind) {
      case "swap":
        return ["swap", pass.id, pass.resourceId];
      // T387 put the COUNT in the structure key, and its argument was sound at the time:
      // the count is not a uniform value — nothing writes it into a buffer — it is how
      // many times the region is encoded, and a plan that runs its body 4 times looked
      // like a different plan from one that runs it 40 times. T425 moved it OUT, because
      // the premise changed, not the logic: the encoder now re-expands the loop against
      // a LIVE count each frame (`expandLoops(passes, countOf)`), so the count became
      // exactly the thing the original argument said it was not — a value something
      // writes per frame (an audio band driving substeps is the case that forced it).
      // The loop REGION — that the markers exist, where they sit, what they enclose —
      // stays structural.
      // T1583b: so is WHICH pair a kernel region steps, appended only when there is one,
      // so a texture loop's key is the one it had. `iterations` and `prepare` are values.
      case "loop":
        return pass.steps === undefined
          ? ["loop", pass.id, pass.edge, pass.loopId]
          : ["loop", pass.id, pass.edge, pass.loopId, pass.steps.pair];
      case "effect":
        return [
          "effect",
          pass.id,
          pass.shader,
          pass.target,
          pass.clear ?? true,
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered", t.array === true, ...(t.layer === undefined ? [] : [t.layer])]),
          (pass.samplers ?? []).map((s) => [s.binding, s.resourceId]),
          pass.uniformBinding ?? null,
          // Names, never values (§V5).
          Object.keys(pass.uniforms ?? {}).sort(),
          pass.sharedBinding ?? null,
        ];
      case "dispatch":
        return [
          "dispatch",
          pass.id,
          pass.shader,
          pass.entryPoint,
          typeof pass.workgroups === "object" && "indirect" in pass.workgroups
            ? ["indirect", pass.workgroups.indirect]
            : pass.workgroups,
          (pass.buffers ?? []).map((b) => [b.binding, b.resourceId, b.half ?? "read", b.offset ?? 0, b.bytes ?? 0]),
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered", t.array === true, ...(t.layer === undefined ? [] : [t.layer])]),
          Object.keys(pass.uniforms ?? {}).sort(),
          pass.uniformBinding ?? null,
        ];
      case "draw":
        return [
          "draw",
          pass.id,
          pass.shader,
          pass.target,
          pass.topology,
          typeof pass.instances === "object" ? ["indirect", pass.instances.indirect] : "literal",
          (pass.buffers ?? []).map((b) => [b.binding, b.resourceId, b.half ?? "read", b.offset ?? 0, b.bytes ?? 0]),
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered", t.array === true, ...(t.layer === undefined ? [] : [t.layer])]),
          Object.keys(pass.uniforms ?? {}).sort(),
          pass.uniformBinding ?? null,
          pass.sharedBinding ?? null,
          pass.blend ?? null,
          pass.clear ?? true,
          // T1623b: only where a layer is named, so every other draw's key is the key it had.
          ...(pass.layer === undefined ? [] : [["layer", pass.layer]]),
          ...(pass.preparation === undefined ? [] : [["preparation", pass.preparation.kind, pass.preparation.source]]),
        ];
      case "counter":
        return ["counter", pass.id, pass.op, pass.resourceId, pass.outputResourceId ?? null];
      // T1623b: where the rows go and what a row is. The rows and their count are values.
      case "write":
        return ["write", pass.id, pass.resourceId, pass.offset, pass.row.join(","), pass.capacity, pass.countOffset ?? null];
  }
}

const BYTES_PER_PIXEL: Record<string, number> = {
  rgba8unorm: 4,
  "rgba8unorm-srgb": 4,
  rgba16float: 8,
  r32float: 4,
};

/** Bytes per texel for the supported color formats (§V60 readback descriptors). */
export function bytesPerPixelFor(format: TextureFormat): number {
  return BYTES_PER_PIXEL[format] ?? 4;
}

/**
 * Coarse texture-memory estimate for a plan's declared resources (§V24 reporting).
 * Shared by the compiler (budget diagnostic against ProjectSettings) and the backend
 * (live status), so the two never disagree about what a plan costs.
 */
export function estimateResourceBytes(resources: ReadonlyArray<ResourceDescriptor>): number {
  let total = 0;
  for (const resource of resources) {
    if (resource.kind === "buffer") {
      total += resource.stride * resource.capacity;
      continue;
    }
    if (resource.kind === "bufferPair") {
      total += resource.stride * resource.capacity * 2;
      continue;
    }
    if (
      resource.kind !== "target" &&
      resource.kind !== "pingPong" &&
      resource.kind !== "externalTexture" &&
      resource.kind !== "ring" &&
      resource.kind !== "layers"
    ) {
      continue;
    }
    const bytesPerPixel = BYTES_PER_PIXEL[resource.format] ?? 4;
    // A ring is `frames` slices, a ping-pong is 2 — the same multiplication, which is
    // what "generalised from 2 to N" means at the level of what it costs (§V226).
    // T1623b: a layered target is `layers` of them, and ONE depth buffer whatever the count.
    const slices = resource.kind === "pingPong" ? 2 : resource.kind === "ring" ? resource.frames : resource.kind === "layers" ? resource.layers : 1;
    total += resource.size[0] * resource.size[1] * bytesPerPixel * slices;
    if ((resource.kind === "target" || resource.kind === "layers") && resource.depth === true) {
      total += resource.size[0] * resource.size[1] * 4; // depth24plus
    }
  }
  return total;
}

/** Uniform values a plan carries, keyed by pass id. Extracted after the signature is taken. */
/**
 * T1598b: the draws a plan SKIPS — its other per-frame value beside the uniform blocks.
 * One reader for the backend (what it does not encode) and the animator (what it pushes).
 */
export function planSkippedDraws(passes: ReadonlyArray<PassDescriptor>): Set<string> {
  const skipped = new Set<string>();
  for (const pass of passes) {
    if (pass.kind === "draw" && pass.skip === true) skipped.add(pass.id);
  }
  return skipped;
}

export function planUniformValues(
  passes: ReadonlyArray<PassDescriptor>,
): ReadonlyMap<string, UniformValues> {
  const out = new Map<string, UniformValues>();
  for (const pass of passes) {
    if ((pass.kind === "effect" || pass.kind === "dispatch" || pass.kind === "draw") && pass.uniforms) {
      out.set(pass.id, pass.uniforms as UniformValues);
    }
    // T1623b: a region's rows travel with the uniform blocks, keyed by their own pass id.
    if (pass.kind === "write") out.set(pass.id, pass.values);
  }
  return out;
}
