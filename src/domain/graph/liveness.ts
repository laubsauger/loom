import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import { parseExpression, type ExpressionAst } from "../expressions/index.ts";
import { isParameterSlot } from "../parameters/slots.ts";

/**
 * THE liveness answer (T268, §V173b).
 *
 * A node is ALIVE through any of three sources, and every consumer — `plan.pruned`,
 * the example gate's dead-node check, cooking's dirty set, the UI's pruned badge —
 * reads the SAME computation, because four places computing it separately are four
 * chances to disagree in four directions:
 *
 *  1. a DATA EDGE chain reaching an active sink (§V25's classic walk);
 *  2. a `driven` slot on an alive node naming a value source's channel (T238-T240);
 *  3. an `op('name')` reference in an alive node's expression (§V127/§V154 — the shape
 *     TD's documented dependency bug takes: parameter reads are dependencies too).
 *
 * Liveness is about REPORTING and dependency truth, not the GPU plan: channel and
 * reference liveness are parameter reads, which need the node's DOCUMENT presence and
 * no GPU work — so the compiler's `kept` set (what compiles and materializes) stays
 * edge-based, while `pruned` (the report) subtracts everything alive here.
 *
 * DEAD (§V173) means: was a candidate for GPU work and nothing reaches it. A value
 * source is never a candidate, so it appears in neither list.
 */

/** Non-plan-resident by design (§V173): a channel/value-graph node, never a GPU candidate. */
export function isValueSourceDefinition(definition: NodeDefinition | undefined): boolean {
  return definition !== undefined && (definition.valueChannel !== undefined || definition.valueEvaluate !== undefined);
}

export interface LivenessNode {
  readonly name: string | undefined;
  readonly parameters: Readonly<Record<string, StoredParameter>>;
  /** Non-plan-resident by design (valueChannel): never a candidate, never "dead". */
  readonly isValueSource: boolean;
  readonly isSink: boolean;
}

export interface LivenessResult {
  /** Everything reachable through any of the three sources, value sources included. */
  readonly alive: ReadonlySet<NodeId>;
  /** §V173: candidates nothing reaches. Sorted. Value sources never appear. */
  readonly dead: ReadonlyArray<NodeId>;
}

/** `op('name')` targets in one expression source. Parse-based; regex fallback for legacy text. */
export function opReferenceNames(source: string): string[] {
  const parsed = parseExpression(source);
  if (parsed.ok) {
    const names: string[] = [];
    const walk = (ast: ExpressionAst): void => {
      switch (ast.kind) {
        case "opRef":
          names.push(ast.name);
          return;
        case "unary":
          walk(ast.operand);
          return;
        case "binary":
          walk(ast.left);
          walk(ast.right);
          return;
        default:
          return;
      }
    };
    walk(parsed.ast);
    return names;
  }
  // A stored source the current grammar refuses (older document): the reference is
  // still a dependency, so a syntactic scan beats pretending it is not there.
  return [...source.matchAll(/op\(\s*(['"])(.+?)\1\s*\)/g)].map((match) => match[2] ?? "");
}

/** Names this node's ACTIVE bindings depend on: driven channels + op() references. */
function referencedNames(node: LivenessNode): string[] {
  const names: string[] = [];
  for (const stored of Object.values(node.parameters)) {
    if (!isParameterSlot(stored)) continue;
    const binding = stored.bindings[stored.mode];
    if (binding === undefined) continue;
    // Active bindings only, matching §V110's convention: a retained payload is data,
    // not a dependency, and activating it is an edit that re-runs this.
    if (binding.kind === "driven") names.push(binding.channel);
    if (binding.kind === "expression") names.push(...opReferenceNames(binding.source));
  }
  return names;
}

export function computeLiveness(
  nodes: ReadonlyMap<NodeId, LivenessNode>,
  producers: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>,
  extraSeeds: Iterable<NodeId> = [],
): LivenessResult {
  const byName = new Map<string, NodeId>();
  for (const [nodeId, node] of [...nodes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (node.name !== undefined && !byName.has(node.name)) byName.set(node.name, nodeId);
  }

  const alive = new Set<NodeId>();
  const queue: NodeId[] = [...extraSeeds];
  for (const [nodeId, node] of nodes) if (node.isSink) queue.push(nodeId);
  queue.sort();

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    if (alive.has(nodeId)) continue;
    const node = nodes.get(nodeId);
    if (node === undefined) continue;
    alive.add(nodeId);
    for (const upstream of [...(producers.get(nodeId) ?? [])].sort()) queue.push(upstream);
    for (const name of referencedNames(node).sort()) {
      const target = byName.get(name);
      if (target !== undefined) queue.push(target);
    }
  }

  const dead = [...nodes.keys()]
    .filter((nodeId) => !alive.has(nodeId) && nodes.get(nodeId)?.isValueSource === false)
    .sort();
  return { alive, dead };
}

/** Document-level convenience: the example gate's and the UI's entry point. */
export function documentLiveness(graph: GraphDocument, registry: NodeRegistryView): LivenessResult {
  const nodes = new Map<NodeId, LivenessNode>();
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    nodes.set(nodeId, {
      name: node.label,
      parameters: node.parameters,
      isValueSource: isValueSourceDefinition(definition),
      isSink: definition?.sink === true,
    });
  }
  const producers = new Map<NodeId, NodeId[]>();
  for (const edge of Object.values(graph.edges)) {
    const list = producers.get(edge.target.nodeId);
    if (list === undefined) producers.set(edge.target.nodeId, [edge.source.nodeId]);
    else list.push(edge.source.nodeId);
  }
  return computeLiveness(nodes, producers);
}
