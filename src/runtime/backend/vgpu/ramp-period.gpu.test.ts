import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T556 — `period` TILES, exactly as its description has always said. The shader
 * divided instead of multiplying, so period 4 showed a quarter of one cycle stretched
 * across the axis (it collapsed E30's shaft to a single colour). The pin is periodic
 * EQUALITY: with period 2 on a horizontal black→white ramp, a point and its
 * half-axis translate must read the SAME value — magnification cannot satisfy that,
 * which is what makes this a tiling test rather than a brightness test (§V461's
 * discrimination rule, applied to a period).
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
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

describe("ramp period tiles (T556)", () => {
  it("period 2: a point and its half-axis translate read the same texel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = {
      revision: 1,
      nodes: {
        r: {
          id: "r", type: "ramp", definitionVersion: 2, position: { x: 0, y: 0 },
          parameters: {
            type: "horizontal", interp: "linear", phase: 0, period: 2,
            stops: [
              { position: 0, color: [0, 0, 0, 1] },
              { position: 1, color: [1, 1, 1, 1] },
            ],
          },
        },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: { e1: { id: "e1", source: { nodeId: "r", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
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
        resolution: [64, 64],
      });
      const image = await backend.readOutput("target:r:out");
      const at = (x: number): number => image.bytes[(32 * 64 + x) * 4] as number;
      // Tiling: columns 8 and 40 sit at the same phase of adjacent cycles.
      expect(Math.abs(at(8) - at(8 + 32))).toBeLessThanOrEqual(1);
      expect(Math.abs(at(20) - at(20 + 32))).toBeLessThanOrEqual(1);
      // And the cycle actually RUNS inside its half-axis — not a flat field.
      expect(at(24) - at(4)).toBeGreaterThan(80);
    } finally {
      backend.dispose();
    }
  });
});
