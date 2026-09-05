import { beforeAll, describe, expect, it } from "vitest";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { eyeRatio, shootFamily } from "./alembic-family.ts";

/**
 * E60 SNARL — THE CLAIM (T1171).
 *
 * E58 Alembic is named for its throat: a dark eye at the middle of the frame with fibre wound
 * round it. Snarl is the same shader with the vessel opened and its axis corkscrewing wide,
 * and the one thing it asserts that no sibling does is that **the eye is gone** — not dimmer,
 * INVERTED. E58's own claims already assert that every look is far from every other, so
 * distance is not this file's job.
 *
 * The statistic is the mean luma of a disc at the centre of the frame over the mean of the
 * whole frame, and it is the rare case where the obvious measurement is the right one: below
 * 1 the middle of the picture is darker than the picture, which is a hole; above 1 it is
 * brighter, which is not. A ratio of two means of the same frame, so the exposure and the
 * ramp cannot move it — which matters here, because Snarl's exposure is 0.012 against E58's
 * 0.02 and its ramp is cold where E58's is gold.
 *
 * WHY THE EYE IS GONE, so the number has a mechanism behind it: `wander` 1.1 strays the
 * vessel's axis nearly its own `radius` from the ray's, and `coil` 1.4 winds that stray more
 * than twice as fast with depth. There is then no depth at which the wall is far from every
 * ray at once, so there is nowhere for a hole to be. The control cuts exactly that — E58's
 * `wander`, `coil` and `radius`, put back with everything else here held.
 *
 * MEASURED at 320x180, frame 60, on the shipped files:
 *   Snarl as shipped                          eye ratio 2.106  (centre twice the frame)
 *   Snarl with E58's vessel put back          eye ratio 0.685  (the hole returns)
 *   E58 Throat as shipped                     eye ratio 0.548
 *
 * The suite FAILS without Dawn; it never skips.
 */

const SNARL = "E60-Snarl.loom.json";
const THROAT = "E58-Alembic.loom.json";
/** E58's vessel: the three numbers that put the throat back. */
const THROAT_VESSEL = { wander: 0.4, coil: 0.6, radius: 2 };

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E60 Snarl — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("there is no throat: the middle of the frame is brighter than the frame, not darker", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const shipped = await shootFamily(SNARL);
    const withThroat = await shootFamily(SNARL, THROAT_VESSEL);
    const throat = await shootFamily(THROAT);

    /* Not a threshold hunt: 1.0 is the value at which the centre and the frame agree, and
       the claim is that this file is on the OTHER SIDE of it from the file it comes from.
       Measured 2.106 here and 0.548 there, so 1.5 and 0.9 leave a wide margin on both sides
       while still being the same statement. */
    expect(eyeRatio(shipped), "Snarl's centre against its own frame").toBeGreaterThan(1.5);
    expect(eyeRatio(throat), "E58 Throat's centre — the eye this file removed").toBeLessThan(0.9);

    /* ⚑ THE ONE THAT MAKES IT A CLAIM ABOUT THE VESSEL (§V910 — last). Everything above is
       satisfied by a file that is simply brighter in the middle for any reason at all: a
       different ramp, a different exposure, a different fold. Put E58's three vessel numbers
       back into THIS document — same ramp, same exposure, same fold, same everything else —
       and the eye must come back. Measured 0.685, i.e. across 1.0 from the shipped 2.106. */
    expect(eyeRatio(withThroat), "Snarl with E58's wander/coil/radius restored").toBeLessThan(0.9);
  }, 240_000);
});
