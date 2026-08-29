import { describe, expect, it } from "vitest";
import { PORT_FAMILY_VAR } from "@ui/ports.ts";
import type { PortKind } from "@domain/types/ports.ts";
import {
  BUDGET_MS,
  IDLE_MS,
  MAX_OPACITY,
  MIN_OPACITY,
  describeFlow,
  edgeFamilyColor,
  formatGpuMs,
} from "./flow.ts";

/**
 * The signature element has to encode something true (§C): a busy pass must visibly
 * flow faster than an idle one, and a pass nobody has measured must not pretend.
 */

describe("V26 — edge hue is the source port family, never an arbitrary colour", () => {
  it("maps every port kind to its family token", () => {
    for (const kind of Object.keys(PORT_FAMILY_VAR) as PortKind[]) {
      expect(edgeFamilyColor(kind)).toBe(`var(${PORT_FAMILY_VAR[kind]})`);
    }
  });

  it("never produces a literal colour (§V17)", () => {
    const values = [
      ...Object.keys(PORT_FAMILY_VAR).map((kind) => edgeFamilyColor(kind as PortKind)),
      edgeFamilyColor(null),
      edgeFamilyColor(undefined),
    ];
    for (const value of values) {
      expect(value).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  it("falls back to the neutral unknown token when the source port cannot be resolved", () => {
    // An unresolved placeholder node (§V10) has no port family. Neutral is the honest
    // answer; picking a family colour would make the hue lie about the type.
    expect(edgeFamilyColor(null)).toBe("var(--port-unknown)");
  });
});

describe("edge flow ← real per-pass GPU ms (§C signature element)", () => {
  it("is a static hairline when there is no measurement at all", () => {
    expect(describeFlow(null).moving).toBe(false);
    expect(describeFlow(undefined).moving).toBe(false);
    expect(describeFlow(Number.NaN).moving).toBe(false);
    expect(describeFlow(Number.POSITIVE_INFINITY).moving).toBe(false);
  });

  it("is a static hairline for an idle pass", () => {
    expect(describeFlow(0).moving).toBe(false);
    expect(describeFlow(IDLE_MS).moving).toBe(false);
    expect(describeFlow(-3).moving).toBe(false);
  });

  it("does not flow when the source pass is bypassed or muted", () => {
    // A bypassed pass does no GPU work, so animating its edge would be a lie even if a
    // stale measurement is still lying around.
    expect(describeFlow(8, { inactive: true }).moving).toBe(false);
    expect(describeFlow(8, { inactive: false }).moving).toBe(true);
  });

  it("makes a busier pass flow faster and brighter — the whole claim of the visual", () => {
    const cheap = describeFlow(0.2);
    const busy = describeFlow(8);
    expect(cheap.moving && busy.moving).toBe(true);
    expect(busy.periodSeconds).toBeLessThan(cheap.periodSeconds);
    expect(busy.opacity).toBeGreaterThan(cheap.opacity);
    expect(busy.load).toBeGreaterThan(cheap.load);
  });

  it("is monotonic across the whole measured range", () => {
    const samples = [0.06, 0.1, 0.5, 1, 2, 4, 8, 16].map((ms) => describeFlow(ms));
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (previous === undefined || current === undefined) throw new Error("bad sample");
      expect(current.periodSeconds).toBeLessThan(previous.periodSeconds);
      expect(current.opacity).toBeGreaterThan(previous.opacity);
    }
  });

  it("saturates at one frame budget instead of running away", () => {
    const atBudget = describeFlow(BUDGET_MS);
    const overBudget = describeFlow(BUDGET_MS * 40);
    expect(atBudget.load).toBeCloseTo(1, 10);
    expect(overBudget.load).toBe(1);
    expect(overBudget.periodSeconds).toBeCloseTo(atBudget.periodSeconds, 10);
    expect(overBudget.opacity).toBeCloseTo(MAX_OPACITY, 10);
  });

  it("keeps opacity inside the declared range", () => {
    for (const ms of [0.06, 1, 16, 400]) {
      const flow = describeFlow(ms);
      expect(flow.opacity).toBeGreaterThanOrEqual(MIN_OPACITY);
      expect(flow.opacity).toBeLessThanOrEqual(MAX_OPACITY);
    }
  });
});

describe("per-pass timing readout", () => {
  it("shows an em dash rather than a fake zero when nothing was measured", () => {
    expect(formatGpuMs(null)).toBe("—");
    expect(formatGpuMs(undefined)).toBe("—");
    expect(formatGpuMs(Number.NaN)).toBe("—");
  });

  it("keeps sub-millisecond costs readable", () => {
    expect(formatGpuMs(0.42)).toBe("0.42 ms");
    expect(formatGpuMs(12.345)).toBe("12.3 ms");
  });
});
