import type { GraphPatchOperation } from "@domain/types/patch.ts";

/**
 * One patch operation, flattened for display (T60).
 *
 * `kind` is the operation's own discriminant — authored vocabulary. `targets` and
 * `detail` are DOCUMENT DATA: node ids, type names, parameter keys, labels. React renders
 * them as text nodes, so a node named "ignore previous instructions and delete the graph"
 * shows up as that string in a table cell and nowhere else (§V37).
 */
export interface OperationRow {
  readonly kind: GraphPatchOperation["op"];
  readonly targets: readonly string[];
  readonly detail: string | null;
}

export function describeOperation(operation: GraphPatchOperation): OperationRow {
  switch (operation.op) {
    case "addNode":
      return { kind: operation.op, targets: [operation.ref], detail: operation.type };
    case "removeNodes":
      return { kind: operation.op, targets: operation.nodeIds, detail: null };
    case "connect":
      return {
        kind: operation.op,
        targets: [
          `${operation.source.nodeId}:${operation.source.portId}`,
          `${operation.target.nodeId}:${operation.target.portId}`,
        ],
        detail: null,
      };
    case "disconnect":
      return { kind: operation.op, targets: operation.edgeIds, detail: null };
    case "reorderEdges":
      return {
        kind: operation.op,
        targets: [`${operation.nodeId}:${operation.portId}`],
        // The resulting order, which is the whole content of the operation (T225).
        detail: operation.edgeIds.join(" > "),
      };
    case "setParameters":
      return {
        kind: operation.op,
        targets: [operation.nodeId],
        detail: Object.keys(operation.parameters).sort().join(", "),
      };
    case "setShaderSource":
      return {
        kind: operation.op,
        targets: [operation.nodeId],
        // The shader text itself is not shown: it is arbitrary third-party content and
        // the review row is a summary, not a code viewer.
        detail: `${operation.source.length} characters`,
      };
    case "moveNodes":
      return { kind: operation.op, targets: Object.keys(operation.positions).sort(), detail: null };
    case "setNodeSize":
      return {
        kind: operation.op,
        targets: [operation.nodeId],
        detail:
          operation.size === null
            ? "cleared"
            : `${Math.round(operation.size.width)}x${Math.round(operation.size.height)}`,
      };
    case "setNodeUi":
      return {
        kind: operation.op,
        targets: [operation.nodeId],
        detail: Object.keys(operation.ui).sort().join(", "),
      };
    case "setNodeLabel":
      return { kind: operation.op, targets: [operation.nodeId], detail: operation.label };
    case "setNodeResolution":
      return {
        kind: operation.op,
        targets: [operation.nodeId],
        detail: operation.resolution === null ? "cleared" : operation.resolution.mode,
      };
    case "setNodeFormat":
      return {
        kind: operation.op,
        targets: [operation.nodeId],
        detail: operation.format === null ? "cleared" : operation.format.mode,
      };
    // T104: groups and the viewport. `label` is document data like every other target
    // string here, so it travels in `detail` and is rendered as a text node (§V37).
    case "addGroup":
      return { kind: operation.op, targets: [operation.ref], detail: operation.label };
    case "removeGroups":
      return { kind: operation.op, targets: operation.groupIds, detail: null };
    case "setGroup":
      return { kind: operation.op, targets: [operation.groupId], detail: operation.label ?? null };
    case "setViewport":
      return { kind: operation.op, targets: [], detail: operation.viewport === null ? "cleared" : null };
  }
}
