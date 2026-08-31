import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { plotValues } from "./value-function.ts";
import type { ValueFunctionPlot } from "./value-function.ts";

/**
 * T735 — a period travelling DOWN a value chain, so a Math node fed by an LFO can draw
 * its whole cycle instead of a sliding window over 2.2% of one.
 *
 * ## The defect this closes
 *
 * T459 gave pure value SOURCES a static full-cycle curve, and only the LFO declares
 * `plotPeriod`, so only LFO nodes got one. Every other value node — including the six
 * `valueMath` nodes the owner was watching — fell back to the 120-frame history plot with
 * T352's sticky auto-range. That window is two seconds; E33's LFOs run 16 to 91 seconds.
 *
 * The consequence was measured, and it is a CLIFF rather than a slope: with the window at
 * 2.2%-30% of a period the axis refits about 200 times a minute, at 50% it is 142 times,
 * and **at 100% and above it is exactly zero**. The moment one period fits in the window,
 * the refits stop. So the fix is not to soften the hysteresis — it is to make sure a
 * period fits, which for a static full-cycle curve it does by construction.
 *
 * T352's docblock stated its own precondition in prose — "a sliding window over a periodic
 * signal varies by a fraction of a percent" — which is true only when a period fits inside
 * the window, and nothing enforced it. §V478's shape: a property asserted in a comment and
 * checked nowhere.
 *
 * ## Why this reuses the value graph rather than walking the chain itself
 *
 * Drawing a Math node's cycle means evaluating its upstream at times the app has not
 * reached, and there is already exactly one thing that knows how a value node consumes its
 * inputs: `createValueGraphSession`. Re-implementing the wiring here — port merging, the
 * §V457 fold, silence propagation, Kahn order — would be a second copy of the semantics
 * that would drift from the first (§V29). So this cuts the chain out as a SUBGRAPH and
 * runs the real evaluator over it, in a throwaway session.
 *
 * Throwaway matters: §V275 forbids a second evaluation of a stateful stage, because a Lag
 * evaluated twice per frame runs at double rate purely because someone was looking at it.
 * A chain that reaches a stateful node is refused outright (below), so no stateful node is
 * ever inside one of these subgraphs — and the session is discarded either way, so nothing
 * it touches can reach the live one.
 */

/** A chain that can be drawn: the subgraph to evaluate, and the cycle it repeats on. */
export interface ValuePlotChain {
  /** Just the contributing nodes and the value edges between them. */
  readonly subgraph: GraphDocument;
  /** The node whose channels the plot wants. */
  readonly nodeId: NodeId;
  readonly periodSeconds: number;
}

/**
 * Periods agree when they are the same number to within floating-point noise. Two LFOs at
 * the same declared frequency must resolve to one period, and `1/0.062` computed twice is
 * not bitwise equal to itself in general.
 */
function samePeriod(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
}

/** The value input ports of a definition — the ports a period can arrive through. */
function valueInputIds(definition: NodeDefinition): ReadonlySet<string> {
  return new Set(
    definition.inputs.filter((port) => port.type.kind === "value").map((port) => port.id),
  );
}

/**
 * The period of `nodeId`'s output, and every node that contributes to it — or null when
 * this node has no drawable cycle, which is the common and safe answer.
 *
 * Refuses, deliberately, rather than guessing:
 *  - a node that neither declares a period nor propagates one (a Mouse, a Lag, a Timer);
 *  - a chain whose sources disagree on their period, whose output repeats on the common
 *    multiple and not on either, so one period of curve would not close;
 *  - a cycle in the graph, which the value graph reports as an error and which would
 *    otherwise spin this walk forever.
 */
export function resolveValuePlotChain(
  graph: GraphDocument,
  nodeId: NodeId,
  registry: NodeRegistryView,
): ValuePlotChain | null {
  const collected = new Set<NodeId>();
  const visiting = new Set<NodeId>();
  let period: number | null = null;

  /** Upstream value edges into one node, by the port they land on. */
  const feedersOf = (target: NodeId, ports: ReadonlySet<string>): NodeId[] => {
    const sources: NodeId[] = [];
    for (const edgeId of Object.keys(graph.edges).sort()) {
      const edge = graph.edges[edgeId];
      if (edge === undefined) continue;
      if (edge.target.nodeId !== target) continue;
      if (!ports.has(edge.target.portId)) continue;
      sources.push(edge.source.nodeId);
    }
    return sources;
  };

  const walk = (current: NodeId): boolean => {
    if (collected.has(current)) return true;
    // A wire loop. The value graph refuses to evaluate one (`valueGraph.cycle`), so there
    // is nothing to draw, and returning false here is also what stops this recursion.
    if (visiting.has(current)) return false;

    const node = graph.nodes[current];
    if (node === undefined) return false;
    const definition = registry.get(node.type);
    if (definition === undefined) return false;

    const declared = definition.plotPeriod?.(plotValues(definition, node.parameters)) ?? null;
    if (declared !== null) {
      // A SOURCE with a cycle. It ends the walk on this branch — a node that declares its
      // own period does not inherit one, whatever is upstream of it.
      if (!Number.isFinite(declared) || declared <= 0) return false;
      if (period !== null && !samePeriod(period, declared)) return false;
      period = declared;
      collected.add(current);
      return true;
    }

    if (definition.plotPeriodFollowsInputs !== true) return false;

    const ports = valueInputIds(definition);
    const feeders = feedersOf(current, ports);
    // A transform with nothing wired in has no period to inherit — its output is whatever
    // its parameters say, which is a constant, and a constant has no cycle to draw.
    if (feeders.length === 0) return false;

    visiting.add(current);
    for (const feeder of feeders) {
      if (!walk(feeder)) {
        visiting.delete(current);
        return false;
      }
    }
    visiting.delete(current);
    collected.add(current);
    return true;
  };

  if (!walk(nodeId)) return null;
  if (period === null || !Number.isFinite(period) || period <= 0) return null;

  const nodes: GraphDocument["nodes"] = {};
  for (const id of collected) {
    const node = graph.nodes[id];
    if (node !== undefined) nodes[id] = node;
  }
  const edges: GraphDocument["edges"] = {};
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (edge === undefined) continue;
    if (collected.has(edge.source.nodeId) && collected.has(edge.target.nodeId)) {
      edges[edgeId] = edge;
    }
  }

  return {
    subgraph: { revision: graph.revision, nodes, edges, groups: {} },
    nodeId,
    periodSeconds: period,
  };
}

export interface ChainSampleOptions {
  readonly samples: number;
  readonly randomSeed: number;
}

/**
 * One cycle of the chain's output, channel by channel, anchored at t=0.
 *
 * Anchored rather than sliding for T459's reason: the picture of the shape must hold
 * still while the playhead moves across it. The absolute clock is set explicitly — the
 * LFO reads `absTimeSecondsOf`, which falls back to `timeSeconds`, and setting both keeps
 * the curve on the same clock the running node is on rather than on whichever one the
 * fallback happened to pick.
 */
export function sampleValueChain(
  chain: ValuePlotChain,
  registry: NodeRegistryView,
  options: ChainSampleOptions,
): { readonly channels: ReadonlyMap<string, number[]> } {
  const count = Math.max(2, options.samples);
  const step = chain.periodSeconds / count;
  const session = createValueGraphSession(registry);
  const channels = new Map<string, number[]>();

  for (let index = 0; index < count; index += 1) {
    const timeSeconds = index * step;
    const result = session.evaluate(chain.subgraph, {
      timeSeconds,
      deltaSeconds: step,
      frameIndex: index,
      mode: "fixed-step",
      randomSeed: options.randomSeed,
      wallSeconds: timeSeconds,
      wallDeltaSeconds: step,
      absFrameIndex: index,
      absTimeSeconds: timeSeconds,
    });
    const bag = result.byId.get(chain.nodeId) ?? {};
    for (const [name, value] of Object.entries(bag)) {
      let series = channels.get(name);
      if (series === undefined) {
        // A channel that appears late starts with the zeros it would have drawn anyway;
        // in practice a stateless chain publishes the same names on every sample.
        series = new Array<number>(index).fill(0);
        channels.set(name, series);
      }
      series.push(Number.isFinite(value) ? value : 0);
    }
    for (const [name, series] of channels) {
      if (series.length === index) series.push(0);
      void name;
    }
  }

  return { channels };
}

/**
 * The chain's cycle in the shape the plot draws (T735), or null when it has no channels.
 *
 * `timeSeconds` is the ABSOLUTE clock, and that is load-bearing rather than incidental —
 * see T495. The curve is evaluated against `absTimeSeconds`, so a playhead placed by any
 * other clock marks a point on a curve it does not belong to. Passing null draws the curve
 * with no marker, which is the honest answer when no frame time is known (§V123).
 */
export function sampleValueChainPlot(
  chain: ValuePlotChain,
  registry: NodeRegistryView,
  options: ChainSampleOptions & { readonly timeSeconds: number | null },
): ValueFunctionPlot | null {
  const { channels } = sampleValueChain(chain, registry, options);
  if (channels.size === 0) return null;
  // The `value` channel is the convention for a single-channel bag; anything else takes
  // the first name in sorted order so the choice is stable between renders.
  const series =
    channels.get("value") ?? channels.get([...channels.keys()].sort()[0] as string) ?? null;
  if (series === null || series.length === 0) return null;

  if (options.timeSeconds === null) {
    return { series, periodSeconds: chain.periodSeconds, phase: null };
  }
  const cycles = options.timeSeconds / chain.periodSeconds;
  const phase = cycles - Math.floor(cycles);
  return {
    series,
    periodSeconds: chain.periodSeconds,
    phase: Number.isFinite(phase) ? phase : null,
  };
}
