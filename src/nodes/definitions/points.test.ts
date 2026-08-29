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
    expect(pass.buffers[0]?.half).toBe("read");
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
