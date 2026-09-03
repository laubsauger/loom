import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";

/**
 * T321 on a REAL device, through the whole catalogue: a CustomWGSL source encodes the
 * FRAME INDEX into red, a CustomWGSL map encodes a horizontal gradient, and the
 * SlitScan output must read, per column, exactly the frame the gradient names —
 * newest at the left edge, deepest history at the right. Every byte is derived
 * analytically (§V147): the source's byte at frame f IS f (f/255 through rgba8unorm),
 * the map quantizes uv.x through a byte, and the shader's own rounding is mirrored
 * below. One row of pixels checks the array binding, the per-frame head uniforms, the
 * copy-on-rotate, and §V229's clamp at once.
 */

const FRAME_SOURCE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(2) var<uniform> frameU: SharedFrame;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ignored = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return vec4f(frameU.frameIndex / 255.0, 0.0, 0.0, ignored.a * 0.0 + 1.0);
}`;

const GRADIENT_MAP = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ignored = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return vec4f(uv.x, 0.0, 0.0, ignored.a * 0.0 + 1.0);
}`;

const SIZE = 64;
const RING_FRAMES = 4;

describe("slit-scan end to end on Dawn (T321)", () => {
  async function columnsReadExactFrames(scale: number): Promise<number> {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const node = (id: string, type: string, parameters: Record<string, unknown>) =>
      ({
        id,
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters,
      }) as unknown as import("../../domain/types/graph.ts").GraphDocument["nodes"][string];
    const edge = (id: string, source: [string, string], target: [string, string]) => ({
      id,
      source: { nodeId: source[0], portId: source[1] },
      target: { nodeId: target[0], portId: target[1] },
    });
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          feed: node("feed", "solid", { color: [0, 0, 0, 1] }),
          src: node("src", "customWgsl", { source: FRAME_SOURCE }),
          map: node("map", "customWgsl", { source: GRADIENT_MAP }),
          slit: node("slit", "slitScan", { frames: RING_FRAMES, depth: 1, scale }),
          out: node("out", "output", {}),
        },
        edges: {
          e1: edge("e1", ["feed", "out"], ["src", "input"]),
          e2: edge("e2", ["feed", "out"], ["map", "input"]),
          e3: edge("e3", ["src", "out"], ["slit", "input"]),
          e4: edge("e4", ["map", "out"], ["slit", "map"]),
          e5: edge("e5", ["slit", "out"], ["out", "input"]),
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: SIZE, height: SIZE },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const totalFrames = 5;
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [SIZE, SIZE],
        });
      }
      expect(errors).toEqual([]);

      // Timing model: the rotate that archives frame f's write happens at frame f+1's
      // entry, so DURING frame 4 the history holds frames 0..3 — written = 4 (full),
      // latest = frame 3. The scan at frame 4 therefore maps back=n to frame 3-n.
      const latestFrame = totalFrames - 2; // 3
      const usable = RING_FRAMES; // written capped at frames

      const slitOutput = plan.outputs.find((output) => output.nodeId === "slit");
      const image = await backend.readOutput(slitOutput?.resourceId ?? "");
      const row = Math.floor(SIZE / 2);
      for (const x of [0, 13, 32, 50, SIZE - 1]) {
        // Mirror the shader's arithmetic exactly, including the map's byte quantization.
        const uvx = (x + 0.5) / SIZE;
        const mapValue = Math.round(uvx * 255) / 255;
        const back = Math.min(Math.floor(mapValue * (RING_FRAMES - 1) + 0.5), usable - 1);
        const expected = latestFrame - back;
        const actual = image.bytes[(row * SIZE + x) * 4];
        expect(actual, `column ${x}: back ${back}`).toBe(expected);
      }
      return backend.status.estimatedResourceBytes;
    } finally {
      backend.dispose();
    }
  }

  it("every column reads exactly the frame its map value names", async () => {
    await columnsReadExactFrames(1);
  });

  /**
   * T1019a — the SCALED ring must never cost a MOMENT, only softness. The fixture is
   * solid-per-frame (the source encodes the frame index as one flat colour), so
   * bilinear filtering over any layer is the identity and every spatial artifact a
   * half-resolution ring could introduce is invisible — which leaves exactly one thing
   * able to fail: the LAYER arithmetic. The same per-column byte-exact assertions as
   * full scale therefore hold at 0.5, or a wrong moment leaked in through the scale.
   */
  it("at half scale the columns still read exactly their frames — softness, never a wrong moment", async () => {
    const fullBytes = await columnsReadExactFrames(1);
    const halfBytes = await columnsReadExactFrames(0.5);
    // The solid fixture cannot SEE a ring that silently stayed full-resolution, so the
    // memory claim is pinned on the backend's own byte estimate: the scaled plan must
    // be smaller — the ring dominates this graph, and halving its edge quarters it.
    expect(halfBytes).toBeLessThan(fullBytes);
  });
});
