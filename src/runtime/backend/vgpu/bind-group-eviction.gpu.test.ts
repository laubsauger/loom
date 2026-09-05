import { describe, expect, it } from "vitest";

import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";

/**
 * T1180 — THE CASE THE EVICTION COULD SWALLOW, ON A REAL DEVICE.
 *
 * `bind-group-eviction.test.ts` proves the cache stops growing. This proves the picture
 * survives it, because the failure mode of dropping a cache entry too eagerly is not a slow
 * frame, it is a stale or missing binding.
 *
 * The scenario is the exact discard shape the fix targets and the hardest one for it: an
 * effect is replaced by an EQUIVALENT effect that binds the SAME surviving target and
 * sampler, in the same recompile. The old drawable's entries are evicted while the new
 * drawable is minting its own over the very same resources, and the frame right after must
 * read back the new shader's pixels — exactly, not approximately.
 *
 * The edit is a channel swizzle rather than a scale, so both expected results are exactly
 * representable in rgba8unorm and the assertion needs no tolerance (§V147). The swap runs
 * BOTH ways: back to the original shader must restore the original bytes, which is what
 * fails if an evicted entry were somehow reused instead of rebuilt.
 */

const SIZE = 8;
/** Chosen so each channel is exact in rgba8unorm: 0.2*255=51, 0.4*255=102, 0.6*255=153. */
const SOURCE_WGSL = `@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.2, 0.4, 0.6, 1.0);
}`;
const PASSTHROUGH_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var midTexture: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(midTexture, inputSampler, uv);
}`;
const SWIZZLED_WGSL = PASSTHROUGH_WGSL.replace(
  "return textureSample(midTexture, inputSampler, uv);",
  "return textureSample(midTexture, inputSampler, uv).bgra;",
);

function planWith(outputShader: string): LogicalExecutionPlan {
  return {
    resources: [
      { kind: "target", id: "mid", size: [SIZE, SIZE], format: "rgba8unorm" },
      { kind: "target", id: "out", size: [SIZE, SIZE], format: "rgba8unorm" },
      { kind: "sampler", id: "linear", filter: "linear" },
    ],
    passes: [
      { kind: "effect", id: "source", nodeId: "node-source", shader: SOURCE_WGSL, target: "mid" },
      {
        kind: "effect",
        id: "output",
        nodeId: "node-output",
        shader: outputShader,
        target: "out",
        samplers: [{ binding: "inputSampler", resourceId: "linear" }],
        textures: [{ binding: "midTexture", resourceId: "mid" }],
      },
    ],
    diagnostics: [],
  } as unknown as LogicalExecutionPlan;
}

describe("a discarded effect's bind groups are evicted without disturbing its replacement (T1180)", () => {
  it("a shader edit that keeps every bound resource still renders the edited pixels, both ways", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});

      const renderAndRead = async (shader: string, frameIndex: number): Promise<number[]> => {
        const compiled = await backend.compile(planWith(shader));
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [SIZE, SIZE],
        } as never);
        const image = await backend.readOutput("out");
        return [...image.bytes.subarray(0, 4)];
      };

      // The `output` effect binds `linear` and `mid` and carries no uniform block, so every
      // resource it names survives each recompile below — the discarded Effect is the ONLY
      // thing that dies, which is what makes this the eviction's own case.
      expect(await renderAndRead(PASSTHROUGH_WGSL, 0)).toEqual([51, 102, 153, 255]);

      // Discard + immediate equivalent rebuild over the same resources.
      expect(await renderAndRead(SWIZZLED_WGSL, 1)).toEqual([153, 102, 51, 255]);

      // And back. A returning shader gets a NEW drawId, so it must build its own entries
      // rather than find the first Effect's — which were evicted two recompiles ago.
      expect(await renderAndRead(PASSTHROUGH_WGSL, 2)).toEqual([51, 102, 153, 255]);
    } finally {
      backend.dispose();
    }
  }, 90_000);
});
