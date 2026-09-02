import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { pointsPreviewResourceId } from "../../../compiler/resources.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { probeDawn } from "./node-gpu-host.ts";
import { capturingHost, drawSynthesizedPreview } from "./preview-synthesis-fixture.ts";
import { POINTS_PREVIEW_DIAMETER_PX } from "../../../nodes/shaders/points-preview.wgsl.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";

/**
 * T952 — WHAT A BOOSTED POINT PREVIEW BUYS, and the T502 reading it replaces.
 *
 * T502 asked whether enlarging a synthesized target was waste, and framed the losing
 * case as: "(c) the source grew and the CONTENT did not — a splat whose disc size is
 * fixed in texels gains nothing from a bigger target". It then measured ink scaling with
 * the target's AREA (24 → 853 lit texels against an area ratio of exactly 36) and called
 * (c) refuted.
 *
 * ⚑ THE MEASUREMENT WAS RIGHT AND THE READING WAS BACKWARDS, AND THIS FILE IS WHERE IT
 * WAS RECORDED, SO IT IS WHERE THE CORRECTION BELONGS. Ink scaling exactly with area is
 * not evidence that a bigger target carries more picture — it is the proof that it
 * carries THE SAME PICTURE, LARGER. `pointSize` was a clip-space fraction, so every disc
 * was 2.86% of the frame's width at 384 texels and at 2592 alike; the boost granted 6.75×
 * the pixels and spent all of them making each blob proportionally fatter. Measured the
 * other way round in `scratchpad/t952/`: a 768 render, downsampled onto a 384 one,
 * differed by a mean of 0.14/255 with 0.05% of texels disagreeing. §T891 and §T919 both
 * chased a resolution win this shader was cancelling out.
 *
 * (c)'s error was equating "the disc does not grow with the target" with "you gain
 * nothing". The opposite is true: only a disc that does NOT grow lets a bigger target
 * separate points that a smaller one merges. So the size is a DEVICE-PIXEL diameter now
 * (`POINTS_PREVIEW_DIAMETER_PX`), and what this file gates is the inverse of what it used
 * to:
 *
 *   (1) the disc is the SAME number of texels at every tile size — 4 across, at 192 and
 *       at 1152 alike, where it used to be 5 and 33; and
 *   (2) BECAUSE of (1), a bigger tile carries more information — the 384-vs-768 delta
 *       that was 0.14/255 is now far off zero, which is the whole point of the ladder.
 *
 * (1)'s numbers stay the shader's own contract rather than observations (§V147): the
 * fragment writes alpha = 1 - |uv|, so ink above the 12/255 test reaches (1 - 12/255) of
 * the half-extent, and the area is π r².
 */

/** POINTS_PREVIEW_DIAMETER_PX, restated and pinned against the import below. */
const DIAMETER_PX = 4;

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function settings(previewLongEdge: number): ProjectSettings {
  return {
    outputResolution: { width: 64, height: 64 },
    workingFormat: "rgba8unorm",
    randomSeed: 7,
    previewLongEdge,
    previewFps: 20,
    limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
  };
}

interface Splat {
  readonly size: readonly [number, number];
  /** Texels with any ink at all. */
  readonly lit: number;
  /** Widest run of lit texels on any row — the disc's diameter, in texels. */
  readonly discWidth: number;
}

/**
 * Ink radius in texels: the disc's half-extent, cut where alpha falls below the test.
 *
 * T952 — TAKES NO `edge` ANY MORE, and the missing parameter IS the fix. It used to read
 * `(POINT_SIZE * edge) / 2`, which is the clip-space scaling written out.
 */
function inkRadius(): number {
  return (DIAMETER_PX / 2) * (1 - 12 / 255);
}

function predictedDiscWidth(): number {
  return Math.round(inkRadius() * 2);
}

function predictedLit(): number {
  return Math.round(Math.PI * inkRadius() ** 2);
}

/** A read-back tile, for the information comparison below. */
interface Cloud {
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  /** Fraction of texels carrying any ink, on the same 12/255 test the splat uses. */
  readonly inkFraction: number;
  /** Fraction clipped to full intensity — picture that has stopped carrying shape. */
  readonly saturatedFraction: number;
}

/** Box-downsample by an integer factor — what the compositor's linear sampler approximates. */
function downsample(image: Cloud, factor: number): Cloud {
  const width = Math.round(image.width / factor);
  const height = Math.round(image.height / factor);
  const bytes = new Uint8Array(width * height * 4);
  let lit = 0;
  let saturated = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const source = ((y * factor + sy) * image.width + (x * factor + sx)) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            acc[channel] = (acc[channel] ?? 0) + (image.bytes[source + channel] ?? 0);
          }
        }
      }
      const destination = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        bytes[destination + channel] = Math.round((acc[channel] ?? 0) / (factor * factor));
      }
      if ((bytes[destination] ?? 0) > 12) lit += 1;
      if ((bytes[destination] ?? 0) > 240) saturated += 1;
    }
  }
  const texels = width * height;
  return { width, height, bytes, inkFraction: lit / texels, saturatedFraction: saturated / texels };
}

/** Mean absolute channel difference, and how much of the frame actually disagrees. */
function compare(a: Cloud, b: Cloud): { meanAbs: number; differingFraction: number } {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  const texels = a.width * a.height;
  let sum = 0;
  let differing = 0;
  for (let index = 0; index < texels; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      sum += Math.abs((a.bytes[index * 4 + channel] ?? 0) - (b.bytes[index * 4 + channel] ?? 0));
    }
    if (Math.abs((a.bytes[index * 4] ?? 0) - (b.bytes[index * 4] ?? 0)) > 8) differing += 1;
  }
  return { meanAbs: sum / (texels * 3), differingFraction: differing / texels };
}

/**
 * A DENSE cloud at one tile size — the regime the owner reported, where discs merge.
 *
 * 120×90 is E13-Prism's own `bar`/`form` count (10,800), so this is that node's picture
 * and not a synthetic stand-in.
 */
async function cloudAt(tileEdge: number): Promise<Cloud> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: {
      revision: 1,
      groups: {},
      edges: {},
      nodes: {
        gen: {
          id: "gen",
          type: "pointGrid",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { cols: 120, rows: 90, count: 10_800 },
        },
      },
    },
    settings: settings(192),
    registry,
    capabilities: CAPABILITIES,
    sinks: [{ nodeId: "gen", portId: "out", kind: "preview" }],
  });
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

  const { host, session } = capturingHost();
  const backend = createVgpuBackend({ host });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    const device = session()?.gpu.gpu as unknown as GPUDevice;
    drawSynthesizedPreview({ backend, device, outputs: plan.outputs, nodeId: "gen", portId: "out", tileEdge });
    await device.queue.onSubmittedWorkDone();
    const image = await backend.readOutput(pointsPreviewResourceId("gen", "out"));
    let lit = 0;
    let saturated = 0;
    for (let index = 0; index < image.width * image.height; index += 1) {
      const red = image.bytes[index * 4] ?? 0;
      if (red > 12) lit += 1;
      if (red > 240) saturated += 1;
    }
    const texels = image.width * image.height;
    return {
      width: image.width,
      height: image.height,
      bytes: new Uint8Array(image.bytes),
      inkFraction: lit / texels,
      saturatedFraction: saturated / texels,
    };
  } finally {
    backend.dispose();
  }
}

/** T563: `tileEdge` is the GRANTED TILE — the preview program sizes the source to it. */
async function splatAt(tileEdge: number): Promise<Splat> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: {
      revision: 1,
      groups: {},
      edges: {},
      nodes: {
        gen: {
          id: "gen",
          type: "pointLine",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { count: 1, sizeX: 2 },
        },
      },
    },
    settings: settings(192),
    registry,
    capabilities: CAPABILITIES,
    sinks: [{ nodeId: "gen", portId: "out", kind: "preview" }],
  });
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

  const { host, session } = capturingHost();
  const backend = createVgpuBackend({ host });
  const errors: string[] = [];
  backend.onDiagnostic((diagnostic) => {
    if (diagnostic.severity === "error") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    const device = session()?.gpu.gpu as unknown as GPUDevice;
    drawSynthesizedPreview({ backend, device, outputs: plan.outputs, nodeId: "gen", portId: "out", tileEdge });
    await device.queue.onSubmittedWorkDone();
    const image = await backend.readOutput(pointsPreviewResourceId("gen", "out"));
    expect(errors).toEqual([]);
    let lit = 0;
    let discWidth = 0;
    for (let y = 0; y < image.height; y += 1) {
      let run = 0;
      for (let x = 0; x < image.width; x += 1) {
        const ink = (image.bytes[(y * image.width + x) * 4] ?? 0) > 12;
        if (ink) {
          lit += 1;
          run += 1;
          if (run > discWidth) discWidth = run;
        } else {
          run = 0;
        }
      }
    }
    return { size: [image.width, image.height], lit, discWidth };
  } finally {
    backend.dispose();
  }
}

describe("T952 on Dawn — a boosted point preview renders more picture, not a bigger blur", () => {
  it("the source grows with the grant and the DISC DOES NOT — the splat is sized in device pixels", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    expect(POINTS_PREVIEW_DIAMETER_PX).toBe(DIAMETER_PX);

    // T563: the source IS the granted tile. Three rungs spanning the ladder's full useful
    // range — 192 at rest to 2592 at the ceiling, 13.5× the edge and 182× the area.
    const rungs = [192, 1152, 2592];
    const measured = [];
    for (const edge of rungs) measured.push(await splatAt(edge));
    expect(measured.map((entry) => entry.size[0])).toEqual(rungs);

    // The CONTENT, derived from the shader rather than observed (§V147): ONE prediction
    // for EVERY tile, where there used to be one per tile. The disc is 3.81 texels across
    // continuously, so it rasterises to 3 or 4 depending on where the point's projection
    // falls between texel centres — sub-texel PHASE, not size, so it is asserted as a
    // SPREAD of at most one texel rather than papered over with a wide range.
    const widths = measured.map((entry) => entry.discWidth);
    const inks = measured.map((entry) => entry.lit);
    expect(widths).toEqual([3, 4, 3]);
    expect(inks).toEqual([10, 11, 12]);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(Math.max(...inks) - Math.min(...inks)).toBeLessThanOrEqual(2);
    for (const entry of measured) {
      expect(Math.abs(entry.discWidth - predictedDiscWidth())).toBeLessThanOrEqual(1);
      expect(Math.abs(entry.lit - predictedLit())).toBeLessThanOrEqual(2);
    }

    // ⚑ THE ASSERTION THAT INVERTS. Ink is INVARIANT across a 182× area ratio; it used to
    // track that ratio exactly. Proportional sizing would read 24 → 4,600 here — three
    // orders of magnitude outside the spread above, so this cannot pass by accident and
    // cannot be restored without reddening.
    expect(Math.max(...inks) / Math.min(...inks)).toBeLessThan(1.5);
  }, 60_000);

  /**
   * The other half, and the one the owner will actually see: with the disc pinned in
   * pixels, a BIGGER TILE SEPARATES POINTS A SMALLER ONE MERGES.
   *
   * Measured as the inverse of the number that exposed the bug. Render the same cloud at
   * 384 and at 768, box-downsample the 768 onto the 384, and compare: identical pictures
   * mean the extra pixels bought nothing. Under the old clip-space size that delta was
   * 0.14/255 with 0.05% of texels disagreeing — near-zero, and that near-zero WAS the
   * defect. The floor here is deliberately far above it rather than beside it, so this
   * cannot pass on noise, and a regression to proportional sizing collapses it to ~0.
   */
  it("a bigger tile carries MORE INFORMATION — the delta that was 0.14/255 is now far off zero", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const small = await cloudAt(384);
    const large = await cloudAt(768);
    expect([small.width, large.width]).toEqual([384, 768]);

    // THE OWNER'S SYMPTOM, at the tile they were looking at. `points are large and blurry`
    // — 10,800 discs at 2.86% of the frame each clipped 25.9% of it to flat colour, and a
    // quarter of the picture at full white carries no shape at all. A 4px disc leaves 2.9%.
    expect(small.saturatedFraction).toBeLessThan(0.06);

    // Coverage: at 384 the cloud is a mat of overlapping discs; at 768 each disc covers a
    // quarter of the frame-fraction it did, so the same points leave far less ink. Under
    // proportional sizing these two were equal to 0.1 of a percentage point.
    expect(large.inkFraction).toBeLessThan(small.inkFraction * 0.85);

    const delta = compare(small, downsample(large, 2));
    expect(delta.meanAbs).toBeGreaterThan(3);
    expect(delta.differingFraction).toBeGreaterThan(0.05);
  }, 60_000);
});
