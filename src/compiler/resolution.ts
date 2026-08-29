import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { NodeResolutionOverride, ProjectSettings } from "../domain/types/graph.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { ResolutionPolicy } from "../domain/types/node-definition.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * Resolution propagation (T27, T72, §V21, §V24, §V50).
 *
 * Resolved once, at compile or resize — never per frame. Precedence is fixed and small:
 *
 *   1. the node instance's own override, unless it is `{mode:"auto"}`;
 *   2. the definition's `resolutionPolicy`;
 *   3. inherit the primary input, or the project resolution when nothing is connected.
 *
 * Whatever comes out is clamped to the project's `limits.maxResolution` (§V24), and the
 * clamp is announced — a silently shrunk image looks like a bug in the user's shader.
 */

export type ResolutionSource = "override" | "policy" | "default";

export interface ResolutionInputs {
  /** Resolved size feeding each input port, or undefined when nothing is connected. */
  readonly byPort: Readonly<Record<PortId, readonly [number, number] | undefined>>;
  /** Port used when a policy or override names none: the first connected input. */
  readonly primaryPort: PortId | undefined;
}

export interface ResolutionRequest {
  readonly nodeId: NodeId;
  readonly nodeType: string;
  readonly override: NodeResolutionOverride | undefined;
  readonly policy: ResolutionPolicy | undefined;
  readonly inputs: ResolutionInputs;
  readonly settings: ProjectSettings;
  /**
   * Device limits, when known. The project cap is a budget the user chose; the device cap
   * is physics. Both are enforced before anything is dispatched (§V24, §V12).
   */
  readonly capabilities?: BackendCapabilities;
}

/** The smaller of the project's own cap and whatever the device reports it can allocate. */
export function effectiveMaxResolution(
  settings: ProjectSettings,
  capabilities: BackendCapabilities | undefined,
): number {
  const deviceMax = capabilities?.limits["maxTextureDimension2D"];
  return deviceMax === undefined || deviceMax <= 0
    ? settings.limits.maxResolution
    : Math.min(settings.limits.maxResolution, deviceMax);
}

export interface ResolutionOutcome {
  readonly size: readonly [number, number];
  readonly source: ResolutionSource;
  readonly clamped: boolean;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

function projectSize(settings: ProjectSettings): readonly [number, number] {
  return [settings.outputResolution.width, settings.outputResolution.height];
}

/** Whole pixels, at least one — a zero-sized target is not a texture. */
function normalize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.round(size[0])), Math.max(1, Math.round(size[1]))];
}

export function resolveNodeResolution(request: ResolutionRequest): ResolutionOutcome {
  const { nodeId, nodeType, override, policy, inputs, settings } = request;
  const diagnostics: RuntimeDiagnostic[] = [];
  const project = projectSize(settings);

  const inputSize = (portId: PortId | undefined, describe: string): readonly [number, number] => {
    const chosen = portId ?? inputs.primaryPort;
    const size = chosen === undefined ? undefined : inputs.byPort[chosen];
    if (size !== undefined) return size;
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.resolutionInputMissing,
        `Node "${nodeId}" (${nodeType}) takes its resolution from ${describe}, but nothing is connected there; the project resolution is used instead.`,
        {
          nodeId,
          ...(chosen === undefined ? {} : { portId: chosen }),
          suggestion: "Connect the input, or set an explicit resolution on the node.",
        },
      ),
    );
    return project;
  };

  let source: ResolutionSource;
  let raw: readonly [number, number];

  if (override !== undefined && override.mode !== "auto") {
    source = "override";
    switch (override.mode) {
      case "project":
        raw = project;
        break;
      case "input":
        raw = inputSize(override.input, `input "${override.input ?? "(primary)"}"`);
        break;
      case "scale": {
        const base = inputSize(override.input, `input "${override.input ?? "(primary)"}"`);
        raw = [base[0] * override.factor, base[1] * override.factor];
        break;
      }
      case "fixed":
        raw = [override.width, override.height];
        break;
      case "fit": {
        // TD "Fit Resolution": largest size inside the box that keeps the input's aspect.
        const base = inputSize(override.input, `input "${override.input ?? "(primary)"}"`);
        const scale = Math.min(override.width / base[0], override.height / base[1]);
        raw = [base[0] * scale, base[1] * scale];
        break;
      }
      case "limit": {
        // TD "Limit Resolution": only shrinks, and only when the input exceeds the box.
        // Aspect is preserved so a limited image is never distorted, just smaller.
        const base = inputSize(override.input, `input "${override.input ?? "(primary)"}"`);
        const scale = Math.min(1, override.width / base[0], override.height / base[1]);
        raw = [base[0] * scale, base[1] * scale];
        break;
      }
    }
  } else if (policy !== undefined) {
    source = "policy";
    switch (policy.kind) {
      case "inherit":
        raw = inputSize(policy.input, `input "${policy.input}"`);
        break;
      case "scale": {
        const base = inputSize(policy.input, `input "${policy.input}"`);
        raw = [base[0] * policy.factor, base[1] * policy.factor];
        break;
      }
      case "fixed":
        raw = [policy.width, policy.height];
        break;
      case "project":
        raw = project;
        break;
      case "custom":
        // The definition computes its own size from state the compiler cannot see. Say so
        // once, and use the project resolution rather than guessing at zero.
        diagnostics.push(
          compilerDiagnostic(
            "info",
            CompilerDiagnosticCode.resolutionCustom,
            `Node "${nodeId}" (${nodeType}) declares a custom resolution policy; the project resolution was used.`,
            { nodeId, suggestion: "Set an explicit resolution on the node to pin its size." },
          ),
        );
        raw = project;
        break;
    }
  } else {
    // No override, no policy: follow the primary input if there is one, else the project.
    source = "default";
    const primary = inputs.primaryPort === undefined ? undefined : inputs.byPort[inputs.primaryPort];
    raw = primary ?? project;
  }

  const rounded = normalize(raw);
  const max = effectiveMaxResolution(settings, request.capabilities);
  const clampedSize: readonly [number, number] = [Math.min(rounded[0], max), Math.min(rounded[1], max)];
  const clamped = clampedSize[0] !== rounded[0] || clampedSize[1] !== rounded[1];

  if (clamped) {
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.resolutionClamped,
        `Node "${nodeId}" (${nodeType}) resolved to ${rounded[0]}x${rounded[1]}, above the ${max}px limit in force; it was clamped to ${clampedSize[0]}x${clampedSize[1]}.`,
        {
          nodeId,
          suggestion:
            "Lower the node's resolution, or raise the project limit — it cannot go above what the device reports (§V24).",
        },
      ),
    );
  }

  return { size: clampedSize, source, clamped, diagnostics };
}
