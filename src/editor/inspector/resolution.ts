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
 * Pure, and separated from the component for one reason: the section's whole job is to
 * show the user the size and format they will actually get, and "which pixels does
 * 1/2 give me" is a claim worth testing. The compiler owns the authoritative
 * propagation at compile time (§V21, T72/T75); this mirrors it for display only and
 * never writes anything.
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
  project: { width: number; height: number };
  /** Inputs in manifest order — index 0 is the implicit "the input" for scale/inherit. */
  inputs?: readonly InputResolution[];
  /** §V24 project cap on either dimension. */
  maxResolution?: number;
}

export interface ResolvedSize {
  width: number;
  height: number;
  /** Human-readable account of where the size came from. Shown next to the numbers. */
  source: string;
  /** True when the project limit reduced the requested size (§V24). */
  clamped: boolean;
}

const MIN_DIMENSION = 1;

function findInput(
  context: ResolutionContext,
  portId: PortId | undefined,
): InputResolution | undefined {
  const inputs = context.inputs ?? [];
  if (portId === undefined) return inputs[0];
  return inputs.find((input) => input.portId === portId);
}

function sizeOfInput(
  context: ResolutionContext,
  portId: PortId | undefined,
): { size: { width: number; height: number }; label: string; resolved: boolean } {
  const input = findInput(context, portId);
  const label = input?.label ?? portId ?? "input";
  if (input?.size === undefined) {
    // Not connected, or the compiler has not reported a size yet. Falling back to the
    // project size is what the propagation does too — say so rather than show nothing.
    return { size: context.project, label, resolved: false };
  }
  return { size: input.size, label, resolved: true };
}

function finish(
  size: { width: number; height: number },
  source: string,
  context: ResolutionContext,
): ResolvedSize {
  const cap = context.maxResolution;
  const round = (value: number): number =>
    Math.max(MIN_DIMENSION, Math.round(Number.isFinite(value) ? value : MIN_DIMENSION));
  let width = round(size.width);
  let height = round(size.height);
  let clamped = false;
  if (cap !== undefined && Number.isFinite(cap) && cap >= MIN_DIMENSION) {
    if (width > cap || height > cap) {
      clamped = true;
      width = Math.min(width, cap);
      height = Math.min(height, cap);
    }
  }
  return { width, height, source, clamped };
}

/** The definition's own policy — what "auto" means for this node (§V50). */
export function resolveFromPolicy(
  policy: ResolutionPolicy | undefined,
  context: ResolutionContext,
): ResolvedSize {
  if (policy === undefined) return finish(context.project, "node default · project", context);
  switch (policy.kind) {
    case "project":
      return finish(context.project, "node default · project", context);
    case "fixed":
      return finish({ width: policy.width, height: policy.height }, "node default · fixed", context);
    case "inherit": {
      const input = sizeOfInput(context, policy.input);
      return finish(
        input.size,
        input.resolved ? `node default · from ${input.label}` : "node default · input unresolved",
        context,
      );
    }
    case "scale": {
      const input = sizeOfInput(context, policy.input);
      return finish(
        { width: input.size.width * policy.factor, height: input.size.height * policy.factor },
        `node default · ${policy.factor}× ${input.label}`,
        context,
      );
    }
    case "custom":
      return finish(context.project, "node default · node-computed", context);
    default: {
      const never: never = policy;
      void never;
      return finish(context.project, "project", context);
    }
  }
}

/**
 * The size the node's output will actually be. An absent override, or `{mode:"auto"}`,
 * defers to the definition's policy — that is the default and the untouched state.
 */
export function resolveNodeSize(
  override: NodeResolutionOverride | undefined,
  policy: ResolutionPolicy | undefined,
  context: ResolutionContext,
): ResolvedSize {
  if (override === undefined || override.mode === "auto") return resolveFromPolicy(policy, context);

  switch (override.mode) {
    case "project":
      return finish(context.project, "project", context);
    case "input": {
      const input = sizeOfInput(context, override.input);
      return finish(input.size, input.resolved ? `from ${input.label}` : "input unresolved", context);
    }
    case "scale": {
      const input = sizeOfInput(context, override.input);
      const label = scaleLabel(override.factor) ?? `${override.factor}×`;
      return finish(
        { width: input.size.width * override.factor, height: input.size.height * override.factor },
        input.resolved ? `${label} of ${input.label}` : `${label} of project`,
        context,
      );
    }
    case "fixed":
      return finish({ width: override.width, height: override.height }, "custom", context);
    default: {
      const never: never = override;
      void never;
      return finish(context.project, "project", context);
    }
  }
}

// ---- mode <-> select option --------------------------------------------

export type ResolutionModeKey = string;

export const RESOLUTION_MODE_AUTO = "auto";
export const RESOLUTION_MODE_PROJECT = "project";
export const RESOLUTION_MODE_INPUT = "input";
export const RESOLUTION_MODE_CUSTOM = "custom";

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
  projectFormat: TextureFormat;
  inputs?: readonly InputResolution[];
  /** Formats the device reports (§V12). Undefined = capability report not read yet. */
  supported?: readonly TextureFormat[];
}

export interface ResolvedFormat {
  format: TextureFormat;
  source: string;
  /** False only when a capability report is present and does not list the format. */
  supported: boolean;
}

function formatOfInput(context: FormatContext, portId: PortId | undefined): ResolvedFormat | null {
  const inputs = context.inputs ?? [];
  const input = portId === undefined ? inputs[0] : inputs.find((entry) => entry.portId === portId);
  if (input?.format === undefined) return null;
  return { format: input.format, source: `from ${input.label}`, supported: true };
}

function withSupport(resolved: ResolvedFormat, context: FormatContext): ResolvedFormat {
  const supported = context.supported;
  if (supported === undefined) return resolved;
  return { ...resolved, supported: supported.includes(resolved.format) };
}

export function resolveFormatFromPolicy(
  policy: FormatPolicy | undefined,
  context: FormatContext,
): ResolvedFormat {
  if (policy === undefined) {
    return withSupport(
      { format: context.projectFormat, source: "node default · project", supported: true },
      context,
    );
  }
  switch (policy.kind) {
    case "project":
      return withSupport(
        { format: context.projectFormat, source: "node default · project", supported: true },
        context,
      );
    case "fixed":
      return withSupport(
        { format: policy.format, source: "node default · fixed", supported: true },
        context,
      );
    case "inherit": {
      const inherited = formatOfInput(context, policy.input);
      return withSupport(
        inherited === null
          ? { format: context.projectFormat, source: "node default · input unresolved", supported: true }
          : { ...inherited, source: `node default · ${inherited.source}` },
        context,
      );
    }
    default: {
      const never: never = policy;
      void never;
      return withSupport(
        { format: context.projectFormat, source: "project", supported: true },
        context,
      );
    }
  }
}

export function resolveNodeFormat(
  override: NodeFormatOverride | undefined,
  policy: FormatPolicy | undefined,
  context: FormatContext,
): ResolvedFormat {
  if (override === undefined || override.mode === "auto") {
    return resolveFormatFromPolicy(policy, context);
  }
  switch (override.mode) {
    case "project":
      return withSupport({ format: context.projectFormat, source: "project", supported: true }, context);
    case "input": {
      const inherited = formatOfInput(context, override.input);
      return withSupport(
        inherited ?? { format: context.projectFormat, source: "input unresolved", supported: true },
        context,
      );
    }
    case "fixed":
      return withSupport({ format: override.format, source: "fixed", supported: true }, context);
    default: {
      const never: never = override;
      void never;
      return withSupport({ format: context.projectFormat, source: "project", supported: true }, context);
    }
  }
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
