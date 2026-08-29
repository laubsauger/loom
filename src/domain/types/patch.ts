import type { EdgeId, GroupId, NodeId, PortId, Revision } from "./ids.ts";
import type { ParameterValue } from "./parameters.ts";
import type { NodeFormatOverride, NodeResolutionOverride, ViewportState } from "./graph.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";

/**
 * Patch-local temporary ids. Resolved to stable ids and returned in
 * GraphPatchResult.createdIds, so one patch can add nodes and wire them (§V35).
 */
export type TempId = `$${string}`;
export type NodeRef = NodeId | TempId;
export type GroupRef = GroupId | TempId;

export type GraphPatchOperation =
  | { op: "addNode"; ref: NodeRef; type: string; position: { x: number; y: number }; parameters?: Record<string, ParameterValue> }
  | { op: "removeNodes"; nodeIds: NodeId[] }
  | { op: "connect"; ref?: TempId; source: { nodeId: NodeRef; portId: PortId }; target: { nodeId: NodeRef; portId: PortId } }
  | { op: "disconnect"; edgeIds: EdgeId[] }
  | { op: "setParameters"; nodeId: NodeRef; parameters: Record<string, ParameterValue> }
  | { op: "setShaderSource"; nodeId: NodeRef; source: string }
  | { op: "moveNodes"; positions: Record<NodeId, { x: number; y: number }> }
  | { op: "setNodeUi"; nodeId: NodeRef; ui: Record<string, unknown> }
  /** null clears the label, returning the node to its definition's title. */
  | { op: "setNodeLabel"; nodeId: NodeRef; label: string | null }
  | { op: "setNodeResolution"; nodeId: NodeRef; resolution: NodeResolutionOverride | null }
  | { op: "setNodeFormat"; nodeId: NodeRef; format: NodeFormatOverride | null }
  /**
   * Groups and viewport (T104, §V29).
   *
   * `GraphDocument` has carried `groups` and `viewport` since the contract froze, and
   * the store already records group changes in its undo groups — so a group was
   * UNDOABLE while being uncreatable through the only mutation path there is. These
   * operations close that hole rather than inventing a second route around the bus.
   */
  | {
      op: "addGroup";
      ref: GroupRef;
      label: string;
      bounds: { x: number; y: number; width: number; height: number };
      color?: string;
      /** Members may be `$temp` refs created earlier in the same patch (§V35). */
      members?: NodeRef[];
    }
  | { op: "removeGroups"; groupIds: GroupId[] }
  /** Partial update: an absent field is left alone; `color: null` clears it. */
  | {
      op: "setGroup";
      groupId: GroupId;
      label?: string;
      bounds?: { x: number; y: number; width: number; height: number };
      color?: string | null;
      members?: NodeRef[];
    }
  /** `null` clears the stored viewport, returning the canvas to its default framing. */
  | { op: "setViewport"; viewport: ViewportState | null };

export interface GraphPatch {
  baseRevision: Revision;
  operations: GraphPatchOperation[];
  label?: string;
}

/**
 * All operations apply, or none do (§V32). A stale `baseRevision` yields "conflict" when
 * — and only when — the patch touches an entity that has changed since (§V33).
 *
 * `"validated"` is a DRY RUN that passed (§V36, T102). It is deliberately not "applied":
 * a caller told "applied" for an edit that never happened caches ids nobody minted and
 * builds its next patch on phantoms. `createdIds` is empty for the same reason — a dry
 * run mints nothing, so it has nothing to hand back.
 */
export interface GraphPatchResult {
  status: "applied" | "validated" | "rejected" | "conflict";
  revision: Revision;
  /** Operations applied — or, for a dry run, validated. */
  appliedOperations: number;
  diagnostics: RuntimeDiagnostic[];
  createdIds: Record<string, string>;
  undoGroupId?: string;
}
