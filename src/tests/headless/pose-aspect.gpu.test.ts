import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { POSE_INPUT_SIDE, keypointsToTexture } from "../../runtime/models/pose-runner.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * T992 — POSE'S ASPECT, THE WHOLE ROUND TRIP: a joint lands where the pixel actually is.
 *
 * The defect this pins was the PLAUSIBLE kind: pose squeezed its input, so every joint
 * on a non-square source was off by a stretch nobody could see on a skeleton that still
 * looked like a person — and adopting the letterbox alone would have traded that for
 * joints off by the bar width, equally plausibly (the row's warning). So the gate is
 * the round trip, with NOTHING derived twice:
 *
 *  1. A single bright dot is rendered at a KNOWN uv on a 2:1 source, and the pose
 *     node's REAL preprocess (the seam's shared letterbox WGSL) packs the model square.
 *  2. The dot's model-space position is MEASURED by scanning the read-back model input —
 *     the letterbox forward, as the GPU actually performed it.
 *  3. That measured position is fed through `keypointsToTexture` exactly as the worker
 *     feeds a MoveNet triple — the un-letterbox back.
 *  4. The joint must land on the dot's own uv, within the analytically derived bound
 *     (one model texel, divided by the occupied band's share, plus half-float rounding).
 *
 * The non-vacuity guard matters as much as the assertion: the MEASURED model uv must
 * differ from the frame uv by the bar geometry (>0.1 here), or the fixture is square-ish
 * and the whole test would pass under the squeeze it exists to rule out.
 */

const SETTINGS = {
  outputResolution: { width: 512, height: 256 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

/** The dot's home, deliberately OFF-centre on both axes. */
const DOT_U = 0.7;
const DOT_V = 0.3;

function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

describe("T992 — pose aspect handling on Dawn", () => {
  it("letterboxes the picture in, un-letterboxes the joint out, and the joint is the pixel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const graph = {
      revision: 1,
      nodes: {
        dot: {
          id: "dot",
          type: "circle",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {
            mode: "fill",
            center: [DOT_U, DOT_V],
            radius: [0.02, 0.02],
            softness: 0,
            fillcolor: [1, 1, 1, 1],
            bgcolor: [0, 0, 0, 1],
            aspectcorrect: false,
          },
          label: "dot1",
        },
        pose: { id: "pose", type: "pose", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "pose1" },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out1" },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "dot", portId: "out" }, target: { nodeId: "pose", portId: "input" } },
        e1: { id: "e1", source: { nodeId: "pose", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never as GraphDocument;

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [512, 256],
      });

      // (2) The letterbox FORWARD, measured: where the GPU actually put the dot.
      const side = POSE_INPUT_SIDE;
      const packed = new Float32Array(await backend.readBuffer("scratch:pose:modelInput"));
      // The dot spans a few model texels, so its position is the bright-texel CENTROID —
      // an argmax could land anywhere inside the disc, a radius wide of the centre.
      let weight = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          const luma = packed[(y * side + x) * 4] ?? 0;
          if (luma < 0.5) continue;
          weight += luma;
          sumX += (x + 0.5) * luma;
          sumY += (y + 0.5) * luma;
        }
      }
      expect(weight).toBeGreaterThan(0); // the dot survived the pack
      const modelU = sumX / weight / side;
      const modelV = sumY / weight / side;

      // Non-vacuity: on this 2:1 frame the occupied band halves v, so the dot's MODEL v
      // must sit far from its FRAME v. If these were close the fixture could not tell
      // the letterbox from the squeeze and every assertion below would be vacuous.
      // (occ = [1, 0.5]: expected model v = (0.3 − 0.5)·0.5 + 0.5 = 0.4.)
      expect(Math.abs(modelV - DOT_V)).toBeGreaterThan(0.05);
      expect(Math.abs(modelV - 0.4)).toBeLessThan(1.5 / side);
      expect(Math.abs(modelU - DOT_U)).toBeLessThan(1.5 / side);

      // (3) The un-letterbox BACK, exactly as the worker encodes a MoveNet triple:
      // (y, x, score), letterboxed model uv in, frame uv out.
      const output = new Float32Array(17 * 3);
      output[0] = modelV;
      output[1] = modelU;
      output[2] = 1;
      const bytes = keypointsToTexture(output, 512, 256);
      const view = new DataView(bytes.buffer);
      const jointU = fromHalf(view.getUint16(0, true));
      const jointV = fromHalf(view.getUint16(2, true));

      // (4) The joint IS the pixel. Bound derived, not tuned: the dot's centre is
      // quantised to one model texel (±0.5/192 in model uv), scaled back up by 1/occ on
      // v (×2), plus half-float rounding (~2^-11) — comfortably inside 2 texels/side per
      // axis. The pre-T992 squeeze put jointV at modelV = 0.4, an error of 0.1 — thirteen
      // times this bound — and the letterbox-without-unletterbox would do the same.
      expect(Math.abs(jointU - DOT_U)).toBeLessThan(2 / side);
      expect(Math.abs(jointV - DOT_V)).toBeLessThan(2 / (side * 0.5));
    } finally {
      backend.dispose();
    }
  }, 240_000);
});
