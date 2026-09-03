import type { NodeId } from "../../domain/types/ids.ts";
import { TEXTURE_FORMATS } from "../../domain/types/node-definition.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { BackendDiagnosticCode, backendDiagnostic } from "./diagnostics.ts";

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

export type ResourceDescriptor =
  | TargetResourceDescriptor
  | PingPongResourceDescriptor
  | SamplerResourceDescriptor
  | BufferResourceDescriptor
  | BufferPairResourceDescriptor
  | ExternalTextureResourceDescriptor
  | RingResourceDescriptor;

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
   */
  readonly array?: boolean;
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
  /** WGSL fragment source. Part of the structural signature — editing it recompiles. */
  readonly shader: string;
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
 * Compute dispatch. Declared now so scheduling, pruning and resource assignment are
 * written against the union rather than against a texture-only assumption (§V58) —
 * adding compute later would otherwise mean rewriting all three.
 */
export interface DispatchPassDescriptor {
  readonly kind: "dispatch";
  readonly id: string;
  readonly nodeId?: string;
  readonly shader: string;
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
  readonly shader: string;
  readonly target: string;
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

export type PassDescriptor =
  | EffectPassDescriptor
  | SwapPassDescriptor
  | LoopPassDescriptor
  | DispatchPassDescriptor
  | DrawPassDescriptor
  | CounterPassDescriptor;

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

function isUniformValue(value: unknown): value is UniformValue {
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
    const { binding, resourceId, sampled, tap, array, live } = entry;
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
    out.push({
      binding,
      resourceId,
      ...(sampled === undefined ? {} : { sampled }),
      ...(tap === undefined ? {} : { tap: tap as number }),
      ...(array === true ? { array: true } : {}),
      ...(live === true ? { live: true } : {}),
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
    return { kind: "buffer", usage, ...base };
  }

  return undefined;
}

function readPass(value: unknown): PassDescriptor | undefined {
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
    return {
      kind: "loop",
      id,
      edge,
      loopId,
      ...(edge === "begin" ? { count: count as number } : {}),
      ...(typeof nodeId === "string" ? { nodeId: nodeId as NodeId } : {}),
    };
  }

  if (kind === "dispatch") return readDispatchPass(id, value);
  if (kind === "draw") return readDrawPass(id, value);
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

  return {
    kind: "effect",
    id,
    shader,
    target,
    textures,
    samplers,
    ...(clear === undefined ? {} : { clear }),
    ...(uniforms === undefined ? {} : { uniforms, uniformBinding: uniformBinding as string }),
    ...(typeof sharedBinding === "string" ? { sharedBinding } : {}),
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(typeof label === "string" ? { label } : {}),
  };
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
  return {
    kind: "dispatch",
    id,
    shader,
    entryPoint,
    workgroups,
    buffers,
    textures,
    ...(uniforms === undefined
      ? {}
      : { uniforms: uniforms as NonNullable<DispatchPassDescriptor["uniforms"]>, uniformBinding: uniformBinding as string }),
    ...(typeof nodeId === "string" ? { nodeId } : {}),
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

  const nodeId = value["nodeId"];
  return {
    kind: "draw",
    id,
    shader,
    target,
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
    ...(typeof nodeId === "string" ? { nodeId } : {}),
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
      case "loop":
        return [];
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

  const ok = diagnostics.every((diagnostic) => diagnostic.severity !== "error");
  return { resources, passes, diagnostics, ok };
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

/** The base pass id a span name belongs to — the inverse of `iterationSpanName`. */
export function spanBasePassId(spanName: string): string {
  const at = spanName.lastIndexOf(SPAN_ITERATION_SEPARATOR);
  if (at === -1) return spanName;
  // Only a trailing all-digit suffix is an iteration index. A pass id that happens to
  // contain the separator keeps its own name rather than being silently truncated onto a
  // pass that does not exist.
  const suffix = spanName.slice(at + 1);
  if (suffix.length === 0 || !/^\d+$/.test(suffix)) return spanName;
  return spanName.slice(0, at);
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
      return JSON.stringify([resource.kind, resource.id, resource.stride, resource.capacity, resource.usage]);
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
  }
}

/** Per-pass structural identity. Uniform NAMES only, never values (§V5). */
export function passStructureKey(pass: PassDescriptor): string {
  return JSON.stringify(passKeyParts(pass));
}

export function planStructureSignature(
  resources: ReadonlyArray<ResourceDescriptor>,
  passes: ReadonlyArray<PassDescriptor>,
): string {
  const resourceKeys = resources.map(resourceStructureKey);
  const passKeys = passes.map(passKeyParts);
  return JSON.stringify({ resourceKeys, passKeys });
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
      case "loop":
        return ["loop", pass.id, pass.edge, pass.loopId];
      case "effect":
        return [
          "effect",
          pass.id,
          pass.shader,
          pass.target,
          pass.clear ?? true,
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered", t.array === true]),
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
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered", t.array === true]),
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
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered", t.array === true]),
          Object.keys(pass.uniforms ?? {}).sort(),
          pass.uniformBinding ?? null,
          pass.sharedBinding ?? null,
          pass.blend ?? null,
          pass.clear ?? true,
        ];
      case "counter":
        return ["counter", pass.id, pass.op, pass.resourceId, pass.outputResourceId ?? null];
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
      resource.kind !== "ring"
    ) {
      continue;
    }
    const bytesPerPixel = BYTES_PER_PIXEL[resource.format] ?? 4;
    // A ring is `frames` slices, a ping-pong is 2 — the same multiplication, which is
    // what "generalised from 2 to N" means at the level of what it costs (§V226).
    const slices = resource.kind === "pingPong" ? 2 : resource.kind === "ring" ? resource.frames : 1;
    total += resource.size[0] * resource.size[1] * bytesPerPixel * slices;
    if (resource.kind === "target" && resource.depth === true) {
      total += resource.size[0] * resource.size[1] * 4; // depth24plus
    }
  }
  return total;
}

/** Uniform values a plan carries, keyed by pass id. Extracted after the signature is taken. */
export function planUniformValues(
  passes: ReadonlyArray<PassDescriptor>,
): ReadonlyMap<string, UniformValues> {
  const out = new Map<string, UniformValues>();
  for (const pass of passes) {
    if ((pass.kind === "effect" || pass.kind === "dispatch" || pass.kind === "draw") && pass.uniforms) {
      out.set(pass.id, pass.uniforms as UniformValues);
    }
  }
  return out;
}
