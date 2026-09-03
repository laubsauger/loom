import type { ExposedPort, GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { PortId } from "../types/ids.ts";
import {
  isComponentInputBoundary,
  isComponentOutputBoundary,
} from "../../nodes/definitions/component-io.ts";

/**
 * Boundary sockets from In/Out nodes (T607).
 *
 * The owner's ask, verbatim: "subgraph input nodes that then produce sockets on the top
 * level". An author drops a `componentIn` inside a component and the instance grows an
 * input socket — no dialog, no exposure step. This module is the ONE mapping from
 * boundary nodes to `ExposedPort` rows, applied where a definition enters the system
 * (the component registry's `register`), so the flattener, the synthesized manifest,
 * validation and every instance all read the same effective interface (§V109).
 *
 * SOCKET ORDER is canvas order: `position.y`, then x, then id — TD's own answer, and
 * Notch independently derives order from node position too. A stored order field would
 * touch three frozen contracts for a property the canvas already expresses.
 *
 * The socket's LABEL comes from the node's NAME (label, else id): naming the In names
 * the socket, which is how every other reference in the product works (§V129), and it
 * is what makes the owner's T1046 ask automatic — a speaking name inside IS the
 * speaking name outside.
 *
 * ## T1046/§B170 — the label is a NAME; the externalId is an ADDRESS, and it must not move
 *
 * The externalId is what the PARENT's edges are wired to. Deriving it from the label on
 * every registration meant renaming an In re-addressed the socket, and — because a
 * component edit session writes back to the SAME version in place — every parent edge
 * wired to the old id dangled the moment the rename landed. So derivation now
 * RECONCILES against the definition's stored rows: a boundary node that already has a
 * row (matched by nodeId — the one identity a rename cannot touch) KEEPS its
 * externalId and only refreshes its label; only a NEW boundary node derives its
 * externalId from its name, once, at birth. Renaming changes what the socket says,
 * never what it is wired by.
 *
 * Legacy exposures (rows stored by the selection-save flow before boundary nodes
 * existed, or hand-authored) are kept, AFTER the derived rows; a stored row that names
 * a boundary node is consumed by the reconciliation above instead of duplicating it.
 */

const positionOrder = (
  a: { position: { x: number; y: number }; id: string },
  b: { position: { x: number; y: number }; id: string },
): number =>
  a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id);

function uniqueId(taken: Set<PortId>, preferred: string): PortId {
  if (!taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (taken.has(`${preferred}_${suffix}`)) suffix += 1;
  const id = `${preferred}_${suffix}`;
  taken.add(id);
  return id;
}

export interface BoundaryPorts {
  readonly inputs: readonly ExposedPort[];
  readonly outputs: readonly ExposedPort[];
}

/**
 * The sockets a graph's In/Out nodes declare, in canvas order.
 *
 * `stored` is the definition's existing rows — the ADDRESS BOOK (§B170/T1046): a
 * boundary node found there by nodeId keeps its externalId across renames. Omitting it
 * derives every address from the current name, which is only correct for a graph that
 * has never been registered (the selection-save synthesis).
 */
export function deriveBoundaryPorts(
  graph: GraphDocument,
  stored?: { inputs?: readonly ExposedPort[]; outputs?: readonly ExposedPort[] },
): BoundaryPorts {
  const inputs: ExposedPort[] = [];
  const outputs: ExposedPort[] = [];
  const addressOf = (rows: readonly ExposedPort[] | undefined): Map<string, PortId> => {
    const byNode = new Map<string, PortId>();
    for (const row of rows ?? []) {
      if (!byNode.has(row.nodeId)) byNode.set(row.nodeId, row.externalId);
    }
    return byNode;
  };
  const storedInputs = addressOf(stored?.inputs);
  const storedOutputs = addressOf(stored?.outputs);
  // Every kept address is reserved BEFORE any new node derives one, so a newcomer named
  // like an existing socket suffixes itself instead of stealing the wired id.
  const takenInputs = new Set<PortId>(storedInputs.values());
  const takenOutputs = new Set<PortId>(storedOutputs.values());
  const nodes = Object.values(graph.nodes).sort(positionOrder);
  for (const node of nodes) {
    if (isComponentInputBoundary(node.type)) {
      const name = node.label ?? node.id;
      inputs.push({
        externalId: storedInputs.get(node.id) ?? uniqueId(takenInputs, name),
        label: name,
        nodeId: node.id,
        // The PASSTHROUGH INPUT: the outer edge lands on `In.in`, flows through, and
        // the compiler's splice rewires every consumer of `In.out` to the outer
        // producer — which is what makes one socket feed many inner nodes (T423).
        portId: "in",
      });
    } else if (isComponentOutputBoundary(node.type)) {
      const name = node.label ?? node.id;
      outputs.push({
        externalId: storedOutputs.get(node.id) ?? uniqueId(takenOutputs, name),
        label: name,
        nodeId: node.id,
        portId: "out",
      });
    }
  }
  return { inputs, outputs };
}

/** True when this exposure names a boundary node — the derivation already covers it. */
function coveredByBoundary(graph: GraphDocument, exposed: ExposedPort): boolean {
  const node = graph.nodes[exposed.nodeId];
  if (node === undefined) return false;
  return isComponentInputBoundary(node.type) || isComponentOutputBoundary(node.type);
}

/**
 * The definition with its boundary-node sockets folded in — derived rows first (canvas
 * order), legacy stored rows after, duplicates dropped. Identity-preserving when the
 * graph holds no boundary nodes and nothing needed dropping.
 */
export function withBoundaryPorts(definition: GraphComponentDefinition): GraphComponentDefinition {
  // The definition's own rows are the address book: re-registering after a rename keeps
  // every externalId a parent may be wired to (§B170/T1046).
  const derived = deriveBoundaryPorts(definition.graph, definition);
  const keptInputs = definition.inputs.filter((port) => !coveredByBoundary(definition.graph, port));
  const keptOutputs = definition.outputs.filter((port) => !coveredByBoundary(definition.graph, port));
  if (
    derived.inputs.length === 0 &&
    derived.outputs.length === 0 &&
    keptInputs.length === definition.inputs.length &&
    keptOutputs.length === definition.outputs.length
  ) {
    return definition;
  }
  // Derived ids win their names; a legacy row colliding with a derived id is suffixed.
  const takenInputs = new Set<PortId>(derived.inputs.map((port) => port.externalId));
  const takenOutputs = new Set<PortId>(derived.outputs.map((port) => port.externalId));
  return {
    ...definition,
    inputs: [
      ...derived.inputs,
      ...keptInputs.map((port) => ({ ...port, externalId: uniqueId(takenInputs, port.externalId) })),
    ],
    outputs: [
      ...derived.outputs,
      ...keptOutputs.map((port) => ({ ...port, externalId: uniqueId(takenOutputs, port.externalId) })),
    ],
  };
}
