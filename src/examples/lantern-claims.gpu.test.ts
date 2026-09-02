import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E46 LANTERN — THE CLAIMS (T850).
 *
 * A dark room lit by drifting lanterns, with static obstacles that the light rakes across
 * and casts soft shadows from — glow and shadow off ONE distance field. A screenshot cannot
 * tell a lit room from a wash, so these read the pixels where the design lives: the light
 * BREATHES on `amount` without ever going black (§V471); the frame holds a real dynamic
 * range — unlit floor falling to black while a lantern core burns bright — rather than the
 * even grey a flood or a blur would give; and an obstacle is an OPAQUE lit surface, so no
 * lantern core bleeds through it (the lanterns steer around the obstacles, never into them).
 */

const WIDTH = 320;
const HEIGHT = 180; // 16:9, matching the shipped aspect so the uv maths hold

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function e46() {
  const file = listExamples().find((entry) => entry.fileName === "E46-Lantern.loom.json");
  if (file === undefined) throw new Error("E46-Lantern.loom.json is not shipped");
  const { document } = requireExample(file);
  return {
    graph: structuredClone(document.graph) as GraphDocument,
    settings: { ...document.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
  };
}

function setAmount(graph: GraphDocument, amount: number): void {
  const node = graph.nodes["lantern"];
  if (node === undefined) throw new Error("E46 has no `lantern`");
  (node.parameters as Record<string, unknown>)["amount"] = amount;
}

interface Shot {
  luma: (u: number, v: number) => number;
  mean: number;
  min: number;
  max: number;
}

async function shoot(amount: number): Promise<Shot> {
  const { graph, settings } = e46();
  setAmount(graph, amount);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    frames: 1,
    capture: [0],
    animate: true,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = result.frames[0]!;
  const space = result.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
    { space },
  );
  const lumaOf = (at: number): number =>
    (0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0)) / 255;
  let sum = 0;
  let min = 1;
  let max = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const l = lumaOf(at);
    sum += l;
    min = Math.min(min, l);
    max = Math.max(max, l);
  }
  return {
    luma: (u, v) => {
      const x = Math.min(WIDTH - 1, Math.max(0, Math.round(u * WIDTH)));
      const y = Math.min(HEIGHT - 1, Math.max(0, Math.round(v * HEIGHT)));
      return lumaOf((y * WIDTH + x) * 4);
    },
    mean: sum / (image.data.length / 4),
    min,
    max,
  };
}

// p → uv, with p.y up and uv.y down, aspect 320/180. The left circle obstacle sits at
// p=(-1.05, 0.15) — well outside the central orbits, so a lantern never enters it.
const puv = (px: number, py: number): [number, number] => [px / (2 * (WIDTH / HEIGHT)) + 0.5, 0.5 - py / 2];

describe("E46 Lantern — a dark room the lanterns light, with shadows off the field", () => {
  it("the light BREATHES on amount and never goes black (§V471)", async () => {
    if (dawnError !== undefined) return;
    const on = await shoot(1);
    const off = await shoot(0);
    // More glow is more light across the whole frame…
    expect(on.mean).toBeGreaterThan(off.mean * 1.15);
    // …but the quietest breath still leaves a lit picture — the room never blacks out.
    expect(off.mean).toBeGreaterThan(0.05);
  });

  it("it is a LIT ROOM, not a wash: real range from black shadow to bright core", async () => {
    if (dawnError !== undefined) return;
    const on = await shoot(1);
    // Unlit floor and shadow behind the obstacles fall to near-black…
    expect(on.min).toBeLessThan(0.03);
    // …while a lantern core burns bright. A flood or a blur would fill that gap; a field of
    // point lights with obstacles casting shadows keeps it wide.
    expect(on.max).toBeGreaterThan(0.6);
  });

  it("an obstacle is an OPAQUE lit surface — no lantern core bleeds through it", async () => {
    if (dawnError !== undefined) return;
    const on = await shoot(1);
    const [u, v] = puv(-1.05, 0.15); // deep inside the left circle obstacle
    const inside = on.luma(u, v);
    // Lit (it takes the lanterns' light), so not black…
    expect(inside).toBeGreaterThan(0.05);
    // …but never core-bright: a lantern steers AROUND the obstacles and never into one, so
    // its core (which would read far brighter) is never drawn inside this surface.
    expect(inside).toBeLessThan(0.6);
  });
});
