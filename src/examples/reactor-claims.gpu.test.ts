import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import { effectFor, example, valueGraphRun, CENTRE } from "./concepts/helpers.ts";
import { decodeComponents } from "../tests/headless/pixel-compare.ts";

/**
 * E55 REACTOR — THE CLAIMS (T1141).
 *
 * A nested, organic-framed, glass-faced ball lit from its own core, with the core's light
 * getting out as shafts through the faces. A screenshot cannot tell an emitter from a lit
 * object, so these read the pixels where the design lives:
 *
 *   1. THE CORE IS THE ONLY LIGHT. With `coreGain` and `laserGain` at zero, no pixel gets
 *      brighter — anywhere — and the ball's disc goes dark. Everything else in the frame is
 *      the background and the frame's environment read, both constant.
 *   2. THE FRAME GATES THE LIGHT. With the bars widened until every cell is bar, the shells
 *      are opaque and the medium OUTSIDE the ball goes dark: the shafts are the faces, not a
 *      halo painted around a sphere.
 *   3. THE MUSIC REACHES THE PICTURE, AND ITS LANES NEVER SIT CLAMPED (§V903). Cutting the
 *      six drives — three on the light, three on the FORM (the outer shell's swell, the bar
 *      width, the shell gap) — changes the frame; the driven `coreGain` never falls below
 *      its bias and never holds one value for a second.
 *   4. LIVELINESS IS STRUCTURAL (T1138, §V913). Consecutive frames still differ at the end
 *      of a whole minute, not only inside the first draw.
 *   5. THE SHUTTERS NEVER POP (T1264). A plate's shut weight is a smoothstep of the shield,
 *      not a threshold, and it reaches only the LIGHT: the glass surface is byte-identical
 *      at shield 0 and 1, the frame glow it drives is periodic in the pulse rate, and a
 *      sweep of the shield never moves any plate region by more than a step bound derived
 *      from the ease width and the sweep step.
 *
 * Every bound is exact or derived (§V147): "no pixel brighter" allows exactly one 8-bit
 * quantisation step, the bias bound is the `valueMath` chain's own arithmetic, and "differs"
 * is byte inequality. The suite FAILS without Dawn; it never skips.
 */

const WIDTH = 320;
const HEIGHT = 180; // 16:9, the shipped aspect, so the disc geometry below holds
const FILE = "E55-Reactor.loom.json";
const LSB = 1 / 255;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function e55() {
  const file = listExamples().find((entry) => entry.fileName === FILE);
  if (file === undefined) throw new Error(`${FILE} is not shipped`);
  const { document } = requireExample(file);
  return {
    graph: structuredClone(document.graph) as GraphDocument,
    settings: { ...document.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
  };
}

function setReactor(graph: GraphDocument, overrides: Record<string, unknown>): void {
  const node = graph.nodes["reactor"];
  if (node === undefined) throw new Error("E55 has no `reactor`");
  Object.assign(node.parameters as Record<string, unknown>, overrides);
}

interface Shot {
  readonly data: Uint8Array;
  readonly luma: Float32Array;
}

/** Zero both bloom widths: the ring claims read the HAZE, and a lit shell's bloom spills past the ball. */
function noBloom(graph: GraphDocument): void {
  (graph.nodes["gain"]!.parameters as Record<string, unknown>)["brightness"] = 0;
  (graph.nodes["gain2"]!.parameters as Record<string, unknown>)["brightness"] = 0;
}
/** Neutralise the saturation grade: an HSV saturation boost after the composite is not monotone in
    luma (adding a pale bloom to a saturated blue pixel desaturates it, and re-saturating lowers
    its luma), so a claim about the BLOOM reads the frame before the grade's non-monotone step. */
function noGrade(graph: GraphDocument): void {
  (graph.nodes["grade"]!.parameters as Record<string, unknown>)["saturation"] = 1;
}

async function shoot(overrides: Record<string, unknown>, frames: readonly number[], mutate?: (graph: GraphDocument) => void): Promise<Shot[]> {
  const { graph, settings } = e55();
  setReactor(graph, overrides);
  mutate?.(graph);
  const last = Math.max(...frames);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    frames: last + 1,
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
      { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
      { space },
    );
    const luma = new Float32Array(WIDTH * HEIGHT);
    for (let p = 0; p < luma.length; p += 1) {
      const at = p * 4;
      luma[p] = (0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0)) / 255;
    }
    return { data: image.data, luma };
  });
}

/* The shader's own screen geometry: q = (uv - 0.5) · (aspect, -1) · 2, focal 1.9, the ball
   at distance 3.2 with unit radius → angular radius asin(1/3.2), on screen 1.9·tan(...) =
   0.625 of the half-height, its centre lifted by the aim offset 0.08·1.9/3.2 ≈ 0.05. */
const BALL_R = 0.625;
const BALL_CY = 0.05;
function screenRadius(p: number): number {
  const x = ((p % WIDTH) + 0.5) / WIDTH;
  const y = (Math.floor(p / WIDTH) + 0.5) / HEIGHT;
  const qx = (x - 0.5) * (WIDTH / HEIGHT) * 2;
  const qy = -(y - 0.5) * 2 - BALL_CY;
  return Math.hypot(qx, qy);
}
const inDisc = (p: number) => screenRadius(p) < BALL_R * 0.8;
const inRing = (p: number) => screenRadius(p) > BALL_R * 1.2 && screenRadius(p) < 1.0;

function meanWhere(shot: Shot, where: (p: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < shot.luma.length; p += 1) {
    if (!where(p)) continue;
    sum += shot.luma[p] ?? 0;
    n += 1;
  }
  return sum / n;
}

/** Pixels where `a` is brighter than `b` by more than one quantisation step. */
function brighterCount(a: Shot, b: Shot, where: (p: number) => boolean): number {
  let count = 0;
  for (let p = 0; p < a.luma.length; p += 1) {
    if (where(p) && (a.luma[p] ?? 0) > (b.luma[p] ?? 0) + LSB) count += 1;
  }
  return count;
}

function differs(a: Shot, b: Shot): boolean {
  for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== b.data[i]) return true;
  return false;
}

describe("E55 Reactor — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the core is the only light: switching it off brightens no pixel and darkens the disc", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [on] = await shoot({}, [60]);
    const [off] = await shoot({ coreGain: 0, laserGain: 0 }, [60]);
    expect(on && off).toBeTruthy();
    // Every term the core feeds is non-negative in coreGain (emission, haze, the frame's
    // diffuse/rim/bleed, the facets' reflected glow) and the post chain is monotone (blur, add,
    // filmic), so off ≤ on holds per pixel up to one 8-bit step.
    expect(brighterCount(off!, on!, () => true)).toBe(0);
    // And it is not vacuous: most of the disc lost more than a step.
    let disc = 0;
    for (let p = 0; p < WIDTH * HEIGHT; p += 1) if (inDisc(p)) disc += 1;
    expect(brighterCount(on!, off!, inDisc)).toBeGreaterThan(disc * 0.5);
    expect(meanWhere(off!, inDisc)).toBeLessThan(meanWhere(on!, inDisc));
  });

  it("the frame gates the light: all-bar shells darken the medium outside the ball", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    // With the bloom zeroed, outside the ball the only lit thing is the haze (a shell that is
    // all lit strut blooms past its own edge), and its gate is ≤ 1 with bars and exactly 1
    // without — monotone per pixel, again up to one quantisation step.
    const [open] = await shoot({ frameWidth: 0 }, [60], noBloom);
    const [closed] = await shoot({ frameWidth: 2 }, [60], noBloom);
    expect(brighterCount(closed!, open!, inRing)).toBe(0);
    expect(meanWhere(closed!, inRing)).toBeLessThan(meanWhere(open!, inRing));
  });

  it("the music reaches the picture, and its lanes never sit clamped (§V903)", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [driven] = await shoot({}, [60]);
    // The retained values are what the slots resolve to with the channel cut (§V108).
    const [cut] = await shoot({ coreGain: 1, laserGain: 0.6, facet: 0.7, swell: 1, frameWidth: 0.12, shellGap: 0.2, shieldOuter: 0, shieldInner: 0 }, [60]);
    expect(differs(driven!, cut!)).toBe(true);

    // The value graph alone, 900 frames of the shipped pattern: coreGain = 4.2·level + 0.5
    // with level ≥ 0, so it can never fall below 0.5 — and it never holds still for a second.
    const run = valueGraphRun(example(FILE).document);
    let min = Number.POSITIVE_INFINITY;
    let longestHold = 0;
    let hold = 0;
    let previous = Number.NaN;
    for (let frame = 0; frame < 900; frame += 1) {
      const gain = Number(effectFor(run.step(CENTRE).plan, "reactor").uniforms?.["coreGain"]);
      expect(Number.isFinite(gain)).toBe(true);
      min = Math.min(min, gain);
      hold = Math.abs(gain - previous) < 1e-6 ? hold + 1 : 0;
      longestHold = Math.max(longestHold, hold);
      previous = gain;
    }
    expect(min).toBeGreaterThanOrEqual(0.5);
    expect(longestHold).toBeLessThan(60);
  });

  it("the shutters shield: a shut shell darkens the medium outside the ball, an open one is the rest state", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [open] = await shoot({ shieldOuter: 0, shieldInner: 0 }, [60], noBloom);
    const [shut] = await shoot({ shieldOuter: 1, shieldInner: 1 }, [60], noBloom);
    // A shut plate is a gate at 0 where an open face is ≤ 1: monotone per pixel in the ring,
    // and the ring is darker in the mean — the "shielded inside" half of the owner's gesture.
    expect(brighterCount(shut!, open!, inRing)).toBe(0);
    expect(meanWhere(shut!, inRing)).toBeLessThan(meanWhere(open!, inRing));
    // And the shipped file at frame 60 IS the open state (§V914): identical bytes.
    const [shipped] = await shoot({}, [60], noBloom);
    expect(differs(shipped!, open!)).toBe(false);
  });

  it("the bloom branch is alive: zeroing both widths darkens the disc", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    // The branch shipped DEAD for three rounds (cut1.brightness was 0, a multiplier) and no
    // gate noticed, because add(x, 0) = x. This is the wire-cut claim that would have.
    const [lit] = await shoot({}, [60], noGrade);
    const { graph, settings } = e55();
    // `add` requires both inputs, so the branch is cut the way the defect cut it: both gains
    // at zero (gain1's brightness is a driven slot; the static 0 replaces it).
    noBloom(graph);
    noGrade(graph);
    const result = await renderHeadless({ host: nodeGpuHost(), graph, settings, frames: 61, capture: [60], animate: true, fps: 60, outputNodeId: "out" });
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
    const frame = result.frames[0]!;
    const space = result.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
    const image = toRgba8(
      { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
      { space },
    );
    const bare: Shot = { data: image.data, luma: new Float32Array(WIDTH * HEIGHT) };
    for (let p = 0; p < bare.luma.length; p += 1) {
      const at = p * 4;
      bare.luma[p] = (0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0)) / 255;
    }
    // A bloom only ADDS: no pixel is darker with it, and the disc is brighter with it.
    expect(brighterCount(bare, lit!, () => true)).toBe(0);
    expect(meanWhere(lit!, inDisc)).toBeGreaterThan(meanWhere(bare, inDisc));
  });

  it("liveliness is structural: consecutive frames differ at the end of a minute", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [a, b, c, d] = await shoot({}, [60, 1800, 3599, 3600]);
    expect(differs(c!, d!)).toBe(true);
    expect(differs(a!, b!)).toBe(true);
    expect(differs(b!, d!)).toBe(true);
  }, 120_000);
});

/* T1264 — THE SHUTTERS. The shield drives a per-plate weight
   w = smoothstep(h, h + E, share), share = mix(rest, 1 + E, shield), E = SHUT_EASE = 0.3,
   h = the plate's hash. Its whole reach is the light: frame seam/bleed glow, the ray's
   transmission (× (1 − shutDim·w)) and the haze gate's leak. The surface is never touched. */

/** The reactor node's own LINEAR output at one frame, luma per pixel — no tone map, no
    bloom, so a term that is affine in the plate weights stays affine in what is read. */
async function shootLinear(overrides: Record<string, unknown>, frame: number): Promise<Float32Array> {
  const { graph, settings } = e55();
  setReactor(graph, overrides);
  const result = await renderHeadless({ host: nodeGpuHost(), graph, settings, frames: frame + 1, capture: [frame], animate: true, fps: 60, outputNodeId: "reactor" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const captured = result.frames.find((entry) => entry.frameIndex === frame);
  if (captured === undefined) throw new Error(`no captured frame ${frame}`);
  if (captured.width !== WIDTH || captured.height !== HEIGHT) throw new Error(`reactor drew ${captured.width}x${captured.height}`);
  const c = decodeComponents(captured.bytes, captured.format);
  const luma = new Float32Array(WIDTH * HEIGHT);
  for (let p = 0; p < luma.length; p += 1) luma[p] = 0.2126 * (c[p * 4] ?? 0) + 0.7152 * (c[p * 4 + 1] ?? 0) + 0.0722 * (c[p * 4 + 2] ?? 0);
  return luma;
}

/** Pixels where `a` and `b` differ by more than one 8-bit step, in `where`. */
function differCount(a: Shot, b: Shot, where: (p: number) => boolean): number {
  let count = 0;
  for (let p = 0; p < a.luma.length; p += 1) {
    if (where(p) && Math.abs((a.luma[p] ?? 0) - (b.luma[p] ?? 0)) > LSB) count += 1;
  }
  return count;
}

describe("E55 Reactor — the shutters never pop (T1264)", () => {
  /* Light-off configuration: coreGain and laserGain zero kill every term the shield reaches
     through the light (glow, haze), shutDim 0 kills the transmission hold, and a BLACK core
     and edge colour pin coreRGB() at zero (the shield cools it towards edgeColor, and the
     frame's ambient term reads it; a non-black pin is inexact — the colours are sRGB-decoded
     before upload and the mix rounds). What is left is the surface: facets, Fresnel,
     refraction, the background and the frame's environment read. */
  const DARK = { coreGain: 0, laserGain: 0, shutDim: 0, coreColor: [0, 0, 0, 1], edgeColor: [0, 0, 0, 1] };

  it("SURFACE INVARIANT: with the light off the picture is byte-identical at shield 0 and 1", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [open] = await shoot({ ...DARK, shieldOuter: 0, shieldInner: 0 }, [60]);
    const [shut] = await shoot({ ...DARK, shieldOuter: 1, shieldInner: 1 }, [60]);
    // Every facet, Fresnel term, refraction path and frame profile is the same: the shield
    // switches no geometry and no material. Exact: not one byte moves.
    expect(differs(open!, shut!)).toBe(false);
    // Not vacuous — with the light still off, the one thing the shield reaches that is not
    // light-scaled, the transmission hold (shutDim shipped), darkens the disc.
    const [heldOpen] = await shoot({ ...DARK, shutDim: 0.7, shieldOuter: 0, shieldInner: 0 }, [60]);
    const [heldShut] = await shoot({ ...DARK, shutDim: 0.7, shieldOuter: 1, shieldInner: 1 }, [60]);
    expect(brighterCount(heldOpen!, heldShut!, inDisc)).toBeGreaterThan(0);
  }, 120_000);

  it("REACTS: shutting the inner shells only ADDS frame glow — no pixel darker, the disc brighter", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    // shieldOuter stays 0 so coreGain() and coreRGB() do not move; shutDim 0 removes the
    // hold; haze 0 removes the gate's leak. What is left of the shield is the seam/bleed
    // glow, which is non-negative and monotone in the weight.
    // The saturation grade is not monotone in luma (see noGrade), so the frame is read before it.
    const still = { shieldOuter: 0, shutDim: 0, haze: 0 };
    const [open] = await shoot({ ...still, shieldInner: 0 }, [60], noGrade);
    const [shut] = await shoot({ ...still, shieldInner: 1 }, [60], noGrade);
    expect(brighterCount(open!, shut!, () => true)).toBe(0);
    expect(brighterCount(shut!, open!, inDisc)).toBeGreaterThan(0);
    expect(meanWhere(shut!, inDisc)).toBeGreaterThan(meanWhere(open!, inDisc));
  });

  it("PULSE: the shut glow is periodic in shutPulse — a rate of 2π at t = 1 s repeats a rate of 0, π does not", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    // pulse = 0.65 + 0.35·sin(absTime·shutPulse + phase). Frame 60 at 60 fps is absTime 1.0
    // exactly, so shutPulse 2π lands every plate on the same sine value as shutPulse 0 (up
    // to a float rounding of the argument, hence "one 8-bit step"), while π negates it.
    const still = { shieldOuter: 0, shieldInner: 1, shutDim: 0, haze: 0 };
    const [hold] = await shoot({ ...still, shutPulse: 0 }, [60]);
    const [turn] = await shoot({ ...still, shutPulse: 2 * Math.PI }, [60]);
    const [half] = await shoot({ ...still, shutPulse: Math.PI }, [60]);
    expect(differCount(hold!, turn!, () => true)).toBe(0);
    expect(differCount(hold!, half!, inDisc)).toBeGreaterThan(0);
  });

  it("CONTINUITY: a 60-step sweep of the inner shield never moves any plate region by more than the derived step bound", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    /* Two shells, shieldOuter 0, blocked 0: only shell 1's weights move, every plate starts
       fully open (share 0 ≤ h) and ends fully shut (share 1 + E ≥ h + E), and nothing else in
       the picture depends on shieldInner. Same frame index for every step, so the pulse and
       the camera are constant.

       THE BOUND. Per step Δs = 1/K of shield, Δshare = (1 + E − rest)/K = (1 + E)/K. The
       smoothstep's steepest slope is 1.5/E per unit share, so any one plate weight moves
       ≤ ρ = 1.5·(1 + E)/(E·K) per step while travelling exactly 1 over the sweep. A region's
       linear luma is a sum of terms each affine in one plate weight (glow, bar glow, gate
       leak) or the product of two (a ray crossing shell 1 twice: (1 − d·w_a)(1 − d·w_b), d =
       shutDim). For an affine term c·w the ratio (largest single step) / (total variation
       over the sweep) is ≤ ρ·|c| / |c| = ρ; for the product term with d = 0.7 the largest
       step is ≤ 2dρ·X and the variation ≥ (1 − (1 − d)²)·X = 0.91·X, so ≤ 1.54ρ. The claim
       asserts 2ρ on the shipped shutDim over every 8×8 block whose variation is at least a
       quarter of the largest (the blocks where the shutters act), with the summed terms'
       partial cancellation the one assumption not derived. Measured 0.101 (ρ = 0.108, 2ρ =
       0.217); a threshold put back in place of the smoothstep gives 0.86, which is what
       red-verified this bound. */
    const K = 60;
    const E = 0.3;
    const rho = (1.5 * (1 + E)) / (E * K);
    const bound = 2 * rho;
    const sweep: Float32Array[] = [];
    for (let i = 0; i <= K; i += 1) sweep.push(await shootLinear({ layers: 2, blocked: 0, shieldOuter: 0, shieldInner: i / K }, 0));
    const BLOCK = 8;
    const cols = WIDTH / BLOCK;
    const rows = HEIGHT / BLOCK;
    const blocks: { ratio: number; variation: number }[] = [];
    for (let by = 0; by < rows; by += 1) {
      for (let bx = 0; bx < cols; bx += 1) {
        const centre = (by * BLOCK + BLOCK / 2) * WIDTH + bx * BLOCK + BLOCK / 2;
        if (!inDisc(centre)) continue;
        const means = sweep.map((luma) => {
          let sum = 0;
          for (let y = 0; y < BLOCK; y += 1) for (let x = 0; x < BLOCK; x += 1) sum += luma[(by * BLOCK + y) * WIDTH + bx * BLOCK + x] ?? 0;
          return sum / (BLOCK * BLOCK);
        });
        let variation = 0;
        let largest = 0;
        for (let i = 1; i <= K; i += 1) {
          const step = Math.abs((means[i] ?? 0) - (means[i - 1] ?? 0));
          variation += step;
          largest = Math.max(largest, step);
        }
        blocks.push({ ratio: variation > 0 ? largest / variation : 0, variation });
      }
    }
    const most = Math.max(...blocks.map((b) => b.variation));
    expect(most).toBeGreaterThan(0);
    const acting = blocks.filter((b) => b.variation >= most / 4);
    expect(acting.length).toBeGreaterThan(0);
    const worst = Math.max(...acting.map((b) => b.ratio));
    expect(worst, `largest step / total variation ${worst.toFixed(4)} over ${acting.length} acting blocks; bound 2ρ = ${bound.toFixed(4)}`).toBeLessThanOrEqual(bound);
  }, 600_000);
});

