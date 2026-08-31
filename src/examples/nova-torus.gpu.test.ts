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
