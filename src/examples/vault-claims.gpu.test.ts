import { beforeAll, describe, expect, it } from "vitest";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { edgeTail, flatShare, shootFamily } from "./alembic-family.ts";

/**
 * E59 VAULT — THE CLAIM (T1171).
 *
 * Vault is E58 Alembic's shader at `twist` 0.5, and the ONE thing it asserts that no sibling
 * does is that the fold has gone **architectural**: the frame is piecewise flat, planes with
 * creases between them rather than fibre. E58's own claims already assert that every look is
 * far from every other, so distance is not this file's job; the mechanism is.
 *
 * "Architectural" is a word about a screenshot until it is a number, and the number is the
 * normalised gradient's p99 over its median — a long tail over a nearly empty middle is what
 * piecewise-constant means when you cannot segment the image. It is a ratio of two quantiles
 * of the same frame, so neither the exposure nor the ramp can move it (§V147: the bound is
 * derived from a control, not a tolerance band read off one picture).
 *
 * THE CONTROL IS `twist` AND NOTHING ELSE, which is what makes this a claim about the knob
 * rather than about the six other numbers Vault also moves: the same document with `twist`
 * put back to the family's 2.0944 — the swizzle the golfs are written with, and the value
 * E58 ships — measures HALF the edge tail. And the same move on E58's own coordinate goes
 * the same way, which is what says the effect belongs to the parameter (§V923's discipline:
 * cut the thing you are naming and see whether the claim survives).
 *
 * MEASURED at 320x180, frame 60, on the shipped files:
 *   Vault as shipped (twist 0.5)      edge tail 21.18   flat share 0.2558
 *   Vault at the family's 2.0944      edge tail 10.06   flat share 0.1674
 *   E58 Throat as shipped (2.0944)    edge tail 10.96   flat share 0.1198
 *   E58 Throat at twist 0.5           edge tail 15.63   flat share 0.2235
 *
 * The suite FAILS without Dawn; it never skips.
 */

const VAULT = "E59-Vault.loom.json";
const THROAT = "E58-Alembic.loom.json";
/** The swizzle: 2π/3 about the (1,1,1) diagonal, which is the only angle `p.zxy` can spell. */
const FAMILY_TWIST = 2.0944;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E59 Vault — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the fold is piecewise flat, and it is `twist` that makes it so", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const shipped = await shootFamily(VAULT);
    const atFamilyTwist = await shootFamily(VAULT, { twist: FAMILY_TWIST });

    /* A quarter of the frame carries no gradient worth the name. Measured 0.2558; the floor
       is set at 0.20 rather than at the measurement, because this is the SHAPE claim and the
       ratio below is the sharp one. Rake, the least flat of the five, reads 0.0128 here. */
    expect(flatShare(shipped)).toBeGreaterThan(0.2);
    expect(flatShare(shipped)).toBeGreaterThan(flatShare(atFamilyTwist));

    /* THE CLAIM, AND IT IS LAST so nothing can return before it (§V910). Measured 21.18
       shipped against 10.06 with only `twist` reverted — a factor of 2.11. The bound is 1.7,
       the measured factor less a fifth: enough slack for a different GPU's rounding, nowhere
       near enough to pass if the knob stopped working. Stated as a RATIO between two renders
       in the same run for §V929's reason — an absolute edge tail would be a number about this
       machine's rasteriser as much as about the fold. */
    expect(edgeTail(shipped) / edgeTail(atFamilyTwist)).toBeGreaterThan(1.7);
  }, 180_000);

  /**
   * ⚑ AND THE HALF THAT SAYS IT IS THE PARAMETER RATHER THAN THIS DOCUMENT (§V910 — last).
   *
   * The test above would pass on a file where `twist` happened to interact with Vault's own
   * `warpGain`, `flare`, `wander`, `coil` and `depthFade` to produce flatness — which would
   * make "low twist goes architectural", the sentence E58's doc has published since T1166,
   * an accident of six other numbers. So the same one-knob move is made from E58's shipped
   * coordinate, where all six are different, and it has to go the same way.
   */
  it("and the same knob does the same thing from E58's own coordinate", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const throat = await shootFamily(THROAT);
    const throatLowTwist = await shootFamily(THROAT, { twist: 0.5 });
    // Measured 15.63 against 10.96 — a smaller factor than Vault's, because E58's other
    // values fight it, and in the same direction, which is the whole assertion.
    expect(edgeTail(throatLowTwist)).toBeGreaterThan(edgeTail(throat) * 1.2);
    expect(flatShare(throatLowTwist)).toBeGreaterThan(flatShare(throat) * 1.5);
  }, 180_000);
});
