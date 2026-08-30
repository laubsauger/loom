import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { pointPairId } from "../../../nodes/definitions/points.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T512 — the texture→points bridges read the picture the way the SCREEN shows it.
 *
 * Both readers (Texture To Attribute, and the in-kernel `fieldAt`) mapped clip
 * `position.y = -1` — the world BOTTOM — to texel row 0, which a texture shows at the
 * TOP. Every bridge in the tool was vertically mirrored, a webcam face arrived upside
 * down, and it survived since T262 because the two sites agreed with EACH OTHER and
 * every test image was symmetric.
 *
 * THE FIXTURE IS ASYMMETRIC TOP-TO-BOTTOM, ON PURPOSE, AND MUST STAY SO: a centred
 * blob, a solid, or any up-down symmetric image is structurally blind to a vertical
 * flip. Do not "simplify" it. The picture here is a circle at uv (0.5, 0.2) — bright
 * near the TOP of the image, black at the bottom — and the claim is exact: a point at
 * world y = +0.8 (the top of the screen) reads the bright texel, its mirror at
 * y = -0.8 reads black.
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

const node = (id: string, type: string, parameters: Record<string, unknown>) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
});

/** Two probes: index 0 at the screen TOP (+0.8), index 1 at the BOTTOM (-0.8). */
const PROBE_KERNEL =
  "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(0.0, select(-0.8, 0.8, ctx.index == 0u), 0.0);\n  return q;\n}";

/** The top-bright picture: a filled circle at uv (0.5, 0.2). */
const topBrightCircle = () =>
  node("pic", "circle", {
    mode: "fill",
    center: [0.5, 0.2],
    radius: [0.25, 0.25],
    softness: 0,
    color: [1, 1, 1, 1],
  });

async function renderAndRead(graph: GraphDocument, pairNode: string): Promise<Float32Array> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    for (let frame = 0; frame < 2; frame += 1) {
      backend.render(compiled, {
        frame: { timeSeconds: frame / 60, deltaSeconds: 1 / 60, frameIndex: frame, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
    }
    return new Float32Array(await backend.readBuffer(pointPairId(pairNode, "sample")));
  } finally {
    backend.dispose();
  }
}

describe("texture→points orientation (T512) — asymmetric fixture, symmetric ones are blind to a flip", () => {
  it("Texture To Attribute: the point at the screen TOP reads the TOP of the picture", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = {
      revision: 1,
      nodes: Object.fromEntries(
        [
          topBrightCircle(),
          node("sim", "pointKernel", {
            capacity: 2,
            seed: 7,
            attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
            kernel: PROBE_KERNEL,
          }),
          node("bridge", "textureToAttribute", { count: 2 }),
          node("draw", "renderPoints", { count: 2, sizePixels: 4 }),
          node("out", "output", {}),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "bridge", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "pic", portId: "out" }, target: { nodeId: "bridge", portId: "texture" } },
        e3: { id: "e3", source: { nodeId: "bridge", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e4: { id: "e4", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never as GraphDocument;

    const samples = await renderAndRead(graph, "bridge");
    // vec4f stride: point 0 at [0..3], point 1 at [4..7].
    expect(samples[0]).toBe(1); // top point reads the bright circle
    expect(samples[4]).toBe(0); // bottom point reads black
  });

  it("fieldAt: the kernel's own read agrees with the bridge, texel for texel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = {
      revision: 1,
      nodes: Object.fromEntries(
        [
          topBrightCircle(),
          node("sim", "pointKernel", {
            capacity: 2,
            seed: 7,
            attributes:
              '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]},{"name":"sample","type":"vec4f","default":[0,0,0,0]}]',
            kernel:
              "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(0.0, select(-0.8, 0.8, ctx.index == 0u), 0.0);\n  q.sample = fieldAt(q.position);\n  return q;\n}",
          }),
          node("draw", "renderPoints", { count: 2, sizePixels: 4 }),
          node("out", "output", {}),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "pic", portId: "out" }, target: { nodeId: "sim", portId: "field" } },
        e2: { id: "e2", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e3: { id: "e3", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never as GraphDocument;

    const samples = await renderAndRead(graph, "sim");
    expect(samples[0]).toBe(1);
    expect(samples[4]).toBe(0);
  });
});
