import { beforeAll, describe, expect, it } from "vitest";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { elongation, shootFamily } from "./alembic-family.ts";

/**
 * E61 SKEIN — THE CLAIM (T1171).
 *
 * Skein is E58 Alembic's shader with a dense, slow-growing octave stack in place of the
 * classic doubling — nine octaves at lacunarity 1.25 from a base of 1.6, at `warpGain` 1 —
 * and the one thing it asserts that no sibling does is that this fold **elongates**: the
 * structures are ribbons, long in one direction and thin across it, where E58's are fibre.
 * E58's own claims already assert that every look is far from every other.
 *
 * The statistic is the mean structure-tensor coherence weighted by local gradient energy:
 * how consistently ONE direction wins inside a small window. It is a share, bounded in
 * [0, 1], computed from gradient ratios, so the exposure and the ramp cannot move it.
 *
 * THE CONTROL IS THE FOLD, all four numbers of it, and that is deliberate rather than lazy.
 * Skein's overrides ARE the fold and nothing else — `octaves`, `baseFreq`, `lacunarity`,
 * `warpGain` — so putting E58's fold back is exactly "cut the thing the file is named for"
 * (§V923), and everything that remains is E58's.
 *
 * MEASURED at 320x180, frame 60, on the shipped files:
 *   Skein as shipped (9 oct, base 1.6, lac 1.25, gain 1)   elongation 0.5471
 *   Skein with E58's fold put back                         elongation 0.3390
 *   E58 Throat as shipped                                  elongation 0.3514
 *   and across the family: Snarl 0.3819, Rake 0.4715, Vault 0.4857 — this file is highest.
 *
 * ⚑ TWO PREMISES DIED IN THE MEASUREMENT AND THE DOC RECORDS BOTH, because a claim that only
 * reports its wins is not evidence. (1) The finest octave here sits at 1.6 x 1.25^8 = 9.5
 * against E58's 3 x 2^5 = 96, ten times coarser — but the frame's autocorrelation says the
 * picture is FINER, not coarser (half-decay at lag 9 against 12), so "coarser stack, coarser
 * picture" is not asserted anywhere. (2) It is not the OCTAVE COUNT: drop to six and hold the
 * rest and elongation RISES, to 0.6207. Knob by knob, `warpGain` carries most of the effect
 * (0.3523 alone). Nine octaves are what a lacunarity of 1.25 costs to span any frequency
 * range at all; the ribbon is the stack and the gain together and no single number owns it.
 * Hence the control below is the whole fold, which is the honest unit.
 *
 * The suite FAILS without Dawn; it never skips.
 */

const SKEIN = "E61-Skein.loom.json";
const THROAT = "E58-Alembic.loom.json";
/** E58's fold, exactly — the four numbers that are Skein's entire difference from it. */
const THROAT_FOLD = { octaves: 6, baseFreq: 3, lacunarity: 2, warpGain: 1.6 };

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E61 Skein — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the dense stack reads as ribbon: cut it back to E58's fold and the elongation goes", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const shipped = await shootFamily(SKEIN);
    const withThroatFold = await shootFamily(SKEIN, THROAT_FOLD);
    const throat = await shootFamily(THROAT);

    // Measured 0.5471 against 0.3390 — a factor of 1.61 with everything but the fold held.
    // The bound is 1.35, the measured factor less a sixth.
    expect(elongation(shipped) / elongation(withThroatFold), "Skein's fold against E58's, in this document").toBeGreaterThan(1.35);

    /* ⚑ AND THE CONTROL LANDS WHERE THE FILE IT CAME FROM IS (§V910 — last). This is the
       assertion that says the control actually removed the feature rather than merely
       changing the picture: with E58's fold in it, Skein measures what E58 measures — 0.3390
       against 0.3514, inside 4% — while the shipped file is half again above both. A control
       that landed somewhere else entirely would mean the four numbers had done something
       other than restore E58's fold. */
    const restored = elongation(withThroatFold);
    const original = elongation(throat);
    expect(Math.abs(restored - original) / original, "Skein-with-E58's-fold against E58 itself").toBeLessThan(0.15);
    expect(elongation(shipped)).toBeGreaterThan(original * 1.35);
  }, 240_000);
});
