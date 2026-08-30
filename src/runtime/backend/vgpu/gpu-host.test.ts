import { describe, expect, it } from "vitest";

import { DESIRED_LIMITS, clampedLimits } from "./gpu-host.ts";

/** T338 (§V256): the ask is always `min(adapter, desired)` — never blind. */
describe("clampedLimits (T338)", () => {
  it("clamps the ask to the adapter's offer, per key", () => {
    expect(clampedLimits({ maxStorageBuffersPerShaderStage: 31 })).toEqual({
      maxStorageBuffersPerShaderStage: 31,
    });
    expect(clampedLimits({ maxStorageBuffersPerShaderStage: 200 })).toEqual({
      maxStorageBuffersPerShaderStage: DESIRED_LIMITS["maxStorageBuffersPerShaderStage"],
    });
  });

  it("asks for nothing it cannot read — no offer, no request", () => {
    expect(clampedLimits(undefined)).toBeUndefined();
    expect(clampedLimits({})).toBeUndefined();
    expect(clampedLimits({ maxStorageBuffersPerShaderStage: "weird" })).toBeUndefined();
  });
});
