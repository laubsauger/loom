import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T548 — Step: the PHRASE-length timescale, and the determinism that makes it usable.
 *
 * The owner asked for "some higher level deformation that keeps active for a couple of
 * bars or something and then lerps to the next one". Two things had to be true for that
 * to be more than a demo: the held value must be a pure function of WHERE you are (so a
 * scrub and an offline render land on it), and the lerp must be the Lag that already
 * exists rather than a second smoother inside this node.
 *
 * ## Why these assertions cannot pass vacuously (§V461)
 *
 * "It held the same value for four bars" is satisfied by a node that returns a CONSTANT,
 * which is the failure mode a hold test invites. So every hold assertion is paired with a
 * DISTINCTNESS assertion over the steps around it: four bars the same, AND the next four
 * different, AND the values across a run of steps not all equal. The exact numbers are
 * pinned rather than described, so a changed hash is a decision someone makes on purpose.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (timeSeconds: number): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "offline",
  randomSeed: 7,
});

function node(id: string, type: string, parameters: Record<string, unknown>, label: string): unknown {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label };
}

/** `count1` (a constant standing in for a bar count) → `step1`. */
function stepGraph(count: number, parameters: Record<string, unknown> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: {
      count: node("count", "constant", { value: count }, "count1"),
      step: node("step", "valueStep", { every: 4, minimum: 0, maximum: 1, seed: 0, ...parameters }, "step1"),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "count", portId: "out" }, target: { nodeId: "step", portId: "in" } },
    },
    groups: {},
  } as never;
}

const heldAt = (count: number, parameters: Record<string, unknown> = {}, seconds = 0): number =>
  createValueGraphSession(registry).evaluate(stepGraph(count, parameters), frameAt(seconds)).byName.get("step1")?.[
    "value"
  ] as number;

/**
 * The two picks this file pins. Measured, not chosen — the point of writing them down is
 * that a changed hash is then a DECISION someone makes on purpose rather than a drift
 * nobody sees, and `cycleHash` is shared with the LFO's noise shape (§V109).
 */
const PIN_FIRST = 0.5309511483646929;
const PIN_SECOND = 0.808492521289736;

describe("valueStep — holds a pick for N counts, then steps (T548)", () => {
  it("every count inside one step is the SAME value, and the next step is a DIFFERENT one", () => {
    const first = [0, 1, 2, 3].map((count) => heldAt(count));
    const second = [4, 5, 6, 7].map((count) => heldAt(count));
    // Held: one value across the whole phrase.
    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    // §V461: and it actually STEPPED. A node returning a constant satisfies the two lines
    // above and fails this one.
    expect(second[0]).not.toBe(first[0]);
    // Pinned, so a changed hash is a decision rather than a drift.
    expect(first[0]).toBeCloseTo(PIN_FIRST, 6);
    expect(second[0]).toBeCloseTo(PIN_SECOND, 6);
  });

  it("`every` is what quantises: at 1 it steps on every count", () => {
    const counts = [0, 1, 2, 3].map((count) => heldAt(count, { every: 1 }));
    expect(new Set(counts).size).toBe(4);
    // And the FIRST step of every:4 is the same pick as index 0 of every:1 — the hash is
    // over the QUANTISED index, so the two agree where the quantisation agrees.
    expect(counts[0]).toBeCloseTo(heldAt(0, { every: 4 }), 12);
  });

  it("a run of steps is not all one value — the sequence really varies", () => {
    const picks = [0, 4, 8, 12, 16, 20, 24, 28].map((count) => heldAt(count));
    expect(new Set(picks).size).toBeGreaterThan(5);
  });

  it("the range is EXACTLY minimum..maximum, and a degenerate range is a constant", () => {
    const wide = [0, 4, 8, 12, 16, 20].map((count) => heldAt(count, { minimum: -3, maximum: 5 }));
    for (const value of wide) {
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThan(5);
    }
    expect(new Set(wide).size).toBeGreaterThan(3);
    // minimum === maximum is a legitimate way to say "off", and it must not produce NaN.
    expect(heldAt(9, { minimum: 2, maximum: 2 })).toBe(2);
  });

  it("the seed picks a different sequence from the same counts", () => {
    const a = [0, 4, 8, 12].map((count) => heldAt(count, { seed: 0 }));
    const b = [0, 4, 8, 12].map((count) => heldAt(count, { seed: 1 }));
    expect(b).not.toEqual(a);
    // Same seed, same answer — it is a seed, not a nonce.
    expect([0, 4, 8, 12].map((count) => heldAt(count, { seed: 1 }))).toEqual(b);
  });

  /**
   * The property the coordinator asked for by name, and the reason this is a hash rather
   * than a stateful RNG or an accumulator: an offline render and a scrub must land on the
   * value the timeline says, not on the value the PATH there produced (§V44/§V47).
   */
  it("is a pure function of the count: a SCRUB lands on the same value as playing through", () => {
    // Play forward through bars 0..12, then jump back to bar 4 in the same session.
    const session = createValueGraphSession(registry);
    const played: number[] = [];
    for (const count of [0, 4, 8, 12]) {
      played.push(session.evaluate(stepGraph(count), frameAt(count)).byName.get("step1")?.["value"] as number);
    }
    const scrubbedBack = session.evaluate(stepGraph(4), frameAt(4)).byName.get("step1")?.["value"];
    expect(scrubbedBack).toBe(played[1]);
    // And a cold session — an offline render that never saw the earlier frames — agrees.
    expect(heldAt(4)).toBe(played[1]);
  });

  it("holds every channel independently, the way the rest of the CHOP set does", () => {
    // `mouse` publishes three channels at once; each is quantised and hashed on its own,
    // which is what lets one Step serve a whole bag and `step1:bar` be the wire you take.
    const graph = {
      revision: 1,
      nodes: {
        m: node("m", "mouse", {}, "m1"),
        step: node("step", "valueStep", { every: 1, minimum: 0, maximum: 1, seed: 0 }, "step1"),
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "m", portId: "out" }, target: { nodeId: "step", portId: "in" } },
      },
      groups: {},
    } as unknown as GraphDocument;
    const bag = createValueGraphSession(registry).evaluate(graph, frameAt(0), {
      pointer: { x: 3, y: 7, buttons: 1 },
    }).byName.get("step1");
    expect(Object.keys(bag ?? {}).sort()).toEqual(["buttons", "x", "y"]);
    // Three different counts in, three different picks out — not one value smeared over
    // the bag, which is what a node that read only `value` would have produced.
    expect(new Set(Object.values(bag ?? {})).size).toBe(3);
  });
});

/**
 * The owner's sentence, end to end: a Beat's `bar` channel into a Step into a Lag.
 *
 * This is the assertion that says NO SECOND SMOOTHER WAS BUILT — the ease comes from
 * `valueLag`, which already smooths every channel of its input, and the Step contributes
 * only the discontinuity for it to smooth.
 */
describe("bar → Step → Lag is 'hold for a phrase, then lerp to the next' (T548)", () => {
  const chain = (): GraphDocument =>
    ({
      revision: 1,
      nodes: {
        beat: node("beat", "audioPattern", { bpm: 120, amount: 1, beatsPerBar: 4 }, "beat1"),
        step: node("step", "valueStep", { every: 4, minimum: 0, maximum: 1, seed: 0 }, "step1"),
        lag: node("lag", "valueLag", { lag: 0.5 }, "lag1"),
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "beat", portId: "out" }, target: { nodeId: "step", portId: "in" } },
        e1: { id: "e1", source: { nodeId: "step", portId: "out" }, target: { nodeId: "lag", portId: "in" } },
      },
      groups: {},
    }) as never;

  it("the STEP is square on the bar boundary and the LAG is the only thing that eases", () => {
    // 120bpm, 4/4: a bar is two seconds, so `every: 4` bars is a step every EIGHT seconds.
    const session = createValueGraphSession(registry);
    const graph = chain();
    const bars: Array<{ t: number; step: number; lag: number }> = [];
    // Sampled at the real frame step, not in quarter-second jumps: the Lag's coefficient
    // is derived from `deltaSeconds`, so stepping time faster than the frame says would
    // make it converge at a rate no running session ever sees.
    for (let index = 0; index <= 16 * 60; index += 1) {
      const seconds = index / 60;
      const result = session.evaluate(graph, frameAt(seconds));
      bars.push({
        t: seconds,
        step: result.byName.get("step1")?.["bar"] as number,
        lag: result.byName.get("lag1")?.["bar"] as number,
      });
    }
    const before = bars.filter((entry) => entry.t > 1 && entry.t < 7.9);
    const after = bars.filter((entry) => entry.t > 8.1 && entry.t < 15);

    // The STEP holds flat on each side of the boundary — one value, then another value.
    expect(new Set(before.map((entry) => entry.step)).size).toBe(1);
    expect(new Set(after.map((entry) => entry.step)).size).toBe(1);
    expect(after[0]?.step).not.toBe(before[0]?.step);

    // The LAG is the transition: right after the boundary it sits BETWEEN the two held
    // values rather than on either, which is what "lerps to the next one" means.
    const low = Math.min(before[0]?.step as number, after[0]?.step as number);
    const high = Math.max(before[0]?.step as number, after[0]?.step as number);
    const crossing = bars.find((entry) => entry.t > 8.2 && entry.t < 8.5) as { lag: number };
    expect(crossing.lag).toBeGreaterThan(low);
    expect(crossing.lag).toBeLessThan(high);

    // And it ARRIVES — a lag that eased forever would satisfy the line above too.
    expect(after[after.length - 1]?.lag).toBeCloseTo(after[0]?.step as number, 3);
  });

  it("Step declares no clock of its own, so it inherits the source's (§V453, §V436)", () => {
    const definition = registry.get("valueStep");
    expect(definition?.description?.toLowerCase()).toContain("clockless");
    // It is a decision recorded in the text a user reads, not only in the gate's table
    // (§V464): the description says what it inherits and why that is the point.
    expect(definition?.description?.toLowerCase()).toContain("inherits");
  });
});
