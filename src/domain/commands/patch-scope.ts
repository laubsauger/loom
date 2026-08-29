import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatchOperation, NodeRef } from "../types/patch.ts";

/**
 * Patch operation classification and entity scope (T107, §V33).
 *
 * ## Why a stale revision is not, by itself, a conflict
 *
 * `baseRevision !== current` used to mean "conflict", full stop. That is correct only if
 * every edit conflicts with every other edit, which is false in the case this product is
 * actually built for: a human dragging a node writes a revision per frame, so at 60Hz an
 * agent's patch goes stale 16ms after it reads the graph. The agent then re-reads,
 * rebuilds, and is stale again before it can dispatch — it never lands an edit while a
 * human is touching the canvas. The T62 gate passes in a quiet room and the product is
 * unusable in a real one.
 *
 * §V33's rule instead: a stale base is a conflict IFF the patch and the newer edits touch
 * the same ENTITY. Nothing is rebased — no operation is rewritten, reordered or
 * reinterpreted — the patch is simply applied against the current document, and every
 * structural precondition (the port is free, the node exists, the id is unused) is
 * re-checked at apply time exactly as it would be for a fresh patch.
 *
 * ## What classification is for
 *
 * The class decides an operation's BLAST RADIUS, which is what the overlap test compares:
 *
 *  - value-only (parameters, position, ui, labels, overrides, viewport, group fields)
 *    touches the entity whose value it changes and nothing else. Two actors setting
 *    different nodes' parameters are not in each other's way.
 *  - structural (add, remove, connect, disconnect) touches the entities it creates or
 *    destroys AND the edges that hang off them, because connectivity is what another
 *    actor's structural edit can invalidate: a `connect` has to notice that someone else
 *    already occupied that input port (§V14), and a `removeNodes` cascades to edges (§V40).
 *
 * Entities are named with the same keys the store's owner map uses — `node:`, `edge:`,
 * `group:` — because that map is the only record of WHEN each entity last changed.
 */

export type PatchOperationClass = "value" | "structural";

export const NODE_ENTITY_PREFIX = "node:";
export const EDGE_ENTITY_PREFIX = "edge:";
export const GROUP_ENTITY_PREFIX = "group:";

const isTemp = (ref: NodeRef): boolean => ref.startsWith("$");

/**
 * §V33's classification. Exhaustive by construction: a new operation in the union stops
 * this compiling until it has been classified, which is the point — an unclassified
 * operation would silently inherit whichever branch happened to be the default.
 */
export function operationClass(operation: GraphPatchOperation): PatchOperationClass {
  switch (operation.op) {
    case "addNode":
    case "removeNodes":
    case "connect":
    case "disconnect":
    case "addGroup":
    case "removeGroups":
      return "structural";
    case "setParameters":
    case "setShaderSource":
    case "moveNodes":
    case "setNodeUi":
    case "setNodeLabel":
    case "setNodeResolution":
    case "setNodeFormat":
    case "setGroup":
    case "setViewport":
      return "value";
    default: {
      const never: never = operation;
      void never;
      return "structural";
    }
  }
}

/** True when every operation only changes a value on an entity that already exists. */
export function isValueOnlyPatch(operations: readonly GraphPatchOperation[]): boolean {
  return operations.every((operation) => operationClass(operation) === "value");
}

/**
 * Entities this operation depends on or changes, as owner-map keys.
 *
 * A `$temp` ref names something the patch is about to CREATE, so it can collide with
 * nobody: it is deliberately absent from the result. Anything the operation reads from
 * the current document — the edges around a node it deletes, the edges already landing on
 * an input port it wants to connect — is included, because that is what another actor's
 * concurrent edit can invalidate.
 */
export function touchedEntities(
  operation: GraphPatchOperation,
  graph: GraphDocument,
  into: Set<string> = new Set(),
): Set<string> {
  const node = (ref: NodeRef): void => {
    if (!isTemp(ref)) into.add(`${NODE_ENTITY_PREFIX}${ref}`);
  };

  switch (operation.op) {
    case "addNode": {
      // A stable ref means "create this exact id", which collides with whoever else
      // used it. A temp ref is minted here and cannot.
      node(operation.ref);
      return into;
    }

    case "removeNodes": {
      const doomed = new Set(operation.nodeIds);
      for (const nodeId of operation.nodeIds) into.add(`${NODE_ENTITY_PREFIX}${nodeId}`);
      // §V40: the incident edges go with the node, so they are part of what this patch
      // changes even though the caller never named them.
      for (const edge of Object.values(graph.edges)) {
        if (doomed.has(edge.source.nodeId) || doomed.has(edge.target.nodeId)) {
          into.add(`${EDGE_ENTITY_PREFIX}${edge.id}`);
        }
      }
      for (const group of Object.values(graph.groups)) {
        if (group.members.some((member) => doomed.has(member))) {
          into.add(`${GROUP_ENTITY_PREFIX}${group.id}`);
        }
      }
      return into;
    }

    case "connect": {
      node(operation.source.nodeId);
      node(operation.target.nodeId);
      // §V14 is decided by what is already landing on the target port, so an edge
      // another actor just added there is an overlap even though this patch never
      // names it.
      if (!isTemp(operation.target.nodeId)) {
        for (const edge of Object.values(graph.edges)) {
          if (
            edge.target.nodeId === operation.target.nodeId &&
            edge.target.portId === operation.target.portId
          ) {
            into.add(`${EDGE_ENTITY_PREFIX}${edge.id}`);
          }
        }
      }
      return into;
    }

    case "disconnect": {
      for (const edgeId of operation.edgeIds) into.add(`${EDGE_ENTITY_PREFIX}${edgeId}`);
      return into;
    }

    case "setParameters":
    case "setShaderSource":
    case "setNodeUi":
    case "setNodeLabel":
    case "setNodeResolution":
    case "setNodeFormat": {
      node(operation.nodeId);
      return into;
    }

    case "moveNodes": {
      for (const nodeId of Object.keys(operation.positions)) {
        into.add(`${NODE_ENTITY_PREFIX}${nodeId}`);
      }
      return into;
    }

    case "addGroup": {
      if (!isTemp(operation.ref)) into.add(`${GROUP_ENTITY_PREFIX}${operation.ref}`);
      // Membership lives on the group, not on the node: grouping nodes does not change
      // the nodes, so it does not contend with anyone editing them.
      return into;
    }

    case "removeGroups": {
      for (const groupId of operation.groupIds) into.add(`${GROUP_ENTITY_PREFIX}${groupId}`);
      return into;
    }

    case "setGroup": {
      into.add(`${GROUP_ENTITY_PREFIX}${operation.groupId}`);
      return into;
    }

    case "setViewport": {
      // The viewport is document state with no entity identity, so it contends with
      // nothing. Two actors framing the canvas differently is not a conflict.
      return into;
    }

    default: {
      const never: never = operation;
      void never;
      return into;
    }
  }
}

/** Union of `touchedEntities` over a whole patch. */
export function patchTouchedEntities(
  operations: readonly GraphPatchOperation[],
  graph: GraphDocument,
): Set<string> {
  const entities = new Set<string>();
  for (const operation of operations) touchedEntities(operation, graph, entities);
  return entities;
}

/**
 * The entities a patch touches that someone has changed since `baseRevision`, sorted so
 * the resulting diagnostic is deterministic for every actor (§V40).
 *
 * `owners` is the store's last-writer map. It is bounded (T103) and evicts its OLDEST
 * rows first, so a missing row means the entity was last written long before any patch a
 * live caller could still be holding — the degradation is toward "no conflict" for
 * ancient edits only, never toward missing a recent one.
 */
export function overlappingEntities(
  operations: readonly GraphPatchOperation[],
  graph: GraphDocument,
  owners: Readonly<Record<string, { revision: number }>>,
  baseRevision: number,
): string[] {
  const touched = patchTouchedEntities(operations, graph);
  const overlapping: string[] = [];
  for (const entity of touched) {
    const owner = owners[entity];
    if (owner !== undefined && owner.revision > baseRevision) overlapping.push(entity);
  }
  return overlapping.sort();
}
