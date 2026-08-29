import { describe, expect, it } from "vitest";
import {
  PREVIEW_SHADERS,
  channelIndex,
  previewShader,
  previewUniforms,
  resolvePreviewView,
  viewForChannelMask,
} from "./debug-effects.ts";
import { ALL_CHANNELS, DEFAULT_PREVIEW_VIEW, PREVIEW_MODES } from "./types.ts";
import type { ChannelMask } from "./types.ts";

function mask(partial: Partial<ChannelMask>): ChannelMask {
  return { r: false, g: false, b: false, a: false, ...partial };
}

describe("T35 — each debug effect emits the WGSL its mode means", () => {
  it("covers every declared mode", () => {
    expect(Object.keys(PREVIEW_SHADERS).sort()).toEqual([...PREVIEW_MODES].sort());
  });

  it.each(PREVIEW_MODES)("%s declares the shared binding layout and a fragment entry", (mode) => {
    const shader = previewShader(mode);
    expect(shader).toContain("@group(0) @binding(0) var<uniform> params: PreviewParams;");
    expect(shader).toContain("@group(0) @binding(1) var previewSampler: sampler;");
    expect(shader).toContain("@group(0) @binding(2) var previewTexture: texture_2d<f32>;");
    expect(shader).toContain("@fragment");
    expect(shader).toContain("fn fs(");
    // Single-mip targets: the implicit-derivative form buys nothing and trips uniformity
    // analysis after a branch, so every effect samples at an explicit level.
    expect(shader).toContain("textureSampleLevel(previewTexture, previewSampler");
    expect(shader).not.toMatch(/\btextureSample\(/);
  });

  it("gives every mode a DIFFERENT program", () => {
    // If two modes compiled to the same text, one of them would be silently unimplemented.
    const sources = new Set(PREVIEW_MODES.map(previewShader));
    expect(sources.size).toBe(PREVIEW_MODES.length);
  });

  it("colour applies the channel mask, exposure and the display encode", () => {
    const shader = previewShader("color");
    expect(shader).toContain("* params.mask");
    expect(shader).toContain("exposed(source.rgb)");
    expect(shader).toContain("encodeDisplay(");
  });

  it("single-channel isolates one channel as grayscale", () => {
    const shader = previewShader("channel");
    expect(shader).toContain("pickChannel(source, params.channel)");
    expect(shader).toContain("vec3f(value)");
  });

  it("alpha composites over a checkerboard using the source alpha", () => {
    const shader = previewShader("alpha");
    expect(shader).toContain("checkerValue(fragment.xy, params.checkerSize)");
    expect(shader).toContain("mix(ground, colour, clamp(source.a, 0.0, 1.0))");
  });

  it("hdr exposure tonemaps AND marks the range it clipped", () => {
    // Tonemapping without the markers hides exactly the clipping this mode exists to find.
    const shader = previewShader("exposure");
    expect(shader).toContain("tonemapFilmic(scaled)");
    expect(shader).toContain("any(scaled > vec3f(1.0))");
    expect(shader).toContain("any(scaled < vec3f(0.0))");
    expect(shader).toContain("stripe(");
  });

  it("nan/inf highlighting tests both NaN and both infinities", () => {
    const shader = previewShader("nan");
    expect(shader).toContain("source != source");
    expect(shader).toContain("source > vec4f(F32_MAX)");
    expect(shader).toContain("source < vec4f(-F32_MAX)");
  });

  it("signed visualisation is two-sided about zero and scaled", () => {
    const shader = previewShader("signed");
    expect(shader).toContain("params.signedScale");
    expect(shader).toContain("max(t, 0.0)");
    expect(shader).toContain("max(-t, 0.0)");
  });

  it("declares no WGSL reserved word as a variable name", () => {
    // `out` is reserved in WGSL; using it compiles nowhere and is an easy slip.
    for (const mode of PREVIEW_MODES) {
      expect(previewShader(mode)).not.toMatch(/\b(?:var|let)\s+out\b/);
    }
  });
});

describe("preview uniforms", () => {
  it("keeps one block shape for every mode, so a view change cannot rebuild a pipeline (§V5)", () => {
    const keys = PREVIEW_MODES.map(() => Object.keys(previewUniforms(DEFAULT_PREVIEW_VIEW)).sort());
    for (const entry of keys) {
      expect(entry).toEqual(["channel", "checkerSize", "exposure", "mask", "signedScale", "tonemap"]);
    }
  });

  it("converts exposure stops to a linear multiplier on the CPU", () => {
    expect(previewUniforms({ ...DEFAULT_PREVIEW_VIEW, exposureStops: 0 }).exposure).toBe(1);
    expect(previewUniforms({ ...DEFAULT_PREVIEW_VIEW, exposureStops: 2 }).exposure).toBe(4);
    expect(previewUniforms({ ...DEFAULT_PREVIEW_VIEW, exposureStops: -1 }).exposure).toBe(0.5);
  });

  it("encodes the channel mask in the index order the WGSL reads", () => {
    expect(previewUniforms({ ...DEFAULT_PREVIEW_VIEW, channels: mask({ g: true }) }).mask).toEqual([
      0, 1, 0, 0,
    ]);
    expect(channelIndex("r")).toBe(0);
    expect(channelIndex("a")).toBe(3);
  });

  it("never divides by zero on the signed scale", () => {
    expect(previewUniforms({ ...DEFAULT_PREVIEW_VIEW, signedScale: 0 }).signedScale).toBeGreaterThan(0);
  });
});

describe("channel toggles resolve to a view (T36)", () => {
  it("all four channels is normal colour", () => {
    expect(viewForChannelMask(ALL_CHANNELS).mode).toBe("color");
  });

  it("exactly one colour channel isolates it as grayscale", () => {
    const view = viewForChannelMask(mask({ g: true }));
    expect(view.mode).toBe("channel");
    expect(view.channel).toBe("g");
  });

  it("alpha alone shows coverage over the checkerboard", () => {
    expect(viewForChannelMask(mask({ a: true })).mode).toBe("alpha");
  });

  it("two or more channels masks rather than isolates", () => {
    const view = viewForChannelMask(mask({ r: true, b: true }));
    expect(view.mode).toBe("color");
    expect(view.channels).toEqual(mask({ r: true, b: true }));
  });

  it("falls back to colour when every channel is off", () => {
    const view = viewForChannelMask(mask({}));
    expect(view.mode).toBe("color");
    expect(view.channels).toEqual(ALL_CHANNELS);
  });

  it("an explicit mode wins over the toggles, which then only narrow what is shown", () => {
    const view = resolvePreviewView("signed", mask({ g: true }));
    expect(view.mode).toBe("signed");
    expect(view.channel).toBe("g");
  });
});
