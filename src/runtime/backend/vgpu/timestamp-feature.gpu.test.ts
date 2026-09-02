import { describe, expect, it } from "vitest";

import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * B172 ON A REAL DEVICE (§V12, §V469, T163): THE PRODUCTION REQUEST ASKS FOR
 * `timestamp-query`, SO A DEVICE THAT HAS IT REPORTS IT.
 *
 * ## The bug this is the gate for
 *
 * `capabilities.ts` read `features.has("timestamp-query")` off a device request that
 * never named the feature. WebGPU grants an optional feature ONLY IF `requestDevice`
 * asked for it, so the check was structurally false on every machine ever to run the
 * product: per-pass GPU spans were permanently absent, `COST BY CATEGORY` read "No timing
 * on this device", and the copy blamed the device for our omission. The string appeared
 * in a `requiredFeatures` array in exactly one TEST file and in no production path.
 *
 * `gpu-host.test.ts` gates the negotiation as a unit and `vgpu-backend.test.ts` gates the
 * bare `initialize({})` call against a mock adapter. This is the third leg, and the one
 * that cannot be satisfied by a fake: a REAL Dawn device, asked the way the headless
 * runner, the cook oracle and the MCP server ask, must come back with the feature.
 *
 * ## Why the assertion is strict, in the house style of `limits.gpu.test.ts`
 *
 * Dawn exposes `timestamp-query` on Metal, Vulkan and D3D12. A machine whose adapter
 * genuinely lacks it fails this loudly, which is the point — a widened assertion
 * ("true or false, either is fine") would pass against exactly the product that shipped.
 * If such a machine ever reaches CI, the assertion should read the adapter's offer rather
 * than be softened.
 *
 * The negative half of §V12 — that a device WITHOUT the feature still gets a working app —
 * is gated where it can be forced: `vgpu-backend.test.ts`, over an adapter that offers
 * nothing. Optional is never required, on either path.
 */
describe("timestamp-query is requested on a real device (B172)", () => {
  it("comes back on the bare production init, so per-pass GPU timing can exist at all", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      // Exactly what `gpu-status.ts` does: no canvas, no features named by the caller.
      // Before B172 this device came back with `core-features-and-limits` and nothing else.
      const capabilities = await backend.initialize({});

      expect(
        capabilities.timestampQueryRequested,
        "the host must ASK for timestamp-query — the ask is the half that was missing",
      ).toBe(true);
      expect(
        capabilities.timestampQuery,
        `this adapter (${probe.adapter ?? "unknown"}) reports no timestamp-query on a request that asked for it`,
      ).toBe(true);
      expect(capabilities.features).toContain("timestamp-query");
    } finally {
      backend.dispose();
    }
  }, 30_000);
});
