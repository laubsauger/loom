import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T298 on a REAL device: a generator's positions read back as floats and proven
 * analytically — every Fibonacci-sphere point sits ON the sphere, |p| = radius — then
 * drawn through renderPoints to show the T296 edge map carries the generator's pair to
 * a consumer that binds it by id. Exact-value assertions per §V147: a radius band that
 * "roughly holds" would tolerate a wrong shape.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const CAPABILITIES = {
  tier: "B" as const,
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"] as const,
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

describe("point generators end to end on Dawn (T298)", () => {
  it("sphere positions have |p| = radius, and they draw", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointSphere", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 256, radius: 1.5 } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 256, sizePixels: 4 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
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
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      expect(errors).toEqual([]);

      const raw = await backend.readBuffer("scratch:gen:position");
      const positions = new Float32Array(raw);
      expect(positions.length).toBeGreaterThanOrEqual(256 * 4);
      for (let point = 0; point < 256; point += 1) {
        const base = point * 4; // vec3f strides at 16 bytes
        const x = positions[base] ?? 0;
        const y = positions[base + 1] ?? 0;
        const z = positions[base + 2] ?? 0;
        expect(Math.hypot(x, y, z), `point ${point}`).toBeCloseTo(1.5, 4);
      }
      // Fibonacci coverage, not a degenerate ring: both hemispheres populated.
      const ys = Array.from({ length: 256 }, (_, point) => positions[point * 4 + 1] ?? 0);
      expect(Math.min(...ys)).toBeLessThan(-0.9);
      expect(Math.max(...ys)).toBeGreaterThan(0.9);

      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      let litPixels = 0;
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        if ((image.bytes[index] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });

  /**
   * T1057, the box on Dawn. Three DIFFERENT side lengths (§V854: a cube fixture cannot
   * tell a box from a cube-shaped bug — every "extent" assertion would read the same
   * number three times and pass on a kernel that ignored two of the knobs), and every
   * side length exactly representable in f32 so the claims are EXACT rather than a
   * tolerance band (§V147).
   *
   * 3 x 1 x 0.5 makes the areas 0.5 / 1.5 / 3 per face pair out of a total of 10, so the
   * area split of 1000 points is 50 / 50 / 150 / 150 / 300 / 300 — six DIFFERENT numbers
   * that an even-by-face split (167 x 4 + 166 x 2) cannot produce. That is the assertion
   * that pins the distribution rule rather than merely observing points on a box.
   */
  it("box points lie exactly ON a 3 x 1 x 0.5 box, split between the faces by area", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const COUNT = 1000;
    const HALF = [1.5, 0.5, 0.25] as const;
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: {
            id: "gen",
            type: "pointBox",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { count: COUNT, sizeX: 3, sizeY: 1, sizeZ: 0.5 },
          },
          // count 4096 deliberately EXCEEDS the generator's: the draw must take its
          // instance count off the EDGE, so this knob is not what is being read.
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 4096, sizePixels: 2 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    // The consumer's count DERIVES from the box's published capacity, not from its own
    // count knob — `points` topology carries no cells, so capacity is the whole claim.
    const drawPass = plan.passes.find((pass) => pass.kind === "draw" && pass.nodeId === "draw");
    expect(drawPass?.kind).toBe("draw");
    expect(drawPass?.kind === "draw" ? drawPass.instances : undefined).toBe(COUNT);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      expect(errors).toEqual([]);

      const positions = new Float32Array(await backend.readBuffer("scratch:gen:position"));
      expect(positions.length).toBeGreaterThanOrEqual(COUNT * 4);

      // face key: which axis is pinned, and to which side. `null` = not on the surface.
      const faces = new Map<string, number>();
      const extents = [
        { min: Infinity, max: -Infinity },
        { min: Infinity, max: -Infinity },
        { min: Infinity, max: -Infinity },
      ];
      for (let point = 0; point < COUNT; point += 1) {
        const base = point * 4; // vec3f strides at 16 bytes
        const p = [positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0];
        const pinned: string[] = [];
        for (let axis = 0; axis < 3; axis += 1) {
          const value = p[axis] ?? 0;
          const half = HALF[axis] ?? 0;
          const extent = extents[axis];
          if (extent !== undefined) {
            extent.min = Math.min(extent.min, value);
            extent.max = Math.max(extent.max, value);
          }
          // ON the box: EXACTLY at the face plane, or strictly between the two.
          if (value === half || value === -half) pinned.push(`${"xyz"[axis]}${value > 0 ? "+" : "-"}`);
          else expect(Math.abs(value), `point ${point} axis ${axis} is off the box`).toBeLessThan(half);
        }
        // Exactly one — a point on two face planes at once would sit on an EDGE, where
        // two faces could each claim it and a seam would carry a doubled point (§V627:
        // doubled points show the moment they are drawn additively).
        expect(pinned, `point ${point} at ${p.join(",")}`).toHaveLength(1);
        const face = pinned[0] ?? "";
        faces.set(face, (faces.get(face) ?? 0) + 1);
      }

      // Analytic, not observed: areas 0.5 / 1.5 / 3 of a total 10, times 1000 points.
      expect(Object.fromEntries([...faces].sort())).toEqual({
        "x+": 50,
        "x-": 50,
        "y+": 150,
        "y-": 150,
        "z+": 300,
        "z-": 300,
      });

      // Extent per axis INDEPENDENTLY: the faces pin their axis exactly, so the extremes
      // are exact. A kernel that read sizeX for all three would read 1.5 three times.
      expect(extents.map((extent) => [extent.min, extent.max])).toEqual([
        [-1.5, 1.5],
        [-0.5, 0.5],
        [-0.25, 0.25],
      ]);

      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      let litPixels = 0;
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        if ((image.bytes[index] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });

  /**
   * The other half of the topology claim (T1057): the box says `points`, and the surface
   * renderer — which needs cols x rows to derive a vertex count — REFUSES it by name
   * (§V288) instead of drawing a plausible wrong sheet. This is a compile-level claim,
   * but it belongs beside the device test: it is what the `points` string BUYS.
   */
  it("a box refuses to be a surface, by name, rather than publishing a grid it is not", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointBox", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 1000, sizeX: 3, sizeY: 1, sizeZ: 0.5 } },
          surf: { id: "surf", type: "renderSurface", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "surf", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "surf", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    const refusal = plan.diagnostics.find((d) => d.code === "node.surface.topology");
    expect(refusal?.severity).toBe("error");
    expect(refusal?.message).toContain('published "points"');
  });
});
