import type { NodeFormatOverride, NodeResolutionOverride } from "@domain/types/graph.ts";
import { RESOLUTION_SCALE_PRESETS } from "@domain/types/graph.ts";
import type {
  FormatPolicy,
  ResolutionPolicy,
  SelectableColorFormat,
  TextureFormat,
} from "@domain/types/node-definition.ts";
import { SELECTABLE_COLOR_FORMATS } from "@domain/types/node-definition.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";

/**
 * The Common section's value logic (T73, §V50, §V51) — TouchDesigner's Common page.
 *
 * ## T1064 — this file used to answer the question itself, and it answered it wrong
 *
 * Until now the module carried a SECOND implementation of the compiler's precedence
 * ladder — `resolveNodeSize` / `resolveNodeFormat` and ~180 lines of arithmetic under
 * them — so that the panel could show a size before anything was compiled. Two copies of
 * one rule is two answers, and both of the ways they diverged were user-visible:
 *
 *  1. THE SIZE WAS WRONG ON EVERY DEVICE BELOW THE PROJECT CAP. The caller passed the
 *     project cap alone while `compiler/resolution.ts` clamps to
 *     `min(project, capabilities.maxTextureDimension2D)`, so a 2048-limit device read a
 *     size no node on it ever has. `a388cda` restored the second half of that `min` as a
 *     stopgap; the `min` is gone now, along with the ladder it was patching.
 *  2. THE FORMAT WAS WRONG WHENEVER IT FELL BACK. The mirror flagged the requested format
 *     `unsupported` while returning it unchanged; the plan carries the `FORMAT_FALLBACKS`
 *     substitute the node actually renders into. Reproducing that here needed the
 *     depth-vs-colour split (§B1), the fallback chain and the no-fallback placeholder
 *     (§B2) — about twenty-five more lines of mirror to fix a mirror.
 *
 * So the panel now READS. `resolvedCommonFor` takes the node's own row out of the
 * compiled plan and reports the numbers the GPU was asked for, and the only thing still
 * derived here is the human SOURCE LABEL — which is precedence, not arithmetic, and
 * cannot disagree with a pixel.
 *
 * What is left is therefore three things and no fourth: the source labels, the select
 * options, and the overrides those selects WRITE. Nothing in this file computes a size.
 */

export interface InputResolution {
  portId: PortId;
  label: string;
  /** Resolved size of whatever is connected, when the caller knows it. */
  size?: { width: number; height: number };
  format?: TextureFormat;
  connected?: boolean;
}

export interface ResolutionContext {
  /**
   * The project size. NOT an answer any more — the plan is. This is the SEED the Custom /
   * Fit / Limit boxes start from when the node has no row in the plan at all (pruned,
   * inside a component, or nothing compiled yet), so choosing a mode never writes a zero.
   */
  project: { width: number; height: number };
  /** Inputs in manifest order — index 0 is the implicit "the input" for scale/inherit. */
  inputs?: readonly InputResolution[];
  /** §V24 editing bound on either dimension: `min(project cap, device cap)`. */
  maxResolution?: number;
}

export interface ResolvedSize {
  width: number;
  height: number;
  /** Human-readable account of where the size came from. Shown next to the numbers. */
  source: string;
  /** True when the limit in force reduced the requested size (§V24). */
  clamped: boolean;
}

const MIN_DIMENSION = 1;

function labelOfInput(
  inputs: readonly InputResolution[],
  portId: PortId | undefined,
): { label: string; resolved: boolean } {
  const input = portId === undefined ? inputs[0] : inputs.find((entry) => entry.portId === portId);
  return {
    label: input?.label ?? portId ?? "input",
    // The input's OWN size, itself read off the plan by the caller. Absent means the
    // compiler has not reported one — not connected, or not compiled.
    resolved: input?.size !== undefined,
  };
}

/**
 * Which level decided the size, in words. PRECEDENCE ONLY (§V50) — an override that is
 * not `auto` wins, else the definition's policy, else the project — and deliberately not
 * a pixel: the numbers beside this label come from the plan, so a label that disagreed
 * with them would be visibly wrong rather than quietly wrong.
 */
export function resolutionSourceLabel(
  override: NodeResolutionOverride | undefined,
  policy: ResolutionPolicy | undefined,
  inputs: readonly InputResolution[],
): string {
  if (override === undefined || override.mode === "auto") {
    if (policy === undefined) return "node default · project";
    switch (policy.kind) {
      case "project":
        return "node default · project";
      case "fixed":
        return "node default · fixed";
      case "inherit": {
        const input = labelOfInput(inputs, policy.input);
        return input.resolved ? `node default · from ${input.label}` : "node default · input unresolved";
      }
      case "scale": {
        const input = labelOfInput(inputs, policy.input);
        return `node default · ${policy.factor}× ${input.label}`;
      }
      case "custom":
        return "node default · node-computed";
      default: {
        const never: never = policy;
        void never;
        return "node default · project";
      }
    }
  }

  switch (override.mode) {
    case "project":
      return "project";
    case "input": {
      const input = labelOfInput(inputs, override.input);
      return input.resolved ? `from ${input.label}` : "input unresolved";
    }
    case "scale": {
      const input = labelOfInput(inputs, override.input);
      const factor = scaleLabel(override.factor) ?? `${override.factor}×`;
      return input.resolved ? `${factor} of ${input.label}` : `${factor} of project`;
    }
    case "fixed":
      return "custom";
    case "fit": {
      const input = labelOfInput(inputs, override.input);
      return input.resolved
        ? `fit ${override.width}×${override.height} of ${input.label}`
        : "input unresolved";
    }
    case "limit": {
      /*
       * "limited to" vs "within" — which of the two it was — is the one label that needed
       * arithmetic to choose, and it is exactly the thing the numbers next to it already
       * say. The box is named; whether it bit is visible.
       */
      const input = labelOfInput(inputs, override.input);
      return input.resolved ? `limit ${override.width}×${override.height}` : "input unresolved";
    }
    default: {
      const never: never = override;
      void never;
      return "project";
    }
  }
}

// ---- mode <-> select option --------------------------------------------

export type ResolutionModeKey = string;

export const RESOLUTION_MODE_AUTO = "auto";
export const RESOLUTION_MODE_PROJECT = "project";
export const RESOLUTION_MODE_INPUT = "input";
export const RESOLUTION_MODE_CUSTOM = "custom";
export const RESOLUTION_MODE_FIT = "fit";
export const RESOLUTION_MODE_LIMIT = "limit";

const scalePresets = RESOLUTION_SCALE_PRESETS;

function scaleLabel(factor: number): string | null {
  return scalePresets.find((preset) => preset.factor === factor)?.label ?? null;
}

export interface ResolutionModeOption {
  value: ResolutionModeKey;
  label: string;
}

/** The TD Common page's list, in its order: auto, project, input, 1/8…8x, custom. */
export const RESOLUTION_MODE_OPTIONS: readonly ResolutionModeOption[] = [
  { value: RESOLUTION_MODE_AUTO, label: "Auto (node default)" },
  { value: RESOLUTION_MODE_PROJECT, label: "Project" },
  { value: RESOLUTION_MODE_INPUT, label: "Use input" },
  ...scalePresets.map((preset) => ({ value: `scale:${preset.label}`, label: preset.label })),
  { value: RESOLUTION_MODE_FIT, label: "Fit resolution" },
  { value: RESOLUTION_MODE_LIMIT, label: "Limit resolution" },
  { value: RESOLUTION_MODE_CUSTOM, label: "Custom" },
];

export function resolutionModeKey(override: NodeResolutionOverride | undefined): ResolutionModeKey {
  if (override === undefined) return RESOLUTION_MODE_AUTO;
  switch (override.mode) {
    case "auto":
      return RESOLUTION_MODE_AUTO;
    case "project":
      return RESOLUTION_MODE_PROJECT;
    case "input":
      return RESOLUTION_MODE_INPUT;
    case "scale": {
      const label = scaleLabel(override.factor);
      // A factor with no preset is still a scale; the select shows the nearest concept.
      return label === null ? RESOLUTION_MODE_CUSTOM : `scale:${label}`;
    }
    case "fixed":
      return RESOLUTION_MODE_CUSTOM;
    case "fit":
      return RESOLUTION_MODE_FIT;
    case "limit":
      return RESOLUTION_MODE_LIMIT;
    default: {
      const never: never = override;
      void never;
      return RESOLUTION_MODE_AUTO;
    }
  }
}

/**
 * The override a chosen mode produces — or `null`, which is how "Auto" is expressed:
 * `node.setResolution` with `null` DELETES the override so the node goes back to its
 * definition's policy (§V50). Writing `{mode:"auto"}` would leave instance state behind
 * that says the same thing, and a later change to the definition would be ignored.
 */
export function overrideForResolutionMode(
  key: ResolutionModeKey,
  current: { width: number; height: number },
  inputPortId?: PortId,
): NodeResolutionOverride | null {
  if (key === RESOLUTION_MODE_AUTO) return null;
  if (key === RESOLUTION_MODE_PROJECT) return { mode: "project" };
  if (key === RESOLUTION_MODE_INPUT) {
    return inputPortId === undefined ? { mode: "input" } : { mode: "input", input: inputPortId };
  }
  if (key === RESOLUTION_MODE_CUSTOM) {
    // Seeded with the size the node has right now, so choosing "custom" never moves it.
    return {
      mode: "fixed",
      width: Math.max(MIN_DIMENSION, Math.round(current.width)),
      height: Math.max(MIN_DIMENSION, Math.round(current.height)),
    };
  }
  if (key === RESOLUTION_MODE_FIT || key === RESOLUTION_MODE_LIMIT) {
    // Seeded from the current size so switching modes never moves the node, matching
    // how "custom" behaves. Both carry a box the user then edits.
    const box = {
      width: Math.max(MIN_DIMENSION, Math.round(current.width)),
      height: Math.max(MIN_DIMENSION, Math.round(current.height)),
    };
    const mode = key === RESOLUTION_MODE_FIT ? ("fit" as const) : ("limit" as const);
    return inputPortId === undefined ? { mode, ...box } : { mode, ...box, input: inputPortId };
  }
  if (key.startsWith("scale:")) {
    const label = key.slice("scale:".length);
    const preset = scalePresets.find((entry) => entry.label === label);
    if (preset === undefined) return null;
    return inputPortId === undefined
      ? { mode: "scale", factor: preset.factor }
      : { mode: "scale", factor: preset.factor, input: inputPortId };
  }
  return null;
}

// ---- format (§V51) ------------------------------------------------------

export interface FormatContext {
  inputs?: readonly InputResolution[];
  /**
   * Formats the device reports (§V12). Undefined = capability report not read yet. Used
   * ONLY to mark unreachable entries in the Format chooser — never to decide what a node
   * got, which is the plan's answer and already carries the fallback.
   */
  supported?: readonly TextureFormat[];
}

export interface ResolvedFormat {
  /** The format the node renders into — the plan's, so already past every fallback. */
  format: TextureFormat;
  source: string;
}

/**
 * Which level decided the format, in words (§V51). Precedence only, exactly as
 * `resolutionSourceLabel` — the format beside it is the plan's.
 *
 * There is deliberately no `supported` flag here any more. The old one was computed from
 * the REQUESTED format and shown next to it, so a node whose `rgba16float` had already
 * been substituted read "rgba16float (unsupported)" — naming a format it was not using
 * and a problem the compiler had already solved. What the user needs instead is the
 * compiler's own `format-unsupported` warning, which names the substitute; that is what
 * `formatDiagnosticsFor` below surfaces, and it is the only claim about support the panel
 * makes.
 */
export function formatSourceLabel(
  override: NodeFormatOverride | undefined,
  policy: FormatPolicy | undefined,
  inputs: readonly InputResolution[],
): string {
  const fromInput = (portId: PortId | undefined): { label: string; resolved: boolean } => {
    const input = portId === undefined ? inputs[0] : inputs.find((entry) => entry.portId === portId);
    return { label: input?.label ?? portId ?? "input", resolved: input?.format !== undefined };
  };

  if (override === undefined || override.mode === "auto") {
    if (policy === undefined) return "node default · project";
    switch (policy.kind) {
      case "project":
        return "node default · project";
      case "fixed":
        return "node default · fixed";
      case "inherit": {
        const input = fromInput(policy.input);
        return input.resolved ? `node default · from ${input.label}` : "node default · input unresolved";
      }
      default: {
        const never: never = policy;
        void never;
        return "node default · project";
      }
    }
  }
  switch (override.mode) {
    case "project":
      return "project";
    case "input": {
      const input = fromInput(override.input);
      return input.resolved ? `from ${input.label}` : "input unresolved";
    }
    case "fixed":
      return "fixed";
    default: {
      const never: never = override;
      void never;
      return "project";
    }
  }
}

/**
 * One materialized output row, as the plan carries it. Structurally satisfied by the
 * compiler's `ResolvedOutput` without this module importing it — the panel needs two of
 * its fields and has no business knowing the other eleven.
 */
export interface PlannedOutput {
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
}

export interface ResolvedCommon {
  readonly size: ResolvedSize;
  readonly format: ResolvedFormat;
}

export interface ResolvedCommonRequest {
  readonly nodeId: NodeId;
  /**
   * The node's own row in the compiled plan, or `undefined` when it has none: pruned to a
   * dead branch (§V25), inside a component the pane dived into, or nothing compiled yet.
   */
  readonly planned: PlannedOutput | undefined;
  readonly resolution: NodeResolutionOverride | undefined;
  readonly format: NodeFormatOverride | undefined;
  readonly resolutionPolicy: ResolutionPolicy | undefined;
  readonly formatPolicy: FormatPolicy | undefined;
  readonly inputs: readonly InputResolution[];
  /** The compile's own diagnostics; `clamped` is read from them, never re-derived. */
  readonly diagnostics: readonly RuntimeDiagnostic[] | undefined;
}

const RESOLUTION_CLAMPED = "compiler/resolution-clamped";

/**
 * The size and format this node ACTUALLY got, read off the plan.
 *
 * `null` when the plan has no row for the node. That state used to be unreachable, because
 * the mirror always had an arithmetic answer to give — which is precisely how it managed
 * to print a confident number for a node that does not exist on the GPU. A caller that
 * gets `null` must say so rather than substitute one.
 */
export function resolvedCommonFor(request: ResolvedCommonRequest): ResolvedCommon | null {
  const { planned } = request;
  if (planned === undefined) return null;
  const clamped = (request.diagnostics ?? []).some(
    (diagnostic) => diagnostic.nodeId === request.nodeId && diagnostic.code === RESOLUTION_CLAMPED,
  );
  return {
    size: {
      width: planned.size[0],
      height: planned.size[1],
      source: resolutionSourceLabel(request.resolution, request.resolutionPolicy, request.inputs),
      clamped,
    },
    format: {
      format: planned.format,
      source: formatSourceLabel(request.format, request.formatPolicy, request.inputs),
    },
  };
}

export const FORMAT_MODE_AUTO = "auto";
export const FORMAT_MODE_PROJECT = "project";
export const FORMAT_MODE_INPUT = "input";

export interface FormatModeOption {
  value: string;
  label: string;
  /** Set when the capability report does not list this format (§V12). */
  disabled?: boolean;
}

/** Depth is never offered: it is not a colour output (§V51). */
export function formatModeOptions(supported?: readonly TextureFormat[]): FormatModeOption[] {
  return [
    { value: FORMAT_MODE_AUTO, label: "Auto (node default)" },
    { value: FORMAT_MODE_PROJECT, label: "Project" },
    { value: FORMAT_MODE_INPUT, label: "Use input" },
    ...SELECTABLE_COLOR_FORMATS.map((format) => ({
      value: format,
      label: supported !== undefined && !supported.includes(format) ? `${format} (unsupported)` : format,
    })),
  ];
}

export function formatModeKey(override: NodeFormatOverride | undefined): string {
  if (override === undefined) return FORMAT_MODE_AUTO;
  switch (override.mode) {
    case "auto":
      return FORMAT_MODE_AUTO;
    case "project":
      return FORMAT_MODE_PROJECT;
    case "input":
      return FORMAT_MODE_INPUT;
    case "fixed":
      return override.format;
    default: {
      const never: never = override;
      void never;
      return FORMAT_MODE_AUTO;
    }
  }
}

function isSelectableFormat(value: string): value is SelectableColorFormat {
  return (SELECTABLE_COLOR_FORMATS as readonly string[]).includes(value);
}

/** `null` clears the override back to the definition's `formatPolicy` (§V51). */
export function overrideForFormatMode(
  key: string,
  inputPortId?: PortId,
): NodeFormatOverride | null {
  if (key === FORMAT_MODE_AUTO) return null;
  if (key === FORMAT_MODE_PROJECT) return { mode: "project" };
  if (key === FORMAT_MODE_INPUT) {
    return inputPortId === undefined ? { mode: "input" } : { mode: "input", input: inputPortId };
  }
  if (isSelectableFormat(key)) return { mode: "fixed", format: key };
  return null;
}

/**
 * Surfaces the compiler's own format diagnostics for a node (§V51: "unsupported →
 * diagnostic + documented fallback"). The fallback decision belongs to the compiler —
 * this only finds what it said, so the two can never disagree.
 */
export function formatDiagnosticsFor(
  nodeId: NodeId,
  diagnostics: readonly RuntimeDiagnostic[] | undefined,
): RuntimeDiagnostic[] {
  if (diagnostics === undefined) return [];
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.nodeId === nodeId &&
      diagnostic.severity !== "info" &&
      diagnostic.code.toLowerCase().includes("format"),
  );
}
