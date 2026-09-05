import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { mediaPlayhead } from "../../domain/media/transport.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1190 — SPEED: does integrating actually remove the freeze, and does the bounce bounce?
 *
 * The node exists for one reported symptom — *"we're seeing the image freezing a lot"*,
 * *"it navigates itself into a corner"* — and one structural claim: under a POSITION map a
 * constant input is a frozen picture, and under a RATE map a constant input is constant
 * motion. So the assertions here are about MOTION, not about a value:
 *
 *  1. a CONSTANT input travels — the whole claim, in one line;
 *  2. the arithmetic is the integral exactly, so a known rate lands on a known distance;
 *  3. MIRROR reverses at the bound rather than stopping or jumping, and a POSITIVE rate
 *     therefore travels BACKWARDS half the time (which is where E56's reverse comes from);
 *  4. HOLD is anti-windup — the failure mode that would make "hold" a freeze you have to
 *     unwind out of;
 *  5. the fold agrees with `mediaPlayhead`'s, exactly, because the repo may not hold two
 *     answers to "where does a mirror put you" (§V109).
 *
 * ## Why the exact numbers (§V147)
 *
 * An integral of a constant rate over a known number of equal steps is an exact rational,
 * and floating-point summation of the same values in the same order is reproducible. So
 * "it moved" is never asserted where "it moved to exactly here" is available.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 60;

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / FPS,
  deltaSeconds: 1 / FPS,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

function makeNode(id: string, type: string, parameters: Record<string, unknown>, label: string): unknown {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label };
}

/** `src1(constant)` → `travel1(valueSpeed)`; the caller rewrites the constant per frame. */
function speedGraph(rate: number, parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: makeNode("src", "constant", { value: rate }, "src1"),
      travel: makeNode("travel", "valueSpeed", parameters, "travel1"),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "travel", portId: "in" } },
    },
    groups: {},
  } as never;
}

/** Push a rate signal through one session and collect `travel1`'s position per frame. */
function travel(rates: readonly number[], parameters: Record<string, unknown>): number[] {
  const session = createValueGraphSession(registry);
  return rates.map((rate, index) => {
    const evaluated = session.evaluate(speedGraph(rate, parameters), frameAt(index));
    return evaluated.byName.get("travel1")?.["value"] as number;
  });
}

const constant = (rate: number, frames: number): number[] => new Array(frames).fill(rate) as number[];

describe("valueSpeed — a constant input is MOTION, not a frozen frame (T1190)", () => {
  it("⚑ THE CLAIM: a perfectly flat input keeps travelling", () => {
    /* The one assertion the node exists for. The same flat input through a position map is
       a single value forever — that is the freeze the owner reported, and it is not a
       tuning failure, it is what a position map DOES with a constant. */
    const positions = travel(constant(1, 120), { minimum: 0, maximum: 10, limit: "hold" });
    expect(new Set(positions).size).toBe(120);
    // And it never repeats a value, so there is no still frame anywhere in the run.
    expect(positions[0]).toBeLessThan(positions[119]!);
  });

  it("starts at the MIDPOINT of the bounds, so a fresh session opens mid-travel", () => {
    /* Not at `minimum`: starting at an end would make the first thing a user sees the one
       state this node exists to avoid, and it would need a parameter to fix. One frame at
       rate 0 is the midpoint exactly. */
    expect(travel([0], { minimum: 0, maximum: 10, limit: "hold" })[0]).toBe(5);
    expect(travel([0], { minimum: 4, maximum: 6, limit: "hold" })[0]).toBe(5);
    expect(travel([0], { minimum: -3, maximum: 1, limit: "hold" })[0]).toBe(-1);
  });

  it("integrates EXACTLY: 60 frames of rate 2 at 60fps is 2 units", () => {
    /* The arithmetic, not an impression. Midpoint of 0..100 is 50, plus 2 units per second
       for exactly one second of 1/60 steps. Asserted close rather than equal only because
       60 additions of 2/60 is not 2 in IEEE-754 — named rather than hidden. */
    const positions = travel(constant(2, 60), { minimum: 0, maximum: 100, limit: "hold" });
    expect(positions[59]).toBeCloseTo(50 + 2, 12);
    // Half the rate is half the distance, on the same steps: the integral is linear in it.
    const half = travel(constant(1, 60), { minimum: 0, maximum: 100, limit: "hold" });
    expect(half[59]! - 50).toBeCloseTo((positions[59]! - 50) / 2, 12);
  });

  it("a NEGATIVE rate runs backwards — reverse is the sign of the input", () => {
    const back = travel(constant(-2, 60), { minimum: -100, maximum: 100, limit: "hold" });
    expect(back[59]).toBeCloseTo(0 - 2, 12); // midpoint of -100..100 is 0
  });

  it("⚑ MIRROR bounces: a POSITIVE rate travels backwards half the time", () => {
    /* Where E56's reverse comes from, and the reason Mirror is the default. The rate never
       goes negative; the BOUND supplies the sign. A node that clamped here would stop, and
       one that looped would jump-cut. */
    const positions = travel(constant(4, 1200), { minimum: 0, maximum: 2, limit: "mirror" });
    let backwards = 0;
    for (let i = 1; i < positions.length; i += 1) if (positions[i]! < positions[i - 1]!) backwards += 1;
    const share = backwards / (positions.length - 1);
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
    // Never leaves the bounds, and reaches both — a bounce, not a drift.
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...positions)).toBeLessThanOrEqual(2);
    expect(Math.min(...positions)).toBeLessThan(0.05);
    expect(Math.max(...positions)).toBeGreaterThan(1.95);
    // And it is never still: no two consecutive frames share a value.
    let stuck = 0;
    for (let i = 1; i < positions.length; i += 1) if (positions[i] === positions[i - 1]) stuck += 1;
    expect(stuck).toBe(0);
  });

  it("LOOP wraps to the other end — the jump cut, named", () => {
    const positions = travel(constant(4, 300), { minimum: 0, maximum: 2, limit: "loop" });
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...positions)).toBeLessThan(2);
    // A wrap is a DISCONTINUITY and this is what distinguishes it from mirror: at least one
    // step is a whole span backwards, where mirror's largest step is one frame's travel.
    let biggest = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const step = Math.abs(positions[i]! - positions[i - 1]!);
      if (step > biggest) biggest = step;
    }
    expect(biggest).toBeGreaterThan(1.5);
  });

  it("HOLD is ANTI-WINDUP: it resumes the moment the rate reverses", () => {
    /* The failure this guards: if the ACCUMULATOR kept running while the OUTPUT clamped,
       200 frames pushed past the top would take 200 frames of reverse before the picture
       moved at all — a freeze wearing a different hat, and exactly the class of bug this
       whole node was written against. */
    const rates = [...constant(10, 200), ...constant(-10, 10)];
    const positions = travel(rates, { minimum: 0, maximum: 2, limit: "hold" });
    expect(positions[199]).toBe(2); // pinned at the top, as Hold promises
    // The very next frame after the reversal must already be moving.
    expect(positions[200]).toBeLessThan(2);
    expect(positions[200]).toBeCloseTo(2 - 10 / 60, 12);
  });

  it("a COLLAPSED range holds its one value rather than dividing by zero", () => {
    expect(new Set(travel(constant(5, 30), { minimum: 3, maximum: 3, limit: "mirror" }))).toEqual(
      new Set([3]),
    );
  });

  it("§V109 — the mirror fold IS `mediaPlayhead`'s, to the double", () => {
    /* Two answers to "where does a bounce put you" is exactly the drift this project keeps
       designing out. Same span, same distance travelled, same number: a Speed integrating
       rate 1 for N seconds must land where a transport that has run N seconds at speed 1
       through a mirrored window lands. */
    const seconds = 7;
    const positions = travel(constant(1, seconds * FPS), { minimum: 0, maximum: 2, limit: "mirror" });
    const head = mediaPlayhead(
      {
        playMode: "freeRun", play: true, speed: 1, cue: false, cuePoint: 0,
        trimStart: 0, trimEnd: 2, extend: "mirror",
      },
      // The Speed node starts at the MIDPOINT, so the transport is offset by that much.
      seconds + 1,
      2,
    );
    expect(positions.at(-1)).toBeCloseTo(head.position, 9);
  });
});
