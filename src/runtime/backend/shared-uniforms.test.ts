import { describe, expect, it } from "vitest";

import { SHARED_UNIFORMS_WGSL, sharedUniformsFromFrame } from "./shared-uniforms.ts";

/**
 * T468: the ABSOLUTE clock reaches shaders, not just expressions. The block and its
 * writer are two texts describing one layout; this pins both sides so neither can
 * gain a member the other lacks (V380's mirror hazard, in the small).
 */
describe("the shared frame block carries the absolute clock (T468)", () => {
  it("declares absTime and absFrame as NAMED f32 members (V380)", () => {
    expect(SHARED_UNIFORMS_WGSL).toContain("absTime: f32");
    expect(SHARED_UNIFORMS_WGSL).toContain("absFrame: f32");
    // Named members, never an array — uniform arrays defeat the writer's reflection.
    expect(SHARED_UNIFORMS_WGSL).not.toContain("array<");
  });

  it("writes the same number expressions read as `abstime` — one clock, two readers", () => {
    const shared = sharedUniformsFromFrame({
      frame: {
        timeSeconds: 0.5, // a fresh lap: the TIMELINE clock just wrapped
        deltaSeconds: 1 / 60,
        frameIndex: 30,
        mode: "live",
        randomSeed: 7,
        absFrameIndex: 3630,
        absTimeSeconds: 60.5, // the show has run a minute — and keeps growing
      },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    } as never);
    expect(shared.absTime).toBe(60.5);
    expect(shared.absFrame).toBe(3630);
    // The lap clock is untouched beside it — two clocks, both real (§V172's shape).
    expect(shared.time).toBe(0.5);
  });

  it("falls back to the lap clock when the transport predates the absolute one", () => {
    const shared = sharedUniformsFromFrame({
      frame: { timeSeconds: 2, deltaSeconds: 1 / 60, frameIndex: 120, mode: "live", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    } as never);
    expect(shared.absTime).toBe(2);
    expect(shared.absFrame).toBe(120);
  });
});
