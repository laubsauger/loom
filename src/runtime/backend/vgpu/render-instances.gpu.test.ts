import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T299 on a REAL device: generator → renderInstances → output through the whole
 * stack. What this pins beyond "it draws": the `depthOutputs` declaration actually
 * reaches the plan as a depth-attached target (the compiler seam, through the REAL
 * compiler), and the image is genuinely SHADED 3D — many distinct lit intensities,
 * which flat unlit billboards cannot produce.
 */

describe("renderInstances end to end on Dawn (T299)", () => {
  it("draws depth-tested shaded boxes on a sphere of points", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointSphere", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 128, radius: 1 } },
          draw: { id: "draw", type: "renderInstances", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 128, shape: "box", scale: 0.12 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 96, height: 96 },
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

    // The compiler seam: `depthOutputs: ["out"]` materialized a depth-attached target.
    const drawTarget = plan.outputs.find((output) => output.nodeId === "draw");
    expect(drawTarget).toBeDefined();
    const descriptor = plan.resources.find((resource) => resource.id === drawTarget?.resourceId);
    expect(descriptor).toMatchObject({ kind: "target", depth: true });

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
          resolution: [96, 96],
        });
      }
      expect(errors).toEqual([]);

      const image = await backend.readOutput(drawTarget?.resourceId ?? "");
      let litPixels = 0;
      const intensities = new Set<number>();
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        const red = image.bytes[index] ?? 0;
        if (red > 0) {
          litPixels += 1;
          intensities.add(red);
        }
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(96 * 96);
      // Per-face lambert: every box is axis-aligned (rotate = 0), so the eye at +z
      // sees exactly THREE face orientations (+z, ±one lateral pair toward the light)
      // — three distinct intensities, no more, no fewer. An unshaded path collapses
      // to one; a per-pixel-noise path explodes past six.
      expect(intensities.size).toBe(3);
    } finally {
      backend.dispose();
    }
  });
});

/**
 * T369 — per-point colour on the LIT renderer, proven the way T364 proved it: in CHANNELS,
 * with the retained static made impossible to mistake for a success.
 *
 * The failure this discriminates against is the one §V288 exists for and the one a single
 * bright picture cannot rule out: the renderer quietly ignoring the map and drawing the
 * static instead. So the static here is deliberately BLUE — a colour NOTHING in the scene
 * should produce — and its absence is asserted as an exact count of zero over every pixel
 * in the frame. A fallback bug paints a lit blue quad, which looks entirely plausible if
 * you only ever check that something was drawn.
 *
 * Red on the left, green on the right, and the OTHER channel exactly zero in each half:
 * that also rules out the near-miss where every instance reads slot 0's colour, which a
 * "some red exists" assertion would happily pass.
 *
 * Lighting still runs (`rgb * shade`), so the channels scale but never mix — which is
 * precisely the property that makes "exactly zero green on the left" a legal claim about a
 * SHADED renderer rather than an unlit one.
 */
describe("colour mapped to a per-point attribute on renderInstances, on Dawn (T369)", () => {
  it("left instance is PURE red, right PURE green, and the blue static reaches no pixel", async () => {
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
            type: "renderInstances",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {
              count: 2,
              shape: "quad",
              scale: 0.35,
              eye: [0, 0, 3],
              lookAt: [0, 0, 0],
              fov: 60,
              color: {
                mode: "map",
                bindings: {
                  // BLUE, and it must never appear: the map is what the renderer honours.
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

      const target = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(target?.resourceId ?? "");
      let leftRed = 0, leftGreen = 0, rightRed = 0, rightGreen = 0, anyBlue = 0;
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          const i = (y * image.rowStride) + x * 4;
          const r = image.bytes[i] ?? 0, g = image.bytes[i + 1] ?? 0, b = image.bytes[i + 2] ?? 0;
          if (x < 32) { leftRed += r > 0 ? 1 : 0; leftGreen += g > 0 ? 1 : 0; }
          else { rightRed += r > 0 ? 1 : 0; rightGreen += g > 0 ? 1 : 0; }
          anyBlue += b > 0 ? 1 : 0;
        }
      }
      expect(leftRed).toBeGreaterThan(0);
      expect(leftGreen).toBe(0);
      expect(rightGreen).toBeGreaterThan(0);
      expect(rightRed).toBe(0);
      expect(anyBlue).toBe(0);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
