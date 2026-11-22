import type { ExposedPort, GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphEdge, GraphNode, GraphTie } from "../types/graph.ts";
import type { ComponentId, EdgeId, NodeId, PortId, TieId } from "../types/ids.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { boundaryTypeFor } from "../../nodes/definitions/component-io.ts";
import { arePortsCompatible } from "../graph/port-compat.ts";
import { compareEdgeOrder, edgeOrderKey, type OrderableEdge } from "../graph/edge-order.ts";
import { readComponentInstance } from "./instance.ts";
import { toInstance, type InstancePath } from "./addressing.ts";
import type { ComponentRegistryView } from "./registry.ts";
import { detectComponentRecursion, describeRecursion } from "./recursion.ts";
import { liveSourceReferenceTokens } from "../graph/source-references.ts";

/**
 * Save selection as a component (T129, §V79).
 *
 * A pure transform: given a graph and a set of selected nodes, work out the internal
 * network, the ports that CROSSED the selection boundary, and how the parent graph must
 * be rewired to talk to the instance that replaces the selection. Nothing here mutates;
 * the command applies the result in one patch.
 *
 * Boundary ports are the whole trick. A selection is almost never closed — the user
 * picked three nodes in the middle of a chain — so every edge with exactly one end inside
 * becomes an exposed port, and the outer end reconnects to the instance. Get that wrong
 * and "make this a component" silently deletes the user's wiring.
 *
 * T1821b(b) — WIRE TIES. A wire with both ends inside goes into the component with its route,
 * and the ties it passes go into the component's graph with it (same ids and positions, as
 * the nodes keep theirs). A wire that CROSSES the boundary is split by the In or Out the
 * save makes: its whole route stays on the OUTER half, in the parent, because the ties were
 * drawn in the parent's space and the outer half is the part still drawn there; the inner
 * half, In → consumer or producer → Out, is born unrouted. Where several crossing wires from
 * one outer source become one outer wire to one In (the fan-in below), that wire takes the
 * route of the first of them by id. A tie the parent then has no wire through goes
 * (§V1040), in the same step.
 */

export interface SelectionWiring {
  externalId: PortId;
  /** The endpoint OUTSIDE the selection that reconnects to the instance. */
  outer: { nodeId: NodeId; portId: PortId };
  /** Retain its slot at the original consumer, including mixed internal/external inputs. */
  order?: number;
  /** T1821b(b): the route of the crossing wire this outer wire replaces, in the parent. */
  via?: TieId[];
}

export interface ComponentFromSelection {
  definition: GraphComponentDefinition;
  /** Outside source -> instance input, one per exposed input that was wired. */
  inputWiring: readonly SelectionWiring[];
  /** Instance output -> outside target. One exposed output may feed several. */
  outputWiring: readonly SelectionWiring[];
  /** Edges the parent graph loses: everything with at least one end inside. */
  removedEdgeIds: readonly EdgeId[];
  /** Original variadic input order, materialized before crossing edges receive new IDs. */
  edgeOrders: Readonly<Record<EdgeId, number>>;
  /** Where to put the instance node: the centre of what it replaces. */
  position: { x: number; y: number };
  diagnostics: readonly RuntimeDiagnostic[];
}

export interface SaveSelectionInput {
  graph: GraphDocument;
  nodeIds: readonly NodeId[];
  componentId: ComponentId;
  version?: number;
  name: string;
  description?: string;
  nodes: NodeRegistryView;
  /** Needed only when selected instances have input wires crossing the selection. */
  components?: Pick<ComponentRegistryView, "get" | "graphOf">;
  /**
   * Author-chosen SOCKET NAMES, keyed by the internal endpoint that crosses the boundary
   * (`"<nodeId>.<portId>"`) — `{ "matte.input": "depth" }` (T1194).
   *
   * The default names a socket after the port it happens to FEED, which says what the
   * signal is plugged INTO, never what it IS: two `pointKernel.field` inputs come out as
   * `field` and `field_2` when one is a colour map and the other a depth map. No default
   * can fix that — the outer source node's label describes one particular signal (Bloom's
   * demo plate is a noise field; its socket is not "noise"), and the target port's own
   * LABEL is "Input"/"Field" across the catalogue. The name is a fact only the author
   * holds, so this is where it enters: ONCE, AT BIRTH.
   *
   * At birth, and nowhere else, on purpose. `externalId` is the ADDRESS the parent's edges
   * are wired by, and §B170/T1046 froze it against later renames — a rename moves what a
   * socket SAYS (its label), never what it is wired BY. A name supplied here precedes any
   * wiring, so it re-addresses nothing.
   *
   * A key naming an endpoint that does not cross the boundary is simply unused: an author
   * revising a selection must not have the save refused over a stale hint.
   */
  portNames?: Readonly<Record<string, string>>;
}

function uniqueId(taken: Set<PortId>, preferred: PortId): PortId {
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

/** Fixed legacy exposures can merge outer wires with hidden variadic feeds. */
function fixedInputOrderProblems(input: SaveSelectionInput, inside: ReadonlySet<NodeId>): RuntimeDiagnostic[] {
  const crossings = Object.values(input.graph.edges).filter(edge => inside.has(edge.target.nodeId) && !inside.has(edge.source.nodeId) &&
    readComponentInstance(input.graph.nodes[edge.target.nodeId]!) !== null);
  if (crossings.length === 0) return [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const refuse = (nodeId: NodeId, message: string, suggestion = "Give the mixed inputs distinct Order values, or route the input through an In boundary, before saving the selection."): void => {
    diagnostics.push({ severity: "error", code: "component.selection.inputOrder", nodeId, message, suggestion });
  };
  const components = input.components;
  if (components === undefined) {
    refuse(crossings[0]!.target.nodeId, "Cannot check the selected component's internal input order without its catalogue.", "Pass the component catalogue to the selection builder.");
    return diagnostics;
  }
  const selectedGraph = { ...input.graph, nodes: Object.fromEntries(crossings.map(edge => [edge.target.nodeId, input.graph.nodes[edge.target.nodeId]!])) };
  const recursion = detectComponentRecursion({ componentId: null, graph: selectedGraph, source: components });
  if (recursion !== null) {
    refuse(crossings[0]!.target.nodeId, describeRecursion(recursion), "Repair the recursive component before saving the selection.");
    return diagnostics;
  }
  type Feed = GraphEdge & { crossing: boolean };
  const edgeIndexes = new Map<GraphDocument, Map<NodeId, Map<PortId, GraphEdge[]>>>();
  const feedsAt = (graph: GraphDocument, path: InstancePath, nodeId: NodeId, portId: PortId): Feed[] => {
    let index = edgeIndexes.get(graph);
    if (index === undefined) {
      index = new Map();
      edgeIndexes.set(graph, index);
      for (const edge of Object.values(graph.edges)) {
        const ports = index.get(edge.target.nodeId) ?? new Map<PortId, GraphEdge[]>();
        index.set(edge.target.nodeId, ports);
        const edges = ports.get(edge.target.portId) ?? [];
        ports.set(edge.target.portId, edges);
        edges.push(edge);
      }
    }
    return (index.get(nodeId)?.get(portId) ?? []).map(edge => ({ ...edge,
      id: toInstance(path, edge.id),
      source: { ...edge.source, nodeId: toInstance(path, edge.source.nodeId) },
      target: { ...edge.target, nodeId: toInstance(path, edge.target.nodeId) },
      crossing: path.length === 0 && inside.has(nodeId) && !inside.has(edge.source.nodeId),
    }));
  };
  const checked = new Set<EdgeId>();
  const walk = (graph: GraphDocument, path: InstancePath, nodeId: NodeId, portId: PortId, carried: ReadonlyMap<PortId, readonly Feed[]>, owner: NodeId): void => {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      refuse(owner, `Cannot resolve internal input "${toInstance(path, nodeId)}.${portId}".`);
      return;
    }
    const instance = readComponentInstance(node);
    if (instance !== null) {
      const definition = components.get(instance.componentId, instance.version);
      const exposed = definition?.inputs.find(port => port.externalId === portId);
      if (definition === undefined || exposed === undefined) {
        refuse(owner, `Cannot resolve exposed input "${toInstance(path, nodeId)}.${portId}" from its registered component.`);
        return;
      }
      // A selected whole input is exclusive. A deeper one can still carry a fixed ancestor's feeds.
      if (path.length === 0 && exposed.variadic === true) return;
      const forwarded = new Map<NodeId, Map<PortId, Feed[]>>();
      for (const port of definition.inputs) {
        const feeds = [...(carried.get(port.externalId) ?? []), ...feedsAt(graph, path, nodeId, port.externalId)];
        const ports = forwarded.get(port.nodeId) ?? new Map<PortId, Feed[]>();
        forwarded.set(port.nodeId, ports);
        ports.set(port.portId, [...(ports.get(port.portId) ?? []), ...feeds]);
      }
      walk(definition.graph, [...path, nodeId], exposed.nodeId, exposed.portId, forwarded.get(exposed.nodeId) ?? new Map(), owner);
      return;
    }
    // An In boundary owns its outgoing slot order; an incoming single wire cannot reorder it.
    if (input.nodes.port(node.type, portId, "input")?.variadic !== true) return;
    const flatId = toInstance(path, nodeId);
    const feeds = [...(carried.get(portId) ?? []), ...feedsAt(graph, path, nodeId, portId)].map(feed => ({ ...feed, target: { nodeId: flatId, portId } }));
    const wires = Object.fromEntries(feeds.map(feed => [feed.id, feed]));
    const peers: OrderableEdge[] = [...feeds];
    for (const spec of input.nodes.get(node.type)?.sourceReferences ?? []) {
      if (spec.input !== portId) continue;
      liveSourceReferenceTokens(spec, { ...node, id: flatId }, wires).forEach((_name, index) => {
        peers.push({ id: spec.list === true ? `ref:${flatId}:${spec.parameter}:${index}` : `ref:${flatId}`,
          ...(spec.list === true ? { order: index } : {}) });
      });
    }
    for (const feed of feeds) {
      if (!feed.crossing || checked.has(feed.id)) continue;
      checked.add(feed.id);
      const peer = peers.find(other => other.id !== feed.id && edgeOrderKey(other) === edgeOrderKey(feed));
      if (peer !== undefined) refuse(owner, `Cannot save the selection: "${toInstance(path, nodeId)}.${portId}" orders "${feed.id}" and "${peer.id}" by their IDs, which wrapping would change.`);
    }
  };
  for (const edge of crossings) walk(input.graph, [], edge.target.nodeId, edge.target.portId, new Map(), edge.target.nodeId);
  return diagnostics;
}

export function buildComponentFromSelection(input: SaveSelectionInput): ComponentFromSelection {
  const diagnostics: RuntimeDiagnostic[] = [];
  /** The author's name for the socket this endpoint crosses on, else the port id (T1194). */
  const socketName = (endpoint: { nodeId: NodeId; portId: PortId }): PortId => {
    const authored = input.portNames?.[`${endpoint.nodeId}.${endpoint.portId}`];
    return authored !== undefined && authored.trim() !== "" ? authored.trim() : endpoint.portId;
  };
  // Sorted and deduplicated: two actors running the same command must build the same
  // component, down to the order of the exposed ports (§V40).
  const selected = [...new Set(input.nodeIds)].sort();
  const inside = new Set<NodeId>();
  const nodes: Record<NodeId, GraphNode> = {};

  for (const nodeId of selected) {
    const node = input.graph.nodes[nodeId];
    if (node === undefined) {
      diagnostics.push({
        severity: "error",
        code: "component.selection.missingNode",
        message: `Cannot include "${nodeId}" in a component: it is not in the graph.`,
        nodeId,
      });
      continue;
    }
    inside.add(nodeId);
    // Internal node ids are kept. They are globally unique already (§V40), they never
    // collide with the parent's because the internal graph is a separate document, and
    // keeping them means a diagnostic path still names something the author recognises.
    nodes[nodeId] = node;
  }
  diagnostics.push(...fixedInputOrderProblems(input, inside));

  const edges: Record<EdgeId, GraphEdge> = {};
  /** T1821b(b): the ties the inside wires pass, which the component's graph keeps. */
  const ties: Record<TieId, GraphTie> = {};
  // An absent or tied order is resolved by edge ID. Reminting a crossing edge would
  // change that decision, so preserve the ORIGINAL total order for the whole input,
  // including peers left outside the selection and feeds that move inside it.
  const inputsByNode = new Map<NodeId, Map<PortId, { edges: GraphEdge[]; crossed: boolean }>>();
  for (const edge of Object.values(input.graph.edges)) {
    const target = input.graph.nodes[edge.target.nodeId];
    if (target === undefined || input.nodes.port(target.type, edge.target.portId, "input")?.variadic !== true) continue;
    let ports = inputsByNode.get(target.id);
    if (ports === undefined) {
      ports = new Map();
      inputsByNode.set(target.id, ports);
    }
    let group = ports.get(edge.target.portId);
    if (group === undefined) {
      group = { edges: [], crossed: false };
      ports.set(edge.target.portId, group);
    }
    group.edges.push(edge);
    group.crossed ||= inside.has(edge.source.nodeId) !== inside.has(edge.target.nodeId);
  }
  const edgeOrders: Record<EdgeId, number> = {};
  for (const ports of inputsByNode.values()) {
    for (const group of ports.values()) {
      if (!group.crossed || group.edges.length < 2) continue;
      const declared = group.edges.map(edgeOrderKey);
      // Distinct sort keys already survive reminting. Keep their values, which can
      // also position a component's incoming edge relative to a fixed internal feed.
      if (new Set(declared).size === declared.length) continue;
      group.edges.sort(compareEdgeOrder).forEach((edge, index) => { edgeOrders[edge.id] = index; });
    }
  }
  const removedEdgeIds: EdgeId[] = [];
  const inputs: ExposedPort[] = [];
  const outputs: ExposedPort[] = [];
  const inputWiring: SelectionWiring[] = [];
  const outputWiring: SelectionWiring[] = [];
  const takenIds = new Set<PortId>();
  /** One exposed output per internal source port, however many outside targets it feeds. */
  const outputByInternal = new Map<string, PortId>();
  /**
   * T607: one boundary node per unique OUTER SOURCE. This is the fan-in fix — before
   * boundary nodes, one outer producer feeding three inner nodes minted THREE input
   * sockets all wired back to the same producer, because an `ExposedPort` maps one
   * external port to exactly one internal endpoint. A synthesized `In` gives the three
   * inner consumers one internal producer to hang off, the register-time derivation
   * turns it into ONE socket, and the compiler's passthrough splice erases it at zero
   * cost. Synthesized ONLY when the port types are exactly compatible through the
   * variant (§V13 — a rewire the connect validation would refuse must not be invented
   * here); anything else keeps the legacy per-edge exposure row.
   */
  const inBoundaryBySource = new Map<string, { nodeId: NodeId; count: number }>();
  const outBoundaryByInternal = new Map<string, NodeId>();
  let boundarySerial = 0;
  const freshBoundaryId = (prefix: string, name: string): NodeId => {
    let id = `${prefix}_${name}` as NodeId;
    while (id in nodes || input.graph.nodes[id] !== undefined) {
      boundarySerial += 1;
      id = `${prefix}_${name}_${String(boundarySerial)}` as NodeId;
    }
    return id;
  };
  const boundaryFits = (
    variantType: string | undefined,
    outerType: { kind: string } | undefined,
    innerType: { kind: string } | undefined,
  ): boolean => {
    if (variantType === undefined || outerType === undefined || innerType === undefined) return false;
    const variant = input.nodes.port(variantType, "in", "input");
    if (variant === undefined) return false;
    return (
      arePortsCompatible(outerType as never, variant.type) &&
      arePortsCompatible(variant.type, innerType as never)
    );
  };

  for (const edgeId of Object.keys(input.graph.edges).sort()) {
    const original = input.graph.edges[edgeId];
    if (original === undefined) continue;
    const order = edgeOrders[edgeId];
    const edge = order === undefined ? original : { ...original, order };
    const sourceInside = inside.has(edge.source.nodeId);
    const targetInside = inside.has(edge.target.nodeId);
    if (!sourceInside && !targetInside) continue;

    removedEdgeIds.push(edgeId);
    // T1821b(b): a crossing wire's route rides on the outer wire that replaces it.
    const route = edge.via === undefined || edge.via.length === 0 ? {} : { via: [...edge.via] };

    if (sourceInside && targetInside) {
      edges[edgeId] = edge;
      // ...and an inside wire's ties go into the component with it.
      for (const tieId of edge.via ?? []) {
        const tie = input.graph.ties?.[tieId];
        if (tie !== undefined) ties[tieId] = { id: tieId, position: { ...tie.position } };
      }
      continue;
    }

    if (targetInside) {
      const node = input.graph.nodes[edge.target.nodeId];
      const targetPort = node === undefined ? undefined : input.nodes.port(node.type, edge.target.portId, "input");
      const outerNode = input.graph.nodes[edge.source.nodeId];
      const outerPort =
        outerNode === undefined ? undefined : input.nodes.port(outerNode.type, edge.source.portId, "output");
      const variantType =
        outerPort === undefined ? undefined : boundaryTypeFor(outerPort.type.kind, "input");

      const sourceKey = `${edge.source.nodeId}/${edge.source.portId}`;
      const standing = inBoundaryBySource.get(sourceKey);
      if (standing !== undefined && boundaryFits(variantType, outerPort?.type, targetPort?.type)) {
        // Second (third, …) inner consumer of the SAME outer source: hang it off the
        // one In. No new socket, no new wiring row — the fan-in fix itself.
        standing.count += 1;
        const feedId = `${standing.nodeId}_feed_${String(standing.count)}` as EdgeId;
        edges[feedId] = {
          id: feedId,
          source: { nodeId: standing.nodeId, portId: "out" },
          target: { ...edge.target },
          ...(edge.order === undefined ? {} : { order: edge.order }),
        };
        continue;
      }
      if (standing === undefined && boundaryFits(variantType, outerPort?.type, targetPort?.type)) {
        const name = uniqueId(takenIds, socketName(edge.target));
        const boundaryId = freshBoundaryId("in", name);
        // Left of the consumer it feeds, so the entry reads left-to-right; stacked by
        // creation order, which the y-sorted derivation then reads back as socket order.
        const anchor = input.graph.nodes[edge.target.nodeId];
        nodes[boundaryId] = {
          id: boundaryId,
          type: variantType as string,
          definitionVersion: 1,
          position: {
            x: (anchor?.position.x ?? 0) - 240,
            y: (anchor?.position.y ?? 0) + inBoundaryBySource.size * 8,
          },
          parameters: {},
          label: name,
        } as GraphNode;
        inBoundaryBySource.set(sourceKey, { nodeId: boundaryId, count: 1 });
        const feedId = `${boundaryId}_feed_1` as EdgeId;
        edges[feedId] = {
          id: feedId,
          source: { nodeId: boundaryId, portId: "out" },
          target: { ...edge.target },
          ...(edge.order === undefined ? {} : { order: edge.order }),
        };
        // No exposure row: the register-time derivation mints the socket from the In
        // node itself, named by its label — one mapping, not two (§V109).
        inputWiring.push({ externalId: name, outer: { ...edge.source }, ...(edge.order === undefined ? {} : { order: edge.order }), ...route });
        continue;
      }

      // Legacy path: exotic or mismatched port types keep the direct exposure.
      const externalId = uniqueId(takenIds, socketName(edge.target));
      inputs.push({
        externalId,
        label: targetPort?.label ?? edge.target.portId,
        nodeId: edge.target.nodeId,
        portId: edge.target.portId,
      });
      inputWiring.push({ externalId, outer: { ...edge.source }, ...(edge.order === undefined ? {} : { order: edge.order }), ...route });
      continue;
    }

    const internalKey = `${edge.source.nodeId}/${edge.source.portId}`;
    const node = input.graph.nodes[edge.source.nodeId];
    const sourcePort = node === undefined ? undefined : input.nodes.port(node.type, edge.source.portId, "output");
    const outerNode = input.graph.nodes[edge.target.nodeId];
    const outerInputPort =
      outerNode === undefined ? undefined : input.nodes.port(outerNode.type, edge.target.portId, "input");
    const outVariant =
      sourcePort === undefined ? undefined : boundaryTypeFor(sourcePort.type.kind, "output");

    const standingOut = outBoundaryByInternal.get(internalKey);
    if (standingOut !== undefined) {
      outputWiring.push({
        externalId: (nodes[standingOut] as GraphNode).label ?? standingOut,
        outer: { ...edge.target },
        ...(edge.order === undefined ? {} : { order: edge.order }),
        ...route,
      });
      continue;
    }
    if (boundaryFits(outVariant, sourcePort?.type, outerInputPort?.type)) {
      const name = uniqueId(takenIds, socketName(edge.source));
      const boundaryId = freshBoundaryId("out", name);
      const anchor = input.graph.nodes[edge.source.nodeId];
      nodes[boundaryId] = {
        id: boundaryId,
        type: outVariant as string,
        definitionVersion: 1,
        position: {
          x: (anchor?.position.x ?? 0) + 240,
          y: (anchor?.position.y ?? 0) + outBoundaryByInternal.size * 8,
        },
        parameters: {},
        label: name,
      } as GraphNode;
      outBoundaryByInternal.set(internalKey, boundaryId);
      const feedId = `${boundaryId}_feed` as EdgeId;
      edges[feedId] = {
        id: feedId,
        source: { ...edge.source },
        target: { nodeId: boundaryId, portId: "in" },
      };
      outputWiring.push({ externalId: name, outer: { ...edge.target }, ...(edge.order === undefined ? {} : { order: edge.order }), ...route });
      continue;
    }

    let externalId = outputByInternal.get(internalKey);
    if (externalId === undefined) {
      externalId = uniqueId(takenIds, socketName(edge.source));
      outputByInternal.set(internalKey, externalId);
      outputs.push({
        externalId,
        label: sourcePort?.label ?? edge.source.portId,
        nodeId: edge.source.nodeId,
        portId: edge.source.portId,
      });
    }
    outputWiring.push({ externalId, outer: { ...edge.target }, ...(edge.order === undefined ? {} : { order: edge.order }), ...route });
  }

  if (inside.size === 0) {
    diagnostics.push({
      severity: "error",
      code: "component.selection.empty",
      message: "Select at least one node to save as a component.",
    });
  }

  let x = 0;
  let y = 0;
  for (const nodeId of inside) {
    const node = input.graph.nodes[nodeId];
    if (node === undefined) continue;
    x += node.position.x;
    y += node.position.y;
  }
  const count = Math.max(1, inside.size);

  const definition: GraphComponentDefinition = {
    componentId: input.componentId,
    version: input.version ?? 1,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    graph: { revision: 0, nodes, edges, groups: {}, ...(Object.keys(ties).length === 0 ? {} : { ties }) },
    inputs,
    outputs,
    // Nothing is published yet: publishing is a separate, deliberate act of re-authoring
    // a control, not a bulk copy of every internal parameter (§V80).
    parameters: [],
  };

  return {
    definition,
    inputWiring,
    outputWiring,
    removedEdgeIds,
    edgeOrders,
    position: { x: Math.round(x / count), y: Math.round(y / count) },
    diagnostics,
  };
}
