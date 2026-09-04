import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import { effectFor, example, valueGraphRun, CENTRE } from "./concepts/helpers.ts";

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
    const [lit] = await shoot({}, [60]);
    const { graph, settings } = e55();
    // `add` requires both inputs, so the branch is cut the way the defect cut it: both gains
    // at zero (gain1's brightness is a driven slot; the static 0 replaces it).
    (graph.nodes["gain"]!.parameters as Record<string, unknown>)["brightness"] = 0;
    (graph.nodes["gain2"]!.parameters as Record<string, unknown>)["brightness"] = 0;
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
