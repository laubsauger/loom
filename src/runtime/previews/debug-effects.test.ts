import { describe, expect, it } from "vitest";
import {
  channelIndex,
  previewShader,
  previewUniforms,
  resolvePreviewView,
  viewForChannelMask,
  viewForLens,
} from "./debug-effects.ts";
import {
  ALL_CHANNELS,
  DEFAULT_PREVIEW_LENS,
  DEFAULT_PREVIEW_VIEW,
  PREVIEW_LENSES,
  PREVIEW_MODES,
  isDefaultLens,
} from "./types.ts";
import type { ChannelMask, PreviewLens } from "./types.ts";

function mask(partial: Partial<ChannelMask>): ChannelMask {
  return { r: false, g: false, b: false, a: false, ...partial };
}

describe("T35 — each debug effect emits the WGSL its mode means", () => {
  it("covers every declared mode", () => {
    // Every mode compiles to real WGSL for both source spaces (T375): a mode that only
    // works for a linear source is a mode that breaks on the Output node's preview.
    for (const mode of PREVIEW_MODES) {
      expect(previewShader(mode, "linear")).toContain("@fragment");
      expect(previewShader(mode, "encoded")).toContain("@fragment");
    }
  });

  it.each(PREVIEW_MODES)("%s declares the shared binding layout and a fragment entry", (mode) => {
    const shader = previewShader(mode, "linear");
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
    const sources = new Set(PREVIEW_MODES.map((mode) => previewShader(mode, "linear")));
    expect(sources.size).toBe(PREVIEW_MODES.length);
  });

  it("colour applies the channel mask, exposure and the display encode", () => {
    const shader = previewShader("color", "linear");
    expect(shader).toContain("* params.mask");
    expect(shader).toContain("exposed(source.rgb)");
    expect(shader).toContain("encodeDisplay(");
  });

  it("single-channel isolates one channel as grayscale", () => {
    const shader = previewShader("channel", "linear");
    expect(shader).toContain("pickChannel(source, params.channel)");
    expect(shader).toContain("vec3f(value)");
  });

  it("luminance weights the graded colour, not the raw one", () => {
    // Order matters and is the whole reason this is asserted: luminance answers "how bright
    // is what I am looking at", so exposure and the tonemap come FIRST. Weighting the raw
    // sample would report the brightness of a picture nobody is being shown.
    const shader = previewShader("luminance", "linear");
    expect(shader).toContain("maybeTonemap(exposed(source.rgb))");
    expect(shader).toContain("dot(graded, vec3f(0.2126, 0.7152, 0.0722))");
  });

  it("alpha composites over a checkerboard using the source alpha", () => {
    const shader = previewShader("alpha", "linear");
    expect(shader).toContain("checkerValue(fragment.xy, params.checkerSize)");
    expect(shader).toContain("mix(ground, colour, clamp(source.a, 0.0, 1.0))");
  });

  it("hdr exposure tonemaps AND marks the range it clipped", () => {
    // Tonemapping without the markers hides exactly the clipping this mode exists to find.
    const shader = previewShader("exposure", "linear");
    expect(shader).toContain("tonemapFilmic(scaled)");
    expect(shader).toContain("any(scaled > vec3f(1.0))");
    expect(shader).toContain("any(scaled < vec3f(0.0))");
    expect(shader).toContain("stripe(");
  });

  it("nan/inf highlighting tests both NaN and both infinities", () => {
    const shader = previewShader("nan", "linear");
    expect(shader).toContain("source != source");
    expect(shader).toContain("source > vec4f(F32_MAX)");
    expect(shader).toContain("source < vec4f(-F32_MAX)");
  });

  it("signed visualisation is two-sided about zero and scaled", () => {
    const shader = previewShader("signed", "linear");
    expect(shader).toContain("params.signedScale");
    expect(shader).toContain("max(t, 0.0)");
    expect(shader).toContain("max(-t, 0.0)");
  });

  it("declares no WGSL reserved word as a variable name", () => {
    // `out` is reserved in WGSL; using it compiles nowhere and is an easy slip.
    for (const mode of PREVIEW_MODES) {
      expect(previewShader(mode, "linear")).not.toMatch(/\b(?:var|let)\s+out\b/);
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

/**
 * T336 — the LENS, the vocabulary the editor actually sets.
 *
 * These assert the widening, because the widening is where a second opinion about "what does
 * isolate green mean" would grow: the popup, a keybinding and an agent all go through
 * `viewForLens`, so if it disagreed with `viewForChannelMask` the same word would mean two
 * things depending on which control the user touched.
 */
describe("preview lens resolves to a view (T336)", () => {
  const lens = (patch: Partial<PreviewLens> = {}): PreviewLens => ({
    ...DEFAULT_PREVIEW_LENS,
    ...patch,
  });

  it("the default lens is the default view — an untouched preview is unchanged", () => {
    expect(viewForLens(DEFAULT_PREVIEW_LENS)).toEqual(DEFAULT_PREVIEW_VIEW);
    expect(isDefaultLens(DEFAULT_PREVIEW_LENS)).toBe(true);
  });

  it("every declared lens produces a mode that HAS a shader", () => {
    // The union is closed at both ends: a lens nobody wrote a shader for would render the
    // colour pass and look like it worked.
    for (const kind of PREVIEW_LENSES) {
      const view = viewForLens(lens({ lens: kind }));
      expect(PREVIEW_MODES).toContain(view.mode);
      expect(previewShader(view.mode, "linear")).toBeTruthy();
    }
  });

  it("isolating a colour channel agrees with the channel-mask rules, it does not restate them", () => {
    const view = viewForLens(lens({ lens: "g" }));
    expect(view).toMatchObject(viewForChannelMask({ r: false, g: true, b: false, a: false }));
    expect(view.mode).toBe("channel");
    expect(view.channel).toBe("g");
  });

  it("alpha alone gets the checkerboard, exactly as the toggles do", () => {
    expect(viewForLens(lens({ lens: "a" })).mode).toBe("alpha");
  });

  it("luminance is a mode, not a mask — every channel still reaches the shader", () => {
    const view = viewForLens(lens({ lens: "luminance" }));
    expect(view.mode).toBe("luminance");
    expect(view.channels).toEqual(ALL_CHANNELS);
  });

  it("exposure and tonemap ride every lens, including an isolated channel", () => {
    const view = viewForLens(lens({ lens: "b", exposureStops: 2, tonemap: true }));
    expect(view.mode).toBe("channel");
    expect(view.channel).toBe("b");
    expect(previewUniforms(view).exposure).toBe(4);
    expect(previewUniforms(view).tonemap).toBe(1);
  });

  it("changing a lens never changes the uniform BLOCK, so it cannot rebuild a pipeline (§V5)", () => {
    const shape = Object.keys(previewUniforms(DEFAULT_PREVIEW_VIEW)).sort();
    for (const kind of PREVIEW_LENSES) {
      const view = viewForLens(lens({ lens: kind, exposureStops: -3, tonemap: true }));
      expect(Object.keys(previewUniforms(view)).sort()).toEqual(shape);
    }
  });

  it("knows when a lens is doing nothing, which is what suppresses the marker", () => {
    expect(isDefaultLens(lens({ lens: "r" }))).toBe(false);
    expect(isDefaultLens(lens({ exposureStops: 1 }))).toBe(false);
    expect(isDefaultLens(lens({ tonemap: true }))).toBe(false);
  });
});
