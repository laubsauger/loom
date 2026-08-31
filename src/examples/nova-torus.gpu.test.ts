import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T660 — E35'S REASON TO EXIST, ASSERTED FROM PIXELS.
 *
 * The orchestration brief was explicit: E35 earns its slot because the audio drives the
 * TUBE'S THICKNESS (`radius2` ← lowMid) where Corona drives a sphere's whole radius —
 * "if that reactivity is not legible in the shipped render, it is Corona with a
 * different mesh and not worth a slot." So the gate measures legibility, not wiring:
 * the same document with the pattern muted renders a visibly thinner ring, and the
 * difference is large enough that no drift can hide it. Judged on the display-encoded
 * tile (§V618). Measured at build time: 16.7% of the frame lit against 6.3% muted.
 */

function e35() {
  const file = listExamples().find((entry) => entry.fileName === "E35-Nova-Torus.loom.json");
  if (file === undefined) throw new Error("E35-Nova-Torus.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

async function litFraction(muted: boolean): Promise<number> {
  const { document } = e35();
  const graph = structuredClone(document.graph) as typeof document.graph;
  if (muted) {
    const music = Object.values(graph.nodes).find((node) => node.label === "music1");
    if (music === undefined) throw new Error("E35 has no music1 — the T504 swap is gone");
    (music.parameters as Record<string, unknown>)["amount"] = 0;
  }
  const output = Object.values(graph.nodes).find((node) => node.label === "output1");
  if (output === undefined) throw new Error("E35 has no output1");
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: 41,
    capture: [40],
    animate: true,
    outputNodeId: output.id,
  });
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
  const rgba = toRgba8(
    { width: frame.width, height: frame.height, format: frame.format, rowStride: frame.bytes.length / frame.height, bytes: frame.bytes } as never,
    { space } as never,
  ).data;
  let lit = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0) > 45) lit += 1;
  }
  return lit / (rgba.length / 4);
}

/**
 * T683 — THE TURNTABLE, gated the way the symmetry trap demands.
 *
 * A torus is rotationally symmetric about its own axis, so "each layer's angle
 * advances" would pass on a rotation nobody can see. What cannot hide is the
 * RELATIONSHIP between the layers — the cyan band and the warm body sweep against
 * each other — so the gate asserts the relative phase between the two colour
 * populations' centroids MOVES across two seconds of absolute time.
 *
 * The motion was the owner's all along: the kernel multiplied ctx.absTime by 0.001
 * (a milliseconds assumption — absTime is seconds), freezing its own authored tumble,
 * band sweep and morphs at 1/1000th speed. Measured before the fix: relative phase
 * jittered with the audio (−0.24 → −0.50 → −0.43 over 120 frames, no progression);
 * after: it sweeps −0.24 → −0.005 → +0.50. That jitter is why the gate demands a
 * NET sweep with a margin no audio wobble reaches.
 */
function centroidAngles(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): { cyan: number; warm: number } {
  let cx = 0, cy = 0, cn = 0, wx = 0, wy = 0, wn = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0, g = rgba[i + 1] ?? 0, b = rgba[i + 2] ?? 0;
    if (r + g + b < 120) continue;
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    if (b > r + 30) { cx += x; cy += y; cn += 1; }
    else if (r > b + 30) { wx += x; wy += y; wn += 1; }
  }
  const angle = (sx: number, sy: number, n: number) => Math.atan2(sy / n - height / 2, sx / n - width / 2);
  if (cn < 500 || wn < 500) throw new Error(`a colour population vanished (cyan ${cn}, warm ${wn})`);
  return { cyan: angle(cx, cy, cn), warm: angle(wx, wy, wn) };
}

describe("E35 — the layers turn against each other (T683)", () => {
  it("relative phase between the colour populations sweeps, and survives a lap by construction", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { document } = e35();
    const kernelNode = Object.values(document.graph.nodes).find((node) => node.label === "pointkernel1");
    const kernel = String((kernelNode?.parameters as Record<string, unknown>)["kernel"]);
    // Lap survival is structural: the kernel's clock is ctx.absTime (seconds, keeps
    // counting across a timeline lap) and never bare ctx.time. A pixel test of the lap
    // would need transport levers this harness does not expose; the clock CHOICE is
    // the §V436 contract, and it is what a lap cannot break.
    expect(kernel).toContain("let t = ctx.absTime;");
    // The comment ABOUT ctx.time is allowed (it explains the choice); a READ is not.
    const code = kernel.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    expect(/\bctx\.time\b/.test(code)).toBe(false);

    const output = Object.values(document.graph.nodes).find((node) => node.label === "output1");
    if (output === undefined) throw new Error("E35 has no output1");
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: document.settings,
      frames: 121,
      capture: [0, 120],
      animate: true,
      outputNodeId: output.id,
    });
    const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
    const angles = result.frames.map((frame) => {
      const rgba = toRgba8(
        { width: frame.width, height: frame.height, format: frame.format, rowStride: frame.bytes.length / frame.height, bytes: frame.bytes } as never,
        { space } as never,
      ).data;
      return centroidAngles(rgba, frame.width, frame.height);
    });
    const rel = angles.map((a) => a.cyan - a.warm);
    // The sweep: 0.74 rad measured over these two seconds; the frozen kernel's
    // audio-only jitter never exceeded ~0.27. The margin sits between the two.
    expect(Math.abs((rel[1] ?? 0) - (rel[0] ?? 0))).toBeGreaterThan(0.4);
  }, 240_000);
});

describe("E35 — the audio drives the tube, visibly (T660, §V471)", () => {
  it("muting the pattern thins the ring to well under half its lit area", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const [loud, muted] = await Promise.all([litFraction(false), litFraction(true)]);
    // The driven tube: with the pattern playing, the lowMid band holds radius2 well
    // above its 0.18 floor and the ring wears real thickness.
    expect(loud).toBeGreaterThan(0.12);
    // Muted, radius2 sits at the floor and the ring is a thread — the reactivity IS
    // the picture, which is the §V461 distinction: a dead audio path cannot pass.
    expect(muted).toBeLessThan(loud * 0.6);
    expect(muted).toBeGreaterThan(0.02); // but the torus itself still draws — muted ≠ blank
  }, 240_000);
});
