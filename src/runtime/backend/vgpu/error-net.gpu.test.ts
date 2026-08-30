import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T327, pinned on the exact B33 shape that motivated it: a dispatch binding NINE
 * storage buffers against the baseline limit of eight. Before the persistent error
 * net, this plan compiled, "rendered", and reported NOTHING — the pipeline failed
 * lazily at first dispatch, after B9's compile-window listener had unsubscribed, and
 * the device's verdict went to an unheard gpu.onError. The claim here is exactly that
 * the verdict now reaches the hub as a diagnostic.
 */

const NINE_BUFFER_WGSL = `
${Array.from({ length: 9 }, (_, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> b${index}: array<u32>;`).join("\n")}
struct P { count: u32, };
@group(0) @binding(0) var<uniform> params: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  b0[gid.x] = b1[gid.x] + b2[gid.x] + b3[gid.x] + b4[gid.x] + b5[gid.x] + b6[gid.x] + b7[gid.x] + b8[gid.x];
}`;

describe("the persistent GPU error net (T327/B33)", () => {
  it("a lazily-failing pipeline reports through the hub instead of rendering nothing silently", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const plan: LogicalExecutionPlan = {
      id: "b33",
      resources: Array.from({ length: 9 }, (_, index) => ({
        kind: "buffer",
        id: `buffer:${index}`,
        stride: 4,
        capacity: 64,
        usage: "storage",
      })),
      passes: [
        {
          kind: "dispatch",
          id: "overbound",
          shader: NINE_BUFFER_WGSL,
          entryPoint: "main",
          workgroups: [1, 1, 1],
          buffers: Array.from({ length: 9 }, (_, index) => ({
            binding: `b${index}`,
            resourceId: `buffer:${index}`,
          })),
          uniforms: { count: 64 },
          uniformBinding: "params",
        },
      ],
    } as unknown as LogicalExecutionPlan;

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

      // The verdict is asynchronous: poll bounded (the honest V144 shape) rather than
      // sleeping a magic amount or asserting on a race.
      const deadline = Date.now() + 2000;
      while (errors.length === 0 && Date.now() < deadline) {
        // A readback is a full GPU round-trip; it drains the error delivery too.
        await backend.readBuffer("buffer:0").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(errors.length, "the device's validation verdict must reach the hub").toBeGreaterThan(0);
      expect(errors.join("\n")).toMatch(/validation|storage|binding|layout/i);
    } finally {
      backend.dispose();
    }
  });
});
