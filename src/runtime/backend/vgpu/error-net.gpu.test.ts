import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T327, pinned on the B33 shape that motivated it: a dispatch binding MORE storage
 * buffers than the device granted. Before the persistent error net, such a plan
 * compiled, "rendered", and reported NOTHING — the pipeline failed lazily at first
 * dispatch, after B9's compile-window listener had unsubscribed, and the device's
 * verdict went to an unheard gpu.onError. The claim here is exactly that the verdict
 * now reaches the hub as a diagnostic.
 *
 * T338 note: the overflow is built against the NEGOTIATED limit read off the live
 * device, not a hardcoded 9-vs-8 — the raised-limits work made the old fixed repro
 * legal, which is the feature working, not the test rotting.
 */

function overboundPlan(bufferCount: number): LogicalExecutionPlan {
  const declarations = Array.from(
    { length: bufferCount },
    (_, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> b${index}: array<u32>;`,
  ).join("\n");
  const sum = Array.from({ length: bufferCount - 1 }, (_, index) => `b${index + 1}[gid.x]`).join(" + ");
  const shader = `
${declarations}
struct P { count: u32, };
@group(0) @binding(0) var<uniform> params: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  b0[gid.x] = ${sum};
}`;
  return {
    id: "b33",
    resources: Array.from({ length: bufferCount }, (_, index) => ({
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
        shader,
        entryPoint: "main",
        workgroups: [1, 1, 1],
        buffers: Array.from({ length: bufferCount }, (_, index) => ({
          binding: `b${index}`,
          resourceId: `buffer:${index}`,
        })),
        uniforms: { count: 64 },
        uniformBinding: "params",
      },
    ],
  } as unknown as LogicalExecutionPlan;
}

describe("the persistent GPU error net (T327/B33)", () => {
  it("a lazily-failing pipeline reports through the hub instead of rendering nothing silently", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      const capabilities = await backend.initialize({});
      const granted = capabilities.limits["maxStorageBuffersPerShaderStage"] ?? 8;
      const compiled = await backend.compile(overboundPlan(granted + 1));
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
