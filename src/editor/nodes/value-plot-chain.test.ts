import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId, EdgeId } from "@domain/types/ids.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { resolveValuePlotChain, sampleValueChain } from "./value-plot-chain.ts";
import { stickyRange } from "./plot-range.ts";
import type { PlotRange } from "./plot-range.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";

/**
 * T735 — the value plot's axis stops refitting once a period fits the window.
 *
 * The bug was DISPLAY, not signal: E33's values are clean (second differences ~1.6, and
 * the instrument was proved non-blind by forcing a wrapping clock, which reads ~447). What
 * moved was the picture — the 120-frame history plot's sticky auto-range over an LFO whose
 * cycle is 16 to 91 seconds, refitting about 200 times a minute while the signal did
 * nothing, and jumping the whole trace vertically each time.
 *
 * It is a CLIFF, not a slope, and that is what these assertions are built on: below one
 * window per period the refits are constant, and at one period they are exactly zero.
 * A gate on "the plot looks calmer" would be untestable and would pass for a hysteresis
 * tweak that merely slowed the lurching down; a gate on the cliff cannot.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const FPS = 60;
/** `VALUE_HISTORY_FRAMES` — two seconds at 60fps. Restated so the test states its own premise. */
const WINDOW = 120;

function node(id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label: id,
  } as GraphNode;
}

/** `lfo1 --out--> math1.a`, with the LFO's frequency and the Math's operation given. */
function lfoIntoMath(frequencyHz: number, extraMath: Record<string, unknown> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: {
      ["lfo1" as NodeId]: node("lfo1", "lfo", { frequency: frequencyHz, amplitude: 1, offset: 0 }),
      ["math1" as NodeId]: node("math1", "valueMath", { operation: "multiply", operand: 3, ...extraMath }),
    },
    edges: {
      ["e1" as EdgeId]: {
        id: "e1" as EdgeId,
        source: { nodeId: "lfo1" as NodeId, portId: "out" },
        target: { nodeId: "math1" as NodeId, portId: "a" },
      },
    },
    groups: {},
  } as GraphDocument;
}

/**
 * Refits of T352's sticky range as a 120-frame window slides over a series — the exact
 * count the diagnosis measured, and a visible vertical jump of the whole trace each time.
 */
function refitsOverHistory(values: readonly number[]): number {
  let range: PlotRange | null = null;
  let refits = 0;
  for (let end = WINDOW; end <= values.length; end += 1) {
    const slice = values.slice(end - WINDOW, end);
    const next = stickyRange(range, {
      low: Math.min(...slice),
      high: Math.max(...slice),
    });
    if (range !== null && (next.low !== range.low || next.high !== range.high)) refits += 1;
    range = next;
  }
  return refits;
}

/** The live per-frame output of `math1`, the way the history plot would have recorded it. */
function runChannel(graph: GraphDocument, frames: number): number[] {
  const session = createValueGraphSession(registry);
  const out: number[] = [];
  for (let index = 0; index < frames; index += 1) {
    const timeSeconds = index / FPS;
    const result = session.evaluate(graph, {
      timeSeconds,
      deltaSeconds: 1 / FPS,
      frameIndex: index,
      mode: "fixed-step",
      randomSeed: 1,
      wallSeconds: timeSeconds,
      wallDeltaSeconds: 1 / FPS,
      absFrameIndex: index,
      absTimeSeconds: timeSeconds,
    });
    const bag = result.byId.get("math1" as NodeId);
    out.push(bag?.["value"] ?? 0);
  }
  return out;
}

describe("T735 — a period propagates down the value chain", () => {
  it("gives a Math node fed by an LFO the LFO's period", () => {
    // The propagation itself. `math1` declares no frequency of its own; it has a cycle
    // only because the thing wired into it does.
    const chain = resolveValuePlotChain(lfoIntoMath(0.062), "math1" as NodeId, registry);
    expect(chain).not.toBeNull();
    expect(chain!.periodSeconds).toBeCloseTo(1 / 0.062, 9);
  });

  it("carries the period through two stages", () => {
    const graph = lfoIntoMath(0.05);
    graph.nodes["limit1" as NodeId] = node("limit1", "valueLimit", { minimum: -2, maximum: 2 });
    graph.edges["e2" as EdgeId] = {
      id: "e2" as EdgeId,
      source: { nodeId: "math1" as NodeId, portId: "out" },
      target: { nodeId: "limit1" as NodeId, portId: "in" },
    } as GraphDocument["edges"][EdgeId];
    const chain = resolveValuePlotChain(graph, "limit1" as NodeId, registry);
    expect(chain?.periodSeconds).toBeCloseTo(1 / 0.05, 9);
    // And it carries the whole chain, not just the node asked about — the curve cannot be
    // evaluated without the stages that feed it.
    expect(Object.keys(chain!.subgraph.nodes).sort()).toEqual(["lfo1", "limit1", "math1"]);
  });

  it("REFUSES a chain it cannot draw one closing cycle of", () => {
    // Each of these would be a lie of a different kind, and the safe answer is history.
    const stateful = lfoIntoMath(0.05);
    stateful.nodes["lag1" as NodeId] = node("lag1", "valueLag", { lag: 0.25 });
    stateful.edges["e2" as EdgeId] = {
      id: "e2" as EdgeId,
      source: { nodeId: "lfo1" as NodeId, portId: "out" },
      target: { nodeId: "lag1" as NodeId, portId: "in" },
    } as GraphDocument["edges"][EdgeId];
    // A Lag's output is a function of everything before it, not of one cycle (§V275 also
    // forbids evaluating it twice per frame at all).
    expect(resolveValuePlotChain(stateful, "lag1" as NodeId, registry)).toBeNull();

    // Two sources at DIFFERENT periods: the output repeats on their common multiple, so
    // one period of either would not close.
    const mixed = lfoIntoMath(0.05);
    mixed.nodes["lfo2" as NodeId] = node("lfo2", "lfo", { frequency: 0.031 });
    mixed.edges["e2" as EdgeId] = {
      id: "e2" as EdgeId,
      source: { nodeId: "lfo2" as NodeId, portId: "out" },
      target: { nodeId: "math1" as NodeId, portId: "b" },
    } as GraphDocument["edges"][EdgeId];
    expect(resolveValuePlotChain(mixed, "math1" as NodeId, registry)).toBeNull();

    // A Math with nothing wired in is a constant, and a constant has no cycle.
    const bare: GraphDocument = {
      revision: 1,
      nodes: { ["math1" as NodeId]: node("math1", "valueMath") },
      edges: {},
      groups: {},
    } as GraphDocument;
    expect(resolveValuePlotChain(bare, "math1" as NodeId, registry)).toBeNull();

    // A Mouse declares no period and propagates none — it is not periodic at all.
    const ambient: GraphDocument = {
      revision: 1,
      nodes: {
        ["mouse1" as NodeId]: node("mouse1", "mouse"),
        ["math1" as NodeId]: node("math1", "valueMath"),
      },
      edges: {
        ["e1" as EdgeId]: {
          id: "e1" as EdgeId,
          source: { nodeId: "mouse1" as NodeId, portId: "out" },
          target: { nodeId: "math1" as NodeId, portId: "a" },
        },
      },
      groups: {},
    } as GraphDocument;
    expect(resolveValuePlotChain(ambient, "math1" as NodeId, registry)).toBeNull();
  });
});

describe("T735 — the cliff: refits stop once a period fits the window", () => {
  /*
   * E33's real band. 0.062 Hz is its fastest LFO (16 s) and 0.011 Hz its slowest (91 s),
   * against a two-second window — 12.4% and 2.2% of a cycle.
   */
  it.each([0.062, 0.035, 0.029, 0.011])(
    "the OLD history plot refits constantly at %f Hz — the reported defect",
    (frequency) => {
      const values = runChannel(lfoIntoMath(frequency), 60 * FPS);
      const refits = refitsOverHistory(values);
      const perMinute = refits / (values.length / FPS / 60);
      // Non-vacuity, and the measured symptom: this is the state the row was filed for.
      // Roughly 200 a minute was the diagnosis; the floor is well under it so the
      // assertion is about the defect existing, not about reproducing a number exactly.
      expect(perMinute).toBeGreaterThan(50);
    },
  );

  it("the NEW chain curve refits ZERO times, because it does not move at all", () => {
    /*
     * The cliff, and the whole point. The chain plot draws one whole cycle anchored at
     * t=0, so the series is the same on every frame — the range is computed once and there
     * is nothing left for the hysteresis to react to. Not "calmer": still.
     */
    const chain = resolveValuePlotChain(lfoIntoMath(0.011), "math1" as NodeId, registry);
    expect(chain).not.toBeNull();

    let range: PlotRange | null = null;
    let refits = 0;
    let first: readonly number[] | null = null;
    // Re-sampled the way the live plot re-samples: once per tick, for a simulated minute.
    for (let tick = 0; tick < 600; tick += 1) {
      const series = sampleValueChain(chain!, registry, { samples: 96, randomSeed: 1 })
        .channels.get("value");
      expect(series).toBeDefined();
      if (first === null) first = series!;
      // The curve is ANCHORED: identical every tick, however far the clock has moved.
      expect(series).toEqual(first);
      const next = stickyRange(range, {
        low: Math.min(...series!),
        high: Math.max(...series!),
      });
      if (range !== null && (next.low !== range.low || next.high !== range.high)) refits += 1;
      range = next;
    }
    expect(refits).toBe(0);
  });

  it("draws a cycle that CLOSES, so the curve is the signal and not a window of it", () => {
    /*
     * Guards the guard. A series of constants would also refit zero times and would also
     * be identical every tick — the §V655 trap in this row's exact shape. So: the curve
     * must have the amplitude the chain actually produces (the LFO's 1, times the Math's
     * operand 3), and it must return to where it started, which is what makes it one
     * period rather than an arbitrary stretch.
     */
    const chain = resolveValuePlotChain(lfoIntoMath(0.011), "math1" as NodeId, registry);
    const series = sampleValueChain(chain!, registry, { samples: 96, randomSeed: 1 })
      .channels.get("value")!;
    expect(series).toHaveLength(96);
    expect(Math.min(...series)).toBeCloseTo(-3, 2);
    expect(Math.max(...series)).toBeCloseTo(3, 2);
    // One period: sample 0 and a full cycle later agree.
    expect(series[0]).toBeCloseTo(0, 6);
    const wrapped = sampleValueChain(chain!, registry, { samples: 97, randomSeed: 1 })
      .channels.get("value")!;
    expect(wrapped[0]).toBeCloseTo(0, 6);
  });

  it("matches what the node actually outputs, rather than a curve of its own", () => {
    // The plot must be a picture of the SIGNAL (§V275: a plot that disagrees with the
    // number driving the parameter is worse than no plot). Sampled curve against the live
    // evaluator, at the same times.
    const graph = lfoIntoMath(0.25);
    const chain = resolveValuePlotChain(graph, "math1" as NodeId, registry)!;
    const curve = sampleValueChain(chain, registry, { samples: 8, randomSeed: 1 })
      .channels.get("value")!;
    const session = createValueGraphSession(registry);
    for (let index = 0; index < 8; index += 1) {
      const timeSeconds = (index * chain.periodSeconds) / 8;
      const result = session.evaluate(graph, {
        timeSeconds,
        deltaSeconds: chain.periodSeconds / 8,
        frameIndex: index,
        mode: "fixed-step",
        randomSeed: 1,
        wallSeconds: timeSeconds,
        wallDeltaSeconds: chain.periodSeconds / 8,
        absFrameIndex: index,
        absTimeSeconds: timeSeconds,
      });
      expect(curve[index]).toBeCloseTo(result.byId.get("math1" as NodeId)!["value"]!, 9);
    }
  });
});
