import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T121 + T122 + T176 on a REAL device, through the WHOLE stack: a user-shaped graph
 * (pointKernel -> renderPoints -> output) compiled by the REAL graph compiler, executed
 * by the REAL backend for several frames, read back as pixels. Every seam this family
 * crosses — codegen, scratch pairs, pointset propagation, dispatch/draw emission, swap
 * placement, half-selected bindings — is on this one path.
 */

describe("point graph end to end on Dawn (T121/T122/T176)", () => {
  it("compileGraph -> backend -> sprites", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 256, seed: 7 } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 256, sizePixels: 6 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
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
      for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }

      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      expect(renderTarget).toBeDefined();
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      const bytes = image.bytes;
      expect(errors).toEqual([]);

      let litPixels = 0;
      for (let index = 0; index < bytes.byteLength; index += 4) {
        if ((bytes[index] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });
});

describe("TextureToAttribute bridge on Dawn (T124)", () => {
  it("solid -> bridge -> sprites: the TOP drives the POP, pixels prove it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 128, seed: 7 } },
          tex: { id: "tex", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [0, 1, 0, 1] } },
          bridge: { id: "bridge", type: "textureToAttribute", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 128 } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 128, sizePixels: 6 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "bridge", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "tex", portId: "out" }, target: { nodeId: "bridge", portId: "texture" } },
          e3: { id: "e3", source: { nodeId: "bridge", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e4: { id: "e4", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
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
      for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }

      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      expect(errors).toEqual([]);

      let litPixels = 0;
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        if ((image.bytes[index] ?? 0) > 0 || (image.bytes[index + 1] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });
});
