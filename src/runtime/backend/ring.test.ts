import { describe, expect, it } from "vitest";

import {
  estimateResourceBytes,
  readExecutionPlan,
  resourceStructureKey,
} from "./plan.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";

/**
 * The ring resource, at the plan contract (T237, §V226).
 *
 * These are the rules the backend relies on being true before it allocates anything: a
 * ring is at least two slices, a tap is at least one frame back, and a ring of a different
 * depth is a different allocation. Each is enforced HERE rather than trusted to the nodes,
 * because a node that gets one wrong produces a plan that looks valid and renders the
 * wrong frame.
 */

const ring = (frames: number) =>
  ({
    kind: "ring",
    id: "history",
    size: [64, 64],
    format: "rgba16float",
    frames,
  }) as const;

function plan(resources: readonly unknown[], passes: readonly unknown[] = []): LogicalExecutionPlan {
  return { resources, passes, diagnostics: [] } as unknown as LogicalExecutionPlan;
}

describe("ring resources (T237)", () => {
  it("needs at least two slices", () => {
    // One slice is a target wearing a ring's name: "the previous frame" would mean "the
    // one being written", which is the read-write hazard the whole design avoids.
    expect(readExecutionPlan(plan([ring(2)])).resources).toHaveLength(1);
    expect(readExecutionPlan(plan([ring(1)])).ok).toBe(false);
    expect(readExecutionPlan(plan([ring(0)])).ok).toBe(false);
  });

  it("refuses a fractional or missing slice count", () => {
    const fractional = { ...ring(2), frames: 4.5 };
    expect(readExecutionPlan(plan([fractional])).ok).toBe(false);
    const missing = { kind: "ring", id: "history", size: [64, 64], format: "rgba16float" };
    expect(readExecutionPlan(plan([missing])).ok).toBe(false);
  });

  it("refuses a tap of zero — slice 0 is the one being written", () => {
    // The floor is a rule, not a convention: a node binding tap 0 would sample the texture
    // an earlier pass in the same frame is still filling, and the picture would be right
    // often enough to survive a casual look.
    const withTap = (tap: number) =>
      plan(
        [ring(4), { kind: "sampler", id: "s" }],
        [
          {
            kind: "effect",
            id: "read",
            shader: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }",
            target: "history",
            textures: [{ binding: "tex", resourceId: "history", tap }],
          },
        ],
      );
    expect(readExecutionPlan(withTap(1)).ok).toBe(true);
    expect(readExecutionPlan(withTap(0)).ok).toBe(false);
    expect(readExecutionPlan(withTap(-1)).ok).toBe(false);
  });

  it("counts every slice in the memory estimate (§V228)", () => {
    // The number the budget warning reports, and the reason `frames` is a parameter rather
    // than an implementation detail: a ring costs its depth, linearly, in full frames.
    const one = estimateResourceBytes([ring(2)]);
    const four = estimateResourceBytes([ring(8)]);
    expect(four).toBe(one * 4);
    // 64 x 64 x 8 bytes x 2 slices.
    expect(one).toBe(64 * 64 * 8 * 2);
  });

  it("treats depth as structural, so a deeper ring is not carried", () => {
    // §V62b: a carried resource keeps its CONTENTS. Carrying a 4-slice ring into an
    // 8-slice one would keep half a history and invent the rest — the same reason a
    // resized ping-pong is reallocated rather than reused.
    expect(resourceStructureKey(ring(4))).not.toBe(resourceStructureKey(ring(8)));
    expect(resourceStructureKey(ring(4))).toBe(resourceStructureKey(ring(4)));
  });
});
