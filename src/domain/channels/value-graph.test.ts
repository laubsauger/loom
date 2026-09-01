import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createValueGraphSession } from "./value-graph.ts";
import { valueFilterNode, valueLagNode } from "../../nodes/definitions/value-graph-nodes.ts";

/**
 * The value graph (T273-T277, §V179): `mouse1 → lag1 → parameter` as a GRAPH — ordered,
 * cycle-rejecting, stateful where declared, deterministic always.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    label: id,
    ...extra,
  };
}

function graphOf(nodes: GraphNode[], edges: Array<[string, string, string, string]>): GraphDocument {
  const edgeRecord: Record<string, unknown> = {};
  edges.forEach(([sn, sp, tn, tp], index) => {
    edgeRecord[`e${index}`] = { id: `e${index}`, source: { nodeId: sn, portId: sp }, target: { nodeId: tn, portId: tp } };
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edgeRecord,
    groups: {},
  } as unknown as GraphDocument;
}

const frameAt = (timeSeconds: number, deltaSeconds = 1 / 60): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 7,
});

describe("value graph evaluation (T273/T274)", () => {
  it("evaluates a chain in topological order, channel bags flowing through", () => {
    // mouse → math(×2) → limit(0..1): per-channel through the whole chain.
    const graph = graphOf(
      [
        node("mouse1", "mouse"),
        node("math1", "valueMath", { parameters: { operation: "multiply", operand: 2 } }),
        node("limit1", "valueLimit"),
      ],
      [
        ["mouse1", "out", "math1", "a"],
        ["math1", "out", "limit1", "in"],
      ],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0), { pointer: { x: 0.3, y: 0.9, buttons: 1 } });

    expect(result.diagnostics).toEqual([]);
    expect(result.byName.get("mouse1")).toEqual({ x: 0.3, y: 0.9, buttons: 1 });
    expect(result.byName.get("math1")).toEqual({ x: 0.6, y: 1.8, buttons: 2 });
    expect(result.byName.get("limit1")).toEqual({ x: 0.6, y: 1, buttons: 1 });

    // T274 addressing: `name:channel` reads a named channel; bare `name` needs `value`.
    expect(result.resolver("limit1:y", {} as never)).toBe(1);
    expect(result.resolver("limit1:x", {} as never)).toBe(0.6);
    expect(result.resolver("nope:x", {} as never)).toBeUndefined();
  });

  it("keeps the trio addressable as the degenerate case — an LFO is a one-channel bag", () => {
    const graph = graphOf([node("lfo1", "lfo", { parameters: { shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0 } })], []);
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0.25));
    expect(result.resolver("lfo1", {} as never)).toBeCloseTo(1, 10);
    expect(result.resolver("lfo1:value", {} as never)).toBeCloseTo(1, 10);
  });

  it("rejects a cycle with a diagnostic; the members emit nothing, nothing hangs (§V152)", () => {
    const graph = graphOf(
      [node("m1", "valueMath"), node("m2", "valueMath")],
      [
        ["m1", "out", "m2", "a"],
        ["m2", "out", "m1", "a"],
      ],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0));
    expect(result.diagnostics.some((d) => d.code === "valueGraph.cycle")).toBe(true);
    expect(result.byName.get("m1")).toBeUndefined();
  });
});

/**
 * T509 — the merge stays (V457: last-wins over sorted edge ids, deliberately); the
 * SILENCE was the bug. Two LFOs both publish `value`; wiring both into one port made
 * one vanish with no symptom anywhere. The diagnostic names the port, both sources
 * and the winner — and a clash-free merge stays clean, so the warning cannot become
 * noise on every composed bag.
 */
describe("a shadowed channel says so (T509)", () => {
  it("two sources supplying one channel name on one port warn, naming winner and loser", () => {
    const session = createValueGraphSession(registry);
    const graph = graphOf(
      [
        node("lfoA", "lfo"),
        node("lfoB", "lfo"),
        node("lag1", "valueLag"),
      ],
      [
        ["lfoA", "out", "lag1", "in"],
        ["lfoB", "out", "lag1", "in"],
      ],
    );
    const result = session.evaluate(graph, frameAt(0));
    const shadowed = result.diagnostics.filter((d) => d.code === "valueGraph.channelShadowed");
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]?.severity).toBe("warning");
    // Sorted edge ids: e1 (lfoB) arrives after e0 (lfoA), so lfoB wins and lfoA is named
    // as ignored — the exact fact the user needs to pick a wire to cut.
    expect(shadowed[0]?.message).toContain('"lfoB" wins');
    expect(shadowed[0]?.message).toContain('"lfoA"');
    expect(shadowed[0]?.message).toContain('"value"');
    // And the merge behaviour itself is UNCHANGED: the winner's value flows.
    expect(shadowed[0]?.nodeId).toBe("lag1");
  });

  it("a clash-free composition stays silent — the warning is for losses, not for merges", () => {
    const session = createValueGraphSession(registry);
    // One source: nothing shadowed, nothing to say.
    const graph = graphOf(
      [node("lfoA", "lfo"), node("lag1", "valueLag")],
      [["lfoA", "out", "lag1", "in"]],
    );
    const result = session.evaluate(graph, frameAt(0));
    expect(result.diagnostics.filter((d) => d.code === "valueGraph.channelShadowed")).toEqual([]);
  });
});

describe("stateful stages (T276/T277, §V181)", () => {
  it("lag eases toward the input across frames, and reset() clears the trajectory", () => {
    const graph = graphOf(
      [node("mouse1", "mouse"), node("lag1", "valueLag", { parameters: { lag: 0.1 } })],
      [["mouse1", "out", "lag1", "in"]],
    );
    const session = createValueGraphSession(registry);
    const at = (t: number, x: number) =>
      session.evaluate(graph, frameAt(t), { pointer: { x, y: 0, buttons: 0 } }).byName.get("lag1")?.["x"] ?? NaN;

    expect(at(0, 0)).toBe(0); // first sight starts ON the input — no swoop-in
    const step1 = at(1 / 60, 1); // input jumps to 1; the lag chases
    const step2 = at(2 / 60, 1);
    expect(step1).toBeGreaterThan(0);
    expect(step1).toBeLessThan(1);
    expect(step2).toBeGreaterThan(step1); // monotone convergence

    session.reset();
    expect(at(0, 1)).toBe(1); // §V181: state cleared; first sight again
  });

  it("slope differentiates per channel; trigger pulses exactly once per crossing", () => {
    const graph = graphOf(
      [
        node("mouse1", "mouse"),
        node("slope1", "valueSlope"),
        node("trig1", "valueTrigger", { parameters: { threshold: 0.5 } }),
      ],
      [
        ["mouse1", "out", "slope1", "in"],
        ["mouse1", "out", "trig1", "in"],
      ],
    );
    const session = createValueGraphSession(registry);
    const step = (t: number, x: number) => session.evaluate(graph, frameAt(t), { pointer: { x, y: 0, buttons: 0 } });

    step(0, 0);
    const rising = step(1 / 60, 0.6);
    expect(rising.byName.get("slope1")?.["x"]).toBeCloseTo(0.6 * 60, 6);
    expect(rising.byName.get("trig1")?.["x"]).toBe(1); // the crossing frame
    const held = step(2 / 60, 0.7);
    expect(held.byName.get("trig1")?.["x"]).toBe(0); // a pulse, not a level
  });

  it("drops state for nodes that left the document — no inherited trajectories", () => {
    const withLag = graphOf(
      [node("mouse1", "mouse"), node("lag1", "valueLag", { parameters: { lag: 1 } })],
      [["mouse1", "out", "lag1", "in"]],
    );
    const session = createValueGraphSession(registry);
    session.evaluate(withLag, frameAt(0), { pointer: { x: 1, y: 0, buttons: 0 } });

    const without = graphOf([node("mouse1", "mouse")], []);
    session.evaluate(without, frameAt(1 / 60), { pointer: { x: 0, y: 0, buttons: 0 } });

    // lag1 comes back: fresh state, first sight is ON the new input, not the old 1.0.
    const returned = session.evaluate(withLag, frameAt(2 / 60), { pointer: { x: 0, y: 0, buttons: 0 } });
    expect(returned.byName.get("lag1")?.["x"]).toBe(0);
  });
});

describe("value nodes and the GPU plan (T273, §V179)", () => {
  it("a value chain compiles alongside a texture chain: no passes, no resources, no dead badges", async () => {
    const { compileGraph } = await import("../../compiler/compile.ts");
    const graph = graphOf(
      [
        node("gen", "solid"),
        node("sink", "output"),
        node("mouse1", "mouse"),
        node("lag1", "valueLag"),
      ],
      [
        ["gen", "out", "sink", "input"],
        ["mouse1", "out", "lag1", "in"],
      ],
    );
    const compiled = compileGraph({
      graph,
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba16float",
        randomSeed: 1,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Never in the GPU plan: no pass, no resource carries a value node's id...
    expect(compiled.passes.some((p) => "nodeId" in p && (p["nodeId"] === "mouse1" || p["nodeId"] === "lag1"))).toBe(false);
    // ...and never reported dead either (§V173): by-design non-residents.
    expect(compiled.pruned).toEqual([]);
  });
});

describe("channelIn (T654, §V615) — the external crossing", () => {
  // channelIn exists so a channel produced OUTSIDE the value graph (analyze's GPU
  // readback, via session extras) can enter it, get processed, and drive a parameter.
  // These gates pin the seam: extras.channels reaches valueEvaluate, the measured
  // number flows through downstream math, and every absence lands on `fallback` —
  // loudly steady, never NaN, never a stall.
  it("reads an external channel through extras.channels and feeds downstream math", () => {
    const graph = graphOf(
      [
        node("in1", "channelIn", { parameters: { channel: "meter1", fallback: 0.5 } }),
        node("math1", "valueMath", { parameters: { operation: "multiply", operand: 2 } }),
      ],
      [["in1", "out", "math1", "a"]],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0), {
      channels: (name) => (name === "meter1" ? 0.25 : undefined),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.byName.get("in1")).toEqual({ value: 0.25 });
    expect(result.byName.get("math1")).toEqual({ value: 0.5 });
  });

  it("falls back — resolver absent, name unanswered, or name blank — and says so with a steady number", () => {
    const doc = (parameters: GraphNode["parameters"]) =>
      graphOf([node("in1", "channelIn", { parameters })], []);
    const session = createValueGraphSession(registry);

    // No extras.channels at all: a headless evaluate that wired nothing.
    expect(session.evaluate(doc({ channel: "meter1", fallback: 0.7 }), frameAt(0)).byName.get("in1")).toEqual({ value: 0.7 });

    // A resolver that does not know the name.
    expect(
      session.evaluate(doc({ channel: "ghost", fallback: -1 }), frameAt(0), { channels: () => undefined }).byName.get("in1"),
    ).toEqual({ value: -1 });

    // A blank name never queries the resolver — an unconfigured node is fallback, not a lookup of "".
    let asked = 0;
    const result = session.evaluate(doc({ channel: "  ", fallback: 3 }), frameAt(0), {
      channels: () => {
        asked += 1;
        return 9;
      },
    });
    expect(result.byName.get("in1")).toEqual({ value: 3 });
    expect(asked).toBe(0);
  });

  it("reads EXTERNAL channels only — a sibling value node's channel is not in scope", () => {
    // The value graph's own channels travel by WIRE (§V349). channelIn naming a
    // sibling lfo answers fallback, not the lfo — otherwise it would be a second,
    // orderless way to plumb the same graph.
    const graph = graphOf(
      [
        node("lfo1", "lfo", { parameters: { shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0 } }),
        node("in1", "channelIn", { parameters: { channel: "lfo1", fallback: 42 } }),
      ],
      [],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0.25), { channels: () => undefined });
    expect(result.byName.get("in1")).toEqual({ value: 42 });
  });
});

/**
 * T814 — THE SMOOTHING FAMILY GROWS TWO KNOBS, AND BOTH HAVE TO BE FREE AT REST.
 *
 * The owner's complaint was that Filter had exactly one parameter. What went on is a
 * RELEASE RATIO (both twins, unitless, so it means one thing in seconds and in hertz) and a
 * MODE (Filter only — the high-pass is the low-pass's residual, and "Lag" is the wrong word
 * for a node that outputs one).
 *
 * Every assertion here is an EXACT value against the closed form rather than a range,
 * because the closed form is the thing that must not move (§V218): a range assertion
 * tolerates exactly the drift this block exists to catch. The identity claim is measured on
 * the picture separately — the ten shipped examples containing a Lag render byte-identically
 * before and after — and this is the arithmetic underneath it, where an exact answer exists.
 */
describe("T814 — asymmetric release and the high-pass tap", () => {
  const DT = 1 / 60;

  /** One smoothing stage fed by the pointer, so the input is ours to move frame by frame. */
  function chain(type: string, parameters: GraphNode["parameters"]): GraphDocument {
    return graphOf([node("src", "mouse"), node("stage", type, { parameters })], [["src", "out", "stage", "in"]]);
  }

  /** Runs `xs` through one stage, one frame each, and returns the stage's `x` channel. */
  function trajectory(
    graph: GraphDocument,
    xs: readonly number[],
    clock: readonly number[] = xs.map((_x, index) => index * DT),
  ): number[] {
    const session = createValueGraphSession(registry);
    return xs.map((x, index) => {
      const frame = frameAt(clock[index] ?? 0, DT);
      const bag = session.evaluate(graph, frame, { pointer: { x, y: 0, buttons: 0 } }).byName.get("stage");
      return bag?.["x"] ?? NaN;
    });
  }

  it("ships both knobs NEUTRAL, so an existing document meets the node it already had", () => {
    // The manifest half of the identity claim: flip either default and this reddens before
    // anyone has to notice a picture changed.
    expect(valueLagNode.parameters?.["releaseRatio"]).toMatchObject({ type: "number", default: 1 });
    expect(valueFilterNode.parameters?.["releaseRatio"]).toMatchObject({ type: "number", default: 1 });
    expect(valueFilterNode.parameters?.["mode"]).toMatchObject({ type: "enum", default: "lowpass" });
  });

  it("ratio 1 IS the one-pole this node always was — omitted and 1 agree, to the closed form", () => {
    const lag = 0.2;
    const k = 1 - Math.exp(-DT / lag);
    // Two frames rising, then a frame falling: at ratio 1 the fall uses the SAME coefficient,
    // which is precisely the behaviour every shipped document was tuned against.
    const rise1 = 0 + (1 - 0) * k;
    const rise2 = rise1 + (1 - rise1) * k;
    const fall = rise2 + (0 - rise2) * k;

    const omitted = trajectory(chain("valueLag", { lag }), [0, 1, 1, 0]);
    expect(omitted).toEqual([0, rise1, rise2, fall]);
    // Not "close to": the same doubles. `attack * 1 === attack`, so there is one coefficient.
    expect(trajectory(chain("valueLag", { lag, releaseRatio: 1 }), [0, 1, 1, 0])).toEqual(omitted);
  });

  it("ratio 4 leaves the RISE untouched and slows only the FALL — fast attack, slow release", () => {
    const lag = 0.2;
    const kRise = 1 - Math.exp(-DT / lag);
    const kFall = 1 - Math.exp(-DT / (lag * 4));
    const rise1 = 0 + (1 - 0) * kRise;
    const rise2 = rise1 + (1 - rise1) * kRise;

    const asymmetric = trajectory(chain("valueLag", { lag, releaseRatio: 4 }), [0, 1, 1, 0]);
    // The rise is bit-identical to the symmetric run: the ratio must not cost attack speed.
    expect(asymmetric.slice(0, 3)).toEqual(trajectory(chain("valueLag", { lag }), [0, 1, 1, 0]).slice(0, 3));
    expect(asymmetric[3]).toBe(rise2 + (0 - rise2) * kFall);
    // And the shape claim in words, so a sign error cannot pass the arithmetic above:
    // one frame of falling covers LESS ground than one frame of rising.
    expect(kFall).toBeLessThan(kRise);
    expect(asymmetric[3]).toBeGreaterThan(rise2 + (0 - rise2) * kRise);
  });

  it("a ratio below 1 mirrors it: snap down, ease up — the knob is not one-sided", () => {
    const lag = 0.2;
    const kFast = 1 - Math.exp(-DT / (lag * 0.25));
    const run = trajectory(chain("valueLag", { lag, releaseRatio: 0.25 }), [0, 1, 1, 0]);
    expect(run[3]).toBe((run[2] ?? NaN) + (0 - (run[2] ?? NaN)) * kFast);
    expect(run[3]).toBeLessThan(0.5);
  });

  it("stays DELTA-DRIVEN with the ratio on: a timeline lap cannot reach the held value (§V436)", () => {
    // §V453 makes this the author's decision, not a default, and the ratio is exactly the
    // shape that could smuggle a second clock in — "how long have I been falling" would be a
    // clock POSITION. It is not: direction is this frame's input against the held state.
    // So a clock that jumps BACKWARDS mid-run, with the frame STEP unchanged (T464), must
    // produce the same trajectory as a clock that never wrapped.
    const graph = chain("valueLag", { lag: 0.2, releaseRatio: 6 });
    const xs = [0, 1, 1, 0, 0, 1, 0];
    const straight = [0, 1, 2, 3, 4, 5, 6].map((index) => index * DT);
    const lapped = [0, 1, 2, 0, 1, 2, 0].map((index) => index * DT); // the loop, twice
    expect(trajectory(graph, xs, lapped)).toEqual(trajectory(graph, xs, straight));
  });

  it("mode lowpass is the Filter that shipped — omitted and named agree exactly", () => {
    const xs = [0, 1, 1, 1, 0, 0];
    const omitted = trajectory(chain("valueFilter", { cutoff: 3 }), xs);
    expect(trajectory(chain("valueFilter", { cutoff: 3, mode: "lowpass" }), xs)).toEqual(omitted);
    // Non-vacuous: the run has to actually MOVE, or every mode would "agree".
    expect(new Set(omitted).size).toBeGreaterThan(3);
  });

  it("high-pass IS the residual: low + high === input every frame, and steady reads zero", () => {
    // Why the mode was nearly free, stated as the thing that must stay true. If this ever
    // fails, the high-pass has grown a second pole and stopped being a tap on the first.
    const cutoff = 3;
    const k = 1 - Math.exp(-DT / (1 / (2 * Math.PI * cutoff)));
    const xs = [0, ...Array.from({ length: 16 }, () => 1), 0, 0];
    const low = trajectory(chain("valueFilter", { cutoff }), xs);
    const high = trajectory(chain("valueFilter", { cutoff, mode: "highpass" }), xs);

    // THE EXACT TRAJECTORY, iterated the way the node iterates it (§V218) — not a bound.
    let heldValue = 0;
    const expectedLow = xs.map((x, index) => {
      heldValue = index === 0 ? x : heldValue + (x - heldValue) * k;
      return heldValue;
    });
    expect(low).toEqual(expectedLow);
    expect(high).toEqual(expectedLow.map((value, index) => (xs[index] ?? NaN) - value));

    // It opens at 0 rather than at the signal's level: first sight holds the input, so the
    // residual is zero — a transient reading from the very first frame.
    expect(high[0]).toBe(0);
    // The transient: the frame the step lands is the largest reading in the run.
    expect(high[1]).toBe(Math.max(...high));
    expect(high[1]).toBeGreaterThan(0.7);
    // And it DECAYS, strictly, for as long as the input holds: what is steady is not a
    // transient. By frame 16 — a quarter of a second of an unchanging signal — it is gone.
    for (let index = 2; index <= 16; index += 1) {
      expect(high[index], `frame ${String(index)}`).toBeLessThan(high[index - 1] ?? NaN);
    }
    expect(high[16]).toBeLessThan(0.01);
    // A fall is a transient too, and it reads negative — direction survives the tap.
    expect(high[17]).toBeLessThan(-0.7);
  });
});
