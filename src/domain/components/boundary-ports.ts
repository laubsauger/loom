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
 * The socket's id and label come from the node's NAME (label, else id): naming the In
 * names the socket, which is how every other reference in the product works (§V129).
 *
 * Legacy exposures (rows stored by the selection-save flow before boundary nodes
 * existed, or hand-authored) are kept, AFTER the derived rows; a stored row that names
 * a boundary node is dropped as a duplicate of the derivation.
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

/** The sockets a graph's In/Out nodes declare, in canvas order. */
export function deriveBoundaryPorts(graph: GraphDocument): BoundaryPorts {
  const inputs: ExposedPort[] = [];
  const outputs: ExposedPort[] = [];
  const takenInputs = new Set<PortId>();
  const takenOutputs = new Set<PortId>();
  const nodes = Object.values(graph.nodes).sort(positionOrder);
  for (const node of nodes) {
    if (isComponentInputBoundary(node.type)) {
      const name = node.label ?? node.id;
      inputs.push({
        externalId: uniqueId(takenInputs, name),
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
        externalId: uniqueId(takenOutputs, name),
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
  const derived = deriveBoundaryPorts(definition.graph);
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
