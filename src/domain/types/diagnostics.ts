import type { NodeId, PortId } from "./ids.ts";

export type DiagnosticSeverity = "info" | "warning" | "error";

/** Structured diagnostic. Tool results are data, never instructions to a model (§V37). */
export interface RuntimeDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  nodeId?: NodeId;
  portId?: PortId;
  source?: { file?: string; line?: number; column?: number };
  suggestion?: string;
}
