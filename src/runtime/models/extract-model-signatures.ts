/**
 * Regenerates `model-signatures.ts` from the REAL weight files (T382, §V742).
 *
 *   node --import ./src/tooling/alias-hooks.ts src/runtime/models/extract-model-signatures.ts <dir>
 *
 * where <dir> holds the pinned .onnx files named as `FILES` below.
 *
 * ## Why this script exists rather than a hand-written constant
 *
 * §B148: Pose shipped unable to run because its packer was written from the model CARD —
 * `int32 [1,192,192,3]`, the TensorFlow original — while the web export takes
 * `uint8 [1,192,192,4]`. Thirty-two green tests never noticed, because every fake in the
 * suite agreed with the packer rather than with the model (§V742: the hermetic fake never
 * disagreed with the model because it never met it).
 *
 * A hand-typed signature fixture would have carried exactly the same wrong assumption. So
 * the fixture is EXTRACTED, and this is what extracts it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FILES: ReadonlyArray<readonly [string, string]> = [
  ["depth-anything-v2-small", "depth.onnx"],
  ["depth-anything-v2-small-q4f16", "depth-q4f16.onnx"],
  ["movenet-lightning", "pose.onnx"],
  ["movenet-lightning-int8", "pose-int8.onnx"],
  ["modnet-photographic", "matte.onnx"],
  ["modnet-photographic-quantized", "matte-quantized.onnx"],
];

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: extract-model-signatures.ts <dir-of-onnx-files>");

const ort = (await import("onnxruntime-web")).default;
ort.env.logLevel = "error";

const rows: string[] = [];
for (const [id, file] of FILES) {
  /* T957: extract what the directory HAS — a partial run pastes a partial table, and the
     absent rows say so loudly instead of failing the whole extraction. */
  if (!existsSync(join(dir, file))) {
    console.log(`skip ${id}: ${file} not in ${dir}`);
    continue;
  }
  const session = await ort.InferenceSession.create(readFileSync(join(dir, file)), {
    executionProviders: ["wasm"],
  });
  const input = session.inputMetadata[0] as { name: string; type: string; shape: readonly unknown[] };
  const output = session.outputMetadata[0] as { name: string; type: string };
  rows.push(
    `  {\n    modelId: ${JSON.stringify(id)},\n` +
      `    input: { name: ${JSON.stringify(input.name)}, type: ${JSON.stringify(input.type)}, ` +
      `shape: ${JSON.stringify(input.shape.map(String))} },\n` +
      `    output: { name: ${JSON.stringify(output.name)}, type: ${JSON.stringify(output.type)} },\n  },`,
  );
  console.log(`read ${id}: ${input.type} [${input.shape.map(String).join(",")}]`);
}
console.log("\n--- paste into model-signatures.ts ---\n" + rows.join("\n"));
