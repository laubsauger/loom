import { describe, expect, it } from "vitest";
import { aggregateComponentTiming, aggregateNodeTiming } from "./aggregate.ts";
import type { AggregateInput } from "./aggregate.ts";
import type { TelemetryPass, TelemetrySourcePath } from "./types.ts";

/**
 * Component timing aggregation (T146, §V87, §V82).
 *
 * The fixture is the shape §V82 promises: a component flattened into the parent graph,
 * with a nested component inside it, and source paths that name every level. If own /
 * children / total were computed from anything but those paths, the two-level case is
 * where it would break.
 *
 *   Main
 *     blur1                      (a plain root node)
 *     dreamy1                    <- component instance
 *       dreamy1/tint1            (authored directly in DreamyFeedback)
 *       dreamy1/inner1           <- nested component instance
 *         dreamy1/inner1/blurA   (two levels deep)
 *         dreamy1/inner1/blurB
 */

const sources: ReadonlyArray<TelemetrySourcePath> = [
  { nodeId: "blur1", path: [], sourcePath: "Main / Blur_1" },
  { nodeId: "dreamy1/tint1", path: ["dreamy1"], sourcePath: "Main / DreamyFeedback_1 / Tint_1" },
  {
    nodeId: "dreamy1/inner1/blurA",
    path: ["dreamy1", "dreamy1/inner1"],
    sourcePath: "Main / DreamyFeedback_1 / InnerBlur_1 / Blur_A",
  },
  {
    nodeId: "dreamy1/inner1/blurB",
    path: ["dreamy1", "dreamy1/inner1"],
    sourcePath: "Main / DreamyFeedback_1 / InnerBlur_1 / Blur_B",
  },
];

const passes: ReadonlyArray<TelemetryPass> = [
  { id: "blur1:p0", kind: "effect", nodeId: "blur1", label: null },
  { id: "tint1:p0", kind: "effect", nodeId: "dreamy1/tint1", label: null },
  { id: "blurA:p0", kind: "effect", nodeId: "dreamy1/inner1/blurA", label: null },
  { id: "blurB:p0", kind: "effect", nodeId: "dreamy1/inner1/blurB", label: null },
  { id: "swap:0", kind: "swap", nodeId: null, label: null },
];

const spans = new Map<string, number>([
  ["blur1:p0", 8],
  ["tint1:p0", 1],
  ["blurA:p0", 2],
  ["blurB:p0", 3],
]);

function input(overrides: Partial<AggregateInput> = {}): AggregateInput {
  return { passes, sources, spans, timingAvailable: true, ...overrides };
}

describe("§V87 — a component reports own / children / total", () => {
  it("splits an instance's cost between what it authored and what it contains", () => {
    const timing = aggregateComponentTiming("dreamy1", input());

    // Own: only the pass authored directly in DreamyFeedback's graph.
    expect(timing.own.gpuMs).toBeCloseTo(1);
    expect(timing.own.passCount).toBe(1);
    expect(timing.own.nodeCount).toBe(1);

    // Children: everything from the nested InnerBlur instance, two levels deep.
    expect(timing.children.gpuMs).toBeCloseTo(5);
    expect(timing.children.passCount).toBe(2);
    expect(timing.children.nodeCount).toBe(2);

    // Total is the number the user asked for: "what does this component cost me".
    expect(timing.total.gpuMs).toBeCloseTo(6);
    expect(timing.total.passCount).toBe(3);
    expect(timing.total.nodeCount).toBe(3);
  });

  it("aggregates a nested instance against its own subtree, not the outer one", () => {
    const timing = aggregateComponentTiming("dreamy1/inner1", input());
    expect(timing.own.gpuMs).toBeCloseTo(5);
    expect(timing.own.passCount).toBe(2);
    expect(timing.children.passCount).toBe(0);
    expect(timing.total.gpuMs).toBeCloseTo(5);
  });

  it("excludes work that lives outside the instance entirely", () => {
    const timing = aggregateComponentTiming("dreamy1", input());
    // blur1 costs 8 ms at the root and must never appear in a component's total —
    // reporting the whole frame as "this component" is the failure mode this guards.
    expect(timing.total.gpuMs).not.toBeCloseTo(14);
    expect(timing.total.gpuMs).toBeCloseTo(6);
  });

  it("reports zero — not a stale number — for an instance with nothing in it", () => {
    const timing = aggregateComponentTiming("empty1", input());
    expect(timing.total.passCount).toBe(0);
    expect(timing.total.nodeCount).toBe(0);
    // No passes genuinely means no cost, which is a fact rather than a fabrication.
    expect(timing.total.gpuMs).toBe(0);
  });

  it("counts nodes the user placed, even when they compile to no pass", () => {
    const withInert: ReadonlyArray<TelemetrySourcePath> = [
      ...sources,
      { nodeId: "dreamy1/note1", path: ["dreamy1"], sourcePath: "Main / DreamyFeedback_1 / Note_1" },
    ];
    const timing = aggregateComponentTiming("dreamy1", input({ sources: withInert }));
    expect(timing.own.nodeCount).toBe(2);
    expect(timing.own.passCount).toBe(1);
  });

  it("ignores pruned nodes when a kept-node set is supplied (§V25)", () => {
    const kept = new Set(["blur1", "dreamy1/tint1"]);
    const timing = aggregateComponentTiming("dreamy1", input({ keptNodes: kept }));
    expect(timing.children.passCount).toBe(0);
    expect(timing.children.nodeCount).toBe(0);
    expect(timing.total.gpuMs).toBeCloseTo(1);
  });
});

describe("§V86 — availability propagates through the aggregate", () => {
  it("reads unavailable in every bucket when the device has no timestamp query", () => {
    const timing = aggregateComponentTiming("dreamy1", input({ timingAvailable: false }));
    for (const bucket of [timing.own, timing.children, timing.total]) {
      expect(bucket.availability).toBe("unavailable");
      expect(bucket.gpuMs).toBeNull();
    }
    // Structure is still reported: only the durations are missing.
    expect(timing.total.passCount).toBe(3);
  });

  it("reads pending while spans are supported but none has landed", () => {
    const timing = aggregateComponentTiming("dreamy1", input({ spans: new Map() }));
    expect(timing.own.availability).toBe("pending");
    expect(timing.own.gpuMs).toBeNull();
    expect(timing.total.availability).toBe("pending");
  });

  it("sums only the spans that actually landed", () => {
    const partial = new Map<string, number>([["blurA:p0", 2]]);
    const timing = aggregateComponentTiming("dreamy1", input({ spans: partial }));
    expect(timing.own.availability).toBe("pending");
    expect(timing.children.gpuMs).toBeCloseTo(2);
    expect(timing.total.gpuMs).toBeCloseTo(2);
  });
});

describe("a plain node", () => {
  it("has own == total and no children", () => {
    const timing = aggregateNodeTiming("blur1", input());
    expect(timing.own.gpuMs).toBeCloseTo(8);
    expect(timing.own.passCount).toBe(1);
    expect(timing.own.nodeCount).toBe(1);
    expect(timing.children.passCount).toBe(0);
    expect(timing.total).toEqual(timing.own);
  });

  it("reads unavailable rather than zero with no timestamp query", () => {
    const timing = aggregateNodeTiming("blur1", input({ timingAvailable: false }));
    expect(timing.own.availability).toBe("unavailable");
    expect(timing.own.gpuMs).toBeNull();
  });
});
