import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1190 — NORMALIZE: does it actually redistribute the resolution, and can it hit a wall?
 *
 * The node exists to answer one complaint — *"wasting most of the resolution on the first
 * 20 decibels that will almost always be used up and never give us anything"* — and that
 * complaint is about a DISTRIBUTION, not about a value. So the load-bearing assertion here
 * is a HISTOGRAM: feed a signal that spends most of its time in a sliver of its own range,
 * and show that the output covers its range evenly while the input does not.
 *
 * ## Why the exact numbers rather than tolerance bands
 *
 * The mid-rank percentile of a known sequence is an exact rational, so every claim below
 * that CAN be exact is (§V147). `1 - 0.5/N` is not "about one" — it is the number, and it
 * is what makes "the output has no wall" a fact rather than an impression.
 *
 * ## Why the flatness claim cannot pass vacuously (§V461)
 *
 * "The output histogram is flat" is satisfied by a node that returns a linear ramp, and it
 * is satisfied by the identity on an already-flat input. So the flatness assertion is
 * always PAIRED with the same measurement over the RAW input, on the same skewed fixture,
 * asserted to FAIL the same threshold. The instrument is shown to be able to see unevenness
 * before its evenness reading is believed.
 *
 * ## Why the window knob is exercised in BOTH directions
 *
 * The docblock's rule — the window must be longer than the cycle you want to see — is the
 * one way a user can hold this node wrong, and a knob that is only tested at its good
 * setting is not tested. So the short window is asserted to DESTROY the sweep, by the same
 * histogram, on the same signal.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const FPS = 60;

const frameAt = (frameIndex: number, deltaSeconds = 1 / FPS): FrameEvaluationInput => ({
  timeSeconds: frameIndex / FPS,
  deltaSeconds,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

function makeNode(id: string, type: string, parameters: Record<string, unknown>, label: string): unknown {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label };
}

/**
 * `src1(constant)` → `norm1(valueNormalize)`.
 *
 * The source is a CONSTANT whose value the caller rewrites per frame, which is how a
 * headless test feeds an arbitrary signal through the real session rather than calling
 * `valueEvaluate` by hand — the state bag, the topological order and the channel naming
 * are all the app's own.
 */
function normalizeGraph(value: number, window: number): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: makeNode("src", "constant", { value }, "src1"),
      norm: makeNode("norm", "valueNormalize", { window }, "norm1"),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "norm", portId: "in" } },
    },
    groups: {},
  } as never;
}

/** Push a signal through one session and collect `norm1`'s output per frame. */
function ranks(signal: readonly number[], window: number, deltaSeconds = 1 / FPS): number[] {
  const session = createValueGraphSession(registry);
  return signal.map((value, index) => {
    const evaluated = session.evaluate(normalizeGraph(value, window), frameAt(index, deltaSeconds));
    return evaluated.byName.get("norm1")?.["value"] as number;
  });
}

/** Share of the run in each of `bins` equal slices of [lo, hi], as percentages. */
function histogram(values: readonly number[], lo: number, hi: number, bins = 20): number[] {
  const counts = new Array(bins).fill(0) as number[];
  for (const value of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(((value - lo) / (hi - lo)) * bins)));
    counts[index]! += 1;
  }
  return counts.map((count) => (count / values.length) * 100);
}

/** Total-variation distance from a perfectly even lane, in percent. 0 = flat. */
function unevenness(share: readonly number[]): number {
  const even = 100 / share.length;
  return share.reduce((total, value) => total + Math.abs(value - even), 0) / 2;
}

/**
 * THE FIXTURE, and it is the shape of the owner's complaint rather than a random signal.
 *
 * A level that sits in the top tenth of its range 80% of the time and visits the rest on
 * the way past — which is what a loudness envelope does, and what a linear map wastes its
 * range on. Deterministic, and its own histogram is asserted to be terrible below.
 */
function skewedLevel(frames: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < frames; index += 1) {
    const phase = (index % 300) / 300;
    // 80% of each cycle inside 0.90..1.00, 20% sweeping the whole 0..1.
    out.push(phase < 0.8 ? 0.9 + (phase / 0.8) * 0.1 : (phase - 0.8) / 0.2);
  }
  return out;
}

describe("valueNormalize — the mapping (T1190)", () => {
  it("the FIRST frame is 0.5: warm-up needs no knob, and opens in the middle", () => {
    /* One sample, itself: mid-rank is (0 below + 0.5 tie) / 1. A node that returned 0 here
       would open every driven destination pinned at an end while its window filled, which
       is the behaviour a warm-up parameter would have had to be invented to avoid. */
    expect(ranks([0.42], 8)[0]).toBe(0.5);
    expect(ranks([99], 8)[0]).toBe(0.5);
  });

  it("a CONSTANT input reports 0.5 forever — no division by zero, no drift to an end", () => {
    const held = ranks(new Array(600).fill(0.3) as number[], 8);
    expect(new Set(held)).toEqual(new Set([0.5]));
  });

  it("mid-rank is EXACT: a rising ramp reports 1 - 0.5/N, and never 1", () => {
    /* The wall claim, as arithmetic. A strictly rising input is the window's maximum on
       every frame, so it is the worst case for "can this reach the top" — and it lands one
       half-sample short of it, by construction, at every window fill. */
    const window = 2; // 120 samples at 60fps
    const rising = Array.from({ length: 400 }, (_, index) => index / 400);
    const out = ranks(rising, window);
    expect(out[0]).toBe(0.5); // 1 sample
    expect(out[1]).toBe(0.75); // (1 below + 0.5 tie) / 2
    expect(out[2]).toBeCloseTo(5 / 6, 12); // (2 + 0.5) / 3
    // Once the window is full at 120 samples the answer is stationary and exact.
    expect(out[200]).toBe(1 - 0.5 / 120);
    expect(out[399]).toBe(1 - 0.5 / 120);
    expect(Math.max(...out)).toBeLessThan(1);
  });

  it("and a falling ramp reports 0.5/N, and never 0", () => {
    const window = 2;
    const falling = Array.from({ length: 400 }, (_, index) => 1 - index / 400);
    const out = ranks(falling, window);
    expect(out[200]).toBe(0.5 / 120);
    expect(Math.min(...out)).toBeGreaterThan(0);
  });

  it("ranks against the WINDOW's history, not against all of it", () => {
    /* The window is the whole knob, so it has to be observable: 240 frames of 0 followed by
       one 1 ranks the 1 at the top of whatever the window still remembers. With a 1-second
       window (60 samples) every remembered sample is a 0, so the answer is 1 - 0.5/60;
       with a 8-second window (480 samples) the buffer holds only the 241 samples seen so
       far, so it is 1 - 0.5/241. Different windows, different numbers, both exact. */
    const signal = [...(new Array(240).fill(0) as number[]), 1];
    expect(ranks(signal, 1).at(-1)).toBe(1 - 0.5 / 60);
    expect(ranks(signal, 8).at(-1)).toBe(1 - 0.5 / 241);
  });

  it("is PER CHANNEL: one node normalises a whole bag independently", () => {
    /* The family convention (§V179). A bag whose channels have opposite trends must not
       share one distribution, or feeding an audio node's whole output through this would
       rank `high` against `low`. */
    const session = createValueGraphSession(registry);
    const graph = {
      revision: 1,
      nodes: {
        pattern: makeNode("pattern", "audioPattern", { bpm: 120, amount: 1, beatsPerBar: 4 }, "music1"),
        norm: makeNode("norm", "valueNormalize", { window: 4 }, "norm1"),
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "pattern", portId: "out" }, target: { nodeId: "norm", portId: "in" } },
      },
      groups: {},
    } as never as GraphDocument;
    let last: Record<string, number> = {};
    for (let index = 0; index < 600; index += 1) {
      last = { ...(session.evaluate(graph, frameAt(index)).byName.get("norm1") ?? {}) };
    }
    expect(Object.keys(last).length).toBeGreaterThan(3);
    for (const [name, value] of Object.entries(last)) {
      expect(value, `${name} left 0..1`).toBeGreaterThan(0);
      expect(value, `${name} left 0..1`).toBeLessThan(1);
    }
    // Not one shared distribution: at least two channels answer differently.
    expect(new Set(Object.values(last)).size).toBeGreaterThan(1);
  });
});

describe("valueNormalize — ⚑ the claim: it redistributes the resolution (T1190)", () => {
  const FRAMES = 3000;
  const signal = skewedLevel(FRAMES);

  it("the fixture really is skewed — the instrument can see unevenness (§V461)", () => {
    /* Red-verify by construction: if this passed on a flat lane the flatness claim below
       would be measuring nothing. The raw level puts 80% of its run in two of twenty bins. */
    const raw = unevenness(histogram(signal, 0, 1));
    expect(raw).toBeGreaterThan(60);
    expect(Math.max(...histogram(signal, 0, 1))).toBeGreaterThan(35);
  });

  it("NORMALISED, the same signal covers its range evenly", () => {
    /* The whole point of the node, on the shape of the owner's complaint. Warm-up excluded
       (the first window), because the claim is about steady state and saying so is cheaper
       than pretending the first 17 seconds are representative. */
    const out = ranks(signal, 17).slice(17 * FPS);
    const share = histogram(out, 0, 1);
    expect(unevenness(share)).toBeLessThan(15);
    expect(Math.max(...share)).toBeLessThan(12);
    expect(Math.min(...share)).toBeGreaterThan(1);
  });

  it("⚠ AND A WINDOW SHORTER THAN THE CYCLE DESTROYS IT — the knob is real, both ways", () => {
    /* The documented failure mode, exercised rather than asserted in prose. The fixture's
       cycle is 300 frames = 5 s; a 1 s window normalises that cycle away, and the lane
       collapses back onto its ends. If this ever passed, the window parameter would be
       doing nothing and the good reading above would be luck. */
    const short = ranks(signal, 1).slice(17 * FPS);
    const share = histogram(short, 0, 1);
    expect(unevenness(share)).toBeGreaterThan(40);
  });
});
