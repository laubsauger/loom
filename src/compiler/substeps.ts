import type { NodeId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { CompileEdge, ResolvedOutput } from "./types.ts";
import type { ResolvedNode } from "./validate.ts";
import { MAX_SUBSTEPS } from "../runtime/backend/plan.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import { swapPassId } from "./resources.ts";

/**
 * SUBSTEPS — N iterations of a feedback loop per DISPLAYED frame (T387).
 *
 * ## What is actually being iterated
 *
 * A feedback loop is a cycle the compiler has already split: the pair's read half carries
 * last frame, the nodes in the cycle compute the next state, the Feedback node writes the
 * write half, and a swap makes it readable. That whole sequence — read, compute, write,
 * swap — is ONE iteration, and the only thing standing between one iteration and fifty is
 * the number of times the encoder walks it. No new resource, no new pipeline, no new pass:
 * the passes below are the ones a single-step plan already emitted, delimited so the
 * backend knows to encode them again (`expandLoops`).
 *
 * ## Which passes belong to the loop, and why it is a graph question
 *
 * The body is every node on a CURRENT-FRAME path from a consumer of the Feedback node's
 * output back into the Feedback node itself. That definition is what keeps the animated
 * noise driving a spatially-varying feed/kill map OUTSIDE the loop: the noise feeds the
 * cycle but the cycle does not feed the noise, so it is computed once per displayed frame
 * and read fifty times, which is both correct and what anyone would want.
 *
 * The traversal forward from the Feedback node deliberately follows CURRENT-FRAME edges
 * only after the first hop. A second feedback loop downstream is behind its own temporal
 * boundary, and iterating it as part of this one would step a state that is not ours.
 *
 * ## Why the passes are REORDERED
 *
 * Topological order does not put a loop's passes next to each other. E2's is `kernel`,
 * `out:present`, `feedback`, `swap` — the Output's blit sits in the middle, because
 * nothing until now cared. A contiguous region is what a begin/end marker pair can
 * delimit, so the plan is repartitioned into three groups whose relative order inside each
 * group is untouched: everything that FEEDS the loop, the loop, and everything else.
 * "Everything else" is where the Output lands, which is also where it belongs — it then
 * presents the last substep rather than the first.
 *
 * ## What it refuses (§V288)
 *
 * A second ping-pong swap or ring rotation sitting inside the span the reorder would move
 * across is a hazard this module will not paper over: the swap would end up on the wrong
 * side of passes that bind it, which shows up as a plausible picture reading a half-frame
 * behind rather than as a crash. Such a graph keeps its single-step plan and gets a
 * diagnostic that names the loop and the parameter.
 */

/** One feedback loop that asked for more than one iteration per frame. */
export interface SubstepLoop {
  /** The ping-pong pair's resource id — the loop's identity in the plan. */
  readonly loopId: string;
  /** The Feedback node closing the loop; the node a diagnostic names. */
  readonly nodeId: NodeId;
  /** Iterations per displayed frame, >= 2 (a loop of 1 is not emitted at all). */
  readonly count: number;
  /** Every node whose passes are inside the region. Includes the Feedback node. */
  readonly bodyNodes: ReadonlySet<NodeId>;
  /** The pair's swap, which closes each iteration. */
  readonly swapPassId: string;
}

export interface SubstepPlanInput {
  readonly temporalOutputs: ReadonlyArray<ResolvedOutput>;
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  readonly currentFrameEdges: ReadonlyArray<CompileEdge>;
  readonly temporalEdges: ReadonlyArray<CompileEdge>;
}

export interface SubstepPlan {
  readonly loops: ReadonlyArray<SubstepLoop>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

/**
 * Reads every temporal output's declared substep count and works out its loop body.
 *
 * A node that does not DECLARE a substeps parameter (`TemporalDefinition.substeps`) is
 * structurally incapable of asking for one — there is no naming convention to remember and
 * no key to guess.
 */
export function planSubstepLoops(input: SubstepPlanInput): SubstepPlan {
  const diagnostics: RuntimeDiagnostic[] = [];
  const loops: SubstepLoop[] = [];

  for (const output of input.temporalOutputs) {
    const resolved = input.nodes.get(output.nodeId);
    if (resolved === undefined) continue;
    const key = resolved.definition.temporal?.substeps;
    if (key === undefined) continue;

    const raw = resolved.parameters[key];
    const requested = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 1;
    if (requested <= 1) continue;
    /*
     * The ceiling is already enforced where a user meets it: the manifest declares
     * `max: MAX_SUBSTEPS`, so an over-range value is REFUSED by name at parameter
     * resolution ("Parameter \"substeps\" is 296, above its maximum 256") and the loop
     * falls back to one step per frame. This clamp is a contract guard, not a second
     * opinion — `readExecutionPlan` refuses a count above the ceiling, and refusing the
     * WHOLE PLAN over a number the user has already been told about would turn one loud
     * parameter error into a black frame.
     */
    const count = Math.min(requested, MAX_SUBSTEPS);

    const bodyNodes = loopBody(output.nodeId, output.portId, input);
    // A Feedback node whose output nothing consumes is a one-node "loop": iterating it
    // would re-copy the same input N times, which costs N times as much and changes
    // nothing. Say so rather than charging for it.
    if (bodyNodes.size < 2) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.substepsRefused,
          `Node "${output.nodeId}" asked for ${count} substeps, but nothing reads its output back into it: there is no loop to iterate.`,
          {
            nodeId: output.nodeId,
            suggestion: `Wire the loop (the Feedback's "source" naming a node that reads this output), or set "${key}" back to 1.`,
          },
        ),
      );
      continue;
    }

    loops.push({
      loopId: output.resourceId,
      nodeId: output.nodeId,
      count,
      bodyNodes,
      swapPassId: swapPassId(output.resourceId),
    });
  }

  return { loops, diagnostics };
}

/**
 * Nodes on a current-frame path from a consumer of `(nodeId, portId)` back into `nodeId`.
 *
 * The first hop crosses the temporal boundary (that IS the loop's back edge); every hop
 * after it is current-frame, so a second feedback loop downstream stays out.
 */
function loopBody(nodeId: NodeId, portId: string, input: SubstepPlanInput): ReadonlySet<NodeId> {
  const forwardOf = new Map<NodeId, NodeId[]>();
  const backwardOf = new Map<NodeId, NodeId[]>();
  const link = (map: Map<NodeId, NodeId[]>, from: NodeId, to: NodeId): void => {
    const list = map.get(from);
    if (list === undefined) map.set(from, [to]);
    else list.push(to);
  };
  for (const edge of input.currentFrameEdges) {
    link(forwardOf, edge.source.nodeId, edge.target.nodeId);
    link(backwardOf, edge.target.nodeId, edge.source.nodeId);
  }

  const seeds: NodeId[] = [];
  for (const edge of input.temporalEdges) {
    if (edge.source.nodeId === nodeId && edge.source.portId === portId) seeds.push(edge.target.nodeId);
  }

  const forward = closure(seeds, forwardOf);
  const backward = closure(backwardOf.get(nodeId) ?? [], backwardOf);

  const body = new Set<NodeId>([nodeId]);
  for (const candidate of forward) if (backward.has(candidate)) body.add(candidate);
  return body;
}

function closure(seeds: ReadonlyArray<NodeId>, edges: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>): Set<NodeId> {
  const seen = new Set<NodeId>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const next = stack.pop() as NodeId;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const onward of edges.get(next) ?? []) stack.push(onward);
  }
  return seen;
}

/** A pass as the compiler holds it before `readExecutionPlan` narrows it. */
type RawPass = Record<string, unknown>;

/**
 * Repartitions `passes` so each loop's body is contiguous, wrapped in begin/end markers.
 *
 * Returns the input unchanged when there is nothing to do, and refuses (with a diagnostic
 * naming the loop) rather than reordering across a swap it does not own.
 */
export function applySubstepLoops(
  passes: ReadonlyArray<RawPass>,
  loops: ReadonlyArray<SubstepLoop>,
  ancestorsOf: (bodyNodes: ReadonlySet<NodeId>) => ReadonlySet<NodeId>,
  diagnostics: RuntimeDiagnostic[],
): ReadonlyArray<RawPass> {
  if (loops.length === 0) return passes;

  /** A pass, or an already-wrapped loop region, kept together by later partitions. */
  interface Entry {
    readonly passes: ReadonlyArray<RawPass>;
    readonly nodeIds: ReadonlySet<NodeId>;
  }
  let entries: Entry[] = passes.map((pass) => ({
    passes: [pass],
    nodeIds: typeof pass["nodeId"] === "string" ? new Set([pass["nodeId"] as NodeId]) : new Set<NodeId>(),
  }));

  for (const loop of loops) {
    const inBody = (entry: Entry): boolean => {
      for (const id of entry.nodeIds) if (loop.bodyNodes.has(id)) return true;
      return entry.passes.some((pass) => pass["id"] === loop.swapPassId);
    };
    const bodyIndices = new Set(entries.flatMap((entry, index) => (inBody(entry) ? [index] : [])));
    if (bodyIndices.size === 0) continue;

    // §V288: a swap or rotation we do not own, sitting inside the span the reorder crosses,
    // would land on the wrong side of the passes that bind it. Refuse, loudly.
    const ordered = [...bodyIndices];
    const first = ordered[0] as number;
    const last = ordered[ordered.length - 1] as number;
    const trapped = entries.slice(first, last + 1).find(
      (entry, offset) =>
        !bodyIndices.has(first + offset) &&
        entry.passes.some((pass) => pass["kind"] === "swap" && pass["id"] !== loop.swapPassId),
    );
    if (trapped !== undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.substepsRefused,
          `Node "${loop.nodeId}" asked for ${loop.count} substeps, but another temporal pair swaps inside the loop; it runs one step per frame.`,
          {
            nodeId: loop.nodeId,
            suggestion:
              "Move the other feedback or cache out of this loop, or set Substeps back to 1 (§V22 places every swap after its last consumer).",
          },
        ),
      );
      continue;
    }

    const ancestors = ancestorsOf(loop.bodyNodes);
    const isAncestor = (entry: Entry): boolean => {
      for (const id of entry.nodeIds) if (ancestors.has(id)) return true;
      return false;
    };

    const before: Entry[] = [];
    const body: Entry[] = [];
    const after: Entry[] = [];
    entries.forEach((entry, index) => {
      if (bodyIndices.has(index)) body.push(entry);
      else if (isAncestor(entry)) before.push(entry);
      else after.push(entry);
    });

    const region: Entry = {
      passes: [
        { kind: "loop", id: `${loop.loopId}#loop:begin`, edge: "begin", loopId: loop.loopId, count: loop.count, nodeId: loop.nodeId },
        ...body.flatMap((entry) => [...entry.passes]),
        { kind: "loop", id: `${loop.loopId}#loop:end`, edge: "end", loopId: loop.loopId, nodeId: loop.nodeId },
      ],
      nodeIds: new Set(body.flatMap((entry) => [...entry.nodeIds])),
    };
    entries = [...before, region, ...after];
  }

  return entries.flatMap((entry) => [...entry.passes]);
}
