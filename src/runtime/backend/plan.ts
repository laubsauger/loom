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

export type ResourceDescriptor =
  | TargetResourceDescriptor
  | PingPongResourceDescriptor
  | SamplerResourceDescriptor;

export interface TextureBindingDescriptor {
  /** WGSL binding name in the pass shader. */
  readonly binding: string;
  /** Id of a `target` or `pingPong` resource. A ping-pong binds its read half. */
  readonly resourceId: string;
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

export type PassDescriptor = EffectPassDescriptor | SwapPassDescriptor;

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
    const { binding, resourceId } = entry;
    if (typeof binding !== "string" || typeof resourceId !== "string") return undefined;
    out.push({ binding, resourceId });
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

  // Reference integrity: every id a pass names must exist.
  for (const pass of passes) {
    const referenced =
      pass.kind === "swap"
        ? [pass.resourceId]
        : [pass.target, ...(pass.textures ?? []).map((t) => t.resourceId), ...(pass.samplers ?? []).map((s) => s.resourceId)];
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
export function planStructureSignature(
  resources: ReadonlyArray<ResourceDescriptor>,
  passes: ReadonlyArray<PassDescriptor>,
): string {
  const resourceKeys = resources.map((resource) =>
    resource.kind === "sampler"
      ? ["sampler", resource.id, resource.filter ?? "nearest", resource.addressMode ?? "clamp-to-edge"]
      : [resource.kind, resource.id, resource.size[0], resource.size[1], resource.format],
  );

  const passKeys = passes.map((pass) =>
    pass.kind === "swap"
      ? ["swap", pass.id, pass.resourceId]
      : [
          "effect",
          pass.id,
          pass.shader,
          pass.target,
          pass.clear ?? true,
          (pass.textures ?? []).map((t) => [t.binding, t.resourceId]),
          (pass.samplers ?? []).map((s) => [s.binding, s.resourceId]),
          pass.uniformBinding ?? null,
          // Names, never values.
          Object.keys(pass.uniforms ?? {}).sort(),
          pass.sharedBinding ?? null,
        ],
  );

  return JSON.stringify({ resourceKeys, passKeys });
}

/** Uniform values a plan carries, keyed by pass id. Extracted after the signature is taken. */
export function planUniformValues(
  passes: ReadonlyArray<PassDescriptor>,
): ReadonlyMap<string, UniformValues> {
  const out = new Map<string, UniformValues>();
  for (const pass of passes) {
    if (pass.kind === "effect" && pass.uniforms) out.set(pass.id, pass.uniforms);
  }
  return out;
}
