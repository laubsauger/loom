/**
 * T1091 — THE MATTE PATH'S INPUT TREATMENT MUST NOT DEPEND ON WHICH MODEL IS SELECTED.
 *
 * T1088 nearly hard-coded an sRGB transfer on MediaPipe's input, reasoning that Loom hands
 * these models linear light, and stopped: encoding for ONE model would make the node quietly
 * mean something different depending on a dropdown. T1091 measured the question across all
 * four matte models on seven frames and ruled that no transfer is applied at all — the
 * table and the argument are at the seam where the input is prepared,
 * `letterboxPreprocessWgsl` in `nodes/definitions/inference-node.ts`.
 *
 * ⚠ A DOCBLOCK IS NOT A GUARD, so this is the guard. Every matte model takes the SAME
 * `vec4f` preprocess buffer and each applies its own documented normalisation, which is
 * AFFINE in the texel — MODNet's (x − 0.5) / 0.5, RVM's identity, MediaPipe's 8-bit
 * quantisation. What is asserted is the value the model itself reads: recover the texel
 * from each packed tensor by inverting that model's own affine map, and every model must
 * come back to the SAME picture. A transfer function added for one of them — the exact
 * change T1088 nearly made and T1091 declined — is not affine and fails here, because
 * `sRGB(0.5) = 0.7354` does not invert to 0.5 under any of these maps.
 *
 * This is deliberately NOT a test that a particular curve is absent (that would be a test
 * of a mechanism, and the next transfer would be spelled differently). It is a test that
 * the four models are still being shown one picture.
 */
import { describe, expect, it } from "vitest";
import { MATTE_MODELS, MATTE_MEDIAPIPE, isMediaPipeMatte } from "./model-catalogue.ts";
import { MODEL_PLANS } from "./inference-worker-core.ts";
import { matteTexelsToRgba } from "./mediapipe-matte.ts";

const SIDE = 4;

/**
 * A ramp across the whole [0, 1] texel range, laid out as the preprocess buffer's `vec4f`.
 * The interior values are where a transfer would show hardest: an sRGB encode moves 0.25
 * to 0.5370 and 0.5 to 0.7354, so any of them landing back on the ramp proves no curve.
 */
const RAMP = [0, 1 / 15, 2 / 15, 3 / 15, 4 / 15, 5 / 15, 6 / 15, 0.5, 8 / 15, 9 / 15, 10 / 15, 11 / 15, 0.8, 13 / 15, 14 / 15, 1];

function texels(): Float32Array {
  const out = new Float32Array(SIDE * SIDE * 4);
  for (let i = 0; i < SIDE * SIDE; i += 1) {
    out[i * 4] = RAMP[i]!;
    out[i * 4 + 1] = RAMP[i]!;
    out[i * 4 + 2] = RAMP[i]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/**
 * Each model's packed tensor mapped back to texel space through ITS OWN documented
 * normalisation — nothing else. The inverses are stated here rather than read from the
 * packer, so a packer that changed its normalisation would fail rather than follow.
 */
function recoverTexels(modelId: string): readonly number[] {
  const input = texels();
  const pixels = SIDE * SIDE;
  if (isMediaPipeMatte(modelId)) {
    // 8-bit RGBA interleaved, `round(x * 255)`; the inverse is exact for these ramp values.
    const rgba = matteTexelsToRgba(input, SIDE);
    return Array.from({ length: pixels }, (_, i) => rgba[i * 4]! / 255);
  }
  const plan = MODEL_PLANS[modelId];
  if (plan === undefined) throw new Error(`no packing for matte model "${modelId}"`);
  const packed = plan.pack(input, SIDE);
  // Planar NCHW: channel 0 is the first `pixels` entries.
  const isSigned = modelId.startsWith("modnet");
  return Array.from({ length: pixels }, (_, i) => (isSigned ? packed[i]! * 0.5 + 0.5 : packed[i]!));
}

describe("T1091 — one picture, four matte models", () => {
  it("recovers the SAME texel ramp from every matte model's packing", () => {
    // MediaPipe's rung quantises to 8 bit, so the shared ramp is the 8-bit-exact one and
    // the comparison stays an equality rather than a tolerance band (§V147).
    const expected = RAMP.map((v) => Math.round(v * 255) / 255);
    for (const model of MATTE_MODELS) {
      const recovered = recoverTexels(model.id).map((v) => Math.round(v * 255) / 255);
      expect(recovered, `matte model "${model.id}" is not fed the same picture`).toEqual(expected);
    }
  });

  it("packs the exact tensor values each model's reference inference specifies", () => {
    // MODNet: (x − 0.5) / 0.5 — the ends land on −1 and +1 and mid-grey on 0, exactly.
    const modnet = MODEL_PLANS["modnet-photographic"]!.pack(texels(), SIDE);
    expect([modnet[0], modnet[7], modnet[15]]).toEqual([-1, 0, 1]);
    // The quantized build shares the packing: it differs in weights, never in treatment.
    expect(Array.from(MODEL_PLANS["modnet-photographic-quantized"]!.pack(texels(), SIDE))).toEqual(
      Array.from(modnet),
    );
    // RVM: `transforms.ToTensor()` and nothing else, so the ramp survives untouched.
    const rvm = MODEL_PLANS["rvm-mobilenetv3"]!.pack(texels(), SIDE);
    expect([rvm[0], rvm[7], rvm[15]]).toEqual([0, 0.5, 1]);
    // MediaPipe: round(x * 255), and 0.8 is the value that pins the rounding rather than
    // a truncation — 0.8 * 255 = 204 exactly, while 13/15 * 255 = 221.0 and 0.5 → 127.5 → 128.
    const mp = matteTexelsToRgba(texels(), SIDE);
    expect([mp[0], mp[7 * 4], mp[12 * 4], mp[15 * 4]]).toEqual([0, 128, 204, 255]);
  });

  it("would fail if any model were fed a transfer — sRGB moves the ramp off itself", () => {
    /* The negative half, so the equality above cannot pass vacuously: this is the encode
       T1088 nearly applied, and it must NOT recover the ramp. Derived, not measured:
       sRGB(0.5) = 1.055 * 0.5^(1/2.4) − 0.055 = 0.7354, four ramp steps away. */
    const encode = (u: number): number => (u <= 0.0031308 ? u * 12.92 : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
    const encoded = texels();
    for (let i = 0; i < SIDE * SIDE; i += 1)
      for (let c = 0; c < 3; c += 1) encoded[i * 4 + c] = encode(encoded[i * 4 + c]!);
    const packed = MODEL_PLANS[MATTE_MODELS[0]!.id]!.pack(encoded, SIDE);
    const recovered = packed[7]! * 0.5 + 0.5;
    expect(recovered).toBeGreaterThan(0.73);
    expect(recovered).toBeLessThan(0.74);
    expect(MATTE_MEDIAPIPE.id).toBe("mediapipe-selfie-segmenter");
  });
});
