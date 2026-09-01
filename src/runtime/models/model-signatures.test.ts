import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_MODELS } from "./model-catalogue.ts";
import { MODEL_SIGNATURES, declaredChannels, signatureFor } from "./model-signatures.ts";
import { packModelInput } from "./depth-runner.ts";
import { POSE_INPUT_CHANNELS, POSE_INPUT_DTYPE, POSE_INPUT_SIDE, packPoseInput } from "./pose-runner.ts";

/**
 * THE CONTRACT TEST §B148 NEEDED (§V742).
 *
 * Pose shipped unable to produce a single result — `int32` with three channels where the
 * model takes `uint8` with four — and thirty-two green tests said otherwise, because every
 * fake in the suite agreed with the packer instead of with the model. More gates of that
 * kind would not have helped: they were all hermetic, and a hermetic gate never meets the
 * artifact it stands in for.
 *
 * What closes it is one cheap conformance check per external artifact, against a signature
 * EXTRACTED from the real file. No inference, no download, no GPU.
 */

describe("§V742 — every packer conforms to the model's own declared input", () => {
  it("has a signature for every shipped model, and no orphans", () => {
    // §V461: if these lists drift apart the assertions below quietly stop covering things.
    expect(MODEL_SIGNATURES.map((s) => s.modelId).sort()).toEqual(ALL_MODELS.map((m) => m.id).sort());
  });

  it("packs POSE as uint8 with four channels, which is what the WEB export takes", () => {
    // The exact shape of §B148. The model card describes int32 x3 — a different artifact
    // with the same name (§V743) — and ORT refuses the mismatch, so this never ran.
    const signature = signatureFor("movenet-lightning");
    expect(signature).toBeDefined();
    expect(POSE_INPUT_DTYPE).toBe(signature!.input.type);
    expect(POSE_INPUT_CHANNELS).toBe(declaredChannels(signature!));

    const side = 2;
    const packed = packPoseInput(new Float32Array(side * side * 4), side);
    expect(packed).toBeInstanceOf(Uint8Array);
    expect(packed.length).toBe(side * side * declaredChannels(signature!));
  });

  it("packs DEPTH as float32 with three planar channels", () => {
    const signature = signatureFor("depth-anything-v2-small");
    expect(signature).toBeDefined();
    expect(signature!.input.type).toBe("float32");
    expect(declaredChannels(signature!)).toBe(3);

    const side = 2;
    const packed = packModelInput(new Float32Array(side * side * 4), side);
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed.length).toBe(side * side * declaredChannels(signature!));
  });

  it("holds the side length the pose graph is fixed at", () => {
    const shape = signatureFor("movenet-lightning")!.input.shape;
    expect(Number(shape[1])).toBe(POSE_INPUT_SIDE);
    expect(Number(shape[2])).toBe(POSE_INPUT_SIDE);
  });

  it("keeps a variant's signature identical to its full-precision sibling", () => {
    // A quantised export that changed dtype or layout would need its own packer, and the
    // node offers them as interchangeable. If that ever stops being true, this says so.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["depth-anything-v2-small", "depth-anything-v2-small-q4f16"],
      ["movenet-lightning", "movenet-lightning-int8"],
    ];
    for (const [full, small] of pairs) {
      expect(signatureFor(small)!.input).toEqual(signatureFor(full)!.input);
      expect(signatureFor(small)!.output.type).toEqual(signatureFor(full)!.output.type);
    }
  });
});

/**
 * The half that makes the fixture trustworthy rather than merely consistent.
 *
 * The always-on gate above cannot catch a signature that was WRONG WHEN RECORDED — it can
 * only catch a packer drifting from it. This re-reads the real weights and asserts the
 * recorded rows still match, which is what a revision bump needs. It runs where the files
 * are (a dev machine, or anywhere `SHADERLOOM_MODEL_DIR` points) and is skipped in CI,
 * because 125 MB of weights is not a thing to download per suite.
 */
const MODEL_DIR = process.env["SHADERLOOM_MODEL_DIR"];
const FILES: Readonly<Record<string, string>> = {
  "depth-anything-v2-small": "depth.onnx",
  "depth-anything-v2-small-q4f16": "depth-q4f16.onnx",
  "movenet-lightning": "pose.onnx",
  "movenet-lightning-int8": "pose-int8.onnx",
};

describe.skipIf(MODEL_DIR === undefined)("the recorded signatures still match the real weights", () => {
  it("re-reads every model and finds what model-signatures.ts claims", async () => {
    const ort = (await import("onnxruntime-web")).default;
    ort.env.logLevel = "error";
    for (const signature of MODEL_SIGNATURES) {
      const file = join(MODEL_DIR!, FILES[signature.modelId]!);
      if (!existsSync(file)) continue;
      const session = await ort.InferenceSession.create(readFileSync(file), {
        executionProviders: ["wasm"],
      });
      const input = session.inputMetadata[0] as { name: string; type: string; shape: readonly unknown[] };
      expect({ id: signature.modelId, name: input.name, type: input.type }).toEqual({
        id: signature.modelId,
        name: signature.input.name,
        type: signature.input.type,
      });
      expect(input.shape.map(String)).toEqual(signature.input.shape);
    }
  }, 300_000);
});
