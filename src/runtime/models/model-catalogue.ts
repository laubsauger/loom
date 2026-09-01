import type { ModelDescriptor } from "./model-acquisition.ts";

/**
 * The depth models, pinned (T715, T736).
 *
 * ## Two variants of ONE model, from ONE host — which is the provider registry
 *
 * The owner ruled the architecture as "pick the right thing for the right platform and
 * use case": a 60fps live set wants the cheapest, an offline render wants the most
 * accurate. That is realised here as two weight files from the same repository at the
 * same revision, rather than two different models from two different hosts — one
 * acquisition story, one licence, one code path, and the registry is real rather than
 * aspirational.
 *
 * ## Every URL is REVISION-PINNED, and that is load-bearing
 *
 * `resolve/<sha>/…`, never `resolve/main/…`. A moving reference lets the bytes under a
 * document change without the document changing, which would make "same graph, same
 * picture" quietly untrue and defeat the record/replay gates that exist to catch exactly
 * that. The byte counts below were read from `content-length` at this revision, not from
 * the model card, and the acquisition path refuses anything that does not match.
 */

const REPO = "onnx-community/depth-anything-v2-small";
/** Verified 2026-09-01 against the HF model API. */
const REVISION = "4472b7362082ad9968fee890ca0f1e5aca36b93d";

const weights = (file: string): string =>
  `https://huggingface.co/${REPO}/resolve/${REVISION}/onnx/${file}`;

/**
 * The owner's choice: "lets do depthanything v2 (94mb)", named with the number after a
 * ~27 MB option was on the table. Full precision — quality over download, deliberately.
 */
export const DEPTH_ACCURATE: ModelDescriptor = {
  id: "depth-anything-v2-small",
  label: "Depth Anything V2 Small",
  url: weights("model.onnx"),
  bytes: 99_060_839,
  license: "Apache-2.0",
};

/**
 * The live variant: 4-bit weights with fp16 activations, a fifth of the download and
 * quicker per frame. A DIFFERENT QUALITY POINT, not a smaller packaging of the same one —
 * so it is offered as a choice and never substituted for the accurate one behind the
 * user's back.
 */
export const DEPTH_LIVE: ModelDescriptor = {
  id: "depth-anything-v2-small-q4f16",
  label: "Depth Anything V2 Small (fast)",
  url: weights("model_q4f16.onnx"),
  bytes: 19_126_267,
  license: "Apache-2.0",
};

export const DEPTH_MODELS: readonly ModelDescriptor[] = [DEPTH_ACCURATE, DEPTH_LIVE];

export function depthModel(id: string): ModelDescriptor | undefined {
  return DEPTH_MODELS.find((model) => model.id === id);
}
