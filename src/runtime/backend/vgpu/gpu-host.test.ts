import { describe, expect, it } from "vitest";

import { DESIRED_LIMITS, clampedLimits, negotiatedFeatures } from "./gpu-host.ts";

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

/**
 * B172 (§V12, §V469): THE PRODUCTION REQUEST ASKS FOR `timestamp-query`.
 *
 * The bug this is the gate for: `capabilities.ts` read `features.has("timestamp-query")`
 * off a device request that never named the feature, and WebGPU grants an optional
 * feature ONLY IF the request named it — so the check was structurally false on every
 * machine, `COST BY CATEGORY` read "No timing on this device" everywhere, and the copy
 * blamed the device for our omission. The string appeared in a `requiredFeatures` array
 * in exactly one TEST file and in no production path.
 *
 * This is the unit both real hosts run: `browserGpuHost` feeds it the probe adapter's
 * `features`, `mockGpuHost` feeds it the mock adapter's. (Dawn has no adapter before
 * device creation, so it asks and falls back — the same policy, expressed as a retry.)
 * The claim is on the ASK, which is the half nobody was making.
 */
describe("negotiatedFeatures (B172)", () => {
  it("asks for timestamp-query when the adapter advertises it", () => {
    expect(negotiatedFeatures(undefined, ["timestamp-query"])).toEqual(["timestamp-query"]);
    // Alongside a genuinely required feature, and never duplicated into the list.
    expect(negotiatedFeatures(["float32-filterable"], ["float32-filterable", "timestamp-query"])).toEqual([
      "float32-filterable",
      "timestamp-query",
    ]);
    expect(negotiatedFeatures(["timestamp-query"], ["timestamp-query"])).toEqual(["timestamp-query"]);
  });

  it("omits it when the adapter does not — optional never becomes required (§V12)", () => {
    // Over-requesting FAILS device creation outright, so a device without the feature
    // must still get a working app. The honest "unavailable" message becomes TRUE here.
    expect(negotiatedFeatures(undefined, ["float32-filterable"])).toEqual([]);
    expect(negotiatedFeatures(["float32-filterable"], [])).toEqual(["float32-filterable"]);
  });

  it("asks for nothing optional when the offer cannot be read at all", () => {
    // A probe that returned no adapter is not a licence to guess: an unreadable offer
    // leaves the required list exactly as it came in, and the capability report then
    // says "not requested" rather than pinning it on the device (§V469).
    expect(negotiatedFeatures(undefined, undefined)).toEqual([]);
    expect(negotiatedFeatures(["float32-filterable"], undefined)).toEqual(["float32-filterable"]);
  });
});
