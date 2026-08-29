import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { NodeFormatOverride, ProjectSettings } from "../domain/types/graph.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { FormatPolicy, TextureFormat } from "../domain/types/node-definition.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * Format propagation (T28, T75, §V21, §V12, §V51).
 *
 * Same precedence as resolution — instance override, then definition policy, then the
 * project working format — with two extra rules that resolution does not need:
 *
 *  - a depth format is never legal on a colour output;
 *  - the result is validated against the capability report, and an unsupported format
 *    falls back along a documented chain WITH a warning. Never a crash, and never a
 *    silent swap: substituting rgba8unorm for rgba16float changes the user's colour
 *    maths, so they have to be told it happened.
 */

export type FormatSource = "override" | "policy" | "default";

const DEPTH_FORMATS: ReadonlyArray<TextureFormat> = ["depth24plus"];

/**
 * Documented fallback order, most-similar first. Precision is preferred over range, and
 * an 8-bit substitute is the last colour resort before giving up on the request.
 */
const FORMAT_FALLBACKS: Readonly<Record<TextureFormat, ReadonlyArray<TextureFormat>>> = {
  rgba16float: ["rgba8unorm", "rgba8unorm-srgb"],
  rgba8unorm: ["rgba16float", "rgba8unorm-srgb"],
  "rgba8unorm-srgb": ["rgba8unorm", "rgba16float"],
  r32float: ["rgba16float", "rgba8unorm"],
  depth24plus: [],
};

export function isDepthFormat(format: TextureFormat): boolean {
  return DEPTH_FORMATS.includes(format);
}

export interface FormatInputs {
  readonly byPort: Readonly<Record<PortId, TextureFormat | undefined>>;
  readonly primaryPort: PortId | undefined;
}

export interface FormatRequest {
  readonly nodeId: NodeId;
  readonly nodeType: string;
  readonly override: NodeFormatOverride | undefined;
  readonly policy: FormatPolicy | undefined;
  readonly inputs: FormatInputs;
  readonly settings: ProjectSettings;
  readonly capabilities: BackendCapabilities;
  /** True when at least one declared output samples as depth — only then is depth legal. */
  readonly allowsDepth: boolean;
}

export interface FormatOutcome {
  readonly format: TextureFormat;
  /** What precedence asked for, before any fallback. */
  readonly requested: TextureFormat;
  readonly source: FormatSource;
  readonly fellBack: boolean;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

export function resolveNodeFormat(request: FormatRequest): FormatOutcome {
  const { nodeId, nodeType, override, policy, inputs, settings, capabilities, allowsDepth } = request;
  const diagnostics: RuntimeDiagnostic[] = [];
  const project = settings.workingFormat;

  const inputFormat = (portId: PortId | undefined): TextureFormat => {
    const chosen = portId ?? inputs.primaryPort;
    const format = chosen === undefined ? undefined : inputs.byPort[chosen];
    if (format !== undefined) return format;
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.formatInputMissing,
        `Node "${nodeId}" (${nodeType}) takes its format from input "${chosen ?? "(primary)"}", but nothing is connected there; the project working format is used instead.`,
        {
          nodeId,
          ...(chosen === undefined ? {} : { portId: chosen }),
          suggestion: "Connect the input, or set an explicit format on the node.",
        },
      ),
    );
    return project;
  };

  let source: FormatSource;
  let requested: TextureFormat;

  if (override !== undefined && override.mode !== "auto") {
    source = "override";
    switch (override.mode) {
      case "project":
        requested = project;
        break;
      case "input":
        requested = inputFormat(override.input);
        break;
      case "fixed":
        requested = override.format;
        break;
    }
  } else if (policy !== undefined) {
    source = "policy";
    switch (policy.kind) {
      case "inherit":
        requested = inputFormat(policy.input);
        break;
      case "fixed":
        requested = policy.format;
        break;
      case "project":
        requested = project;
        break;
    }
  } else {
    source = "default";
    const primary = inputs.primaryPort === undefined ? undefined : inputs.byPort[inputs.primaryPort];
    requested = primary ?? project;
  }

  let format = requested;

  // §V51: depth is not a colour output. Reject rather than render something the user's
  // shader cannot sample the way it expects.
  if (isDepthFormat(format) && !allowsDepth) {
    const replacement = isDepthFormat(project) ? "rgba16float" : project;
    diagnostics.push(
      compilerDiagnostic(
        "error",
        CompilerDiagnosticCode.formatDepthOnColor,
        `Node "${nodeId}" (${nodeType}) resolved to depth format "${format}" on a colour output; "${replacement}" was used instead.`,
        { nodeId, suggestion: "Depth formats are only valid on an output declared as a depth texture (§V51)." },
      ),
    );
    format = replacement;
  }

  // §V12: a format is used only after the capability report says the device has it.
  const supported = capabilities.formats;
  if (!supported.includes(format)) {
    // B1 (T158): a depth output may only ever fall back to another DEPTH format. A
    // colour substitute would let a depth output silently become colour — the user's
    // depth-sampling shader is then wrong in a way no warning label makes acceptable.
    const chain = isDepthFormat(format)
      ? DEPTH_FORMATS.filter((option) => option !== format)
      : (FORMAT_FALLBACKS[format] ?? []);
    const candidate =
      chain.find((option) => supported.includes(option)) ??
      (isDepthFormat(format)
        ? undefined
        : supported.find((option) => !isDepthFormat(option)));
    if (candidate === undefined) {
      // B2 (T158): the plan must never carry a format the device cannot allocate. The
      // error already rejects the plan (§V9 keeps the last good one); the placeholder
      // only exists so downstream propagation has something allocatable to reason
      // about, and the diagnostic says so.
      const placeholder = supported.find((option) => !isDepthFormat(option)) ?? project;
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.formatNoFallback,
          `Node "${nodeId}" (${nodeType}) needs "${format}", which this device does not support, and no acceptable fallback exists. The plan is rejected; "${placeholder}" stands in during propagation only.`,
          { nodeId, suggestion: isDepthFormat(format) ? "A depth output cannot fall back to a colour format (§V51)." : "Pick a format this device supports (§V51)." },
        ),
      );
      return { format: placeholder, requested, source, fellBack: true, diagnostics };
    }
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.formatUnsupported,
        `Node "${nodeId}" (${nodeType}) asked for "${format}", which this device does not support; "${candidate}" was used instead.`,
        {
          nodeId,
          suggestion: `Colour maths differs between "${format}" and "${candidate}" — set the node's format explicitly if the difference matters (§V51).`,
        },
      ),
    );
    return { format: candidate, requested, source, fellBack: true, diagnostics };
  }

  return { format, requested, source, fellBack: format !== requested, diagnostics };
}
