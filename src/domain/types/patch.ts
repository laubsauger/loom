import type { EdgeId, NodeId, PortId, Revision } from "./ids.ts";
import type { ParameterValue } from "./parameters.ts";
import type { NodeFormatOverride, NodeResolutionOverride } from "./graph.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";

/**
 * Patch-local temporary ids. Resolved to stable ids and returned in
 * GraphPatchResult.createdIds, so one patch can add nodes and wire them (§V35).
 */
export type TempId = `$${string}`;
export type NodeRef = NodeId | TempId;

export type GraphPatchOperation =
  | { op: "addNode"; ref: NodeRef; type: string; position: { x: number; y: number }; parameters?: Record<string, ParameterValue> }
  | { op: "removeNodes"; nodeIds: NodeId[] }
  | { op: "connect"; ref?: TempId; source: { nodeId: NodeRef; portId: PortId }; target: { nodeId: NodeRef; portId: PortId } }
  | { op: "disconnect"; edgeIds: EdgeId[] }
  | { op: "setParameters"; nodeId: NodeRef; parameters: Record<string, ParameterValue> }
  | { op: "setShaderSource"; nodeId: NodeRef; source: string }
  | { op: "moveNodes"; positions: Record<NodeId, { x: number; y: number }> }
  | { op: "setNodeUi"; nodeId: NodeRef; ui: Record<string, unknown> }
  | { op: "setNodeResolution"; nodeId: NodeRef; resolution: NodeResolutionOverride | null }
  | { op: "setNodeFormat"; nodeId: NodeRef; format: NodeFormatOverride | null };

export interface GraphPatch {
  baseRevision: Revision;
  operations: GraphPatchOperation[];
  label?: string;
}

/** All operations apply, or none do (§V32). Stale baseRevision yields "conflict" (§V33). */
export interface GraphPatchResult {
  status: "applied" | "rejected" | "conflict";
  revision: Revision;
  appliedOperations: number;
  diagnostics: RuntimeDiagnostic[];
  createdIds: Record<string, string>;
  undoGroupId?: string;
}
