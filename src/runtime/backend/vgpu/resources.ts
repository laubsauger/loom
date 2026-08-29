import { effect, pingPong, pingPongStorage, sampler, storage, target, uniforms } from "vgpu";
import type { Effect, Gpu, PingPongStorage, PingPongTargets, SharedUniforms, StorageBuffer, Target } from "vgpu";
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

export interface ResourceSet {
  readonly targets: ReadonlyMap<string, Target>;
  readonly pingPongs: ReadonlyMap<string, PingPongTargets>;
  readonly samplers: ReadonlyMap<string, GPUSampler>;
  /** SoA point storage (T118, §V75): one buffer per attribute, plus counters. */
  readonly buffers: ReadonlyMap<string, StorageBuffer>;
  readonly bufferPairs: ReadonlyMap<string, PingPongStorage>;
  readonly effects: ReadonlyMap<string, Effect>;
  readonly passUniforms: ReadonlyMap<string, SharedUniforms<Record<string, unknown>>>;
  readonly shared: SharedUniforms<SharedUniformValues>;
  /**
   * Texture bindings that must be re-pointed each frame because their source is a
   * ping-pong read half, which changes identity on every swap. Rebinding is a `set()` —
   * it allocates nothing (§V8).
   */
  readonly dynamicTextures: ReadonlyMap<string, ReadonlyArray<TextureBindingDescriptor>>;
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
  readonly pingPongs: ReadonlyMap<string, PingPongTargets>;
  readonly samplers: ReadonlyMap<string, GPUSampler>;
  /** A carried buffer keeps its CONTENTS — a sim's state survives unrelated edits (§V22). */
  readonly buffers: ReadonlyMap<string, StorageBuffer>;
  readonly bufferPairs: ReadonlyMap<string, PingPongStorage>;
  readonly effects: ReadonlyMap<string, Effect>;
  readonly passUniforms: ReadonlyMap<string, SharedUniforms<Record<string, unknown>>>;
  readonly shared: SharedUniforms<SharedUniformValues> | undefined;
}

export const emptyCarryOver: CarryOver = {
  targets: new Map(),
  pingPongs: new Map(),
  samplers: new Map(),
  buffers: new Map(),
  bufferPairs: new Map(),
  effects: new Map(),
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
): ResourceSet {
  guard.assertOutsideFrame("plan resources");

  const targets = new Map<string, Target>();
  const pingPongs = new Map<string, PingPongTargets>();
  const samplers = new Map<string, GPUSampler>();
  const buffers = new Map<string, StorageBuffer>();
  const bufferPairs = new Map<string, PingPongStorage>();
  const effects = new Map<string, Effect>();
  const passUniforms = new Map<string, SharedUniforms<Record<string, unknown>>>();
  const dynamicTextures = new Map<string, ReadonlyArray<TextureBindingDescriptor>>();
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

  const readTexture = (resourceId: string): unknown => {
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
    return undefined;
  };

  for (const pass of passes) {
    if (pass.kind !== "effect") continue;

    const plainTarget = targets.get(pass.target);
    const pair = pingPongs.get(pass.target);
    if (!plainTarget && !pair) {
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
    const resolveTarget: () => Target = plainTarget ? () => plainTarget : () => pair!.write;

    // A carried effect's set bag already points at the carried resource objects — the
    // caller only offers it when the pass key and everything it binds survived.
    const carriedEffect = carry.effects.get(pass.id);
    if (carriedEffect) {
      effects.set(pass.id, carriedEffect);
      renderTargets.set(pass.id, resolveTarget);
      const carriedUniforms = carry.passUniforms.get(pass.id);
      if (carriedUniforms) passUniforms.set(pass.id, carriedUniforms);
      const dynamic = (pass.textures ?? []).filter(
        (binding) => pingPongs.has(binding.resourceId) || externals.pingPongs.has(binding.resourceId),
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
        (binding) => pingPongs.has(binding.resourceId) || externals.pingPongs.has(binding.resourceId),
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

  if (diagnostics.length > 0) throw new ResourceBuildError(diagnostics);

  return {
    targets,
    pingPongs,
    samplers,
    buffers,
    bufferPairs,
    effects,
    passUniforms,
    shared,
    dynamicTextures,
    renderTargets,
  };
}

interface SetBagContext {
  readonly gpu: Gpu;
  readonly readTexture: (resourceId: string) => unknown;
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
    const texture = ctx.readTexture(binding.resourceId);
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
