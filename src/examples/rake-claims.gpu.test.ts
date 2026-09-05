import { beforeAll, describe, expect, it } from "vitest";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { radialAlignment, shootFamily } from "./alembic-family.ts";

/**
 * E62 RAKE — THE CLAIM (T1171).
 *
 * Rake is E58 Alembic's shader with marching depth driven hard into the fold's phase —
 * `drift` 2.4 against E58's 1 — and the one thing it asserts that no sibling does is that
 * **depth is what combs the picture**: structures are drawn out along their own depth, and a
 * direction in depth projected onto the screen is a line through the vanishing point. E58's
 * own claims already assert that every look is far from every other.
 *
 * The statistic is the share of the frame's gradient energy running ACROSS the rays from the
 * frame centre, because a streak lying ALONG a ray has its gradient perpendicular to it. It
 * is a share of the frame's own gradient energy, so the exposure and the ramp cannot move it
 * — which matters, since Rake runs at a sixth of E58's exposure on a one-hue ramp.
 *
 * ⚑ THE CONTROL THAT MATTERS IS NOT `drift` 0 ON THIS FILE. That is necessary and it is
 * asserted, but on its own it would let the doc's sentence be about the KNOB, and it is not:
 * §V923's test is to cut the thing you name and see whether the claim survives, and the
 * mirror of it is to apply the same cut somewhere else and see whether it does the same
 * thing. IT DOES NOT. On E58's shipped coordinate the same knob moves the alignment the
 * OTHER WAY. So what this file demonstrates is an interaction — depth in the phase, on a
 * vessel whose axis is the ray's — and the second assertion is what keeps the prose honest.
 *
 * MEASURED at 320x180, frame 60, on the shipped files:
 *   Rake, drift swept   0    0.5316
 *                       0.5  0.5448
 *                       1    0.5481
 *                       1.6  0.5611
 *                       2.4  0.6004   <- as shipped, and monotone up to it
 *   E58 Throat          0    0.5390
 *                       1    0.5150   <- as shipped
 *                       2.4  0.5198   <- the same knob, the other direction
 *
 * The suite FAILS without Dawn; it never skips.
 */

const RAKE = "E62-Rake.loom.json";
const THROAT = "E58-Alembic.loom.json";

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E62 Rake — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("depth drives the phase: cut `drift` and the comb goes with it", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const shipped = await shootFamily(RAKE);
    const noDrift = await shootFamily(RAKE, { drift: 0 });
    const halfDrift = await shootFamily(RAKE, { drift: 1 });

    // 0.5 is the value at which neither direction wins. The shipped file is above it and its
    // own drift-0 control is barely above it: 0.6004 against 0.5316, measured.
    expect(radialAlignment(shipped), "Rake as shipped").toBeGreaterThan(0.57);
    expect(radialAlignment(shipped) - radialAlignment(noDrift), "what `drift` is worth here").toBeGreaterThan(0.04);
    // Monotone through the middle of the sweep, which is what says this is a knob turning
    // rather than two coordinates that happen to differ: 0.5316, 0.5481, 0.6004.
    expect(radialAlignment(halfDrift)).toBeGreaterThan(radialAlignment(noDrift));
    expect(radialAlignment(shipped)).toBeGreaterThan(radialAlignment(halfDrift));
  }, 240_000);

  /**
   * ⚑ AND THE ASSERTION THAT KEEPS THE SENTENCE HONEST (§V910 — last).
   *
   * "Depth drives the phase and the picture combs" is a claim this file may make and the
   * shader may not. The identical cut on E58's shipped coordinate — where the vessel's axis
   * wanders off the ray's, so there is no single vanishing point to comb toward — moves the
   * alignment the OTHER WAY: 0.5390 at `drift` 0 down to 0.5198 at 2.4. If that ever stopped
   * being true, `drift` would have become a property of the shader rather than of this
   * coordinate, and both this file's doc and E58's table row would be overclaiming.
   */
  it("and the same knob on E58's coordinate does the opposite, so the comb is this file's", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const throatNoDrift = await shootFamily(THROAT, { drift: 0 });
    const throatHardDrift = await shootFamily(THROAT, { drift: 2.4 });
    expect(radialAlignment(throatHardDrift), "E58 at Rake's drift").toBeLessThan(radialAlignment(throatNoDrift));
  }, 180_000);
});
