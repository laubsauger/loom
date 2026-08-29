import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import {
  DEFAULT_POINT_ATTRIBUTES,
  pointKernelNode,
  pointKernelResources,
  pointPairId,
  renderPointsNode,
} from "../../../nodes/definitions/points.ts";
import { compileContext } from "../../../nodes/definitions/test-support.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T121 + T122 on a REAL device: the two nodes' EMITTED passes — not hand-written ones —
 * assembled into a plan, compiled by the real backend, rendered for several frames, and
 * read back as pixels. This is the point family working end to end below the graph
 * compiler; the chain-through-compileGraph half lands with the compiler deltas.
 */

describe("point nodes on Dawn (T121, T122)", () => {
  it("the kernel node simulates and the render node draws its sprites", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const capacity = 256;
    const kernel = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity, seed: 7 } }),
    );
    const render = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        parameters: { count: capacity, sizePixels: 6, blend: "additive" },
      }),
    );
    expect(kernel.diagnostics ?? []).toEqual([]);
    expect(render.diagnostics ?? []).toEqual([]);

    const plan: LogicalExecutionPlan = {
      resources: [
        ...pointKernelResources("sim", DEFAULT_POINT_ATTRIBUTES, capacity),
        { kind: "target", id: "out", size: [64, 64], format: "rgba8unorm" },
      ],
      passes: [
        ...kernel.passes,
        { ...(render.passes[0] as Record<string, unknown>), target: "out" },
        ...DEFAULT_POINT_ATTRIBUTES.map((attribute) => ({
          kind: "swap" as const,
          id: `swap:${pointPairId("sim", attribute.name)}`,
          resourceId: pointPairId("sim", attribute.name),
        })),
      ],
      diagnostics: [],
    };

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
          frame: {
            timeSeconds: frameIndex / 60,
            deltaSeconds: 1 / 60,
            frameIndex,
            mode: "offline",
            randomSeed: 7,
          },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }

      const bytes = await backend.readOutput("out");
      expect(errors).toEqual([]);

      // Zero-initialized positions cluster at clip origin; the sprites land mid-target.
      let litPixels = 0;
      for (let index = 0; index < bytes.length; index += 4) {
        if ((bytes[index] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });
});
