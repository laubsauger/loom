import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { PassDescriptor } from "../plan.ts";
import { bindingOverflows, describeOverflow } from "../../../compiler/bindings.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * The whole limit chain, end to end, on one device — three pieces built by three
 * tracks, proven TOGETHER for the first time:
 *
 *   T338 raises the negotiated limit → T328's validator reads that SAME number and
 *   its verdict flips at exactly the boundary → the device executes the full-width
 *   pass and computes the right values (with T327's net standing behind anything that
 *   slips past, pinned separately in error-net.gpu.test.ts).
 *
 * Everything is built against the NEGOTIATED limit read off the live device (§V266):
 * a hardcoded width would quietly stop testing the boundary the moment the
 * negotiation improves — the exact rot the raised-limits work inflicted on the old
 * 9-vs-8 repro.
 */

function wideDispatch(bufferCount: number): { pass: PassDescriptor; plan: LogicalExecutionPlan } {
  const declarations = Array.from(
    { length: bufferCount },
    (_, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> b${index}: array<u32>;`,
  ).join("\n");
  const seeds = Array.from(
    { length: bufferCount - 1 },
    (_, index) => `  b${index + 1}[gid.x] = gid.x + ${index + 1}u;`,
  ).join("\n");
  const sum = Array.from({ length: bufferCount - 1 }, (_, index) => `b${index + 1}[gid.x]`).join(" + ");
  const shader = `
${declarations}
struct P { count: u32, };
@group(0) @binding(0) var<uniform> params: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
${seeds}
  b0[gid.x] = ${sum};
}`;
  const pass = {
    kind: "dispatch",
    id: "fullwidth",
    shader,
    entryPoint: "main",
    workgroups: [1, 1, 1],
    buffers: Array.from({ length: bufferCount }, (_, index) => ({
      binding: `b${index}`,
      resourceId: `buffer:${index}`,
    })),
    uniforms: { count: 64 },
    uniformBinding: "params",
  } as unknown as PassDescriptor;
  const plan = {
    id: "limit-chain",
    resources: Array.from({ length: bufferCount }, (_, index) => ({
      kind: "buffer",
      id: `buffer:${index}`,
      stride: 4,
      capacity: 64,
      usage: "storage",
    })),
    passes: [pass],
  } as unknown as LogicalExecutionPlan;
  return { pass, plan };
}

describe("the limit chain: negotiation → validation → execution (T338/T328/T327)", () => {
  it("the validator's verdict flips at exactly the negotiated boundary, and the device honours the allowed side", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      const capabilities = await backend.initialize({});
      const granted = capabilities.limits["maxStorageBuffersPerShaderStage"];
      expect(granted, "the negotiated limit must be reported at all").toBeTypeOf("number");
      expect(granted, "T338 must have raised it above the baseline").toBeGreaterThan(8);

      // T328 reads the SAME capabilities: at the boundary it permits; one past, it
      // refuses, and the refusal names the negotiated number as device-discovered.
      const allowed = wideDispatch(granted as number);
      expect(bindingOverflows([allowed.pass], capabilities)).toEqual([]);

      const overbound = wideDispatch((granted as number) + 1);
      const overflows = bindingOverflows([overbound.pass], capabilities);
      expect(overflows).toHaveLength(1);
      expect(overflows[0]?.count).toBe((granted as number) + 1);
      expect(overflows[0]?.limit).toBe(granted);
      expect(overflows[0]?.discovered).toBe(true);
      expect(describeOverflow(overflows[0]!)).toContain(String(granted));

      // And the device HONOURS the allowed side: the full-width pass — every binding
      // the negotiation granted, none to spare — executes and computes exactly.
      const compiled = await backend.compile(allowed.plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      // slot i of b0 = Σ(i + k) for k in 1..granted-1 (exact, §V147).
      const width = granted as number;
      const sums = new Uint32Array(await backend.readBuffer("buffer:0"));
      const expectedAt = (slot: number): number =>
        (width - 1) * slot + ((width - 1) * width) / 2;
      expect(sums[0]).toBe(expectedAt(0));
      expect(sums[10]).toBe(expectedAt(10));
      expect(sums[63]).toBe(expectedAt(63));
    } finally {
      backend.dispose();
    }
  });
});
