import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { AudioFeatures } from "../types/frame.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { bypassPassthroughPorts } from "../graph/bypass.ts";
import { createValueGraphSession } from "./value-graph.ts";

/**
 * T541/B114 — MUTE and BYPASS on a VALUE node.
 *
 * The bug: `value-graph.ts` contained no occurrence of either word. Texture chains
 * honoured the flags from T250; value chains never learned, so an `audioPattern` with the
 * mute badge lit kept driving the switch wired to it — the owner's screenshot has both
 * nodes reading LEVEL 0.330 / LOW 0.689 with **M** lit on the source.
 *
 * ## Why these assertions cannot pass vacuously (§V461)
 *
 * A mute test whose source happens to emit zero proves nothing: `{value: 0}` and "no
 * output" look the same from a consumer that reads a number. So:
 *
 *  - every source here is driven to a DISTINCTIVE NON-ZERO bag, asserted by exact value
 *    BEFORE the flag goes on, and the property sweep refuses any node whose live bag is
 *    empty or all-zero — a node that cannot be heard cannot be silenced;
 *  - "absent" is asserted as ABSENT, never as zero and never as `{}`. The difference is
 *    load-bearing rather than pedantic: `valueSwitch` counts CONNECTED inputs, so an empty
 *    bag would still be a branch and muting `in1` would silently renumber the rest. The
 *    switch test below fails on an empty-bag implementation and passes on an absent one;
 *  - the bypass sweep asserts the EXACT feed bag out of the node, so a bypass that
 *    evaluated anyway (Limit clamping 3.7 to 1) fails, and one that muted instead fails.
 *
 * ## Property-shaped (§V437)
 *
 * The sweep enumerates every value node in the REGISTRY. Value node N+1 is covered the day
 * it is registered, without anyone editing a list here — the whole point of T541 being a
 * property of the value graph rather than a patch to `audioPattern`.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

/** Every value node the registry knows, in a stable order. */
const valueNodes: readonly NodeDefinition[] = allNodeDefinitions
  .filter((definition) => definition.valueEvaluate !== undefined || definition.valueChannel !== undefined)
  .slice()
  .sort((a, b) => a.type.localeCompare(b.type));

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
    edgeRecord[`e${index}`] = {
      id: `e${index}`,
      source: { nodeId: sn, portId: sp },
      target: { nodeId: tn, portId: tp },
    };
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

/**
 * A pointer that MOVES between the sweep's two frames, and a feature record with no zeros
 * in it. Both exist for §V461: `valueSlope` reads 0 on a still input and `valueTrigger`
 * reads 0 on one that never crosses, so a motionless fixture would hand the sweep two
 * nodes whose "live" reading is silence — and a mute you cannot hear is not a gate. Every
 * channel rises across the step and crosses Trigger's default 0.5.
 */
const POINTER = { x: 0.31, y: 0.22, buttons: 0 };
const POINTER_NEXT = { x: 0.72, y: 0.83, buttons: 1 };
const AUDIO: AudioFeatures = {
  level: 0.33,
  low: 0.689,
  lowMid: 0.247,
  highMid: 0.144,
  high: 0.41,
  onset: 0.52,
  onsetCount: 2,
  onsetMax: 0.77,
};

const bag = (result: { byName: ReadonlyMap<string, Record<string, number>> }, name: string) => {
  const found = result.byName.get(name);
  return found === undefined ? undefined : { ...found };
};

/**
 * The owner's graph, reduced: an `audioPattern` named `music1` into a `valueSwitch` named
 * `source1`, which is exactly the pair in the screenshot.
 */
function musicIntoSwitch(flags: { muted?: boolean; bypassed?: boolean }): GraphDocument {
  return graphOf(
    [
      node("music1", "audioPattern", { parameters: { bpm: 112, amount: 1 }, ui: { ...flags } }),
      node("source1", "valueSwitch", { parameters: { index: 0 } }),
    ],
    [["music1", "out", "source1", "in1"]],
  );
}

describe("B114 — a muted value source stops driving what is wired to it (T541)", () => {
  /**
   * The live reading first, by EXACT value. Without this the mute assertions below could
   * be green on a graph that never produced anything.
   */
  it("reads the pattern's exact bag on BOTH nodes while nothing is flagged", () => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(musicIntoSwitch({}), frameAt(1.37));

    const music = bag(result, "music1");
    // T701 moved `low` from 0.137789 to the analyser's dB domain — same kick envelope,
    // published as `(dB + 100) / 70` the way `getByteFrequencyData` would report it.
    // `level` is UNCHANGED at 0.1383246 and that is the tell: it is amplitude on both
    // paths (§V648) and is still summed from the linear envelopes, so a domain change to
    // the four bands has to leave it exactly where it was.
    expect(music?.["low"]).toBeCloseTo(0.729061, 6);
    expect(music?.["level"]).toBeCloseTo(0.1383246, 6);
    // The switch passes it through unchanged — the screenshot's "identical values", which
    // are CORRECT here and only wrong once the source is muted.
    expect(bag(result, "source1")).toEqual(music);
    expect(result.resolver("source1:low", {} as never)).toBeCloseTo(0.729061, 6);
  });

  it("MUTE: the source publishes nothing and the switch sees its port as UNWIRED", () => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(musicIntoSwitch({ muted: true }), frameAt(1.37));

    // The muted node itself: absent, not an empty bag and not zeros. Its plot reads the
    // same map, so this is also why the plot stops.
    expect(result.byName.has("music1")).toBe(false);
    // The switch: its only input is now unwired, so it has no branch to cut to and
    // publishes nothing either. Silence PROPAGATES.
    expect(result.byName.has("source1")).toBe(false);
    expect(result.resolver("source1:low", {} as never)).toBeUndefined();
    expect(result.resolver("music1:level", {} as never)).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("BYPASS on a SOURCE means the same silence — it has nothing to pass through", () => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(musicIntoSwitch({ bypassed: true }), frameAt(1.37));

    expect(result.byName.has("music1")).toBe(false);
    expect(result.byName.has("source1")).toBe(false);
    expect(result.resolver("source1:low", {} as never)).toBeUndefined();
  });
});

describe("BYPASS on a node WITH an input is a wire (T541)", () => {
  /** constant(3.7) → Limit(max 0.2) → the clamp is visible, so bypass removing it is too. */
  const limitGraph = (bypassed: boolean): GraphDocument =>
    graphOf(
      [
        node("src1", "constant", { parameters: { value: 3.7 } }),
        node("clamp1", "valueLimit", {
          parameters: { minimum: 0, maximum: 0.2 },
          ui: bypassed ? { bypassed: true } : {},
        }),
      ],
      [["src1", "out", "clamp1", "in"]],
    );

  it("clamps to exactly 0.2 while live, and passes exactly 3.7 while bypassed", () => {
    const session = createValueGraphSession(registry);
    expect(bag(session.evaluate(limitGraph(false), frameAt(0)), "clamp1")).toEqual({ value: 0.2 });
    expect(bag(session.evaluate(limitGraph(true), frameAt(0)), "clamp1")).toEqual({ value: 3.7 });
  });

  it("passes the WHOLE bag, channel names and all, not just a `value`", () => {
    const graph = graphOf(
      [
        node("m1", "mouse"),
        node("clamp1", "valueLimit", { parameters: { minimum: 0, maximum: 0.5 }, ui: { bypassed: true } }),
      ],
      [["m1", "out", "clamp1", "in"]],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0), { pointer: POINTER_NEXT });
    // Live it would be {x: 0.5, y: 0.5, buttons: 0.5} — every channel on the ceiling.
    // Bypassed it is the mouse verbatim, which no clamp of this input could produce.
    expect(bag(result, "clamp1")).toEqual(POINTER_NEXT);
  });

  it("takes the FIRST type-coherent input, so a bypassed Switch is its `in1` — not its index", () => {
    // Index 1 selects `in2` live. Bypassed, the node is a wire from in1 and the index is
    // not consulted at all: the two answers differ, so this cannot pass on a no-op bypass.
    const graph = (bypassed: boolean): GraphDocument =>
      graphOf(
        [
          node("a1", "constant", { parameters: { value: 11 } }),
          node("b1", "constant", { parameters: { value: 22 } }),
          node("pick1", "valueSwitch", { parameters: { index: 1 }, ui: bypassed ? { bypassed: true } : {} }),
        ],
        [
          ["a1", "out", "pick1", "in1"],
          ["b1", "out", "pick1", "in2"],
        ],
      );
    const session = createValueGraphSession(registry);
    expect(bag(session.evaluate(graph(false), frameAt(0)), "pick1")).toEqual({ value: 22 });
    expect(bag(session.evaluate(graph(true), frameAt(0)), "pick1")).toEqual({ value: 11 });
  });

  it("a bypassed node whose passthrough port is UNWIRED is silent, and the silence propagates", () => {
    // `b` is wired, `a` (the passthrough port) is not: a wire from an unconnected input
    // carries nothing, exactly as the texture compiler's spliced wire does.
    const graph = graphOf(
      [
        node("src1", "constant", { parameters: { value: 3.7 } }),
        node("math1", "valueMath", { parameters: { operation: "add" }, ui: { bypassed: true } }),
        node("after1", "valueLimit", { parameters: { minimum: -9, maximum: 9 } }),
      ],
      [
        ["src1", "out", "math1", "b"],
        ["math1", "out", "after1", "in"],
      ],
    );
    const result = createValueGraphSession(registry).evaluate(graph, frameAt(0));
    expect(result.byName.has("math1")).toBe(false);
    expect(result.byName.has("after1")).toBe(false);
  });
});

/**
 * §V457 — the merge is `{...prior, ...next}` over SORTED EDGE IDS, last-wins on a name
 * clash, and it composes bags of different channels. A muted node leaves that fold, so
 * muting one node CAN change what another node contributes. That is correct and it is
 * DELIBERATE; it is pinned here so nobody has to rediscover it from a graph.
 */
describe("muting changes a §V457 merge, deliberately (T541)", () => {
  const merged = (mute: "none" | "early" | "late") =>
    graphOf(
      [
        // e0 sorts before e1, so `late1` wins the shared `value` name while both are live.
        node("early1", "constant", { parameters: { value: 11 }, ui: mute === "early" ? { muted: true } : {} }),
        node("late1", "constant", { parameters: { value: 22 }, ui: mute === "late" ? { muted: true } : {} }),
        node("sum1", "valueLimit", { parameters: { minimum: -99, maximum: 99 } }),
      ],
      [
        ["early1", "out", "sum1", "in"],
        ["late1", "out", "sum1", "in"],
      ],
    );

  it("the last edge wins while both are live; muting the WINNER hands the port to the loser", () => {
    const session = createValueGraphSession(registry);
    expect(bag(session.evaluate(merged("none"), frameAt(0)), "sum1")).toEqual({ value: 22 });
    // Muting `late1` does not zero the channel — it hands it to `early1`. A different
    // node's contribution changed because of a flag on this one.
    expect(bag(session.evaluate(merged("late"), frameAt(0)), "sum1")).toEqual({ value: 11 });
    expect(bag(session.evaluate(merged("early"), frameAt(0)), "sum1")).toEqual({ value: 22 });
  });

  it("a muted contributor takes ITS channels out of the composed bag and leaves the rest", () => {
    const graph = (muteMouse: boolean): GraphDocument =>
      graphOf(
        [
          node("m1", "mouse", { ui: muteMouse ? { muted: true } : {} }),
          node("k1", "constant", { parameters: { value: 3.7 } }),
          node("join1", "valueLimit", { parameters: { minimum: -9, maximum: 9 } }),
        ],
        [
          ["m1", "out", "join1", "in"],
          ["k1", "out", "join1", "in"],
        ],
      );
    const session = createValueGraphSession(registry);
    expect(bag(session.evaluate(graph(false), frameAt(0), { pointer: POINTER_NEXT }), "join1")).toEqual({
      ...POINTER_NEXT,
      value: 3.7,
    });
    // Not zeroed channels — GONE channels, and the untouched contributor is intact.
    expect(bag(session.evaluate(graph(true), frameAt(0), { pointer: POINTER_NEXT }), "join1")).toEqual({
      value: 3.7,
    });
  });

  it("a muted input is NOT a branch: Switch renumbers, which an empty bag would not do", () => {
    // in1=11, in2=22, index 1 → 22. Mute `b1` and there is ONE connected input, so index 1
    // wraps to it and the switch reads 11. An implementation that published `{}` for a
    // muted node would leave TWO branches and select the empty one, publishing nothing —
    // so this assertion is what separates "absent" from "empty".
    const graph = (muteLate: boolean): GraphDocument =>
      graphOf(
        [
          node("a1", "constant", { parameters: { value: 11 } }),
          node("b1", "constant", { parameters: { value: 22 }, ui: muteLate ? { muted: true } : {} }),
          node("pick1", "valueSwitch", { parameters: { index: 1 } }),
        ],
        [
          ["a1", "out", "pick1", "in1"],
          ["b1", "out", "pick1", "in2"],
        ],
      );
    const session = createValueGraphSession(registry);
    expect(bag(session.evaluate(graph(false), frameAt(0)), "pick1")).toEqual({ value: 22 });
    expect(bag(session.evaluate(graph(true), frameAt(0)), "pick1")).toEqual({ value: 11 });
  });
});

/**
 * The property, over the REGISTRY (§V437). Every value node — including the one added
 * tomorrow — must honour both flags without anyone editing a list.
 */
describe("EVERY value node honours mute and bypass (T541, §V437)", () => {
  it("covers the whole registered set, and the set is not empty", () => {
    expect(valueNodes.length).toBeGreaterThan(10);
    expect(valueNodes.map((definition) => definition.type)).toContain("audioPattern");
  });

  /**
   * Parameters that make each node speak, and — §V461 again — make it do something a WIRE
   * would not. `maximum: 0.5` is the load-bearing one: with Limit's default 0..1 the feed
   * passes through untouched, live and bypassed answers coincide, and this node's bypass
   * assertion would be structurally blind. Measured: with the clamp, deleting the bypass
   * branch reddens Limit; without it, Limit stayed green while every other stage failed.
   *
   * `valueSwitch` is the one node where the two answers legitimately coincide here — a
   * Switch with one wired input IS a wire, at index 0 or wrapped to it — so its sweep row
   * cannot distinguish, and its distinguishing case is the dedicated two-input test above
   * ("a bypassed Switch is its `in1` — not its index"), which does redden.
   */
  const LOUD = {
    value: 3.7,
    amplitude: 1,
    frequency: 1,
    phase: 0.25,
    speed: 1,
    bpm: 112,
    amount: 1,
    minimum: 0,
    maximum: 0.5,
    // T654: channelIn with no external resolver speaks its fallback — nonzero here so
    // the sweep can hear it go silent. No other node has a `fallback` parameter.
    fallback: 0.62,
    // T942: the same shape for midiIn, and for the same reason. A node with NOTHING
    // learned publishes an empty bag — correctly: there are no controls to report, and
    // inventing one would be a channel the user never asked for. So the sweep hands it one
    // learned control whose REST is nonzero, which is exactly what it publishes with no
    // hardware attached, and the mute assertion has something to silence. No other node
    // has a `mapping` parameter.
    mapping: JSON.stringify([
      { channel: "cutoff", source: { kind: "cc", channel: 1, number: 74 }, range: [0.4, 1], mode: "absolute" },
    ]),
  };

  const evaluateOne = (
    definition: NodeDefinition,
    flags: { muted?: boolean; bypassed?: boolean },
    feed: boolean,
  ) => {
    const through = bypassPassthroughPorts(definition);
    const nodes = [node("subject", definition.type, { parameters: { ...LOUD }, ui: { ...flags } })];
    const edges: Array<[string, string, string, string]> = [];
    if (feed && through !== undefined) {
      nodes.unshift(node("feed", "mouse"));
      edges.push(["feed", "out", "subject", through.input]);
    }
    // A downstream reader, so "the port is absent" is asserted from where it matters.
    nodes.push(node("reader", "valueSwitch", { parameters: { index: 0 } }));
    edges.push(["subject", "out", "reader", "in1"]);
    const graph = graphOf(nodes, edges);
    const session = createValueGraphSession(registry);
    // TWO frames with a MOVING pointer: Slope and Trigger have nothing to say about a
    // still signal, and a silent "live" reading would make the mute assertion vacuous.
    session.evaluate(graph, frameAt(1.37), { pointer: POINTER, audio: AUDIO });
    return session.evaluate(graph, frameAt(1.37 + 1 / 60), { pointer: POINTER_NEXT, audio: AUDIO });
  };

  for (const definition of valueNodes) {
    it(`${definition.type}: speaks, then goes silent when muted`, () => {
      const live = evaluateOne(definition, {}, true);
      const spoken = bag(live, "subject");
      // §V461: a node that produced nothing, or produced only zeros, cannot prove a mute.
      expect(spoken, `${definition.type} produced no bag — the mute assertion below would be vacuous`).toBeDefined();
      const values = Object.values(spoken ?? {});
      expect(values.length, `${definition.type} published an empty bag`).toBeGreaterThan(0);
      expect(
        values.some((value) => value !== 0),
        `${definition.type} published only zeros — drive it to something audible or this gate is blind`,
      ).toBe(true);
      // And it reached the reader, so the wire under test is real.
      expect(bag(live, "reader")).toEqual(spoken);

      const muted = evaluateOne(definition, { muted: true }, true);
      expect(muted.byName.has("subject")).toBe(false);
      expect(muted.byName.has("reader"), `${definition.type} muted but the reader still had a branch`).toBe(false);
    });

    it(`${definition.type}: bypassed is its passthrough input, or silence when it has none`, () => {
      const through = bypassPassthroughPorts(definition);
      const result = evaluateOne(definition, { bypassed: true }, true);
      if (through === undefined) {
        // A SOURCE: nothing to pass, so bypass is silence — the same answer T250 gives a
        // bypassed texture source, and TD's answer for a bypassed generator.
        expect(result.byName.has("subject"), `${definition.type} is a source; bypass must silence it`).toBe(false);
        expect(result.byName.has("reader")).toBe(false);
        return;
      }
      // A WIRE: the feed's bag, verbatim, out of the node and out of the reader behind it.
      expect(bag(result, "subject"), `${definition.type} bypassed did not pass its input through`).toEqual(
        POINTER_NEXT,
      );
      expect(bag(result, "reader")).toEqual(POINTER_NEXT);
    });

    it(`${definition.type}: bypassed with NOTHING wired is silent`, () => {
      const result = evaluateOne(definition, { bypassed: true }, false);
      expect(result.byName.has("subject")).toBe(false);
      expect(result.byName.has("reader")).toBe(false);
    });
  }
});

/**
 * §V181's state, under a mute. A muted node is NOT COOKED — the way a muted CHOP is not
 * cooked — so its state is neither advanced nor cleared, and unmuting resumes the
 * trajectory rather than jumping to a value the stage never travelled to.
 */
describe("a muted stateful stage is not cooked (T541, §V181)", () => {
  it("holds its state across the muted frames instead of integrating through them", () => {
    const graph = (input: number, muted: boolean): GraphDocument =>
      graphOf(
        [
          node("src1", "constant", { parameters: { value: input } }),
          node("lag1", "valueLag", { parameters: { lag: 0.25 }, ui: muted ? { muted: true } : {} }),
        ],
        [["src1", "out", "lag1", "in"]],
      );
    const session = createValueGraphSession(registry);
    // Settled on 1 (the smoother starts ON its input, so one frame is enough).
    expect(bag(session.evaluate(graph(1, false), frameAt(0)), "lag1")).toEqual({ value: 1 });

    // Sixty muted frames while the INPUT is 0: nothing published, and — the point —
    // nothing integrated. Had the stage cooked through them it would now hold ~0.018.
    for (let index = 1; index < 61; index += 1) {
      const muted = session.evaluate(graph(0, true), frameAt(index / 60));
      expect(muted.byName.has("lag1")).toBe(false);
    }

    // Unmuted, it resumes from 1 and takes its FIRST step down — one frame of a 0.25s
    // lag, ≈0.935. A stage that had been cooking would read ≈0.017 here.
    const resumed = bag(session.evaluate(graph(0, false), frameAt(61 / 60)), "lag1")?.["value"] as number;
    expect(resumed).toBeCloseTo(0.9355, 4);
  });
});
