import type { NodeId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import type { CompileEdge } from "./types.ts";

/**
 * Temporal-edge splitting, cycle rejection and topological ordering (T25, §V4).
 *
 * The current-frame graph is a DAG. A cycle is legal only when every path around it
 * crosses a node whose output is declared temporal — that output carries the PREVIOUS
 * frame, so removing those edges before ordering is not an approximation, it is what the
 * cycle actually means. Whatever is still cyclic afterwards is a genuine same-frame
 * dependency loop and is rejected by name.
 */

export interface TopologyResult {
  /** Kept nodes in execution order. Empty when a cycle was rejected. */
  readonly order: ReadonlyArray<NodeId>;
  /** Edges that participate in the current frame (temporal edges removed). */
  readonly currentFrameEdges: ReadonlyArray<CompileEdge>;
  /** Edges that cross a frame boundary; they still make the producer reachable. */
  readonly temporalEdges: ReadonlyArray<CompileEdge>;
  /** Node groups that form an illegal same-frame cycle, each sorted, groups sorted. */
  readonly cycles: ReadonlyArray<ReadonlyArray<NodeId>>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

/**
 * Tarjan's strongly-connected components, iterative so a deep graph cannot blow the JS
 * stack, and driven from a sorted root list so the reported grouping is deterministic.
 */
function stronglyConnectedComponents(
  nodeIds: ReadonlyArray<NodeId>,
  successors: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>,
): NodeId[][] {
  const index = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const components: NodeId[][] = [];
  let counter = 0;

  for (const root of nodeIds) {
    if (index.has(root)) continue;

    const work: Array<{ node: NodeId; next: number }> = [{ node: root, next: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const v = frame.node;

      if (frame.next === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter += 1;
        stack.push(v);
        onStack.add(v);
      }

      const outgoing = successors.get(v) ?? [];
      if (frame.next < outgoing.length) {
        const w = outgoing[frame.next];
        frame.next += 1;
        if (w === undefined) continue;
        const seen = index.get(w);
        if (seen === undefined) {
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v) ?? seen, seen));
        }
        continue;
      }

      const vLow = low.get(v) ?? 0;
      if (vLow === index.get(v)) {
        const component: NodeId[] = [];
        for (;;) {
          const w = stack.pop();
          if (w === undefined) break;
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        components.push(component.sort());
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? vLow, vLow));
      }
    }
  }

  return components.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/**
 * Orders the kept nodes.
 *
 * Kahn's algorithm with a lexicographically sorted ready set: two structurally identical
 * graphs must produce the same pass order, or the plan signature — and therefore the
 * decision to rebuild GPU resources — would flap for no reason (§V5).
 */
export function orderNodes(
  kept: ReadonlySet<NodeId>,
  edges: ReadonlyArray<CompileEdge>,
): TopologyResult {
  const nodeIds = [...kept].sort();
  const relevant = edges.filter((edge) => kept.has(edge.source.nodeId) && kept.has(edge.target.nodeId));
  const currentFrameEdges = relevant.filter((edge) => !edge.temporal);
  const temporalEdges = relevant.filter((edge) => edge.temporal);

  const successors = new Map<NodeId, NodeId[]>();
  const inDegree = new Map<NodeId, number>();
  for (const nodeId of nodeIds) {
    successors.set(nodeId, []);
    inDegree.set(nodeId, 0);
  }
  for (const edge of currentFrameEdges) {
    successors.get(edge.source.nodeId)?.push(edge.target.nodeId);
    inDegree.set(edge.target.nodeId, (inDegree.get(edge.target.nodeId) ?? 0) + 1);
  }
  for (const list of successors.values()) list.sort();

  const ready = nodeIds.filter((nodeId) => (inDegree.get(nodeId) ?? 0) === 0);
  const order: NodeId[] = [];
  while (ready.length > 0) {
    ready.sort();
    const nodeId = ready.shift();
    if (nodeId === undefined) break;
    order.push(nodeId);
    for (const next of successors.get(nodeId) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (order.length === nodeIds.length) {
    return { order, currentFrameEdges, temporalEdges, cycles: [], diagnostics: [] };
  }

  // Something is still cyclic. Name the actual participants rather than everything
  // downstream of them — "these five nodes form a loop" is actionable, "compilation
  // failed" is not.
  const ordered = new Set(order);
  const residual = nodeIds.filter((nodeId) => !ordered.has(nodeId));
  const residualSet = new Set(residual);
  const residualSuccessors = new Map<NodeId, NodeId[]>();
  for (const nodeId of residual) {
    residualSuccessors.set(
      nodeId,
      (successors.get(nodeId) ?? []).filter((next) => residualSet.has(next)),
    );
  }
  const selfLoops = new Set(
    currentFrameEdges
      .filter((edge) => edge.source.nodeId === edge.target.nodeId)
      .map((edge) => edge.source.nodeId),
  );
  const cycles = stronglyConnectedComponents(residual, residualSuccessors).filter(
    (component) => component.length > 1 || (component[0] !== undefined && selfLoops.has(component[0])),
  );

  const diagnostics = cycles.map((component) =>
    compilerDiagnostic(
      "error",
      CompilerDiagnosticCode.cycle,
      `Nodes ${component.map((id) => `"${id}"`).join(", ")} form a same-frame cycle.`,
      {
        ...(component[0] === undefined ? {} : { nodeId: component[0] }),
        suggestion:
          "A loop is only legal when it passes through a node whose output is declared temporal (a feedback node) — insert one, or break the loop (§V4).",
      },
    ),
  );

  return { order: [], currentFrameEdges, temporalEdges, cycles, diagnostics };
}
