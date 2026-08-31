import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { absTimeSecondsOf } from "@domain/types/frame.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { plotValues, sampleValueFunction } from "./value-function.ts";

/**
 * T495 — the playhead and the curve must be on the SAME clock.
 *
 * The LFO is free-running by design: it reads `absTimeSecondsOf` so that a timeline lap
 * cannot snap its phase, which is what makes it lap seamlessly at any frequency the way
 * TouchDesigner's does. The curve is drawn from that same function. The MARKER, though,
 * was placed from `frame.timeSeconds` — the timeline clock, which wraps at the out point.
 *
 * So at the first frame of a lap the dot sat at the curve's left edge while the node was
 * reading 0.951. Nothing about the value was wrong; the picture of it was keyed to the
 * wrong clock, and that is what "hard to describe" looks like from the outside.
 *
 * ## What this asserts, and why not the obvious thing
 *
 * Not "the phase is computed from `absTimeSeconds`" — that restates the implementation and
 * would pass for any expression mentioning the right field. The property is that THE
 * MARKER LANDS ON THE VALUE THE NODE IS PRODUCING: read the curve at the phase the plot
 * would draw, and it must equal what the LFO actually outputs on that frame. That is the
 * thing a person sees, it is false in the reported state, and it cannot be satisfied by a
 * marker on the wrong clock.
 *
 * The test only bites where the two clocks DISAGREE, so the timeline here wraps on a
 * period that does not divide the LFO's — which is the case §T495 was reported against
 * and the case the old code got wrong.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const lfo = registry.require("lfo");

/** A timeline that laps every `LOOP` seconds while absolute time runs on for ever. */
const LOOP = 4;
const FPS = 60;
/** Deliberately not a divisor of LOOP: 1/0.3 = 3.33s, so every lap starts mid-cycle. */
const FREQUENCY = 0.3;

function frameAt(index: number): FrameEvaluationInput {
  const absTimeSeconds = index / FPS;
  return {
    timeSeconds: absTimeSeconds % LOOP,
    deltaSeconds: 1 / FPS,
    frameIndex: index,
    mode: "fixed-step",
    randomSeed: 1,
    wallSeconds: absTimeSeconds,
    wallDeltaSeconds: 1 / FPS,
    absFrameIndex: index,
    absTimeSeconds,
  };
}

/** The value the curve puts under the marker, for a plot stamped with `stamp`. */
function markedValue(stamp: number): number {
  const values = plotValues(lfo, { frequency: FREQUENCY, amplitude: 1, offset: 0 });
  const fn = sampleValueFunction(lfo, values, { timeSeconds: stamp, randomSeed: 1 });
  if (fn === null || fn.phase === null) throw new Error("the LFO must have a drawable curve");
  const index = Math.min(fn.series.length - 1, Math.round(fn.phase * fn.series.length));
  return fn.series[index] as number;
}

describe("T495 — the playhead marks the value the node is actually producing", () => {
  it("agrees with the live output across several timeline laps", () => {
    const values = plotValues(lfo, { frequency: FREQUENCY, amplitude: 1, offset: 0 });
    let worst = 0;
    for (let index = 0; index < LOOP * FPS * 5; index += 1) {
      const frame = frameAt(index);
      const live = lfo.valueChannel!(values, frame);
      // The stamp the history ring now carries (T495): the ABSOLUTE clock.
      const marked = markedValue(absTimeSecondsOf(frame));
      worst = Math.max(worst, Math.abs(marked - live));
    }
    // One sample of a 96-point curve is ~0.065 of a cycle, so the marker can differ from
    // the live value by at most the curve's own step. Well inside that.
    expect(worst).toBeLessThan(0.08);
  });

  it("would MISS the curve on the timeline clock — the reported state", () => {
    /*
     * Non-vacuity, and the measurement of the defect. On the wrapping clock the marker
     * walks a different curve, and the disagreement is a large fraction of the LFO's
     * amplitude rather than one sample's worth. Without this the test above would pass
     * just as happily if both clocks were the same.
     */
    const values = plotValues(lfo, { frequency: FREQUENCY, amplitude: 1, offset: 0 });
    let worst = 0;
    for (let index = 0; index < LOOP * FPS * 5; index += 1) {
      const frame = frameAt(index);
      const live = lfo.valueChannel!(values, frame);
      const marked = markedValue(frame.timeSeconds);
      worst = Math.max(worst, Math.abs(marked - live));
    }
    expect(worst).toBeGreaterThan(1);
  });

  it("is the clock the app actually STAMPS the ring with", () => {
    /*
     * The wiring, not just the property. Everything above proves that a marker placed by
     * the absolute clock lands on the curve — and would go on passing if the one call site
     * that produces the stamp went back to `frame.timeSeconds`, because nothing above
     * reads it. That is §V147's gap: a correct function nobody calls correctly.
     *
     * There is exactly one producer (`app.tsx`) and exactly one consumer (the playhead in
     * `value-plot.tsx`), so this is small enough to pin by reading it.
     */
    const app = readFileSync(fileURLToPath(new URL("../../app/app.tsx", import.meta.url)), "utf8");
    const pushes = app.match(/valueHistory\.push\([^;]*?\);/gs) ?? [];
    // Guards the guard: a regex that stopped matching would assert nothing at all.
    expect(pushes.length).toBeGreaterThan(0);
    for (const call of pushes) {
      expect(call).toContain("absTimeSecondsOf(frame)");
      expect(call).not.toContain("frame.timeSeconds");
    }
  });

  it("puts the two clocks together only where they agree", () => {
    // An unbounded timeline publishes no absolute clock, and `absTimeSecondsOf` falls back
    // to `timeSeconds` — so every existing picture keeps exactly the numbers it had.
    const unbounded: FrameEvaluationInput = {
      timeSeconds: 7.5,
      deltaSeconds: 1 / FPS,
      frameIndex: 450,
      mode: "fixed-step",
      randomSeed: 1,
      wallSeconds: 7.5,
      wallDeltaSeconds: 1 / FPS,
    };
    expect(absTimeSecondsOf(unbounded)).toBe(7.5);
  });
});
