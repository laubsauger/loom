import { describe, expect, it } from "vitest";

import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import {
  DEFAULT_POINT_ATTRIBUTES,
  pointKernelNode,
  pointKernelResources,
  pointPairId,
  renderPointsNode,
} from "./points.ts";
import { compileContext } from "./test-support.ts";

/**
 * The point family at the fixture level (T121, T122): manifests, emitted passes, the
 * producer/consumer id contract, and the whole emitted output accepted by the backend's
 * own plan reader. The pixels-on-Dawn half lives in
 * `src/runtime/backend/vgpu/point-nodes.gpu.test.ts`.
 */

describe("pointKernel — manifest and emission (T121)", () => {
  it("declares determinism honestly and carries the kernel contract version (§V46, §V77)", () => {
    expect(pointKernelNode.stateful).toEqual({
      reset: true,
      deterministicReplay: true,
      checkpoint: false,
      randomAccess: false,
    });
    expect(pointKernelNode.contractVersion).toBe(1);
    expect(pointKernelNode.outputs[0]?.type.kind).toBe("pointset");
  });

  it("emits one dispatch whose buffers follow the pair-id contract with read/write halves", () => {
    const result = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 1000, seed: 3 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toHaveLength(1);
    const pass = result.passes[0] as {
      kind: string;
      buffers: Array<{ binding: string; resourceId: string; half: string }>;
      uniforms: Record<string, number>;
      uniformBinding: string;
    };
    expect(pass.kind).toBe("dispatch");
    expect(pass.uniformBinding).toBe("kernelFrame");
    expect(pass.uniforms["count"]).toBe(1000);
    expect(pass.uniforms["seed"]).toBe(3);

    // in_* reads the pair's read half, out_* writes the write half — one identity,
    // swapped by the compiler after all consumers (§V22, T143 carry applies).
    const position = pass.buffers.filter((binding) => binding.resourceId === pointPairId("sim", "position"));
    expect(position.map((binding) => `${binding.binding}:${binding.half}`).sort()).toEqual([
      "in_position:read",
      "out_position:write",
    ]);
  });

  it("rejects a broken attributes schema or kernel with named diagnostics", () => {
    const badSchema = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: "[{\"name\":\"3x\"}]" } }),
    );
    expect(badSchema.passes).toEqual([]);
    expect(badSchema.diagnostics?.[0]?.code).toBe("node.points.attributes");

    const badKernel = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { kernel: "fn nope() {}" } }),
    );
    expect(badKernel.passes).toEqual([]);
    expect(badKernel.diagnostics?.[0]?.code).toBe("node.points.kernel");
  });
});

describe("renderPoints — manifest and emission (T122)", () => {
  it("requires a position attribute on its pointset input (§V13)", () => {
    const input = renderPointsNode.inputs[0];
    expect(input?.type.kind).toBe("pointset");
    if (input?.type.kind === "pointset") {
      expect(input.type.requires).toEqual([{ name: "position", type: "vec3f" }]);
    }
  });

  it("derives the producer's position pair from the input's source identity", () => {
    const result = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        parameters: { count: 512, sizePixels: 8, blend: "alpha", accumulate: true },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as {
      kind: string;
      buffers: Array<{ resourceId: string; half: string }>;
      blend: string;
      clear: boolean;
      instances: number;
    };
    expect(pass.kind).toBe("draw");
    expect(pass.buffers[0]?.resourceId).toBe(pointPairId("sim", "position"));
    // T296/§V168: consumers read the WRITE half — THIS frame's positions, in plan order.
    expect(pass.buffers[0]?.half).toBe("write");
    expect(pass.blend).toBe("alpha");
    // accumulate = the T180 trails pattern: no clear between frames.
    expect(pass.clear).toBe(false);
    expect(pass.instances).toBe(512);
  });

  it("reports a missing producer identity instead of guessing buffer ids", () => {
    const result = renderPointsNode.compile(compileContext({ nodeId: "draw", inputs: ["points"] }));
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.source");
  });
});

describe("pointKernel → renderPoints → output through the REAL compiler (T176)", () => {
  it("materializes pairs, propagates the pointset edge, swaps after all consumers", async () => {
    const { compileGraph } = await import("../../compiler/index.ts");
    const { createNodeRegistry } = await import("../registry/registry.ts");
    const { allNodeDefinitions } = await import("./index.ts");

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 512 } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 512 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 640, height: 360 },
        workingFormat: "rgba16float",
        randomSeed: 1,
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

    // One pair per default attribute, materialized from the node's scratch declaration.
    const pairs = plan.resources.filter((resource) => resource.kind === "bufferPair");
    expect(pairs.map((pair) => pair.id).sort()).toEqual(
      DEFAULT_POINT_ATTRIBUTES.map((attribute) => pointPairId("sim", attribute.name)).sort(),
    );
    // …and NO texture resource for the pointset marker itself.
    expect(plan.resources.some((resource) => resource.id.startsWith("points:sim"))).toBe(false);

    // The consumer found the producer through the propagated edge.
    const drawPass = plan.passes.find((pass) => pass.kind === "draw");
    expect(drawPass?.buffers?.[0]?.resourceId).toBe(pointPairId("sim", "position"));

    // T297 (§V197/§V22): each pair's swap comes after the LAST pass that BINDS it —
    // ownership by binder, not by reachability. Position is read by the draw, so its
    // swap must follow the draw; the attributes only the kernel touches swap right
    // after the kernel. Every swap still precedes nothing that binds its pair.
    const swaps = plan.passes
      .map((pass, index) => ({ pass, index }))
      .filter((entry) => entry.pass.kind === "swap");
    expect(swaps).toHaveLength(DEFAULT_POINT_ATTRIBUTES.length);
    for (const { pass, index } of swaps) {
      const pairId = (pass as { resourceId: string }).resourceId;
      const lastBinder = plan.passes
        .map((candidate, candidateIndex) =>
          (candidate as { buffers?: Array<{ resourceId: string }> }).buffers?.some((b) => b.resourceId === pairId) === true
            ? candidateIndex
            : -1,
        )
        .reduce((a, b) => Math.max(a, b), -1);
      expect(index, `swap for ${pairId}`).toBeGreaterThan(lastBinder);
    }
    const drawIndex = plan.passes.findIndex((pass) => pass.kind === "draw");
    const positionSwapIndex = plan.passes.findIndex(
      (pass) => pass.kind === "swap" && (pass as { resourceId: string }).resourceId === pointPairId("sim", "position"),
    );
    expect(positionSwapIndex).toBeGreaterThan(drawIndex); // the by-binding claim, explicitly

    // The whole plan reads cleanly through the backend's own validation.
    expect(readExecutionPlan(plan).ok).toBe(true);
  });
});

describe("the emitted output is a plan the backend accepts", () => {
  it("kernel + render + pairs + swaps read cleanly end to end", () => {
    const kernel = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const render = renderPointsNode.compile(
      compileContext({ nodeId: "draw", inputs: ["points"], sources: { points: "sim" }, parameters: { count: 256 } }),
    );
    expect(kernel.diagnostics ?? []).toEqual([]);
    expect(render.diagnostics ?? []).toEqual([]);

    const plan: LogicalExecutionPlan = {
      resources: [
        ...pointKernelResources("sim", DEFAULT_POINT_ATTRIBUTES, 256),
        { kind: "target", id: "target:out", size: [64, 64], format: "rgba16float" },
      ],
      passes: [
        ...kernel.passes,
        // Retarget the render pass at the declared target (the fixture's id differs).
        { ...(render.passes[0] as Record<string, unknown>), target: "target:out" },
        // The compiler owns swap placement (§V22); the assembled plan mirrors it.
        ...DEFAULT_POINT_ATTRIBUTES.map((attribute) => ({
          kind: "swap" as const,
          id: `swap:${pointPairId("sim", attribute.name)}`,
          resourceId: pointPairId("sim", attribute.name),
        })),
      ],
      diagnostics: [],
    };

    const read = readExecutionPlan(plan);
    expect(read.diagnostics).toEqual([]);
    expect(read.ok).toBe(true);
  });
});
