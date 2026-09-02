import { describe, expect, it } from "vitest";
import {
  POSE_INPUT_CHANNELS,
  POSE_INPUT_DTYPE,
  POSE_INPUT_SIDE,
  POSE_KEYPOINTS,
  POSE_KEYPOINT_COUNT,
  keypointsToTexture,
  neutralPose,
  packPoseInput,
  toHalf,
} from "./pose-runner.ts";

/** Reads a half-float back, so the assertions are about VALUES, not bit patterns. */
function readHalf(bytes: Uint8Array, texel: number, channel: number): number {
  const bits = new DataView(bytes.buffer).getUint16(texel * 8 + channel * 2, true);
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

describe("packing MoveNet's input", () => {
  /**
   * Depth wants normalised planar float; MoveNet wants INTERLEAVED int32 in 0..255.
   * Carrying depth's packer over would put every channel near zero and the model would
   * confidently find a person-shaped nothing — no throw, no diagnostic.
   */
  /**
   * The signature is the model's, not its documentation's. MoveNet's upstream card says
   * `int32 [1,192,192,3]`; the pinned WEB export takes `uint8 [1,192,192,4]`, and ORT
   * refuses the mismatch outright — so the first version of this packer meant pose could
   * never produce a single result. Read from the weights on 2026-09-01, not from a README.
   */
  it("emits UNSIGNED BYTES, which is what the web export actually takes", () => {
    const packed = packPoseInput(new Float32Array([1, 0.5, 0, 1]), 1);
    expect(POSE_INPUT_DTYPE).toBe("uint8");
    expect(packed).toBeInstanceOf(Uint8Array);
    expect([...packed]).toEqual([255, 128, 0, 255]);
  });

  it("emits FOUR channels, not three — alpha is part of this model's input", () => {
    expect(POSE_INPUT_CHANNELS).toBe(4);
    const packed = packPoseInput(new Float32Array(4 * 4), 2);
    expect(packed.length).toBe(2 * 2 * 4);
  });

  it("keeps channels INTERLEAVED rather than planar", () => {
    // Two pixels: red then green. Interleaved is [255,0,0, 0,255,0]; planar would be
    // [255,0, 0,255, 0,0] — the same numbers, a scrambled image, and a model that runs.
    // side 2 = 4 texels: red, green, blue, black.
    const texels = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1]);
    // Interleaved RGBA per pixel: red, green, blue, black — each with alpha 255.
    expect([...packPoseInput(texels, 2)]).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      0, 0, 0, 255,
    ]);
  });

  it("clamps rather than wrapping, so an HDR input cannot alias to black", () => {
    const packed = packPoseInput(new Float32Array([2.5, -1, 0.5, 1]), 1);
    expect([...packed]).toEqual([255, 0, 128, 255]);
  });

  it("sizes to the model's fixed 192, which is Lightning's graph", () => {
    expect(POSE_INPUT_SIDE).toBe(192);
    expect(packPoseInput(new Float32Array(4 * 4), 2).length).toBe(2 * 2 * POSE_INPUT_CHANNELS);
  });
});

describe("encoding keypoints for the graph", () => {
  /**
   * THE one that would ship a plausible lie. MoveNet's triple is (y, x, score); reading
   * it as (x, y) mirrors the whole skeleton through the diagonal. It still looks like a
   * person, it is still confident, and no pixel gate would catch it.
   */
  it("reads the model's (y, x, score) order and writes (x, y, confidence)", () => {
    const output = new Float32Array(POSE_KEYPOINT_COUNT * 3);
    output[0] = 0.25; // y
    output[1] = 0.75; // x
    output[2] = 0.9; // score
    const bytes = keypointsToTexture(output, 192, 192);

    expect(readHalf(bytes, 0, 0)).toBeCloseTo(0.75, 3); // R = x
    expect(readHalf(bytes, 0, 1)).toBeCloseTo(0.25, 3); // G = y
    expect(readHalf(bytes, 0, 2)).toBeCloseTo(0.9, 3); // B = confidence
  });

  /**
   * T992 — THE UN-LETTERBOX, exact on a 2:1 source. The preprocess fits a wide frame
   * into the model square with bars above and below (occ = [1, 0.5]), so the model's
   * vertical uv only spans the centred half: model v 0.25 IS the frame's top edge,
   * 0.75 its bottom, 0.5 its middle — and x passes through untouched. A joint the
   * model parks inside a bar clamps to the frame edge instead of leaving [0, 1].
   * Before this change every one of these joints shipped at its raw model uv — off by
   * the bar width, plausibly (§T992's words).
   */
  it("maps letterboxed model uv back onto a 2:1 frame, exactly", () => {
    const output = new Float32Array(POSE_KEYPOINT_COUNT * 3);
    const joint = (i: number, y: number, x: number): void => {
      output[i * 3] = y;
      output[i * 3 + 1] = x;
      output[i * 3 + 2] = 1;
    };
    joint(0, 0.25, 0.75); // the band's start: frame top, x untouched
    joint(1, 0.75, 0.25); // the band's end: frame bottom
    joint(2, 0.5, 0.5); //   dead centre stays dead centre
    joint(3, 0.375, 0.5); // a quarter into the band: frame v 0.25
    joint(4, 0.1, 0.5); //   inside the top bar: clamps to the edge, stays drawable
    const bytes = keypointsToTexture(output, 512, 256);

    expect(readHalf(bytes, 0, 0)).toBeCloseTo(0.75, 3); // x: occX = 1, identity
    expect(readHalf(bytes, 0, 1)).toBe(0); //              v: (0.25 − 0.5)/0.5 + 0.5
    expect(readHalf(bytes, 1, 1)).toBe(1);
    expect(readHalf(bytes, 2, 1)).toBeCloseTo(0.5, 3);
    expect(readHalf(bytes, 3, 1)).toBeCloseTo(0.25, 3);
    expect(readHalf(bytes, 4, 1)).toBe(0); // clamped, not negative
  });

  it("writes one texel per joint, opaque, at the model's own count", () => {
    const bytes = keypointsToTexture(new Float32Array(POSE_KEYPOINT_COUNT * 3), 192, 192);
    expect(POSE_KEYPOINT_COUNT).toBe(17);
    expect(POSE_KEYPOINTS[9]).toBe("left_wrist");
    expect(bytes.length).toBe(17 * 8);
    for (let i = 0; i < POSE_KEYPOINT_COUNT; i += 1) expect(readHalf(bytes, i, 3)).toBe(1);
  });

  it("keeps precision far below the model's own jitter", () => {
    // A byte would quantise a joint to ~1/255 — about 7px at 1080p, a permanent tremor.
    const output = new Float32Array(POSE_KEYPOINT_COUNT * 3);
    output[1] = 0.5001;
    const bytes = keypointsToTexture(output, 192, 192);
    expect(Math.abs(readHalf(bytes, 0, 0) - 0.5001)).toBeLessThan(1 / 2048);
  });

  it("survives a NaN from the model rather than placing a joint at infinity", () => {
    const output = new Float32Array(POSE_KEYPOINT_COUNT * 3);
    output[0] = Number.NaN;
    output[1] = Number.POSITIVE_INFINITY;
    const bytes = keypointsToTexture(output, 192, 192);
    expect(Number.isFinite(readHalf(bytes, 0, 0))).toBe(true);
    expect(Number.isFinite(readHalf(bytes, 0, 1))).toBe(true);
  });
});

describe("half-float conversion", () => {
  it("round-trips the range keypoints actually occupy", () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setUint16(0, toHalf(value), true);
      expect(readHalf(bytes, 0, 0)).toBeCloseTo(value, 3);
    }
  });
});

describe("the identity a Pose node publishes with no model", () => {
  /**
   * Honest because it is not invented: zero confidence is byte-for-byte what the model
   * emits when nobody is in shot, so `pointsFromTexture` parks every point and the
   * no-model path needs no special case. A T-pose here would be a person who is not
   * there — the §V147 failure this deliberately refuses.
   */
  it("is every joint at zero confidence, which parks every point", () => {
    const bytes = neutralPose();
    expect(bytes.length).toBe(17 * 8);
    for (let i = 0; i < POSE_KEYPOINT_COUNT; i += 1) {
      expect(readHalf(bytes, i, 2)).toBe(0);
    }
  });

  it("is byte-identical to what a real inference of an empty frame produces", () => {
    // The argument for the identity in one assertion: the no-model state and the
    // no-person state are the SAME state, so nothing downstream can tell them apart and
    // nothing needs to.
    expect([...neutralPose()]).toEqual([...keypointsToTexture(new Float32Array(POSE_KEYPOINT_COUNT * 3), 192, 192)]);
  });
});
