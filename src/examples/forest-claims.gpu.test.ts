import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E57 FOREST — THE CLAIMS (T1156).
 *
 * A misty moonlit forest walked through forever, meant to sit behind a web page. A
 * screenshot cannot tell an infinite hashed grid from a skybox, a shaft from a gradient, or
 * a quiet zone from a dark corner, so these read the pixels where the design lives:
 *
 *   1. THE MOON IS THE ONLY LIGHT. With `moonGain` at zero no pixel gets brighter anywhere,
 *      and the frame collapses to near-black. Everything else in the picture — the sky
 *      gradient, the fog's own colour, the ambient fill on the bark — is what remains.
 *   2. THE TREES ARE THE STRUCTURE. Emptying the grid halves the local detail in the band
 *      where the forest lives: the picture is trees, not a painted backdrop.
 *   3. THE QUIET ZONE IS MEASURED AND LOCAL. Inside it the local contrast a headline has to
 *      compete with is under half what it is outside; and the window's own arithmetic says
 *      where it stops, so past that point `quiet` may not move a single byte.
 *   4. THE VEIL IS WIRED. Changing the input texture changes the sky and CANNOT change the
 *      bottom of the frame, because a ray that meets ground or trunk never samples it.
 *   5. THE MOTION IS THE WALK, AND IT NEVER STOPS. Cutting the walk collapses frame-to-frame
 *      difference by three orders of magnitude; and at the END of a whole minute the
 *      per-frame motion is still the pace it opened at, with the picture's own statistics
 *      unchanged — which is the repeated domain working, not a loop and not a decay.
 *
 * T1170 added four, for the deepening:
 *
 *   6. THE WOOD CLUMPS, so a minute of walking is not one forest repeated. Twelve frames
 *      spread over half a minute vary from EACH OTHER more than twice as much as they do
 *      with the density field switched off — and the control is thinned to the clumped
 *      field's own mean share, so "more variance" cannot be "fewer trees".
 *   7. THE SECOND STOREY IS SHORT: `understory` moves the picture's structure down the
 *      frame. Its honest limit is stated on the assertion — the SHIPPED value is set by eye
 *      and this measure cannot see it; what is gated is the knob's direction.
 *   8. THE DEFOCUS IS NEAR-FIELD AND DEPTH-DRIVEN. At `focus` 0 it is a byte-exact
 *      passthrough; as shipped it changes under a fifth of the frame and leaves whole-frame
 *      contrast within a percent; with `focus` past the fog's reach the whole picture
 *      collapses — so it is reading depth, over the whole range, and the shipped value is
 *      what restricts it to the near field.
 *   9. THE GAIT IS A TRANSLATION, so it cannot move the sky. With no trees and no haze
 *      every pixel above the horizon is a function of the ray direction alone and is
 *      byte-identical with the gait on and off, while the ground below it is not. That is
 *      the guard on "the camera never turns" — the invariant the veil and the headline
 *      both rest on — against the thing T1170 put next to it.
 *
 * Every bound is exact or derived (§V147): "no pixel brighter" allows exactly one 8-bit
 * quantisation step; the quiet window's edge is solved from the shipped parameters rather
 * than typed in; "differs" is byte inequality; and the ratios carry the measured value they
 * were set from. The suite FAILS without Dawn; it never skips.
 */

const WIDTH = 320;
const HEIGHT = 180; // 16:9, the shipped aspect, so the screen-space derivations below hold
const FILE = "E57-Forest.loom.json";
const LSB = 1 / 255;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function e57() {
  const file = listExamples().find((entry) => entry.fileName === FILE);
  if (file === undefined) throw new Error(`${FILE} is not shipped`);
  const { document } = requireExample(file);
  return {
    graph: structuredClone(document.graph) as GraphDocument,
    settings: { ...document.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
  };
}

/** The shipped value of one of `forest1`'s knobs — derivations read the file, never a copy. */
function knob(name: string): number[] {
  const value = (e57().graph.nodes["forest"]?.parameters ?? {})[name];
  if (typeof value === "number") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) return value as number[];
  throw new Error(`E57's forest1 has no numeric parameter "${name}"`);
}

/** The shipped value of one of `dof1`'s knobs (T1170) — same rule: read the file. */
function dofKnob(name: string): number {
  const value = (e57().graph.nodes["dof"]?.parameters ?? {})[name];
  if (typeof value !== "number") throw new Error(`E57's dof1 has no numeric parameter "${name}"`);
  return value;
}

interface Shot {
  readonly data: Uint8Array;
  readonly luma: Float64Array;
}

async function shoot(
  overrides: Record<string, unknown>,
  frames: readonly number[],
  veilAmp?: number,
  /** T1170: `dof1`'s own knobs — `focus` and `blur` live on the defocus pass, not on `forest1`. */
  dof?: Record<string, unknown>,
): Promise<Shot[]> {
  const { graph, settings } = e57();
  Object.assign(graph.nodes["forest"]!.parameters as Record<string, unknown>, overrides);
  if (dof !== undefined) Object.assign(graph.nodes["dof"]!.parameters as Record<string, unknown>, dof);
  if (veilAmp !== undefined) {
    (graph.nodes["veil"]!.parameters as Record<string, unknown>)["amp"] = veilAmp;
  }
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    frames: Math.max(...frames) + 1,
    capture: [...frames],
    animate: true,
    fps: 60,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = result.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  return frames.map((index) => {
    const frame = result.frames.find((entry) => entry.frameIndex === index);
    if (frame === undefined) throw new Error(`no captured frame ${index}`);
    const image = toRgba8(
      {
        width: frame.width,
        height: frame.height,
        format: frame.format,
        bytes: frame.bytes,
        rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
      },
      { space },
    );
    const luma = new Float64Array(WIDTH * HEIGHT);
    for (let p = 0; p < luma.length; p += 1) {
      const at = p * 4;
      luma[p] =
        (0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0)) / 255;
    }
    return { data: image.data, luma };
  });
}

const mean = (shot: Shot): number => shot.luma.reduce((a, b) => a + b, 0) / shot.luma.length;

/** Pixels where `a` is brighter than `b` by more than one quantisation step. */
function brighterCount(a: Shot, b: Shot): number {
  let count = 0;
  for (let p = 0; p < a.luma.length; p += 1) if ((a.luma[p] ?? 0) > (b.luma[p] ?? 0) + LSB) count += 1;
  return count;
}

/**
 * LOCAL CONTRAST: the mean absolute luma gradient over a region — literally what a headline
 * set over that region has to compete with. A flat wash reads near zero however bright it
 * is; an edge (a trunk, a branch, the moon's limb) is what raises it.
 */
function detail(shot: Shot, where: (u: number, v: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let y = 1; y < HEIGHT - 1; y += 1) {
    for (let x = 1; x < WIDTH - 1; x += 1) {
      if (!where((x + 0.5) / WIDTH, (y + 0.5) / HEIGHT)) continue;
      const at = y * WIDTH + x;
      sum += Math.abs((shot.luma[at] ?? 0) - (shot.luma[at + 1] ?? 0));
      sum += Math.abs((shot.luma[at] ?? 0) - (shot.luma[at + WIDTH] ?? 0));
      n += 1;
    }
  }
  return sum / n;
}

function differingPixels(a: Shot, b: Shot, where: (u: number, v: number) => boolean): number {
  let count = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (!where((x + 0.5) / WIDTH, (y + 0.5) / HEIGHT)) continue;
      const at = (y * WIDTH + x) * 4;
      if (a.data[at] !== b.data[at] || a.data[at + 1] !== b.data[at + 1] || a.data[at + 2] !== b.data[at + 2]) {
        count += 1;
      }
    }
  }
  return count;
}

/** The `q`-quantile of luma over a region — the dark TAIL of a band is its trunks. */
function quantile(shot: Shot, where: (u: number, v: number) => boolean, q: number): number {
  const values: number[] = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (where((x + 0.5) / WIDTH, (y + 0.5) / HEIGHT)) values.push(shot.luma[y * WIDTH + x] ?? 0);
    }
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * q)] ?? 0;
}

function meanAbsDelta(a: Shot, b: Shot): number {
  let sum = 0;
  for (let p = 0; p < a.luma.length; p += 1) sum += Math.abs((a.luma[p] ?? 0) - (b.luma[p] ?? 0));
  return sum / a.luma.length;
}

const differs = (a: Shot, b: Shot): boolean => differingPixels(a, b, () => true) > 0;

/**
 * THE QUIET ZONE'S OWN GEOMETRY, solved from the shipped knobs rather than copied.
 *
 * The shader mixes toward the far-field fog by `quiet * smoothstep(1.7, 0, len)` where
 * `len = |(uv - quietAt) * (aspect, 1)| / quietSize`. `smoothstep` is EXACTLY zero at and
 * above its upper edge, so the weight is exactly zero — no rounding, no epsilon — wherever
 * `len >= 1.7`, and the horizontal term alone is enough to guarantee that:
 *
 *     |u - quietAt.x| * aspect / quietSize >= 1.7   ⟺   |u - quietAt.x| >= 1.7 * quietSize / aspect
 *
 * That is the column past which `quiet` may not change a single byte, and it is what makes
 * "the zone is LOCAL" a claim about identity rather than about smallness.
 */
const QUIET_FALLOFF = 1.7;
function quietGeometry() {
  const at = knob("quietAt");
  const size = knob("quietSize")[0]!;
  const aspect = WIDTH / HEIGHT;
  return {
    centre: { u: at[0]!, v: at[1]! },
    size,
    aspect,
    /* T1170: AND PAST THE DEFOCUS PASS'S OWN REACH. `dof1` gathers over `uv + d * blur *
       (1, aspect)` with `|d| <= 1`, so its widest horizontal reach is exactly `blur` in
       u — which means a pixel within `blur` of the column below can still collect a tap
       from INSIDE the quiet zone, and the byte-identity claim would be false by one
       gather. Adding the shipped `blur` keeps the claim derived from the file rather than
       loosened by an epsilon. */
    outsideFrom: at[0]! + (QUIET_FALLOFF * size) / aspect + dofKnob("blur"),
    /** Well inside the zone: half the falloff radius, so it is unambiguously "the patch". */
    inZone: (u: number, v: number) =>
      Math.hypot(((u - at[0]!) * aspect) / size, (v - at[1]!) / size) < QUIET_FALLOFF * 0.32,
  };
}

describe("E57 Forest — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the moon is the only light: switching it off brightens no pixel and empties the frame", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [lit] = await shoot({}, [60]);
    const [dark] = await shoot({ moonGain: 0 }, [60]);
    // Every term `moonGain` feeds — the disc, the aureole, the bark's diffuse and rim, the
    // ground, the shafts — is non-negative and LINEAR in it, and the post chain (exposure,
    // vignette, filmic) is monotone, so `dark <= lit` holds per pixel up to one 8-bit step.
    expect(brighterCount(dark!, lit!)).toBe(0);
    // Not vacuous, and the number is the point: the moon carries 98% of the light in this
    // picture (measured 0.298 -> 0.006 mean linear-ish luma). What survives is the sky's own
    // gradient and the fog's colour, which is the correct answer for a night with no moon.
    expect(mean(dark!)).toBeLessThan(mean(lit!) * 0.05);
  });

  it("the trees are the structure: emptying the grid halves the detail in the band they live in", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    /* T1170: FOUR FRAMES RATHER THAN ONE, and that is a consequence of the clumping rather
       than a convenience. With a constant per-cell probability every frame held about the
       same amount of wood, so one frame WAS the file; with a density field the frames differ
       from each other by design (that is claim 6), and a single-frame statistic now reports
       which stand the camera happens to be standing in. */
    const frames = [60, 240, 900, 1500];
    const wood = await shoot({}, frames);
    const bare = await shoot({ density: 0 }, frames);
    // The band between a quarter and a half down the frame is above the mist floor and below
    // the crowns — where trunks and branches are the only thing in the picture.
    const band = (_u: number, v: number) => v > 0.25 && v < 0.55;
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(differs(wood[0]!, bare[0]!)).toBe(true);
    // Measured 0.0340 with the forest and 0.0189 without: half of everything there is to see
    // in that band is the wood. What is left is the fog's own gradient and the moon.
    expect(avg(bare.map((s) => detail(s, band)))).toBeLessThan(avg(wood.map((s) => detail(s, band))) * 0.6);
    /* AND THE DARK TAIL IS TRUNK, which is the half of the claim the gradient cannot make.
       Local contrast is raised as much by a shaft in the mist as by a silhouette, so a forest
       that had stopped drawing its trees and only kept throwing their shadows would still
       pass the line above — it was tried, and it did.
       ⚑ T1170 HAD TO REBUILD THIS ASSERTION, AND WHY IS THE INTERESTING PART. It used to
       compare the darkest HUNDREDTH of the band, wooded against bare, and asked for a factor
       of two: 0.0199 against 0.0589. That worked only because a uniformly dense wood always
       put a near backlit trunk in the band, so the trunk owned the dark tail. Under a
       clumped field it stops owning it — in three of these four frames the darkest hundredth
       is the VIGNETTE'S OWN CORNER, not a tree, and the ratio collapses to 1.16. The
       statistic had quietly changed what it was measuring.
       So the claim is now stated the way it was always meant: take the level below which the
       TREELESS frame puts exactly one percent of the band — that level is the fog's own
       floor, by construction — and count how much of the wooded band falls below it. The
       fog cannot make a pixel darker than its own floor; only a trunk can. Measured: 0.85%
       of the bare band against 3.88% of the wooded one, four and a half times as many, and
       every single frame is above its own control (the closest is 1.30% against 0.80%). */
    const level = avg(bare.map((s) => quantile(s, band, 0.01)));
    const belowLevel = (shot: Shot): number => {
      let dark = 0;
      let total = 0;
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          if (!band((x + 0.5) / WIDTH, (y + 0.5) / HEIGHT)) continue;
          total += 1;
          if ((shot.luma[y * WIDTH + x] ?? 0) < level) dark += 1;
        }
      }
      return dark / total;
    };
    expect(avg(wood.map(belowLevel))).toBeGreaterThan(avg(bare.map(belowLevel)) * 2);
  }, 180_000);

  it("the quiet zone is quiet, and it stops exactly where its own window says", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const q = quietGeometry();
    const [shipped] = await shoot({}, [60]);
    const [none] = await shoot({ quiet: 0 }, [60]);
    const [full] = await shoot({ quiet: 1 }, [60]);
    // It is a knob and it moves the thing it claims to: more `quiet`, less local contrast in
    // the patch (measured 0.0271 at 0, 0.0155 as shipped, 0.0069 at 1).
    expect(detail(full!, q.inZone)).toBeLessThan(detail(shipped!, q.inZone));
    expect(detail(shipped!, q.inZone)).toBeLessThan(detail(none!, q.inZone));
    // As shipped, a headline lands on under half the contrast of the frame around it
    // (measured 0.0155 inside against 0.0324 outside).
    expect(detail(shipped!, q.inZone)).toBeLessThan(detail(shipped!, (u, v) => !q.inZone(u, v)) * 0.55);
    // AND IT IS LOCAL, to the byte: past the column its own falloff solves to, going from
    // quiet 0 to quiet 1 may not change a single pixel. This is the assertion that separates
    // a placed zone from a global grade, so it is last (§V910).
    expect(differingPixels(none!, full!, (u) => u > q.outsideFrom)).toBe(0);
  });

  it("the cloud veil is wired to the sky, and cannot reach the ground", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [shipped] = await shoot({}, [60]);
    const [flat] = await shoot({}, [60], 0);
    // A ray that meets the ground plane or a trunk never samples `inputTexture` — the veil is
    // read only where the sky is drawn — and below the horizon band the ground is always
    // inside the march's reach. So the bottom fifth of the frame is byte-identical however
    // the veil is set, while the sky is not. Measured: 5438 pixels change, 0 of them here.
    expect(differingPixels(shipped!, flat!, (_u, v) => v > 0.8)).toBe(0);
    // Non-vacuous, and the wire claim proper: the input is not decoration, the picture
    // depends on it (§V88's "built, tested, never wired" is this project's dominant bug).
    expect(differs(shipped!, flat!)).toBe(true);
  });

  it("the motion is the walk, and a whole minute later it has not stopped", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [a, b] = await shoot({}, [60, 180]);
    const [stillA, stillB] = await shoot({ walkSpeed: 0, sway: 0, bob: 0 }, [60, 180]);
    // Cut the walk and the picture stops: 0.02775 mean |Δ| over the look window becomes
    // 0.00004, which is the cloud drift and nothing else. The motion budget is the walk's.
    expect(meanAbsDelta(stillA!, stillB!)).toBeLessThan(meanAbsDelta(a!, b!) * 0.01);
    /* A MINUTE IN, IT IS WALKING AT THE SAME PACE, and the pace is what is measured rather
       than mere inequality. "Frames 3599 and 3600 differ" was the first draft of this and it
       is VACUOUS: with the walk frozen after eight seconds the bytes STILL differ, because
       the cloud veil drifts on its own clock — the assertion passed over a camera that had
       stopped dead, which is precisely the failure §V913 is about and precisely why the
       instrument's own f60-to-f180 row cannot be the whole answer for a file like this.
       So the claim is the per-frame motion at the END against the per-frame motion at the
       START. Measured: 8.577e-4 at f59→60, 1.169e-3 at f1799→1800, 9.155e-4 at f3599→3600 —
       107% of the opening pace at the end of the minute, because a free-running translation
       through a repeated domain has no fixed point to decay into. With the walk cut the same
       measure at the end reads 5.010e-7, three orders of magnitude down. */
    /* ⚑ AND T1170 MADE THIS MEASURE NOISY, WHICH IS THE SECOND THING IT HAD TO LEARN. The
       first draft above compared ONE pair at the start with ONE pair at the end, and the
       deepening broke it: the gait puts a 1.18 Hz oscillation into the per-frame delta and
       the clumped density field puts a thicket-or-clearing into each frame's content, so a
       single pair now reads anywhere from 3.1e-4 to 1.3e-3 — a factor of four — purely on
       which phase and which stand it lands in. The old assertion failed at 0.54 of the
       opening pace and it was RIGHT to: it was measuring one draw, not the pace.
       So the pace is averaged over four pairs spread across the first sixteen seconds and
       four across the last fifteen, which is several gait cycles and several clumps each.
       Measured: 7.977e-4 opening, 7.855e-4 closing — 98% of the pace after a full minute,
       and with the walk cut the same closing measure reads 6.130e-7, thirteen hundred times
       down. */
    const START: readonly (readonly [number, number])[] = [[59, 60], [359, 360], [659, 660], [959, 960]];
    const END: readonly (readonly [number, number])[] = [[2699, 2700], [2999, 3000], [3299, 3300], [3599, 3600]];
    const marks: readonly number[] = [...START, ...END].flat();
    const shots = await shoot({}, marks);
    const at = new Map(marks.map((index, i) => [index, shots[i]!]));
    const pace = (pairs: readonly (readonly [number, number])[]): number =>
      pairs.reduce((sum, [i, j]) => sum + meanAbsDelta(at.get(i)!, at.get(j)!), 0) / pairs.length;
    // And the picture's own statistics have not drifted either — the world is a hashed
    // repeat, not a scene being consumed.
    expect(Math.abs(mean(at.get(3600)!) - mean(at.get(60)!))).toBeLessThan(mean(at.get(60)!) * 0.05);
    expect(pace(END)).toBeGreaterThan(pace(START) * 0.6);
  }, 180_000);

  /* ------------------------------------------------------------------ T1170, the deepening */

  it("the wood clumps, so half a minute of walking is not one forest repeated", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    /* WHAT THIS HAD TO MEASURE, AND THE TWO INSTRUMENTS THAT COULD NOT.
       "The stand clumps" is a statement about the density field's SPATIAL structure, and
       the obvious readings of a single frame both failed on the shipped file: the
       coefficient of variation of per-column local contrast came back 0.559 clumped against
       0.559 even, and the lag-one autocorrelation of the same series 0.824 against 0.792 —
       because a column's contrast is dominated by the vignette and the quiet zone, which
       are identical in both and swamp the wood.
       What a clump field actually does is put a DIFFERENT AMOUNT OF WOOD IN DIFFERENT
       FRAMES. A constant per-cell probability cannot: about fifty cells lie inside the
       reach, so the law of large numbers hands every frame the same forest by the numbers
       however different its trees are — which is the whole of "it reads as a lattice". So
       the measure is the dispersion of whole-frame local contrast ACROSS a walk. The
       vignette contributes to every frame equally and drops out of it. */
    const walk = [60, 210, 360, 510, 660, 810, 960, 1110, 1260, 1410, 1560, 1710];
    const clumped = await shoot({}, walk);
    const even = await shoot({ clumping: 0 }, walk);
    /* THE ASSERTION THAT HAD TO BE FOUND (§V910): a thinner wood would also vary more just
       by sampling, so the honest control is one with the SAME AMOUNT OF WOOD in it. The
       clumped field's mean share is a measured 0.85 of cells against the shipped `density`
       of 1, so this is the even field carrying the same trees over the same walk. */
    const evenMatched = await shoot({ clumping: 0, density: 0.85 }, walk);
    const spread = (shots: Shot[]): number => {
      const series = shots.map((shot) => detail(shot, () => true));
      const m = series.reduce((a, b) => a + b, 0) / series.length;
      return Math.sqrt(series.reduce((a, b) => a + (b - m) ** 2, 0) / series.length) / m;
    };
    // Measured: 0.1447 clumped, 0.0831 even, 0.0690 even and density-matched — so the
    // shipped field varies 1.74x and 2.10x more than the two controls respectively, and the
    // bound is set below the WEAKER of the two rather than the flattering one.
    expect(spread(clumped)).toBeGreaterThan(Math.max(spread(even), spread(evenMatched)) * 1.5);
  }, 240_000);

  it("the broken stems are a different object: `snags` moves the structure down the frame", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const frames = [60, 240, 900, 1500];
    const shipped = await shoot({}, frames);
    const none = await shoot({ snags: 0 }, frames);
    const all = await shoot({ snags: 1 }, frames);
    // The high band is where only a whole trunk reaches; the low band is under the crowns,
    // which is where a broken one lives and where the mist is thin enough overhead to see it.
    const low = (_u: number, v: number) => v > 0.5 && v < 0.72;
    const high = (_u: number, v: number) => v > 0.02 && v < 0.22;
    const balance = (shots: Shot[]): number =>
      shots.reduce((a, shot) => a + detail(shot, low) / detail(shot, high), 0) / shots.length;
    /* Break every stem and the frame's structure moves down it: 0.787 at 0 against 0.889 at
       1. The knob does what its comment says (§V146).
       ⚑ AND THIS GATES THE KNOB, NOT ONE OF ITS THREE LIMBS — which is worth stating because
       the red-verify said so. A snag differs from a whole tree three ways: it is shorter, it
       carries no branches, and it ends blunt. Disabling only the HEIGHT and leaving the other
       two still passed this assertion, because a full-height branchless pole moves the same
       balance by emptying the high band instead of filling the low one. So the honest red
       for this line is `snags` having no effect at all, which is what it was verified
       against; a claim that the SHORTNESS specifically carries it would be false. */
    expect(balance(all)).toBeGreaterThan(balance(none) * 1.05);
    /* ⚑ AND THE HONEST LIMIT OF THIS TEST, stated rather than hidden. The SHIPPED value of
       0.28 measures 0.787 on the same instrument — indistinguishable from 0. Three
       statistics were tried and not one of them could see it: this balance, the ratio of
       vertical to horizontal gradient in the band (0.897 at 0, 0.898 shipped, 0.885 at 1 —
       which does not even move monotonically), and per-band local contrast. The shipped
       value was set by LOOKING (§V912), and it was set TWICE: the first version made the
       short stems young trees, which is a mature tree at a quarter scale, and the owner
       read the frame and said the trees were growing. They were. The fix was a change of
       FORM, not of number — a snag keeps the full trunk radius, carries no branches and
       ends blunt where it snapped — and no statistic in this file would have caught the
       first version either. This suite gates the knob's direction; the picture is the judge
       of the value. */
    expect(differingPixels(shipped[0]!, none[0]!, () => true)).toBeGreaterThan(0);
  }, 180_000);

  it("the defocus is near-field and depth-driven, and at focus 0 it is a byte-exact passthrough", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const frames = [60, 240, 900, 1500];
    const all = () => true;
    const shipped = await shoot({}, frames);
    const off = await shoot({}, frames, undefined, { blur: 0 });
    const unfocused = await shoot({}, frames, undefined, { focus: 0 });
    /* `focus` past the fog's own reach, so every surface in the picture is inside the near
       field and the pass has to blur all of it. Derived rather than typed: the reach is
       REACH_OPACITY over the eye-height extinction, which is about 26 m here, and 60 is
       past the hard cap of `spacing * MAX_CELLS` divided by two — well past anything the
       march can return. */
    const everything = await shoot({}, frames, undefined, { focus: 60 });
    /* AT `focus` 0 NOTHING MAY BE DEFOCUSED, AND THE CLAIM IS IDENTITY, NOT SMALLNESS.
       This is the assertion that caught the pass's real defect: the first draft weighted a
       tap by `smoothstep(k - 0.34, k + 0.34, coc)`, whose lower edge is negative for the
       inner taps, so a circle of confusion of exactly zero still landed with weight 0.10 —
       a permanent low-grade blur over the whole frame, far field included, which is exactly
       the "argues with the fog" failure the pass exists to avoid. No still showed it. This
       line read 27401 differing pixels of 57600 and named it. */
    for (let i = 0; i < frames.length; i += 1) {
      expect(differingPixels(unfocused[i]!, off[i]!, all)).toBe(0);
    }
    /* Wired, and LOCAL. Measured 6434, 3637, 445 and 353 pixels of 57600, and the SPREAD is
       the point rather than an inconvenience: a frame with a trunk inside eight metres has a
       tenth of itself defocused and a frame walking an open stand has almost none, which is
       what a near-field effect looks like on a walk. So the wired half is asserted on the
       frame that HAS a near trunk (a hundredth of the frame is far past chance) and the
       local half on every frame — a per-frame "greater than zero" would be asserting that a
       clearing must contain something close, which is not true and not wanted. */
    const touched = frames.map((_f, i) => differingPixels(shipped[i]!, off[i]!, all));
    expect(Math.max(...touched)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
    for (const count of touched) expect(count).toBeLessThan(WIDTH * HEIGHT * 0.2);
    const contrast = (shots: Shot[]): number =>
      shots.reduce((a, shot) => a + detail(shot, all), 0) / shots.length;
    // As shipped the whole frame's contrast is untouched to within a percent (0.02702
    // against 0.02723) — the far field is the fog's job and this pass leaves it alone.
    expect(contrast(shipped)).toBeGreaterThan(contrast(off) * 0.97);
    /* AND IT IS READING DEPTH OVER THE WHOLE RANGE, which is what separates a depth-driven
       blur from a fixed near-field vignette of softness: move `focus` past everything and
       the whole picture collapses to 0.01182, 43% of the sharp frame. The shipped value is
       therefore a CHOICE to restrict it to the near field, not a limit of the mechanism. */
    expect(contrast(everything)).toBeLessThan(contrast(off) * 0.5);
  }, 180_000);

  it("the gait is a translation, so it cannot move the sky", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    /* THE GUARD ON THE INVARIANT T1170 PUT SOMETHING NEXT TO. This file's whole design rests
       on the camera never turning: that is what makes the screen-space cloud veil correct
       rather than a cheat, and what holds the moon and the quiet zone still under a
       headline. The gait added a bob and a lateral roll at the stride rate, and the
       difference between a walk and a shaky-cam is precisely that both of those are
       TRANSLATIONS, and so is the third thing standing beside them — the eye's rise and
       fall over the ground swell (`relief`), which is cut here too. A translation cannot
       change a ray DIRECTION, so with no trees to parallax and no haze whose depth integral
       depends on the eye's altitude, every pixel above the horizon is a pure function of
       `uv` and must be identical to the byte. */
    const frames = [60, 240, 900, 1500];
    const airless = { density: 0, fog: 0, mist: 0, shafts: 0 };
    const walking = await shoot({ ...airless }, frames);
    const gliding = await shoot({ ...airless, bob: 0, sway: 0, relief: 0 }, frames);
    /* The horizon, solved from the shipped camera rather than typed. `q.y = 1 - 2v` and
       `rd.y` has the sign of `lens * sin(pitch) + q.y * cos(pitch)`, so a ray leaves the
       ground exactly at `v = 0.5 + lens * tan(pitch) / 2` — 0.5890 as shipped. One pixel
       row of margin either side keeps the two regions off the boundary itself. */
    const pitch = knob("pitch")[0]!;
    const lens = knob("lens")[0]!;
    const horizon = 0.5 + (Math.tan((pitch * Math.PI) / 180) * lens) / 2;
    const sky = (_u: number, v: number) => v < horizon - 1 / HEIGHT;
    const ground = (_u: number, v: number) => v > horizon + 1 / HEIGHT;
    for (let i = 0; i < frames.length; i += 1) {
      expect(differingPixels(walking[i]!, gliding[i]!, sky)).toBe(0);
      // Non-vacuous, and it is the half that says the gait and the swell are doing anything
      // at all: below the horizon the ground's litter parallaxes with the eye. Measured
      // 3396 to 4387 pixels of the ground band.
      expect(differingPixels(walking[i]!, gliding[i]!, ground)).toBeGreaterThan(0);
    }
    /* AND THE SWELL ON ITS OWN, because the two terms above would pass on the gait alone
       and `relief` is the newer of the two (§V146 wants every knob to move the picture, and
       a knob whose evidence is another knob's is not gated). Cutting only `relief` — the
       gait left running — moves the ground and still cannot touch the sky. */
    const level = await shoot({ ...airless, relief: 0 }, frames);
    for (let i = 0; i < frames.length; i += 1) {
      expect(differingPixels(walking[i]!, level[i]!, sky)).toBe(0);
      expect(differingPixels(walking[i]!, level[i]!, ground)).toBeGreaterThan(0);
    }
  }, 240_000);
});
