import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { pointsPreviewResourceId } from "../../../compiler/resources.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { probeDawn } from "./node-gpu-host.ts";
import { capturingHost, drawSynthesizedPreview } from "./preview-synthesis-fixture.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";

/**
 * T502 — THE MEASUREMENT THAT DECIDED IT, on a real device.
 *
 * The complaint was "zooming in on point operator previews still leaves us with quite a
 * blurry preview", and there were two candidate causes with opposite fixes:
 *
 *   (a) the LADDER never reached the point path, so the tile stayed small; or
 *   (b) the tile grew and the SOURCE did not, so the boost bought an upscale; or
 *   (c) the source grew and the CONTENT did not — a splat whose disc size or point count
 *       is fixed in texels gains nothing from a bigger target, and enlarging it would be
 *       pure waste.
 *
 * (c) is the one that would make the whole T502 fix wrong, so it is measured rather than
 * assumed. This renders ONE point through the compiler's own synthesized splat pass at
 * two target sizes and counts what came out:
 *
 *     edge  192 →  24 lit texels, disc  5 texels across
 *     edge 1152 → 853 lit texels, disc 33 texels across
 *
 * 853/24 = 35.5, against a target-area ratio of exactly 36: the ink scales with the AREA
 * of the target, so the content's resolution IS the target's resolution. (c) is refuted.
 * Both numbers are the shader's own contract rather than observations — `pointSize` is a
 * clip-space fraction and the fragment writes a linear falloff, so the disc's ink radius
 * is `POINT_SIZE × edge / 2 × (1 - 12/255)` texels and its area is π r² (§V147).
 *
 * That left (b): the tile grew and the source did not. The source is now the BASE TILE
 * every preview is guaranteed rather than the raw `previewLongEdge`, so a synthesized
 * preview is 1:1 with its guaranteed tile instead of a 2× blow-up of it.
 */

const POINT_SIZE = 0.03; // POINTS_PREVIEW_POINT_SIZE, pinned by points-preview.gpu.test.ts

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

/** Ink radius in texels: the disc's half-extent, cut where alpha falls below the test. */
function inkRadius(edge: number): number {
  return ((POINT_SIZE * edge) / 2) * (1 - 12 / 255);
}

function predictedDiscWidth(edge: number): number {
  return Math.round(inkRadius(edge) * 2);
}

function predictedLit(edge: number): number {
  return Math.round(Math.PI * inkRadius(edge) ** 2);
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

describe("T502 on Dawn — a boosted point preview renders more picture, not a bigger blur", () => {
  it("the source grows with the grant, and so does the ink", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // T563: the source IS the granted tile now — 192 at rest against 1152 fully
    // boosted, the exact pair T502 measured when it proved the ink scales with area.
    const base = await splatAt(192);
    const boosted = await splatAt(1152);
    expect(base.size).toEqual([192, 192]);
    expect(boosted.size).toEqual([1152, 1152]);

    // The CONTENT, derived from the shader rather than observed (§V147). `pointSize` is a
    // clip-space fraction, so the disc's half-extent is POINT_SIZE × edge / 2 TEXELS at
    // any target size; the fragment writes alpha = 1 - |uv|, so ink above the 12/255 test
    // reaches 1 - 12/255 of that. Both the width and the area follow, and both match.
    expect([base.discWidth, boosted.discWidth]).toEqual([
      predictedDiscWidth(192),
      predictedDiscWidth(1152),
    ]);
    expect([base.discWidth, boosted.discWidth]).toEqual([5, 33]);
    // Area comes out one texel above the continuous prediction at 1152 (852) and exactly
    // on it at 192 — a rasterisation edge, named rather than papered over with a range.
    expect(Math.abs(base.lit - predictedLit(192))).toBeLessThanOrEqual(1);
    expect(Math.abs(boosted.lit - predictedLit(1152))).toBeLessThanOrEqual(1);
    expect([base.lit, boosted.lit]).toEqual([24, 853]);

    // Ink scales with AREA: 35.5×, against a target-area ratio of exactly 36. A splat
    // whose disc did NOT scale with the target would have held near 24 here, and enlarging
    // the target would have been pure waste — that is the reading this rules out.
    expect(boosted.lit / base.lit).toBeGreaterThan(34);
    expect(boosted.lit / base.lit).toBeLessThan(36);
  }, 60_000);
});
