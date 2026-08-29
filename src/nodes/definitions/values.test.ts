import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { constantNode, lfoNode, lfoValue, timerNode } from "./values.ts";

/**
 * T238-T240 (§V143): value sources are pure functions of parameters and the frame — the
 * SAME frame always yields the SAME number, on any machine, offline or live.
 */

const frameAt = (timeSeconds: number, randomSeed = 7): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed,
});

describe("lfoValue (T238)", () => {
  it("oscillates the declared shapes with amplitude and offset applied", () => {
    const base = { frequency: 1, amplitude: 2, offset: 10, phase: 0 };
    // Sine: t=0.25 is the crest of a 1Hz cycle.
    expect(lfoValue({ ...base, shape: "sine" }, frameAt(0.25))).toBeCloseTo(12, 10);
    expect(lfoValue({ ...base, shape: "sine" }, frameAt(0.75))).toBeCloseTo(8, 10);
    // Square: first half high, second half low.
    expect(lfoValue({ ...base, shape: "square" }, frameAt(0.1))).toBe(12);
    expect(lfoValue({ ...base, shape: "square" }, frameAt(0.6))).toBe(8);
    // Saw: ramps -1 → 1 across the cycle.
    expect(lfoValue({ ...base, shape: "saw" }, frameAt(0.5))).toBeCloseTo(10, 10);
    // Triangle: crest at the quarter cycle.
    expect(lfoValue({ ...base, shape: "triangle" }, frameAt(0.25))).toBeCloseTo(12, 10);
  });

  it("applies frequency and phase as cycles", () => {
    // 4Hz at t=1/16 is a quarter cycle — the sine crest.
    expect(lfoValue({ shape: "sine", frequency: 4, amplitude: 1, offset: 0, phase: 0 }, frameAt(1 / 16))).toBeCloseTo(1, 10);
    // A phase of 0.25 shifts the crest to t=0.
    expect(lfoValue({ shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0.25 }, frameAt(0))).toBeCloseTo(1, 10);
  });

  it("holds one deterministic noise value per cycle, keyed by the project seed (§V45)", () => {
    const params = { shape: "noise", frequency: 2, amplitude: 1, offset: 0, phase: 0 };
    const a = lfoValue(params, frameAt(0.1));
    const withinSameCycle = lfoValue(params, frameAt(0.2));
    const nextCycle = lfoValue(params, frameAt(0.6));
    expect(withinSameCycle).toBe(a); // sample & hold: constant inside the cycle
    expect(nextCycle).not.toBe(a);
    // Same frame, same seed, same number — replay-identical. A different seed differs.
    expect(lfoValue(params, frameAt(0.1))).toBe(a);
    expect(lfoValue(params, frameAt(0.1, 8))).not.toBe(a);
    expect(Math.abs(a)).toBeLessThanOrEqual(1);
  });
});

describe("constant and timer (T239, T240)", () => {
  it("constant returns its value, whatever the clock says", () => {
    expect(constantNode.valueChannel?.({ value: 42 }, frameAt(123))).toBe(42);
  });

  it("timer ramps after its delay, scaled by speed, never negative", () => {
    const channel = timerNode.valueChannel;
    expect(channel?.({ speed: 2, delay: 1 }, frameAt(0.5))).toBe(0);
    expect(channel?.({ speed: 2, delay: 1 }, frameAt(3))).toBe(4);
  });

  it("declares no ports and no passes — the number IS the output (§V143)", () => {
    for (const definition of [lfoNode, constantNode, timerNode]) {
      expect(definition.inputs).toEqual([]);
      expect(definition.outputs).toEqual([]);
      expect(definition.compile({} as never)).toEqual({ passes: [] });
    }
  });
});
