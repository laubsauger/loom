import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { DiagnosticSeverity, RuntimeDiagnostic } from "../domain/types/diagnostics.ts";

/**
 * Diagnostic codes emitted by the graph compiler (§I.diag, T30).
 *
 * Stable strings: the problems tab, the agent tools and the tests all key off them, so a
 * code is renamed only with the same care as a public API. Every compiler failure surfaces
 * as one of these rather than as a thrown error — a broken graph must still produce a
 * report the user can act on (§V9).
 */
export const CompilerDiagnosticCode = {
  unknownNodeType: "compiler/unknown-node-type",
  definitionVersion: "compiler/definition-version",
  parameterUnknown: "compiler/parameter-unknown",
  edgeEndpointMissing: "compiler/edge-endpoint-missing",
  portMissing: "compiler/port-missing",
  portIncompatible: "compiler/port-incompatible",
  portOccupied: "compiler/port-occupied",
  inputMissing: "compiler/input-missing",
  cycle: "compiler/cycle",
  noActiveSinks: "compiler/no-active-sinks",
  sinkUnknown: "compiler/sink-unknown",
  resolutionInputMissing: "compiler/resolution-input-missing",
  resolutionCustom: "compiler/resolution-custom",
  resolutionClamped: "compiler/resolution-clamped",
  formatInputMissing: "compiler/format-input-missing",
  formatUnsupported: "compiler/format-unsupported",
  formatDepthOnColor: "compiler/format-depth-on-color",
  formatNoFallback: "compiler/format-no-fallback",
  colorSpaceMismatch: "compiler/color-space-mismatch",
  nodeNoPasses: "compiler/node-no-passes",
  nodeCompileFailed: "compiler/node-compile-failed",
  passInvalid: "compiler/pass-invalid",
  memoryBudget: "compiler/memory-budget",
  scratchInvalid: "compiler/scratch-invalid",
  resolutionParameter: "compiler/resolution-parameter",
  bindingUnfilterable: "compiler/binding-unfilterable",
  /** A pass binds more of something than the device allows (T328, B33, §V24). */
  bindingBudget: "compiler/binding-budget",
  /** Component flattening (T134, T135, §V82, §V83). */
  componentRecursion: "compiler/component-recursion",
  componentMissing: "compiler/component-missing",
  componentPortUnresolved: "compiler/component-port-unresolved",
  componentIdCollision: "compiler/component-id-collision",
  componentParameterConflict: "compiler/component-parameter-conflict",
  /** A passthrough (Null) chain that reaches no producer (T223, §V130). */
  passthroughUnconnected: "compiler/passthrough-unconnected",
} as const;

export type CompilerDiagnosticCodeValue =
  (typeof CompilerDiagnosticCode)[keyof typeof CompilerDiagnosticCode];

export interface DiagnosticDetails {
  nodeId?: NodeId;
  portId?: PortId;
  suggestion?: string;
}

export function compilerDiagnostic(
  severity: DiagnosticSeverity,
  code: CompilerDiagnosticCodeValue,
  message: string,
  details: DiagnosticDetails = {},
): RuntimeDiagnostic {
  return {
    severity,
    code,
    message,
    ...(details.nodeId === undefined ? {} : { nodeId: details.nodeId }),
    ...(details.portId === undefined ? {} : { portId: details.portId }),
    ...(details.suggestion === undefined ? {} : { suggestion: details.suggestion }),
  };
}

/** A compilation is usable only when nothing failed outright; warnings are reported, not fatal. */
export function hasError(diagnostics: ReadonlyArray<RuntimeDiagnostic>): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
