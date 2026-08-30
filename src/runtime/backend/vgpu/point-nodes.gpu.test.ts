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

      // §V168: within a frame, plan order is execution order — the bridge samples the
      // texture rendered THIS frame, not the previous one. "litPixels > 0" tolerated
      // exactly that bug (this test was green while the bridge silently ran one frame
      // late). A solid field makes the claim EXACT: every point's sampled attribute is
      // the solid's linear colour [0,1,0,1], byte for byte, on the very first frames.
      const sampleRaw = await backend.readBuffer("scratch:bridge:sample");
      const samples = new Float32Array(sampleRaw);
      for (let point = 0; point < 8; point += 1) {
        const base = point * 4;
        expect(samples[base], `point ${point} r`).toBeCloseTo(0, 5);
        expect(samples[base + 1], `point ${point} g`).toBeCloseTo(1, 5);
        expect(samples[base + 2], `point ${point} b`).toBeCloseTo(0, 5);
        expect(samples[base + 3], `point ${point} a`).toBeCloseTo(1, 5);
      }
    } finally {
      backend.dispose();
    }
  });
});

describe("sizePixels mapped to a per-point attribute on Dawn (T286)", () => {
  it("pscale by VALUE: a zero-size point vanishes, its sibling draws", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  /* id 0 sits in the LEFT half at size zero; id 1 in the RIGHT at 14px. */
  q.position = vec3f(select(-0.5, 0.5, q.id == 1u), 0.0, 0.0);
  q.size = select(0.0, 14.0, q.id == 1u);
  return q;
}`;
    const attributes = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "size", type: "f32", default: [0] },
      { name: "id", type: "u32", semantic: "id", default: [0] },
    ]);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 2, seed: 7, kernel, attributes } },
          draw: {
            id: "draw",
            type: "renderPoints",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {
              count: 2,
              // THE DOCUMENT SHAPE: sizePixels in map mode, retained static beside it.
              sizePixels: {
                mode: "map",
                bindings: {
                  static: { kind: "static", value: 4 },
                  map: { kind: "map", attribute: "size" },
                },
              },
            },
          },
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

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      let leftLit = 0;
      let rightLit = 0;
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          if ((image.bytes[(y * 64 + x) * 4] ?? 0) > 0) {
            if (x < 32) leftLit += 1;
            else rightLit += 1;
          }
        }
      }
      // EXACT (§V147): size zero is a zero-area quad — the left half draws NOTHING.
      // A build that fell back to the retained static (4px) would light both halves,
      // which is precisely the silent failure §V288 exists to prevent.
      expect(leftLit).toBe(0);
      expect(rightLit).toBeGreaterThan(0);
    } finally {
      backend.dispose();
    }
  });
});

describe("color mapped to a per-point attribute on Dawn (T364)", () => {
  it("left point renders PURE red, right point PURE green — channels never mix", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  q.position = vec3f(select(-0.5, 0.5, q.id == 1u), 0.0, 0.0);
  q.tint = select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), q.id == 1u);
  return q;
}`;
    const attributes = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "tint", type: "vec4f", qualifier: "color", default: [0, 0, 0, 0] },
      { name: "id", type: "u32", semantic: "id", default: [0] },
    ]);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 2, seed: 7, kernel, attributes } },
          draw: {
            id: "draw",
            type: "renderPoints",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {
              count: 2,
              sizePixels: 10,
              blend: "alpha",
              color: {
                mode: "map",
                bindings: {
                  static: { kind: "static", value: [0, 0, 1, 1] },
                  map: { kind: "map", attribute: "tint" },
                },
              },
            },
          },
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

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      let leftRed = 0, leftGreen = 0, rightRed = 0, rightGreen = 0, anyBlue = 0;
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          const i = (y * 64 + x) * 4;
          const r = image.bytes[i] ?? 0, g = image.bytes[i + 1] ?? 0, b = image.bytes[i + 2] ?? 0;
          if (x < 32) { leftRed += r > 0 ? 1 : 0; leftGreen += g > 0 ? 1 : 0; }
          else { rightRed += r > 0 ? 1 : 0; rightGreen += g > 0 ? 1 : 0; }
          anyBlue += b > 0 ? 1 : 0;
        }
      }
      // EXACT per half: the left point is pure red, the right pure green, and the
      // retained static (BLUE, deliberately) reaches no pixel anywhere — the
      // static-fallback failure would paint blue, and V288's silence would look
      // plausible in any single channel.
      expect(leftRed).toBeGreaterThan(0);
      expect(leftGreen).toBe(0);
      expect(rightGreen).toBeGreaterThan(0);
      expect(rightRed).toBe(0);
      expect(anyBlue).toBe(0);
    } finally {
      backend.dispose();
    }
  });
});
