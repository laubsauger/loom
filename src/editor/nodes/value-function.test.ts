import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { isPureValueSource } from "@domain/types/node-definition.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { lfoNode } from "@nodes/definitions/values.ts";
import {
  FUNCTION_PLOT_SAMPLES,
  plotValues,
  sampleValueFunction,
} from "./value-function.ts";

const pureSources = allNodeDefinitions.filter((definition) => isPureValueSource(definition));

function valuesOf(definition: NodeDefinition): Record<string, unknown> {
  return plotValues(definition, {});
}

describe("§V143 — the purity every function plot depends on, CHECKED not assumed", () => {
  it("finds the real catalogue, or it is measuring nothing", () => {
    // LFO, Constant and Timer today. Zero would mean the filter broke and every purity
    // claim below would pass having evaluated nothing.
    expect(pureSources.length).toBeGreaterThan(2);
    // And it is a SPLIT, not the union: the stateful value nodes must not be in here.
    const names = pureSources.map((definition) => definition.type);
    expect(names).not.toContain("valueLag");
    expect(names).not.toContain("valueFilter");
    expect(names).not.toContain("mouse");
  });

  it("gives the same number for the same frame, every time", () => {
    // A node that memoised on first call, or read a wall clock, would look completely
    // normal at rest and would make a plot that disagreed with the render.
    for (const definition of pureSources) {
      const values = valuesOf(definition) as Record<string, never>;
      const channel = definition.valueChannel;
      if (channel === undefined) continue;
      for (const t of [0, 0.37, 1.25, 9.5]) {
        const frame = {
          timeSeconds: t, deltaSeconds: 1 / 60, frameIndex: Math.round(t * 60),
          mode: "fixed-step" as const, randomSeed: 7, wallSeconds: t, wallDeltaSeconds: 1 / 60,
        };
        const first = channel(values, frame);
        const second = channel(values, frame);
        expect(second, `${definition.type} is not repeatable at t=${String(t)}`).toBe(first);
      }
    }
  });

  it("gives the same numbers out of order as in order", () => {
    // The property evaluating AHEAD actually needs: frame N must not depend on N-1 having
    // been asked for first. Anything carrying state between calls fails here.
    for (const definition of pureSources) {
      const values = valuesOf(definition) as Record<string, never>;
      const channel = definition.valueChannel;
      if (channel === undefined) continue;
      const times = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
      const frame = (t: number) => ({
        timeSeconds: t, deltaSeconds: 1 / 60, frameIndex: Math.round(t * 60),
        mode: "fixed-step" as const, randomSeed: 3, wallSeconds: t, wallDeltaSeconds: 1 / 60,
      });
      const forwards = times.map((t) => channel(values, frame(t)));
      const backwards = [...times].reverse().map((t) => channel(values, frame(t)));
      expect([...backwards].reverse(), `${definition.type} depends on evaluation ORDER`).toEqual(
        forwards,
      );
    }
  });
});

describe("one cycle, sampled — the curve rather than the tail", () => {
  it("draws a full sine cycle no matter how fast the LFO runs", () => {
    // THE ALIASING BUG, stated as a test. At 40 Hz the history plot had at most one
    // sample per cycle at 60fps; the function plot's resolution does not depend on the
    // frame rate at all, so the shape is identical at 0.5 Hz and at 40 Hz.
    const slow = sampleValueFunction(lfoNode, plotValues(lfoNode, { frequency: 0.5 }), {
      timeSeconds: 0,
      randomSeed: 1,
    });
    const fast = sampleValueFunction(lfoNode, plotValues(lfoNode, { frequency: 40 }), {
      timeSeconds: 0,
      randomSeed: 1,
    });
    expect(slow).not.toBeNull();
    expect(fast).not.toBeNull();
    if (slow === null || fast === null) return;

    expect(slow.series).toHaveLength(FUNCTION_PLOT_SAMPLES);
    expect(fast.series).toHaveLength(FUNCTION_PLOT_SAMPLES);
    for (let index = 0; index < FUNCTION_PLOT_SAMPLES; index += 1) {
      expect(fast.series[index] as number).toBeCloseTo(slow.series[index] as number, 10);
    }
    // And it really is one whole cycle: a sine over [0,1) of phase crosses zero twice,
    // peaks near +1 and troughs near -1.
    expect(Math.max(...slow.series)).toBeGreaterThan(0.99);
    expect(Math.min(...slow.series)).toBeLessThan(-0.99);
  });

  it("is SMOOTH — successive samples step by a small fraction of the amplitude", () => {
    // The polygon symptom, measured. Twelve samples per cycle gives ~0.5 jumps; ninety-six
    // gives ~0.065. Asserting the step bound is what makes "smooth" a fact rather than an
    // impression (§V218 — the exact claim beats a range).
    const plot = sampleValueFunction(lfoNode, plotValues(lfoNode, { frequency: 12 }), {
      timeSeconds: 0,
      randomSeed: 1,
    });
    if (plot === null) throw new Error("expected a function plot");
    let biggest = 0;
    for (let index = 1; index < plot.series.length; index += 1) {
      biggest = Math.max(biggest, Math.abs((plot.series[index] as number) - (plot.series[index - 1] as number)));
    }
    // 2 * sin(pi / 96) ≈ 0.0654 for a unit sine.
    expect(biggest).toBeLessThan(0.07);
  });

  it("marks the phase where the graph actually is, and it advances with time", () => {
    // §V147: a plot that never moves passes any "does it draw?" check. The playhead is
    // the part that makes this readable rather than a static diagram, so its motion is
    // asserted, not assumed.
    const values = plotValues(lfoNode, { frequency: 2 });
    const at = (t: number) => sampleValueFunction(lfoNode, values, { timeSeconds: t, randomSeed: 1 });
    expect(at(0)?.phase).toBeCloseTo(0, 10);
    expect(at(0.125)?.phase).toBeCloseTo(0.25, 10);
    expect(at(0.25)?.phase).toBeCloseTo(0.5, 10);
    // Wraps rather than growing without bound.
    expect(at(0.5)?.phase).toBeCloseTo(0, 10);
    expect(at(10.375)?.phase).toBeCloseTo(0.75, 10);
  });

  it("draws NO playhead when no frame time is known, rather than claiming phase zero", () => {
    /*
     * Found by the look pass, not by a test (§V383).
     *
     * A value node in a graph with no output never has its channels advanced —
     * `frame-driver.ts` returns before `onBeforeFrame` when there is no compiled plan —
     * so the history holds no frame time while the transport's clock visibly runs. The
     * first version of this defaulted that to 0, which drew a confident playhead at the
     * start of a cycle: a marker claiming a position on a curve that looks entirely
     * alive, and wrong for as long as the graph has no output. The curve is still true;
     * the position on it is not something this plot can know (§V123).
     */
    const values = plotValues(lfoNode, { frequency: 2 });
    const unknown = sampleValueFunction(lfoNode, values, { timeSeconds: null, randomSeed: 1 });
    expect(unknown).not.toBeNull();
    expect(unknown?.series.length).toBe(FUNCTION_PLOT_SAMPLES);
    expect(unknown?.phase, "a plot with no frame time claimed a phase anyway").toBeNull();
  });

  it("holds the CURVE still while the playhead moves across it", () => {
    // Anchored at t=0 on purpose. A window that slid with the clock would put the drift
    // back, at higher resolution — the picture would keep changing and the shape would
    // still be hard to read at a glance.
    const values = plotValues(lfoNode, { frequency: 3 });
    const first = sampleValueFunction(lfoNode, values, { timeSeconds: 0, randomSeed: 1 });
    const later = sampleValueFunction(lfoNode, values, { timeSeconds: 7.31, randomSeed: 1 });
    expect(later?.series).toEqual(first?.series);
    expect(later?.phase).not.toBeCloseTo(first?.phase ?? 0, 3);
  });

  it("carries the project seed into sample-and-hold, so the plot matches the render", () => {
    const values = plotValues(lfoNode, { frequency: 4, shape: "noise" });
    const a = sampleValueFunction(lfoNode, values, { timeSeconds: 0, randomSeed: 1 });
    const b = sampleValueFunction(lfoNode, values, { timeSeconds: 0, randomSeed: 2 });
    expect(a?.series).not.toEqual(b?.series);
    // One held step across one cycle: S&H is constant within a cycle, which is exactly
    // the picture the aliased history could never show.
    expect(new Set(a?.series ?? []).size).toBe(1);
  });
});

describe("falling back rather than drawing something untrue", () => {
  it("declines a stateful node — its output is not a function of the frame", () => {
    const lag = allNodeDefinitions.find((definition) => definition.type === "valueLag");
    expect(lag).toBeDefined();
    if (lag === undefined) return;
    expect(sampleValueFunction(lag, {}, { timeSeconds: 0, randomSeed: 1 })).toBeNull();
  });

  it("declines a pure node with no period — a ramp has no cycle to draw", () => {
    const timer = allNodeDefinitions.find((definition) => definition.type === "timer");
    const constant = allNodeDefinitions.find((definition) => definition.type === "constant");
    expect(isPureValueSource(timer)).toBe(true);
    expect(isPureValueSource(constant)).toBe(true);
    expect(sampleValueFunction(timer, {}, { timeSeconds: 0, randomSeed: 1 })).toBeNull();
    expect(sampleValueFunction(constant, {}, { timeSeconds: 0, randomSeed: 1 })).toBeNull();
  });

  it("declines a node that declares BOTH hooks — valueEvaluate supersedes valueChannel", () => {
    /*
     * The case the split exists for, and it is not reachable through the shipped
     * catalogue: no node declares both today, so `valueChannel !== undefined` and
     * `isPureValueSource` agree on every real definition and the distinction is invisible.
     * That is exactly §V316's shape — an invariant stated over a category, implemented
     * over the one member that happens to exist — so the second member is constructed
     * here rather than waited for.
     *
     * The contract says `valueEvaluate` SUPERSEDES `valueChannel` when both are present.
     * A plot drawn from the superseded function would be a confident, smooth, complete
     * picture of something the node does not produce.
     */
    const both: NodeDefinition = {
      ...lfoNode,
      type: "lfoWithOverride",
      valueEvaluate: () => ({ value: 0 }),
    };
    expect(isPureValueSource(both), "a node whose valueChannel is superseded is not pure").toBe(
      false,
    );
    expect(sampleValueFunction(both, plotValues(both, { frequency: 2 }), {
      timeSeconds: 0,
      randomSeed: 1,
    })).toBeNull();
  });

  it("declines a frequency of zero rather than drawing an infinite period", () => {
    const values = plotValues(lfoNode, { frequency: 0 });
    expect(sampleValueFunction(lfoNode, values, { timeSeconds: 0, randomSeed: 1 })).toBeNull();
  });

  it("leaves a DRIVEN parameter at its default rather than reading a number that is not there", () => {
    const driven = plotValues(lfoNode, {
      frequency: { mode: "driven", bindings: { driven: { source: "other" } } },
    });
    expect(driven["frequency"]).toBe(1);
  });
});
