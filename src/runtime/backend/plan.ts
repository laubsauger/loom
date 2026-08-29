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
 * Point storage is structure-of-arrays — one buffer per attribute — so an operator binds
 * only the attributes it touches, and WGSL struct alignment stops being a source of bugs.
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

export type ResourceDescriptor =
  | TargetResourceDescriptor
  | PingPongResourceDescriptor
  | SamplerResourceDescriptor
  | BufferResourceDescriptor
  | BufferPairResourceDescriptor;

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
}

export interface SamplerBindingDescriptor {
  readonly binding: string;
  readonly resourceId: string;
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
  readonly buffers?: ReadonlyArray<{ readonly binding: string; readonly resourceId: string }>;
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
  readonly buffers?: ReadonlyArray<{ readonly binding: string; readonly resourceId: string }>;
  readonly textures?: ReadonlyArray<TextureBindingDescriptor>;
  /** Per-pass uniform values (sprite size, tint). Values only, never structure (§V5). */
  readonly uniforms?: UniformValues;
  readonly uniformBinding?: string;
  /** Binding name of the shared frame block, when the shader declares it. */
  readonly sharedBinding?: string;
  /** Blend applied to the color target. Sprites usually want "additive" or "alpha". */
  readonly blend?: "alpha" | "additive" | "premultiplied";
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
    const { binding, resourceId, sampled } = entry;
    if (typeof binding !== "string" || typeof resourceId !== "string") return undefined;
    if (sampled !== undefined && sampled !== "filtered" && sampled !== "unfiltered") return undefined;
    out.push(sampled === undefined ? { binding, resourceId } : { binding, resourceId, sampled });
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
    return kind === "target"
      ? { kind: "target", ...withLabel }
      : { kind: "pingPong", ...withLabel };
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

function readBufferBindings(
  value: unknown,
): ReadonlyArray<{ binding: string; resourceId: string }> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ binding: string; resourceId: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const { binding, resourceId } = entry;
    if (typeof binding !== "string" || typeof resourceId !== "string") return undefined;
    out.push({ binding, resourceId });
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

  const ok = diagnostics.every((diagnostic) => diagnostic.severity !== "error");
  return { resources, passes, diagnostics, ok };
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
    case "pingPong":
      return JSON.stringify([resource.kind, resource.id, resource.size[0], resource.size[1], resource.format]);
    case "buffer":
      return JSON.stringify([resource.kind, resource.id, resource.stride, resource.capacity, resource.usage]);
    case "bufferPair":
      return JSON.stringify([resource.kind, resource.id, resource.stride, resource.capacity]);
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
      case "effect":
        return [
          "effect",
          pass.id,
          pass.shader,
          pass.target,
          pass.clear ?? true,
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered"]),
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
          (pass.buffers ?? []).map((b) => [b.binding, b.resourceId]),
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered"]),
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
          (pass.buffers ?? []).map((b) => [b.binding, b.resourceId]),
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId, t.sampled ?? "filtered"]),
          Object.keys(pass.uniforms ?? {}).sort(),
          pass.uniformBinding ?? null,
          pass.sharedBinding ?? null,
          pass.blend ?? null,
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
    if (resource.kind !== "target" && resource.kind !== "pingPong") continue;
    const bytesPerPixel = BYTES_PER_PIXEL[resource.format] ?? 4;
    total += resource.size[0] * resource.size[1] * bytesPerPixel * (resource.kind === "pingPong" ? 2 : 1);
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
