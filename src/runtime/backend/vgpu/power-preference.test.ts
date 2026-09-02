import { afterEach, describe, expect, it, vi } from "vitest";

import { browserGpuHost } from "./gpu-host.ts";
import { describeCapabilities, grantedAdapter } from "./capabilities.ts";
import type { Gpu } from "vgpu";

/**
 * §B173 (§V12, §V469, §T381) — WE ASK FOR A HIGH-PERFORMANCE ADAPTER, AND WE REPORT THE
 * ONE WE GOT.
 *
 * The defect: `powerPreference` existed as a type and as pass-through plumbing, and no
 * caller anywhere ever supplied a value, so every session called `requestAdapter({})`. On
 * a Windows laptop with switchable graphics a bare request typically resolves to the
 * INTEGRATED GPU — the owner's report exactly ("super high variance in fps… crashes down
 * hard during the drag to like 15 fps… works great on mac", and a Mac has one adapter and
 * no choice to get wrong).
 *
 * Two claims, and the second is the one §T381 insists on:
 *
 *  1. the REQUEST carries the preference — on both halves of the acquisition, the probe
 *     adapter AND the device init, because those are two separate `requestAdapter` calls
 *     and only asking on one of them is asking on neither;
 *  2. the REPORT is a MEASUREMENT. A capability report that echoed "high-performance"
 *     would be a claim about the ask; the panel has to be able to say "we asked for
 *     high-performance and this machine handed us Intel integrated graphics", which is a
 *     fact only the granted device can supply. So the fixture deliberately grants an
 *     adapter that CONTRADICTS the ask, and the report must name the adapter.
 */

const REQUESTS: Array<Record<string, unknown> | undefined> = [];
const INITS: Array<Record<string, unknown>> = [];

/** The device we are GRANTED — integrated, whatever we asked for. */
const INTEGRATED = {
  vendor: "intel",
  architecture: "gen-12lp",
  device: "",
  description: "Intel(R) Iris(R) Xe Graphics",
};

vi.mock("vgpu", () => ({
  init: vi.fn(async (options: Record<string, unknown>) => {
    INITS.push(options);
    return {
      device: {
        features: new Set<string>(["timestamp-query"]),
        limits: {},
        gpu: { adapterInfo: INTEGRATED, lost: undefined },
      },
      gpu: { lost: undefined },
      dispose() {},
    };
  }),
}));

function installNavigator(): void {
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async (options?: Record<string, unknown>) => {
        REQUESTS.push(options);
        return { features: new Set<string>(["timestamp-query"]), limits: {}, info: INTEGRATED };
      },
    },
  });
}

afterEach(() => {
  REQUESTS.length = 0;
  INITS.length = 0;
  vi.unstubAllGlobals();
});

describe("§B173 adapter power preference", () => {
  it("asks for high-performance when no caller supplies one", async () => {
    installNavigator();
    await browserGpuHost().create({});

    // The probe: this is the call that was `requestAdapter({})` for the whole life of
    // the seam, and on a switchable-graphics laptop that is the integrated GPU.
    expect(REQUESTS).toEqual([{ powerPreference: "high-performance" }]);
    // And the device request, which is a SECOND adapter selection — vgpu does its own.
    expect(INITS.every((options) => options["powerPreference"] === "high-performance")).toBe(true);
    expect(INITS.length).toBeGreaterThan(0);
  });

  it("lets an explicit caller preference win — the default is a default, not a policy", async () => {
    installNavigator();
    await browserGpuHost().create({ powerPreference: "low-power" });

    expect(REQUESTS).toEqual([{ powerPreference: "low-power" }]);
    expect(INITS.every((options) => options["powerPreference"] === "low-power")).toBe(true);
  });

  it("reports the adapter it was GRANTED, which may contradict the ask (§T381)", async () => {
    installNavigator();
    const session = await browserGpuHost().create({});
    const capabilities = describeCapabilities(session.gpu as unknown as Gpu, ["timestamp-query"]);

    // Asked high-performance, got integrated: the report names what arrived. Echoing
    // the request here would make the panel unable to ever tell the owner the truth.
    expect(capabilities.adapter).toEqual(INTEGRATED);
  });

  it("says nothing rather than guessing when the device exposes no identity", () => {
    // Dawn and the mock host have no `adapterInfo`, and a browser may mask every field.
    // Absent is honest; four empty strings would render as a blank row that reads as a bug.
    const noInfo = { device: { gpu: {} } } as unknown as Gpu;
    const masked = {
      device: { gpu: { adapterInfo: { vendor: "", architecture: "", device: "", description: "" } } },
    } as unknown as Gpu;

    expect(grantedAdapter(noInfo)).toBeUndefined();
    expect(grantedAdapter(masked)).toBeUndefined();
  });
});
