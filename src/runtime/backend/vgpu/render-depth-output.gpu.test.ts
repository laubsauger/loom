import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T722 — the camera's depth, readable, §V147 exact.
 *
 * The stage is arithmetic: a flat wall exactly 3 units in front of the camera, far
 * plane 10 — every wall texel must read R = 3/10 = 0.3, and the un-covered border
 * (the clear plate) reads the far plane's 1.0. Off, the plan carries no depth target
 * and no sweep (§V309), which is what makes the switch a price and not a default.
 */

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function depthGraph(depthOutput: boolean): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0], fov: 55, near: 0.1, far: 10 }, "cam1"),
        node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "", depthOutput }, "shot1"),
        // The depth consumer: displace's disp port is DATA space — the same §V13 gate
        // that (correctly) refuses depth into a colour input accepts it here, which is
        // also the first real use: displacement by camera depth.
        ...(depthOutput ? [node("push", "displace", { weight: [0.02, 0.02] }, "push1")] : []),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      ...(depthOutput
        ? {
            e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "push", portId: "source" } },
            e3: { id: "e3", source: { nodeId: "shot", portId: "depth" }, target: { nodeId: "push", portId: "disp" } },
            e4: { id: "e4", source: { nodeId: "push", portId: "out" }, target: { nodeId: "out", portId: "input" } },
          }
        : {
            e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
          }),
    },
    groups: {},
  } as never;
}

function planFor(graph: GraphDocument) {
  return compileGraph({
    graph,
    settings: {
      outputResolution: { width: 64, height: 64 },
      workingFormat: "rgba16float",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    } as never,
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    } as never,
  });
}

describe("the render's depth output (T722, §V147, §V309)", () => {
  it("off: no depth target, no sweep — the switch is the price", () => {
    const plan = planFor(depthGraph(false));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.resources.some((resource) => resource.id === "target:shot:depth")).toBe(false);
    expect(plan.passes.some((pass) => pass.id.includes("depthOut"))).toBe(false);
  });

  it("on: the wall reads exactly distance ÷ far, and the border reads the far plate", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const plan = planFor(depthGraph(true));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.resources.some((resource) => resource.id === "target:shot:depth")).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      } as never);
      const image = await backend.readOutput("target:shot:depth");
      // rgba16float rows: 4 half floats per texel. readOutput returns bytes; decode
      // through the Float16 view the format implies.
      const half = new Uint16Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength / 2);
      const decode = (h: number): number => {
        const sign = (h & 0x8000) !== 0 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const mantissa = h & 0x3ff;
        if (exponent === 0) return sign * mantissa * 2 ** -24;
        if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
        return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
      };
      const texel = (x: number, y: number): number => decode(half[(y * 64 + x) * 4]!);
      // The wall (the ±1 grid at z = 0) sits exactly 3 from the eye; far is 10.
      expect(texel(32, 32)).toBeCloseTo(0.3, 3);
      // The corner sees past the grid: the clear plate — the far plane's 1.0.
      expect(texel(1, 1)).toBeCloseTo(1.0, 3);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
