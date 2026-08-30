import { describe, expect, it } from "vitest";

import { createPacedGate } from "./frame-pacing.ts";

/**
 * T355 (§V298): the quantization bug, as arithmetic. Feed the gate synthetic tick
 * trains and count what renders — every scenario's expectation is derivable by hand.
 */

function run(gate: ReturnType<typeof createPacedGate>, ticks: number[], intervalMs: number): number[] {
  const rendered: number[] = [];
  for (const t of ticks) if (gate.due(t, intervalMs)) rendered.push(t);
  return rendered;
}

const train = (count: number, deltaMs: number, jitter = 0): number[] =>
  Array.from({ length: count }, (_, i) => i * deltaMs + (jitter ? Math.sin(i * 2.3) * jitter : 0));

describe("the paced fps gate (T355/§V298)", () => {
  it("120 Hz display, 60 fps target: EXACTLY every second tick — the bug this fixes", () => {
    // The naive gate skips the 16.66ms tick (< 16.667) and runs at 25ms, averaging
    // 45-55 fps. The paced gate must lock every-2nd-tick.
    const rendered = run(createPacedGate(), train(240, 1000 / 120), 1000 / 60);
    expect(rendered.length).toBe(120);
    const gaps = rendered.slice(1).map((t, i) => +(t - rendered[i]!).toFixed(2));
    expect(new Set(gaps).size).toBe(1); // steady, no 2-tick/3-tick mix
    expect(gaps[0]).toBeCloseTo(1000 / 60, 1);
  });

  it("survives sub-millisecond jitter without dropping to the 3-tick cadence", () => {
    const rendered = run(createPacedGate(), train(240, 1000 / 120, 0.9), 1000 / 60);
    // Long-run rate is the target by construction: 240 ticks ≈ 2 s ≈ 120 frames.
    expect(rendered.length).toBeGreaterThanOrEqual(118);
    expect(rendered.length).toBeLessThanOrEqual(122);
  });

  it("60 Hz display, 60 fps target: every tick is due", () => {
    const rendered = run(createPacedGate(), train(120, 1000 / 60), 1000 / 60);
    expect(rendered.length).toBe(120);
  });

  it("120 Hz display, 30 fps target: every fourth tick", () => {
    const rendered = run(createPacedGate(), train(240, 1000 / 120), 1000 / 30);
    expect(rendered.length).toBe(60);
  });

  it("144 Hz display, 60 fps target: long-run rate is exact despite no clean divisor", () => {
    const rendered = run(createPacedGate(), train(1440, 1000 / 144), 1000 / 60);
    // 10 seconds of ticks: 600 frames ± the two edge frames.
    expect(Math.abs(rendered.length - 600)).toBeLessThanOrEqual(2);
  });

  it("a stall resyncs instead of bursting to catch up", () => {
    const gate = createPacedGate();
    const interval = 1000 / 60;
    run(gate, train(24, 1000 / 120), interval);
    // Two seconds hidden, then ticks resume: the first resumed tick renders, the
    // next is gated normally — no burst of 120 make-up frames.
    const resumed = run(
      gate,
      [2200, 2200 + 8.33, 2200 + 16.66, 2200 + 25],
      interval,
    );
    expect(resumed.length).toBeLessThanOrEqual(2);
    expect(resumed[0]).toBe(2200);
  });

  it("a live fps change takes effect on the next tick — no gate rebuild", () => {
    const gate = createPacedGate();
    const ticks = train(240, 1000 / 120);
    const rendered: number[] = [];
    for (const [i, t] of ticks.entries()) {
      const interval = i < 120 ? 1000 / 60 : 1000 / 120;
      if (gate.due(t, interval)) rendered.push(t);
    }
    // First half at 60 (every 2nd of 120 ticks = 60), second half at 120 (every tick).
    expect(Math.abs(rendered.length - (60 + 120))).toBeLessThanOrEqual(2);
  });
});
