import { compute, draw, effect, pingPong, pingPongStorage, sampler, storage, target, uniforms } from "vgpu";
import type { Compute, Draw, Effect, Gpu, PingPongStorage, PingPongTargets, SharedUniforms, StorageBuffer, Target, Texture } from "vgpu";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { BackendDiagnosticCode, backendDiagnostic, describeError } from "../diagnostics.ts";
import type { BuildStats } from "../backend-types.ts";
import type { FrameGuard } from "../frame-guard.ts";
import type {
  EffectPassDescriptor,
  PassDescriptor,
  ResourceDescriptor,
  TextureBindingDescriptor,
  UniformValues,
} from "../plan.ts";
import { initialSharedUniforms, type SharedUniformValues } from "../shared-uniforms.ts";

/**
 * Builds every GPU object a plan needs — targets, ping-pong pairs, samplers, uniform
 * buffers, effects and their pipelines — before any frame is opened (§V8).
 *
 * All of it is owned by the `Gpu`, so `gpu.dispose()` (which is what a device rebuild does)
 * releases the lot; there is no per-resource teardown to get wrong.
 */

/**
 * An `externalTexture` resource, live (T229, §V135). The texture is GPU-allocated here;
 * its CONTENTS arrive from the media source registered under `sourceId`, uploaded by
 * the backend when — and only when — the source's frameId advances (§V136).
 */
export interface ExternalTextureEntry {
  readonly texture: Texture;
  readonly sourceId: string;
  readonly size: readonly [number, number];
  readonly format: string;
  /** Mutable: the frameId last uploaded, so an unchanged frame uploads nothing (§V136). */
  lastFrameId: number | undefined;
}

/**
 * N textures, one written per frame, older ones readable by tap (T237, §V226).
 *
 * `pingPong` with a bigger modulus: `head` is the slice this frame writes, `rotate()`
 * advances it, and `tap(n)` is the slice written n frames ago. Nothing is copied — the
 * rotation is an integer, which is the entire argument for the kind existing (§V227).
 *
 * `written` is what makes §V229 work: before the ring has filled, a tap deeper than the
 * history clamps to the OLDEST slice rather than reading a never-written texture. Black
 * there would flash on every reset and would differ between a live session and a headless
 * render that started at frame 0 — the class of bug that only shows up in parity runs.
 */
export interface RingTargets {
  readonly frames: number;
  /** The single write target — producers render into it every frame (T321). */
  current(): Target;
  /** Raw single-layer view of the frame written `n` ago, clamped to the oldest (§V229). */
  tapView(n: number): GPUTextureView;
  /** Raw 2d-array view of the whole history — the slit-scan binding (T321). */
  arrayView(): GPUTextureView;
  /** Layer index of the MOST RECENT frame — the per-frame uniform array readers need. */
  latestLayer(): number;
  /** Frames actually recorded, capped at `frames` (§V229). */
  writtenCount(): number;
  /**
   * Marks rotation due. The plan's swap pass calls this DURING encode; the actual
   * copy happens at the next frame entry via `flush()`, after the frame that wrote
   * the target has been submitted — copying mid-encode would archive LAST frame.
   */
  rotate(): void;
  /** Performs a pending rotation: copy write target → layer[head], advance. OUTSIDE any open frame. */
  flush(): void;
  /** Zeroes every history layer from the (cleared) write target and resets the counters. */
  resetHistory(): void;
  dispose(): void;
}

/**
 * Allocates a ring (T237, restorage by T321): ONE ordinary write target — producers
 * render into it exactly as before — plus ONE `texture_2d_array` of N layers holding
 * the history. `rotate()` marks; `flush()` (next frame entry, after the writing frame
 * submitted) copies the target into layer[head] and advances.
 *
 * BOTH consumers come off the same storage: a fixed tap binds a single-layer view
 * (`dimension: "2d"`), which IS an ordinary `texture_2d` at the WGSL level — T237's
 * shaders unchanged — and per-pixel time (slit-scan) binds the whole-array view. The
 * per-frame price is one full-frame copy PER RING (§V228: five Cache nodes is five
 * copies a frame; the node states this beside its byte arithmetic).
 *
 * The array texture is raw-device (§V3's sanctioned reach-through — vgpu's target()
 * owns its own texture and cannot wrap layers); the views are created ONCE and reused,
 * so binding identity stays stable for the bind-group cache and nothing allocates in
 * the frame loop (§V8: flush encodes a copy, allocates nothing).
 */
function createRing(
  gpu: Gpu,
  size: readonly [number, number],
  format: GPUTextureFormat,
  frames: number,
  label: string,
): RingTargets {
  const count = Math.max(2, Math.floor(frames));
  const raw = gpu.gpu;
  const writeTarget = target(gpu, { size, format, label: `${label} [write]` });
  // Literal usage bits with a global fallback: the mock host has no GPUTextureUsage
  // global, and the values are spec constants (TEXTURE_BINDING = 4, COPY_DST = 2).
  const usage =
    (globalThis as { GPUTextureUsage?: { TEXTURE_BINDING: number; COPY_DST: number } }).GPUTextureUsage ??
    { TEXTURE_BINDING: 4, COPY_DST: 2 };
  const history = raw.createTexture({
    size: { width: size[0], height: size[1], depthOrArrayLayers: count },
    format,
    usage: usage.TEXTURE_BINDING | usage.COPY_DST,
    label: `${label} [history]`,
  });
  const layerViews = Array.from({ length: count }, (_, index) =>
    history.createView({
      dimension: "2d",
      baseArrayLayer: index,
      arrayLayerCount: 1,
      label: `${label} [layer ${index}]`,
    }),
  );
  const wholeView = history.createView({ dimension: "2d-array", label: `${label} [array]` });
  /** Next layer to write. `latest` = (head - 1) mod count once anything is written. */
  let head = 0;
  /** How many layers hold a frame. Caps at count; only ever grows (§V229). */
  let written = 0;
  let pendingRotate = false;

  const copyInto = (layer: number): void => {
    const encoder = raw.createCommandEncoder({ label: `${label} rotate` });
    encoder.copyTextureToTexture(
      { texture: writeTarget.color.gpu },
      { texture: history, origin: { x: 0, y: 0, z: layer } },
      { width: size[0], height: size[1], depthOrArrayLayers: 1 },
    );
    raw.queue.submit([encoder.finish()]);
  };

  return {
    frames: count,
    current() {
      return writeTarget;
    },
    tapView(n) {
      // §V229: before the ring has filled, the deepest available layer stands in for
      // a deeper tap — never a layer nobody has written.
      const back = Math.min(Math.max(1, Math.floor(n)), Math.max(written, 1));
      const latest = (head - 1 + count) % count;
      return layerViews[(latest - (back - 1) + count * 2) % count] as GPUTextureView;
    },
    arrayView() {
      return wholeView;
    },
    latestLayer() {
      return (head - 1 + count) % count;
    },
    writtenCount() {
      return written;
    },
    rotate() {
      pendingRotate = true;
    },
    flush() {
      if (!pendingRotate) return;
      pendingRotate = false;
      copyInto(head);
      written = Math.min(written + 1, count);
      head = (head + 1) % count;
    },
    resetHistory() {
      // The caller cleared the write target; archive that zero frame into every layer.
      for (let layer = 0; layer < count; layer += 1) copyInto(layer);
      head = 0;
      written = 0;
      pendingRotate = false;
    },
    dispose() {
      history.destroy();
    },
  };
}

export interface ResourceSet {
  readonly targets: ReadonlyMap<string, Target>;
  readonly pingPongs: ReadonlyMap<string, PingPongTargets>;
  /** Frame history rings (T237), keyed by resource id. */
  readonly rings: ReadonlyMap<string, RingTargets>;
  readonly samplers: ReadonlyMap<string, GPUSampler>;
  /** CPU-fed sampleable textures, keyed by resource id (T229). */
  readonly externalTextures: ReadonlyMap<string, ExternalTextureEntry>;
  /** SoA point storage (T118, §V75): one buffer per attribute, plus counters. */
  readonly buffers: ReadonlyMap<string, StorageBuffer>;
  readonly bufferPairs: ReadonlyMap<string, PingPongStorage>;
  readonly effects: ReadonlyMap<string, Effect>;
  /** Compute pipelines per dispatch pass (T172). */
  readonly computes: ReadonlyMap<string, Compute>;
  /** Draw pipelines per draw pass (T172) — the sprite/instances/mesh spine. */
  readonly draws: ReadonlyMap<string, Draw>;
  readonly passUniforms: ReadonlyMap<string, SharedUniforms<Record<string, unknown>>>;
  readonly shared: SharedUniforms<SharedUniformValues>;
  /**
   * Texture bindings that must be re-pointed each frame because their source is a
   * ping-pong read half, which changes identity on every swap. Rebinding is a `set()` —
   * it allocates nothing (§V8).
   */
  readonly dynamicTextures: ReadonlyMap<string, ReadonlyArray<TextureBindingDescriptor>>;
  /** Buffer bindings whose source is a bufferPair read half — re-pointed after each swap. */
  readonly dynamicBuffers: ReadonlyMap<string, ReadonlyArray<{ readonly binding: string; readonly resourceId: string; readonly half?: "read" | "write" }>>;
  /** Render target per effect pass, resolved once. Ping-pong passes render into the write half. */
  readonly renderTargets: ReadonlyMap<string, () => Target>;
}

/**
 * GPU objects carried over from the previous program because their structure keys are
 * unchanged (T143, §V22). A carried ping-pong keeps its CONTENTS — adding an unrelated
 * node must not zero someone's feedback history. A carried effect is reused only when
 * its pass key AND everything it binds survived; the caller decides that.
 */
export interface CarryOver {
  readonly targets: ReadonlyMap<string, Target>;
  /** A carried ring keeps its CONTENTS and its position, exactly as a pair does (§V62b). */
  readonly rings: ReadonlyMap<string, RingTargets>;
  readonly pingPongs: ReadonlyMap<string, PingPongTargets>;
  readonly samplers: ReadonlyMap<string, GPUSampler>;
  /** A carried external texture keeps its contents AND its upload cursor (§V136). */
  readonly externalTextures: ReadonlyMap<string, ExternalTextureEntry>;
  /** A carried buffer keeps its CONTENTS — a sim's state survives unrelated edits (§V22). */
  readonly buffers: ReadonlyMap<string, StorageBuffer>;
  readonly bufferPairs: ReadonlyMap<string, PingPongStorage>;
  readonly effects: ReadonlyMap<string, Effect>;
  readonly computes: ReadonlyMap<string, Compute>;
  readonly draws: ReadonlyMap<string, Draw>;
  readonly passUniforms: ReadonlyMap<string, SharedUniforms<Record<string, unknown>>>;
  readonly shared: SharedUniforms<SharedUniformValues> | undefined;
}

export const emptyCarryOver: CarryOver = {
  targets: new Map(),
  rings: new Map(),
  pingPongs: new Map(),
  samplers: new Map(),
  externalTextures: new Map(),
  buffers: new Map(),
  bufferPairs: new Map(),
  effects: new Map(),
  computes: new Map(),
  draws: new Map(),
  passUniforms: new Map(),
  shared: undefined,
};

/**
 * Resources owned by ANOTHER resource set that passes in this build may bind but never
 * render into (T161). This is how the preview program samples the main program's
 * outputs: tile targets are local, the sampled node outputs are external. Externals are
 * looked up as binding sources only — a pass whose render target is external is a plan
 * error, and externals are never destroyed by this set's lifecycle.
 */
export interface ExternalResources {
  readonly targets: ReadonlyMap<string, Target>;
  readonly pingPongs: ReadonlyMap<string, PingPongTargets>;
  readonly samplers: ReadonlyMap<string, GPUSampler>;
}

export const noExternalResources: ExternalResources = {
  targets: new Map(),
  pingPongs: new Map(),
  samplers: new Map(),
};

export class ResourceBuildError extends Error {
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;

  constructor(diagnostics: ReadonlyArray<RuntimeDiagnostic>) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "Resource build failed.");
    this.name = "ResourceBuildError";
    this.diagnostics = diagnostics;
  }
}

function samplerDescriptor(
  filter: "nearest" | "linear" | undefined,
  addressMode: "clamp-to-edge" | "repeat" | "mirror-repeat" | undefined,
): GPUSamplerDescriptor {
  const mode = addressMode ?? "clamp-to-edge";
  const filterMode = filter ?? "linear";
  return {
    magFilter: filterMode,
    minFilter: filterMode,
    addressModeU: mode,
    addressModeV: mode,
  };
}

export function buildResources(
  gpu: Gpu,
  resources: ReadonlyArray<ResourceDescriptor>,
  passes: ReadonlyArray<PassDescriptor>,
  guard: FrameGuard,
  carry: CarryOver = emptyCarryOver,
  stats?: BuildStats,
  externals: ExternalResources = noExternalResources,
  /**
   * T258: fault isolation. When given, problems land HERE and the build returns the
   * PARTIAL set — every pass that resolved still runs; a pass with a broken binding is
   * simply absent. The preview host uses this: one node's bad binding must black out
   * ONE tile, never every preview. The main program stays strict (absent = throw),
   * because a half-built main program rendering quietly is §V9's bug inverted.
   */
  tolerate?: { diagnostics: RuntimeDiagnostic[] },
): ResourceSet {
  guard.assertOutsideFrame("plan resources");

  const targets = new Map<string, Target>();
  const pingPongs = new Map<string, PingPongTargets>();
  const rings = new Map<string, RingTargets>();
  const samplers = new Map<string, GPUSampler>();
  const externalTextures = new Map<string, ExternalTextureEntry>();
  const buffers = new Map<string, StorageBuffer>();
  const bufferPairs = new Map<string, PingPongStorage>();
  const effects = new Map<string, Effect>();
  const computes = new Map<string, Compute>();
  const draws = new Map<string, Draw>();
  const passUniforms = new Map<string, SharedUniforms<Record<string, unknown>>>();
  const dynamicTextures = new Map<string, ReadonlyArray<TextureBindingDescriptor>>();
  const dynamicBuffers = new Map<string, ReadonlyArray<{ binding: string; resourceId: string; half?: "read" | "write" }>>();
  const renderTargets = new Map<string, () => Target>();
  const diagnostics: RuntimeDiagnostic[] = [];

  const shared = carry.shared ?? uniforms<SharedUniformValues>(gpu, initialSharedUniforms());

  const note = (field: keyof BuildStats): void => {
    if (stats) stats[field] += 1;
  };

  for (const resource of resources) {
    try {
      if (resource.kind === "target") {
        const carried = carry.targets.get(resource.id);
        if (carried) {
          targets.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        targets.set(
          resource.id,
          target(gpu, {
            size: resource.size,
            format: resource.format as GPUTextureFormat,
            // T295: depth24plus attachment; draws into this target depth-test by
            // vgpu's default (write, less-equal) with no per-pass plumbing.
            ...(resource.depth === true ? { depth: true } : {}),
            label: resource.label ?? resource.id,
          }),
        );
        note("resourcesCreated");
      } else if (resource.kind === "pingPong") {
        // A carried pair keeps its texture CONTENTS: this is what makes feedback
        // history survive an unrelated structural edit (§V22, T143).
        const carried = carry.pingPongs.get(resource.id);
        if (carried) {
          pingPongs.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        pingPongs.set(
          resource.id,
          pingPong(gpu, resource.size[0], resource.size[1], {
            format: resource.format as GPUTextureFormat,
            label: resource.label ?? resource.id,
          }),
        );
        note("resourcesCreated");
      } else if (resource.kind === "ring") {
        // Carried like a pair, and for the same reason: adding an unrelated node must not
        // throw away seconds of history someone is reading from (§V22, §V62b). `frames` is
        // in the structure key, so a deeper ring is a new allocation rather than a carried
        // one with the wrong length.
        const carried = carry.rings.get(resource.id);
        if (carried) {
          rings.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        rings.set(
          resource.id,
          createRing(gpu, resource.size, resource.format as GPUTextureFormat, resource.frames, resource.label ?? resource.id),
        );
        note("resourcesCreated");
      } else if (resource.kind === "externalTexture") {
        // T229: the texture is ours; the contents are the media source's. A carried
        // entry keeps both the pixels and the upload cursor — a structural edit
        // elsewhere must not re-upload (or blank) a paused video frame (§V136). The
        // sourceId is part of the structure key, so a re-pointed source never carries.
        const carried = carry.externalTextures.get(resource.id);
        if (carried) {
          externalTextures.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        externalTextures.set(resource.id, {
          texture: gpu.device.createTexture({
            size: resource.size,
            format: resource.format as GPUTextureFormat,
            // RENDER_ATTACHMENT is not optional here, and it is not this file's choice:
            // `copyExternalImageToTexture` REQUIRES `COPY_DST | RENDER_ATTACHMENT` on the
            // destination, because the implementation performs the copy as a draw (that
            // is what buys the colour-space conversion and the flip). Without it every
            // upload fails validation on the device's uncaptured-error path — no throw
            // for the caller's try/catch to see — and the texture stays black forever.
            usage: ["texture_binding", "copy_dst", "render_attachment"],
            label: resource.label ?? resource.id,
          }),
          sourceId: resource.sourceId,
          size: resource.size,
          format: resource.format,
          lastFrameId: undefined,
        });
        note("resourcesCreated");
      } else if (resource.kind === "sampler") {
        const carried = carry.samplers.get(resource.id);
        if (carried) {
          samplers.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        samplers.set(
          resource.id,
          sampler(gpu, samplerDescriptor(resource.filter, resource.addressMode)),
        );
        note("resourcesCreated");
      } else if (resource.kind === "buffer") {
        // T118 (§V75): SoA point storage. "uniform" usage is not a storage buffer and
        // stays a per-pass uniform block's business.
        if (resource.usage === "uniform") {
          diagnostics.push(
            backendDiagnostic(
              "warning",
              BackendDiagnosticCode.planInvalid,
              `Resource "${resource.id}" declares usage "uniform"; kernel uniforms belong to the pass uniform block, not a storage buffer.`,
            ),
          );
          continue;
        }
        const carried = carry.buffers.get(resource.id);
        if (carried) {
          buffers.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        const bytes = resource.stride * resource.capacity;
        buffers.set(
          resource.id,
          storage(
            gpu,
            bytes,
            resource.usage === "indirect"
              ? { access: "read-write", indirect: true }
              : resource.usage === "storage-read"
                ? "read"
                : "read-write",
          ),
        );
        note("resourcesCreated");
      } else if (resource.kind === "bufferPair") {
        // A carried pair keeps its contents, exactly like a texture ping-pong (§V22).
        const carried = carry.bufferPairs.get(resource.id);
        if (carried) {
          bufferPairs.set(resource.id, carried);
          note("resourcesReused");
          continue;
        }
        bufferPairs.set(resource.id, pingPongStorage(gpu, resource.stride * resource.capacity));
        note("resourcesCreated");
      }
    } catch (error) {
      diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Failed to allocate resource "${resource.id}": ${describeError(error)}`,
        ),
      );
    }
  }

  /**
   * The slice a binding reads (T237). A tap is resolved per FRAME, not once: the ring
   * rotates under it, which is why ring bindings join the dynamic set below.
   */
  const readRingSlice = (resourceId: string, tap: number | undefined, array?: boolean): unknown => {
    const ring = rings.get(resourceId);
    if (ring === undefined) return undefined;
    // T321: the whole-array view for per-pixel time; a single-layer view for a fixed
    // tap — an ordinary texture_2d at the WGSL level, T237's shaders untouched.
    return array === true ? ring.arrayView() : ring.tapView(Math.max(1, tap ?? 1));
  };

  const readTexture = (resourceId: string, tap?: number, array?: boolean): unknown => {
    const slice = readRingSlice(resourceId, tap, array);
    if (slice !== undefined) return slice;
    // T94: bind the Target itself, never its .color texture. vgpu wires
    // onTexturesRecreated only for Target values, and Target.resize() destroys and
    // recreates its textures — a bound .color would keep pointing at the destroyed
    // one after resize, and every pass sampling it would break.
    const plain = targets.get(resourceId) ?? externals.targets.get(resourceId);
    if (plain) return plain;
    // Ping-pong halves swap identity per frame; they are re-pointed explicitly by
    // rebindDynamicTextures before each render, so no recreation wiring is needed here.
    const pair = pingPongs.get(resourceId) ?? externals.pingPongs.get(resourceId);
    if (pair) return pair.read.color;
    // T229: an external texture binds as the (stable-identity) Texture itself — its
    // contents change via queue writes, never its object, so no re-pointing is needed.
    const external = externalTextures.get(resourceId);
    if (external) return external.texture;
    return undefined;
  };

  const bufferValue = (resourceId: string, half: "read" | "write"): unknown => {
    const plain = buffers.get(resourceId);
    if (plain) return plain;
    // T121: a pair binds the SELECTED half — a stateful kernel reads "read" and writes
    // "write", the pair swaps as one identity. Both halves swap per frame, so both are
    // re-pointed by the backend before each render.
    const pair = bufferPairs.get(resourceId);
    if (pair) return half === "write" ? pair.write : pair.read;
    return undefined;
  };

  /** Builds a dispatch/draw set bag: buffers + textures + uniforms. Returns undefined on a bad ref. */
  const buildComputeDrawBag = (
    passId: string,
    nodeId: string | undefined,
    bufferBindings: ReadonlyArray<{ readonly binding: string; readonly resourceId: string; readonly half?: "read" | "write" }>,
    textureBindings: ReadonlyArray<TextureBindingDescriptor>,
    uniformsValue: Readonly<Record<string, unknown>> | undefined,
    uniformBinding: string | undefined,
  ): Record<string, unknown> | undefined => {
    const bag: Record<string, unknown> = {};
    for (const binding of bufferBindings) {
      const value = bufferValue(binding.resourceId, binding.half ?? "read");
      if (value === undefined) {
        diagnostics.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.unknownResource,
            `Pass "${passId}" binds unknown buffer resource "${binding.resourceId}".`,
            nodeId === undefined ? {} : { nodeId },
          ),
        );
        return undefined;
      }
      bag[binding.binding] = value;
    }
    for (const binding of textureBindings) {
      const value = readTexture(binding.resourceId, binding.tap, binding.array);
      if (value === undefined) {
        diagnostics.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.unknownResource,
            `Pass "${passId}" binds unknown texture resource "${binding.resourceId}".`,
            nodeId === undefined ? {} : { nodeId },
          ),
        );
        return undefined;
      }
      bag[binding.binding] = value;
    }
    if (uniformsValue !== undefined && uniformBinding !== undefined) {
      const block = uniforms<Record<string, unknown>>(gpu, { ...uniformsValue });
      passUniforms.set(passId, block);
      bag[uniformBinding] = block;
    }
    return bag;
  };

  const noteDynamicBindings = (
    passId: string,
    bufferBindings: ReadonlyArray<{ readonly binding: string; readonly resourceId: string; readonly half?: "read" | "write" }>,
    textureBindings: ReadonlyArray<TextureBindingDescriptor>,
  ): void => {
    const dynamicTex = textureBindings.filter(
      (binding) =>
        pingPongs.has(binding.resourceId) ||
        externals.pingPongs.has(binding.resourceId) ||
        // T237: a tap points at a different slice after every rotation, so it is
        // re-pointed each frame exactly as a ping-pong read half is.
        rings.has(binding.resourceId),
    );
    if (dynamicTex.length > 0) dynamicTextures.set(passId, dynamicTex);
    const dynamicBuf = bufferBindings.filter((binding) => bufferPairs.has(binding.resourceId));
    if (dynamicBuf.length > 0) dynamicBuffers.set(passId, dynamicBuf);
  };

  for (const pass of passes) {
    if (pass.kind === "dispatch") {
      // T172: kernels run in frames. Carried pipelines skip WGSL recompilation exactly
      // like effects; the caller's carry rules decided reuse safety.
      const carried = carry.computes.get(pass.id);
      if (carried) {
        computes.set(pass.id, carried);
        const carriedUniforms = carry.passUniforms.get(pass.id);
        if (carriedUniforms) passUniforms.set(pass.id, carriedUniforms);
        noteDynamicBindings(pass.id, pass.buffers ?? [], pass.textures ?? []);
        note("effectsReused");
        continue;
      }
      const bag = buildComputeDrawBag(pass.id, pass.nodeId, pass.buffers ?? [], pass.textures ?? [], pass.uniforms, pass.uniformBinding);
      if (bag === undefined) continue;
      try {
        computes.set(pass.id, compute(gpu, pass.shader, { set: bag, entry: pass.entryPoint, label: pass.id }));
        noteDynamicBindings(pass.id, pass.buffers ?? [], pass.textures ?? []);
        note("effectsBuilt");
      } catch (error) {
        diagnostics.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.planInvalid,
            `Dispatch pass "${pass.id}" failed to compile: ${describeError(error)}`,
            pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
          ),
        );
      }
      continue;
    }

    if (pass.kind === "draw") {
      const plainTarget = targets.get(pass.target);
      const pair = pingPongs.get(pass.target);
      if (!plainTarget && !pair) {
        diagnostics.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.unknownResource,
            `Draw pass "${pass.id}" renders into unknown target "${pass.target}".`,
            pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
          ),
        );
        continue;
      }
      const resolveTarget: () => Target = plainTarget ? () => plainTarget : () => pair!.write;

      const carried = carry.draws.get(pass.id);
      if (carried) {
        draws.set(pass.id, carried);
        renderTargets.set(pass.id, resolveTarget);
        const carriedUniforms = carry.passUniforms.get(pass.id);
        if (carriedUniforms) passUniforms.set(pass.id, carriedUniforms);
        noteDynamicBindings(pass.id, pass.buffers ?? [], pass.textures ?? []);
        note("effectsReused");
        continue;
      }
      const bag = buildComputeDrawBag(pass.id, pass.nodeId, pass.buffers ?? [], pass.textures ?? [], pass.uniforms, pass.uniformBinding);
      if (bag === undefined) continue;
      if (pass.sharedBinding !== undefined) bag[pass.sharedBinding] = shared;
      try {
        const created = draw(gpu, {
          shader: pass.shader,
          set: bag,
          label: pass.id,
          // Topology rides on a minimal geometry descriptor — vgpu has no top-level
          // topology option; a buffer-less GeometryLike carries it for vertex-pulling
          // draws (positions come from storage buffers, not vertex buffers).
          geometry: { topology: pass.topology, vertexCount: pass.vertexCount ?? 6 },
          ...(typeof pass.instances === "number" ? { instances: pass.instances } : {}),
          ...(pass.blend === undefined ? {} : { blend: pass.blend }),
        });
        created.compileSync(resolveTarget());
        draws.set(pass.id, created);
        renderTargets.set(pass.id, resolveTarget);
        noteDynamicBindings(pass.id, pass.buffers ?? [], pass.textures ?? []);
        note("effectsBuilt");
      } catch (error) {
        diagnostics.push(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.planInvalid,
            `Draw pass "${pass.id}" failed to compile: ${describeError(error)}`,
            pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
          ),
        );
      }
      continue;
    }

    if (pass.kind !== "effect") continue;

    const plainTarget = targets.get(pass.target);
    const pair = pingPongs.get(pass.target);
    const ring = rings.get(pass.target);
    if (!plainTarget && !pair && !ring) {
      diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.unknownResource,
          `Pass "${pass.id}" renders into unknown target "${pass.target}".`,
          pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
        ),
      );
      continue;
    }
    // A ring renders into the slice this frame owns, resolved per frame like a pair's
    // write half — the resolver is called at encode time, never cached (T237).
    const resolveTarget: () => Target = plainTarget
      ? () => plainTarget
      : ring
        ? () => ring.current()
        : () => pair!.write;

    // A carried effect's set bag already points at the carried resource objects — the
    // caller only offers it when the pass key and everything it binds survived.
    const carriedEffect = carry.effects.get(pass.id);
    if (carriedEffect) {
      effects.set(pass.id, carriedEffect);
      renderTargets.set(pass.id, resolveTarget);
      const carriedUniforms = carry.passUniforms.get(pass.id);
      if (carriedUniforms) passUniforms.set(pass.id, carriedUniforms);
      const dynamic = (pass.textures ?? []).filter(
        (binding) =>
          pingPongs.has(binding.resourceId) ||
          externals.pingPongs.has(binding.resourceId) ||
          rings.has(binding.resourceId),
      );
      if (dynamic.length > 0) dynamicTextures.set(pass.id, dynamic);
      note("effectsReused");
      continue;
    }

    const setBag = buildSetBag(pass, { readTexture, samplers, externals, shared, passUniforms, gpu, diagnostics });
    if (!setBag) continue;

    try {
      const created = effect(gpu, pass.shader, {
        set: setBag,
        label: pass.label ?? pass.id,
      });
      // Builds the render pipeline now, so the first frame encodes without creating one (§V8).
      created.compileSync(resolveTarget());
      effects.set(pass.id, created);
      renderTargets.set(pass.id, resolveTarget);
      note("effectsBuilt");

      const dynamic = (pass.textures ?? []).filter(
        (binding) =>
          pingPongs.has(binding.resourceId) ||
          externals.pingPongs.has(binding.resourceId) ||
          rings.has(binding.resourceId),
      );
      if (dynamic.length > 0) dynamicTextures.set(pass.id, dynamic);
    } catch (error) {
      diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Pass "${pass.id}" failed to compile: ${describeError(error)}`,
          pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
        ),
      );
    }
  }

  if (diagnostics.length > 0) {
    if (tolerate === undefined) throw new ResourceBuildError(diagnostics);
    tolerate.diagnostics.push(...diagnostics);
  }

  return {
    targets,
    rings,
    pingPongs,
    samplers,
    externalTextures,
    buffers,
    bufferPairs,
    effects,
    computes,
    draws,
    passUniforms,
    shared,
    dynamicTextures,
    dynamicBuffers,
    renderTargets,
  };
}

interface SetBagContext {
  readonly gpu: Gpu;
  readonly readTexture: (resourceId: string, tap?: number, array?: boolean) => unknown;
  readonly samplers: ReadonlyMap<string, GPUSampler>;
  readonly externals: ExternalResources;
  readonly shared: SharedUniforms<SharedUniformValues>;
  readonly passUniforms: Map<string, SharedUniforms<Record<string, unknown>>>;
  readonly diagnostics: RuntimeDiagnostic[];
}

function buildSetBag(
  pass: EffectPassDescriptor,
  ctx: SetBagContext,
): Record<string, unknown> | undefined {
  const bag: Record<string, unknown> = {};

  for (const binding of pass.textures ?? []) {
    const texture = ctx.readTexture(binding.resourceId, binding.tap, binding.array);
    if (texture === undefined) {
      ctx.diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.unknownResource,
          `Pass "${pass.id}" binds unknown texture resource "${binding.resourceId}".`,
          pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
        ),
      );
      return undefined;
    }
    bag[binding.binding] = texture;
  }

  for (const binding of pass.samplers ?? []) {
    const found = ctx.samplers.get(binding.resourceId) ?? ctx.externals.samplers.get(binding.resourceId);
    if (!found) {
      ctx.diagnostics.push(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.unknownResource,
          `Pass "${pass.id}" binds unknown sampler "${binding.resourceId}".`,
          pass.nodeId === undefined ? {} : { nodeId: pass.nodeId },
        ),
      );
      return undefined;
    }
    bag[binding.binding] = found;
  }

  if (pass.uniforms && pass.uniformBinding) {
    const block = uniforms<Record<string, unknown>>(ctx.gpu, toMutable(pass.uniforms));
    ctx.passUniforms.set(pass.id, block);
    bag[pass.uniformBinding] = block;
  }

  // vgpu rejects a set value with no matching WGSL binding, so the shared block is only
  // bound when the pass declares it.
  if (pass.sharedBinding) bag[pass.sharedBinding] = ctx.shared;

  return bag;
}

export function toMutable(values: UniformValues): Record<string, unknown> {
  return { ...values };
}
