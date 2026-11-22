import { NODE_WIDTH } from "../graph/node-box.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphEdge } from "../types/graph.ts";
import type { EdgeId, Revision, TieId } from "../types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult } from "../types/patch.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import { z } from "zod";
import { idInput, pointInput } from "./input-schema.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";

/**
 * `graph.rerouteEdge` — a wire routed through a TIE (T1821b, §V1040).
 *
 * The edge menu has named this command since T127 as a planned "Reroute" row. It is built
 * now as the one door to the tie gestures that are a sentence rather than a drag: put a tie
 * on these wires here, or route these wires through that tie. It is a patch (`addTie`,
 * `setEdgeVia`) applied through `applyGraphPatch`, so it is one undo step and an agent's
 * `apply_graph_patch` can say the same thing operation by operation. Moving, merging and
 * removing ties are plain patches the canvas builds (docs/wire-ties-design-2026-11-21.md).
 *
 * ## Where in a wire's route a new tie goes
 *
 * A wire may already pass other ties, and the route is an ORDER. The canvas knows exactly
 * which leg of the drawn wire was clicked and passes it as `index`. Without one (an agent,
 * or several wires at once) the tie goes where it lengthens the wire's route least, measured
 * between the ports' approximate places on their nodes — the document holds node positions,
 * not the handle positions React Flow measures, which is close enough to ORDER ties by and
 * is never used to draw anything.
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /**
     * Route wires through a tie: a NEW tie at `position`, or the existing `tieId`. Several
     * `edgeIds` through one tie run as one strand there and part after it.
     */
    "graph.rerouteEdge": { input: RerouteEdgeInput; output: GraphPatchResult };
  }
}

export interface RerouteEdgeInput {
  readonly edgeIds: readonly EdgeId[];
  /** Where a NEW tie goes, in graph space. Exactly one of `position` and `tieId`. */
  readonly position?: { readonly x: number; readonly y: number };
  /** The existing tie the wires join. */
  readonly tieId?: TieId;
  /** With one wire: where in its route the tie goes, 0 = first after its output. */
  readonly index?: number;
}

export const REROUTE_EDGE_COMMAND = "graph.rerouteEdge";

const rejection = (_input: unknown, diagnostics: RuntimeDiagnostic[], revision: Revision): GraphPatchResult => ({
  status: "rejected",
  revision,
  appliedOperations: 0,
  diagnostics,
  createdIds: {},
});

function refuse(
  context: CommandContext,
  code: string,
  message: string,
  severity: "info" | "warning" = "warning",
): CommandOutcome<GraphPatchResult> {
  const revision = context.store.getRevision();
  const diagnostics: RuntimeDiagnostic[] = [{ severity, code, message }];
  return { status: "rejected", revision, diagnostics, output: rejection(null, diagnostics, revision) };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Roughly where a wire leaves its output and enters its input: the right and left edges of
 * the two nodes, a header's height down. Only ever used to ORDER ties (see the docblock).
 */
function portAnchors(graph: GraphDocument, edge: GraphEdge): { from: Point; to: Point } | null {
  const source = graph.nodes[edge.source.nodeId];
  const target = graph.nodes[edge.target.nodeId];
  if (source === undefined || target === undefined) return null;
  const HEADER = 40;
  return {
    from: { x: source.position.x + (source.size?.width ?? NODE_WIDTH), y: source.position.y + HEADER },
    to: { x: target.position.x, y: target.position.y + HEADER },
  };
}

/** The place in `edge`'s route where a tie at `at` adds the least length. */
export function cheapestRouteIndex(graph: GraphDocument, edge: GraphEdge, at: Point): number {
  const via = edge.via ?? [];
  if (via.length === 0) return 0;
  const anchors = portAnchors(graph, edge);
  if (anchors === null) return via.length;
  const points: Point[] = [
    anchors.from,
    ...via.map((tieId) => graph.ties?.[tieId]?.position ?? anchors.from),
    anchors.to,
  ];
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index] as Point;
    const b = points[index + 1] as Point;
    const cost = distance(a, at) + distance(at, b) - distance(a, b);
    if (cost < bestCost) {
      bestCost = cost;
      best = index;
    }
  }
  return best;
}

/**
 * T1821b(a) — where the ties go when nodes move under them in one step (`graph.layoutAll`,
 * `graph.layout`): every tie a moved node's wire passes, carried with that wire's two ends.
 *
 * A tie `s` of the way along its wire (measured along the route, port to port) moves by the
 * blend of the moves of the wire's two ends: all of its output's move at the output end,
 * all of its input's at the input end, half of each halfway. So a tie that sat on the
 * straight run between two nodes still sits on it after they move, and a bend keeps its
 * depth beside the wire — a feedback wire routed under a chain stays under the chain when the
 * chain moves. Placing the ties ON the new straight run instead would read tidier for a
 * forward wire and would draw every feedback wire straight back through the nodes it was
 * routed around. A tie several wires pass (a bundle) moves by the mean of what each of its
 * wires asks, so the strand stays one point. A tie whose wires' ends did not move stays.
 */
export function carriedTiePositions(
  graph: GraphDocument,
  moved: Readonly<Record<string, Point>>,
): Record<TieId, { x: number; y: number }> {
  const ties = graph.ties;
  if (ties === undefined) return {};
  const shiftOf = (nodeId: string): Point => {
    const to = moved[nodeId];
    const node = graph.nodes[nodeId];
    return to === undefined || node === undefined ? { x: 0, y: 0 } : { x: to.x - node.position.x, y: to.y - node.position.y };
  };
  const asked = new Map<TieId, { x: number; y: number; wires: number }>();
  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId] as GraphEdge;
    const via = edge.via ?? [];
    if (via.length === 0) continue;
    const anchors = portAnchors(graph, edge);
    if (anchors === null) continue;
    const points: Point[] = [anchors.from, ...via.map((tieId) => ties[tieId]?.position ?? anchors.from), anchors.to];
    const along: number[] = [0];
    for (let index = 1; index < points.length; index += 1) {
      along.push((along[index - 1] as number) + distance(points[index - 1] as Point, points[index] as Point));
    }
    const total = along[along.length - 1] as number;
    const from = shiftOf(edge.source.nodeId);
    const to = shiftOf(edge.target.nodeId);
    via.forEach((tieId, index) => {
      const s = total > 0 ? (along[index + 1] as number) / total : (index + 1) / (via.length + 1);
      const sum = asked.get(tieId) ?? { x: 0, y: 0, wires: 0 };
      sum.x += from.x + (to.x - from.x) * s;
      sum.y += from.y + (to.y - from.y) * s;
      sum.wires += 1;
      asked.set(tieId, sum);
    });
  }
  const positions: Record<TieId, { x: number; y: number }> = {};
  for (const tieId of [...asked.keys()].sort()) {
    const tie = ties[tieId];
    const sum = asked.get(tieId);
    if (tie === undefined || sum === undefined) continue;
    const dx = sum.x / sum.wires;
    const dy = sum.y / sum.wires;
    if (dx === 0 && dy === 0) continue;
    positions[tieId] = { x: tie.position.x + dx, y: tie.position.y + dy };
  }
  return positions;
}

/** Idempotent: the bus has no unregister, and tests build more than one bus per module. */
export function registerWireTieCommands(bus: LoomBus): void {
  if (bus.hasCommand(REROUTE_EDGE_COMMAND)) return;

  bus.registerCommand({
    name: REROUTE_EDGE_COMMAND,
    inSession: "definition",
    inputSchema: z
      .object({
        edgeIds: z.array(idInput).min(1),
        position: pointInput.optional(),
        tieId: idInput.optional(),
        index: z.number().int().min(0).optional(),
      })
      .strict(),
    description:
      "Route wires through a tie (a point a wire bends through, never a node, no effect on render): a new tie at `position`, or the existing `tieId`. Several wires through one tie run as one strand there (T1821b).",
    handler: (input, context) => {
      if ((input.position === undefined) === (input.tieId === undefined)) {
        return refuse(context, "tie.target", "Give either a position for a new tie or the tieId of an existing one, not both.");
      }
      if (input.index !== undefined && input.edgeIds.length !== 1) {
        return refuse(context, "tie.index", "An index places a tie in ONE wire's route; several wires each get the place that lengthens them least.");
      }
      const graph = context.graph;
      const edgeIds = [...new Set(input.edgeIds)].sort();
      // §V123: a stale id is named, never quietly dropped.
      const missing = edgeIds.filter((edgeId) => graph.edges[edgeId] === undefined);
      if (missing.length > 0) return refuse(context, "edge.missing", `The document holds no wire ${missing.join(", ")}.`);

      const joining = input.tieId;
      const at = joining === undefined ? input.position : graph.ties?.[joining]?.position;
      if (at === undefined) return refuse(context, "tie.missing", `The document holds no tie ${joining ?? ""}.`);
      const tieRef = joining ?? "$tie";

      const operations: GraphPatchOperation[] = [];
      if (joining === undefined) operations.push({ op: "addTie", ref: "$tie", position: { x: at.x, y: at.y } });
      for (const edgeId of edgeIds) {
        const edge = graph.edges[edgeId] as GraphEdge;
        const via = edge.via ?? [];
        // Already through it: nothing to say about this wire.
        if (joining !== undefined && via.includes(joining)) continue;
        const place = input.index === undefined ? cheapestRouteIndex(graph, edge, at) : Math.min(input.index, via.length);
        operations.push({ op: "setEdgeVia", edgeId, via: [...via.slice(0, place), tieRef, ...via.slice(place)] });
      }
      if (operations.length === 0) {
        return refuse(context, "tie.alreadyRouted", "Every one of those wires already passes that tie.", "info");
      }
      return applyGraphPatch(
        {
          baseRevision: graph.revision,
          label: joining === undefined ? (edgeIds.length === 1 ? "Add tie" : "Tie wires") : "Tie wires",
          operations,
        },
        context,
      );
    },
    rejectionOutput: rejection,
  });
}
