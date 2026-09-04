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

interface Shot {
  readonly data: Uint8Array;
  readonly luma: Float64Array;
}

async function shoot(
  overrides: Record<string, unknown>,
  frames: readonly number[],
  veilAmp?: number,
): Promise<Shot[]> {
  const { graph, settings } = e57();
  Object.assign(graph.nodes["forest"]!.parameters as Record<string, unknown>, overrides);
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
    outsideFrom: at[0]! + (QUIET_FALLOFF * size) / aspect,
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
    const [wood] = await shoot({}, [60]);
    const [bare] = await shoot({ density: 0 }, [60]);
    // The band between a quarter and a half down the frame is above the mist floor and below
    // the crowns — where trunks and branches are the only thing in the picture.
    const band = (_u: number, v: number) => v > 0.25 && v < 0.55;
    expect(differs(wood!, bare!)).toBe(true);
    // Measured 0.0393 with the forest and 0.0193 without: half of everything there is to see
    // in that band is the wood. What is left is the fog's own gradient and the moon.
    expect(detail(bare!, band)).toBeLessThan(detail(wood!, band) * 0.6);
    // AND THE DARK TAIL IS TRUNK, which is the half of the claim the gradient cannot make.
    // Local contrast is raised as much by a shaft in the mist as by a silhouette, so a
    // forest that had stopped drawing its trees and only kept throwing their shadows would
    // still pass the line above — it was tried, and it did. The darkest hundredth of the
    // band is a backlit trunk and nothing else is anywhere near that dark: measured 0.0199
    // with the wood against 0.0589 without, three times up, because with no trees the floor
    // of the band IS the fog (§V910: the assertion that had to be found is last).
    expect(quantile(bare!, band, 0.01)).toBeGreaterThan(quantile(wood!, band, 0.01) * 2);
  });

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
    const [pre, early, penultimate, last] = await shoot({}, [59, 60, 3599, 3600]);
    // And the picture's own statistics have not drifted either — the world is a hashed
    // repeat, not a scene being consumed.
    expect(Math.abs(mean(last!) - mean(early!))).toBeLessThan(mean(early!) * 0.05);
    expect(meanAbsDelta(penultimate!, last!)).toBeGreaterThan(meanAbsDelta(pre!, early!) * 0.6);
  }, 180_000);
});
