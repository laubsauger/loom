import { describe, expect, it } from "vitest";
import { depthToRgba, neutralDepth, packModelInput } from "./depth-runner.ts";

/**
 * The two conversions around the model (T385).
 *
 * These are where depth silently goes wrong — a channel order swapped, a normalisation
 * skipped, an axis transposed — each producing something that LOOKS like a depth map. No
 * gate over the rendered pixels would catch any of them, so they are checked by value.
 */

describe("packing the model's input", () => {
  it("converts interleaved RGBA texels into PLANAR channels", () => {
    // Four pixels (side 2), each a pure primary or black, so every channel's plane has a
    // distinct signature. Interleaved input left interleaved would still RUN and would
    // feed the model a scrambled image — the failure this asserts against.
    const texels = new Float32Array([
      1, 0, 0, 1, // red
      0, 1, 0, 1, // green
      0, 0, 1, 1, // blue
      0, 0, 0, 1, // black
    ]);
    const packed = packModelInput(texels, 2);
    expect(packed.length).toBe(3 * 4);

    const denorm = (plane: number, index: number) =>
      packed[plane * 4 + index]! * [0.229, 0.224, 0.225][plane]! + [0.485, 0.456, 0.406][plane]!;

    // Plane 0 is RED across all four pixels: 1,0,0,0 — not the first four numbers of the
    // interleaved buffer, which would be 1,0,0,1.
    expect([0, 1, 2, 3].map((i) => Math.round(denorm(0, i)) + 0)).toEqual([1, 0, 0, 0]);
    expect([0, 1, 2, 3].map((i) => Math.round(denorm(1, i)) + 0)).toEqual([0, 1, 0, 0]);
    expect([0, 1, 2, 3].map((i) => Math.round(denorm(2, i)) + 0)).toEqual([0, 0, 1, 0]);
  });

  it("normalises per channel with ImageNet statistics, not one global scale", () => {
    // A mid-grey pixel must NOT map to zero: the three channels have different means, so
    // a single global normalisation would put all three at the same value and quietly
    // shift the colour balance the model was trained against.
    const texels = new Float32Array([0.5, 0.5, 0.5, 1]);
    const packed = packModelInput(texels, 1);

    expect(packed[0]).toBeCloseTo((0.5 - 0.485) / 0.229, 6);
    expect(packed[1]).toBeCloseTo((0.5 - 0.456) / 0.224, 6);
    expect(packed[2]).toBeCloseTo((0.5 - 0.406) / 0.225, 6);
    expect(packed[0]).not.toBeCloseTo(packed[1]!, 3);
  });

  it("drops alpha rather than feeding it as a fourth channel", () => {
    const texels = new Float32Array([0, 0, 0, 0.123]);
    expect(packModelInput(texels, 1).length).toBe(3);
  });
});

describe("turning relative depth into a texture", () => {
  it("stretches the frame's own range across 0..255", () => {
    const depth = new Float32Array([0, 1, 2, 3]);
    const rgba = depthToRgba(depth, 2, 2, 2);

    expect(rgba[0]).toBe(0);
    expect(rgba[(3 * 4)]).toBe(255);
  });

  it("writes grey — equal channels — with opaque alpha", () => {
    const rgba = depthToRgba(new Float32Array([0, 1, 2, 3]), 2, 2, 2);
    for (let i = 0; i < rgba.length; i += 4) {
      expect(rgba[i]).toBe(rgba[i + 1]);
      expect(rgba[i]).toBe(rgba[i + 2]);
      expect(rgba[i + 3]).toBe(255);
    }
  });

  /**
   * The one that matters for the contract. A flat input has no range to stretch, and
   * normalising it to 0 would read as "everything is at the far plane" — a downstream
   * Displace would shove the entire image. 0.5 is the no-displacement value, so a flat
   * input stays flat, exactly as the never-yet fallback does.
   */
  it("normalises a degenerate frame to the IDENTITY, not to zero", () => {
    const rgba = depthToRgba(new Float32Array([7, 7, 7, 7]), 2, 2, 2);
    for (let i = 0; i < rgba.length; i += 4) expect(rgba[i]).toBe(128);
  });

  it("survives a frame containing NaN rather than producing a black map", () => {
    const rgba = depthToRgba(new Float32Array([0, Number.NaN, 1, 0.5]), 2, 2, 2);
    expect([...rgba].every((v) => Number.isFinite(v))).toBe(true);
  });

  it("resamples to the node's resolution, not the model's", () => {
    // The model works at a fixed side whatever the picture is. If this returned the
    // model's size the upload would fail an extent assertion rather than scale.
    const rgba = depthToRgba(new Float32Array([0, 1, 2, 3]), 2, 8, 5);
    expect(rgba.length).toBe(8 * 5 * 4);
  });

  it("keeps near bright and far dark across the resample", () => {
    // A left-to-right ramp must still run left-to-right after scaling up.
    const depth = new Float32Array([0, 3, 0, 3]);
    const rgba = depthToRgba(depth, 2, 4, 2);
    expect(rgba[0]).toBeLessThan(rgba[3 * 4]!);
  });
});

describe("the identity a node publishes with no result", () => {
  it("is the value Displace reads as no displacement", () => {
    // 128/255 = 0.502. `displace`'s `offset` default is 0.5, so this composes to a no-op
    // and a machine without the model renders the document as if the node were not there.
    const grey = neutralDepth(3, 2);
    expect(grey.length).toBe(3 * 2 * 4);
    for (let i = 0; i < grey.length; i += 4) {
      expect(grey[i]).toBe(128);
      expect(grey[i + 3]).toBe(255);
    }
  });
});
