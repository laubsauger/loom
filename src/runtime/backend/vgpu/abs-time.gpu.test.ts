import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { SHARED_UNIFORMS_WGSL } from "../shared-uniforms.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T468 on a REAL device: a SHADER reads the clock that keeps growing. The owner's
 * complaint was that abstime lapped like the timeline — delivered to expressions,
 * not to WGSL. The frame here is mid-lap-reset (time back at 0) while the show has
 * run 100 seconds; a shader on the lap clock renders black, one on the absolute
 * clock renders full red. Exact bytes, 0/1 fixed points of the display decode (§V56).
 */

const SETTINGS = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CLOCK_PROBE = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let keep = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).a * 0.0;
  /* Red = the ABSOLUTE clock, green = the lap clock — both scaled to hit 0/1 exactly. */
  return vec4f(frameU.absTime / 100.0 + keep, frameU.time, 0.0, 1.0);
}`;

function probeGraph(): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("feed", "solid", { color: [0, 0, 0, 1] }),
        node("clock", "customWgsl", { source: CLOCK_PROBE }),
        node("out", "output", {}),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "clock", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "clock", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

describe("absTime reaches WGSL and keeps growing (T468, §V147)", () => {
  it("mid-lap-reset, the absolute channel is full and the lap channel is empty", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: probeGraph(),
      settings: SETTINGS,
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: {
          timeSeconds: 0, // the timeline just lapped…
          deltaSeconds: 1 / 60,
          frameIndex: 0,
          mode: "realtime",
          randomSeed: 7,
          absFrameIndex: 6000,
          absTimeSeconds: 100, // …and the show keeps counting.
        },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [8, 8],
      });
      const image = await backend.readOutput("target:clock:out");
      const centre = (4 * 8 + 4) * 4;
      expect([image.bytes[centre], image.bytes[centre + 1]]).toEqual([255, 0]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
