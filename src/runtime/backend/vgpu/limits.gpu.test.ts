import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T338 (§V256) on a REAL device: the baseline default is not a ceiling, and asking
 * moves it. Two claims, both on values:
 *
 * 1. The NEGOTIATED limit is above the baseline 8 — i.e. the ladder actually asked
 *    and the adapter actually granted. (A machine whose adapter truly offers only 8
 *    fails this loudly, which is the house style; if that machine ever exists in CI,
 *    the assertion should read the probe rather than be widened.)
 *
 * 2. The exact plan that WAS B33 — nine storage buffers in one dispatch — now runs
 *    and computes the right numbers. Yesterday's silent failure, today's feature.
 */

function nineBufferPlan(): LogicalExecutionPlan {
  const declarations = Array.from(
    { length: 9 },
    (_, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> b${index}: array<u32>;`,
  ).join("\n");
  const shader = `
${declarations}
struct P { count: u32, };
@group(0) @binding(0) var<uniform> params: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  b1[gid.x] = gid.x + 1u;
  b2[gid.x] = gid.x + 2u;
  b3[gid.x] = gid.x + 3u;
  b4[gid.x] = gid.x + 4u;
  b5[gid.x] = gid.x + 5u;
  b6[gid.x] = gid.x + 6u;
  b7[gid.x] = gid.x + 7u;
  b8[gid.x] = gid.x + 8u;
  b0[gid.x] = b1[gid.x] + b2[gid.x] + b3[gid.x] + b4[gid.x] + b5[gid.x] + b6[gid.x] + b7[gid.x] + b8[gid.x];
}`;
  return {
    id: "t338",
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
        id: "ninewide",
        shader,
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
}

describe("raised device limits (T338/§V256)", () => {
  it("negotiates above the baseline and runs yesterday's impossible dispatch", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      const capabilities = await backend.initialize({});
      expect(
        capabilities.limits["maxStorageBuffersPerShaderStage"],
        "the ladder must have raised the negotiated limit above the baseline 8",
      ).toBeGreaterThan(8);

      const compiled = await backend.compile(nineBufferPlan());
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      // slot i of b0 = Σ(i + k) for k in 1..8 = 8i + 36 — exact, per §V147.
      const sums = new Uint32Array(await backend.readBuffer("buffer:0"));
      expect(sums[0]).toBe(36);
      expect(sums[10]).toBe(8 * 10 + 36);
      expect(sums[63]).toBe(8 * 63 + 36);
    } finally {
      backend.dispose();
    }
  });
});
