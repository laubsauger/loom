import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T477 on a REAL device, answered as §V361 demands — what differs if the edge is cut?
 * A kernel advects its points by `fieldAt(...)`; the same graph with a zero field must
 * move nothing. Rendered twice and compared as BYTES, because "the pass compiled" says
 * nothing about whether the texture read reaches the position write.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

function advectionGraph(fieldColor: readonly number[]): GraphDocument {
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
        node("flow", "solid", { color: fieldColor }),
        node("sim", "pointKernel", {
          capacity: 16,
          seed: 7,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          ]),
          kernel:
            "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* The field IS the velocity: red drives +x. */\n  q.position += vec3f(fieldAt(p.position).r, 0.0, 0.0) * 0.1;\n  return q;\n}",
        }),
        node("draw", "renderPoints", { count: 16, sizePixels: 12 }),
        node("out", "output", {}),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "flow", portId: "out" }, target: { nodeId: "sim", portId: "field" } },
      e2: { id: "e2", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

describe("fieldAt advects points on Dawn (T477, §V361)", () => {
  it("a red field moves the sprites; a black field is the cut — bytes differ", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();

    const render = async (fieldColor: readonly number[]): Promise<Uint8Array> => {
      const plan = compileGraph({
        graph: advectionGraph(fieldColor),
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
        for (let frame = 0; frame < 4; frame += 1) {
          backend.render(compiled, {
            frame: { timeSeconds: frame / 60, deltaSeconds: 1 / 60, frameIndex: frame, mode: "offline", randomSeed: 7 },
            pointer: { x: 0, y: 0, buttons: 0 },
            resolution: [64, 64],
          });
        }
        const image = await backend.readOutput("target:draw:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    const driven = await render([1, 0, 0, 1]);
    const cut = await render([0, 0, 0, 1]);
    // Both drew SOMETHING — a pair of blank frames trivially agrees.
    expect(driven.some((byte) => byte !== 0)).toBe(true);
    expect(cut.some((byte) => byte !== 0)).toBe(true);
    // §V361: the field is load-bearing — cut it and the picture changes.
    expect(Buffer.compare(Buffer.from(driven), Buffer.from(cut))).not.toBe(0);
  }, 120_000);
});
