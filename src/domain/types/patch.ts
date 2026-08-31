import type { EdgeId, GroupId, NodeId, PortId, Revision } from "./ids.ts";
import type { StoredParameter } from "./parameters.ts";
import type { NodeFormatOverride, NodeResolutionOverride, ViewportState } from "./graph.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";

/**
 * Patch-local temporary ids. Resolved to stable ids and returned in
 * GraphPatchResult.createdIds, so one patch can add nodes and wire them (§V35).
 */
export type TempId = `$${string}`;
export type NodeRef = NodeId | TempId;
export type GroupRef = GroupId | TempId;

/**
 * A parameter operation carries a `StoredParameter`, not a bare `ParameterValue`.
 *
 * `GraphNode.parameters`, the zod boundary (`storedParameterSchema`) and
 * `applyGraphPatch` have all spoken `StoredParameter` since T202 — a mode envelope
 * travels end to end at runtime. This type was the last layer still saying
 * `ParameterValue`, which forced a cast at every writer and made the compound editor's
 * one-patch write (§V114) and every mode switch (§V107) type-illegal at the very
 * boundary designed to carry them. A bare value stays legal: it IS a `StoredParameter`.
 */
export type GraphPatchOperation =
  | { op: "addNode"; ref: NodeRef; type: string; position: { x: number; y: number }; parameters?: Record<string, StoredParameter>; label?: string }
  | { op: "removeNodes"; nodeIds: NodeId[] }
  /**
   * `order` places the new edge at a POSITION on a variadic input rather than at the end
   * (T695, §V131).
   *
   * Absent means append, which is what every caller before T695 meant and what a new
   * layer means: the end is the only placement that does not reinterpret the layers
   * already there. It is present for exactly one gesture — a connection DROPPED ON AN
   * OCCUPIED SOCKET, which replaces that edge and must leave the replacement where the
   * old one was. Appending there would count right (three edges in, three edges out) and
   * be wrong: the user aimed at layer 2 and the wire would land on layer 3.
   *
   * The semantics are INSERT, not overwrite: the edges at or after `order` shift up one.
   * That is what makes the replace gesture one patch — the `disconnect` runs first and
   * compacts the survivors, so by the time this lands the slot the user aimed at is held
   * by the edge that used to follow it, and inserting is what puts the new wire back in
   * front of it. Ignored on a non-variadic port, which has no position to carry.
   */
  | { op: "connect"; ref?: TempId; source: { nodeId: NodeRef; portId: PortId }; target: { nodeId: NodeRef; portId: PortId }; order?: number }
  | { op: "disconnect"; edgeIds: EdgeId[] }
  /**
   * The new order of the edges landing on one VARIADIC input port (T225, §V131).
   *
   * `edgeIds` is the COMPLETE resulting order, not a move instruction: one drag is one
   * operation, one patch and one undo entry (§V132, §V15), and the caller never has to do
   * arithmetic on its siblings. A list that is not exactly the port's current edge set is
   * REJECTED rather than reconciled — a caller holding a stale list is describing a graph
   * that no longer exists, and quietly filling in the edges it forgot would produce an
   * order nobody asked for.
   */
  | { op: "reorderEdges"; nodeId: NodeRef; portId: PortId; edgeIds: EdgeId[] }
  | { op: "setParameters"; nodeId: NodeRef; parameters: Record<string, StoredParameter> }
  | { op: "setShaderSource"; nodeId: NodeRef; source: string }
  | { op: "moveNodes"; positions: Record<NodeId, { x: number; y: number }> }
  /**
   * Node size, in graph-space CSS pixels (T208, §V116).
   *
   * Document state, not view state: a resized node is how a graph gets a composition —
   * the node you are working on big, its neighbours small — and a saved project that
   * lost that would have lost the layout the user built. `null` clears the override and
   * returns the node to its content-derived size.
   */
  | { op: "setNodeSize"; nodeId: NodeRef; size: { width: number; height: number } | null }
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
