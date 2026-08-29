import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, ProjectDocument, ProjectSettings } from "../types/graph.ts";
import type { TextureFormat } from "../types/node-definition.ts";

/**
 * Resource caps (T44, §V24).
 *
 * §V24 is enforced in two places for one reason: the compiler checks a PLAN, and a plan
 * only exists after a document has been loaded. A file claiming a 30000 x 30000 output is
 * a hostile input that reaches the device unless someone stops it at the door — so the
 * loader clamps it here, before the graph is ever compiled, and reports every clamp.
 *
 * These are pure functions over plain data. The edit-time path calls the same `check*`
 * functions to refuse a value before it is committed; the load path calls `clampSettings`
 * to salvage a document rather than refuse to open it, because a project the user cannot
 * open is a worse outcome than a project that opens at a smaller resolution and says so.
 */

/**
 * Absolute ceilings, independent of `settings.limits`.
 *
 * `settings.limits` is user data and lives in the file: it can itself be absurd. These are
 * the values above which no project's own limits are believed. `maxResolution` is the
 * WebGPU `maxTextureDimension2D` guarantee ceiling for the baseline tier (§C: Chrome 128
 * desktop, Tier B); `maxDispatch` is the `maxComputeWorkgroupsPerDimension` guarantee.
 * The device's own reported limits are stricter still and are applied by the compiler
 * against the capability report (§V12) — this is the floor under that, not a substitute.
 */
export const HARD_LIMITS = {
  maxResolution: 16_384,
  maxDispatch: 65_535,
  maxBufferBytes: 2_147_483_648,
  memoryBudgetBytes: 17_179_869_184,
} as const satisfies ProjectSettings["limits"];

/** Bytes per texel, matching the compiler/backend estimate so the two never disagree. */
const BYTES_PER_TEXEL: Record<TextureFormat, number> = {
  rgba8unorm: 4,
  "rgba8unorm-srgb": 4,
  rgba16float: 8,
  r32float: 4,
  depth24plus: 4,
};

export function bytesPerTexel(format: TextureFormat): number {
  return BYTES_PER_TEXEL[format] ?? 4;
}

export interface CapCheck {
  ok: boolean;
  /** The value to use: unchanged when `ok`, clamped into range otherwise. */
  value: number;
  diagnostic: RuntimeDiagnostic | null;
}

function capped(
  label: string,
  code: string,
  value: number,
  limit: number,
  unit: string,
): CapCheck {
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      value: Math.min(1, limit),
      diagnostic: {
        severity: "error",
        code,
        message: `${label} must be a positive number; got ${String(value)}.`,
      },
    };
  }
  if (value <= limit) return { ok: true, value, diagnostic: null };
  return {
    ok: false,
    value: limit,
    diagnostic: {
      severity: "error",
      code,
      message: `${label} of ${format(value)}${unit} exceeds the limit of ${format(limit)}${unit}.`,
      suggestion: `Reduced to ${format(limit)}${unit} (§V24).`,
    },
  };
}

/** One dimension of a texture, against `settings.limits.maxResolution`. */
export function checkResolution(
  value: number,
  limits: ProjectSettings["limits"],
  label = "Resolution",
): CapCheck {
  return capped(label, "project.limit.resolution", value, limits.maxResolution, "px");
}

/** One dimension of a compute dispatch, against `settings.limits.maxDispatch`. */
export function checkDispatch(value: number, limits: ProjectSettings["limits"]): CapCheck {
  return capped("Dispatch size", "project.limit.dispatch", value, limits.maxDispatch, " workgroups");
}

/** One buffer allocation, against `settings.limits.maxBufferBytes`. */
export function checkBufferBytes(value: number, limits: ProjectSettings["limits"]): CapCheck {
  return capped("Buffer size", "project.limit.buffer", value, limits.maxBufferBytes, " bytes");
}

export interface ClampedSettings {
  settings: ProjectSettings;
  /** True when anything had to be changed — the document no longer matches the file. */
  clamped: boolean;
  diagnostics: RuntimeDiagnostic[];
}

/**
 * Brings a document's own settings into range: first the limits themselves against
 * `HARD_LIMITS`, then everything the limits govern against the (now sane) limits.
 *
 * Order matters. Checking the output resolution against a `maxResolution` of 10^9 taken
 * from the same untrusted file would pass everything, which is how a cap that exists
 * still lets a device-losing texture through.
 */
export function clampSettings(settings: ProjectSettings): ClampedSettings {
  const diagnostics: RuntimeDiagnostic[] = [];
  let clamped = false;

  const limits = { ...settings.limits };
  for (const key of ["maxResolution", "maxDispatch", "maxBufferBytes", "memoryBudgetBytes"] as const) {
    const check = capped(`Project limit "${key}"`, "project.limit.settings", limits[key], HARD_LIMITS[key], "");
    if (check.diagnostic !== null) diagnostics.push(check.diagnostic);
    if (check.value !== limits[key]) {
      limits[key] = check.value;
      clamped = true;
    }
  }

  const width = checkResolution(settings.outputResolution.width, limits, "Project output width");
  const height = checkResolution(settings.outputResolution.height, limits, "Project output height");
  for (const check of [width, height]) {
    if (check.diagnostic !== null) diagnostics.push(check.diagnostic);
  }
  const outputResolution = { width: width.value, height: height.value };
  if (outputResolution.width !== settings.outputResolution.width) clamped = true;
  if (outputResolution.height !== settings.outputResolution.height) clamped = true;

  const preview = checkResolution(settings.previewLongEdge, limits, "Preview long edge");
  if (preview.diagnostic !== null) {
    diagnostics.push({ ...preview.diagnostic, code: "project.limit.preview" });
  }
  if (preview.value !== settings.previewLongEdge) clamped = true;

  return {
    settings: { ...settings, limits, outputResolution, previewLongEdge: preview.value },
    clamped,
    diagnostics,
  };
}

export interface ClampedGraph {
  graph: GraphDocument;
  clamped: boolean;
  diagnostics: RuntimeDiagnostic[];
}

/**
 * Clamps per-node resolution overrides (§V50: "clamped to project limits").
 *
 * A mode this build does not know is left completely alone — it carries no width and
 * height we could interpret, and inventing a clamp for it would corrupt data written by a
 * build that understood it (§V68).
 */
export function clampNodeResolutions(
  graph: GraphDocument,
  limits: ProjectSettings["limits"],
): ClampedGraph {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodes = { ...graph.nodes };
  let clamped = false;

  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    const resolution = node?.resolution;
    if (node === undefined || resolution === undefined) continue;
    if (resolution.mode !== "fixed" && resolution.mode !== "fit" && resolution.mode !== "limit") continue;

    const name = node.label ?? node.type;
    const width = checkResolution(resolution.width, limits, `"${name}" override width`);
    const height = checkResolution(resolution.height, limits, `"${name}" override height`);
    if (width.ok && height.ok) continue;

    for (const check of [width, height]) {
      if (check.diagnostic !== null) {
        diagnostics.push({ ...check.diagnostic, code: "project.limit.nodeResolution", nodeId });
      }
    }
    nodes[nodeId] = { ...node, resolution: { ...resolution, width: width.value, height: height.value } };
    clamped = true;
  }

  return { graph: clamped ? { ...graph, nodes } : graph, clamped, diagnostics };
}

/**
 * Coarse whole-project texture-memory estimate (§V24 "project memory budget reported").
 *
 * One full-size target per node, at the node's own resolution when it fixes one and the
 * project resolution otherwise. Deliberately an over-estimate of the naive kind: it is
 * computed before compilation, so it knows nothing about pruning (§V25) or reuse (§V6).
 * The authoritative figure is the compiler's `estimatedResourceBytes` over a real plan;
 * this one exists so an obviously unopenable project says so at the door.
 */
export function estimateProjectMemoryBytes(document: ProjectDocument): number {
  const perTexel = bytesPerTexel(document.settings.workingFormat);
  const { width, height } = document.settings.outputResolution;
  let total = 0;
  for (const node of Object.values(document.graph.nodes)) {
    const resolution = node.resolution;
    const fixed =
      resolution !== undefined &&
      (resolution.mode === "fixed" || resolution.mode === "fit" || resolution.mode === "limit")
        ? resolution
        : undefined;
    total += (fixed?.width ?? width) * (fixed?.height ?? height) * perTexel;
  }
  return total;
}

/** Warns when the coarse estimate is already over the project's own budget. */
export function checkMemoryBudget(document: ProjectDocument): RuntimeDiagnostic | null {
  const estimate = estimateProjectMemoryBytes(document);
  const budget = document.settings.limits.memoryBudgetBytes;
  if (estimate <= budget) return null;
  return {
    severity: "warning",
    code: "project.limit.memoryBudget",
    message: `This project's textures are estimated at ${megabytes(estimate)} MB against a budget of ${megabytes(budget)} MB.`,
    suggestion: "Lower the output resolution or raise the project memory budget (§V24).",
  };
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
}
