import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T377 on a REAL device, with §V147 exact values: one directional light straight down
 * the view axis onto a flat grid gives |N·L| = 1, so the centre texel is
 * albedo × (ambient + intensity) to the byte. And §V361's question answered as bytes:
 * CUT the light (clear the lights list) and the same texel drops to the ambient floor —
 * also exact. A lighting model that ignored its lights would fail both.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

function sceneGraph(lights: string): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label,
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
        // Straight down the view axis: toLight = (0,0,1), |N·L| = 1 on a flat grid.
        node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
        node(
          "shot",
          "render",
          { scenes: "geo1", camera: "cam1", lights, ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

describe("the scene render lights exactly (T377, §V147, §V361)", () => {
  it("centre texel = albedo × (ambient + lambert); cut the light and it is the floor", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const render = async (lights: string): Promise<Uint8Array> => {
      const plan = compileGraph({
        graph: sceneGraph(lights),
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
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    const lit = await render("sun1");
    const centre = (32 * 64 + 32) * 4;
    // albedo 0.8 × (0.12 ambient + 1.0 × |N·L| = 1) = 0.896 → byte 228, every channel.
    const litExpected = Math.round(0.8 * (0.12 + 1) * 255);
    expect([lit[centre], lit[centre + 1], lit[centre + 2]]).toEqual([litExpected, litExpected, litExpected]);

    // §V361: the drive cut. Same graph, no light named — the exact ambient floor.
    const dark = await render("");
    const floorExpected = Math.round(0.8 * 0.12 * 255);
    expect([dark[centre], dark[centre + 1], dark[centre + 2]]).toEqual([
      floorExpected,
      floorExpected,
      floorExpected,
    ]);
    expect(litExpected).not.toBe(floorExpected);
  }, 120_000);
});
