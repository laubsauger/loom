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
 * The SMALL variant: 4-bit weights with fp16 activations, a fifth of the download.
 *
 * ⚠ SMALLER IS NOT FASTER, measured 2026-09-01 (§T753). On the CPU path this is
 * **3833 ms against fp32's 2670 ms** — 1.44x SLOWER, because dequantising 4-bit weights
 * costs more than the memory traffic it saves. It was labelled "fast" and described as
 * "quicker per frame" on the strength of its size alone, which was never measured and is
 * false. The honest offer is a smaller DOWNLOAD at some cost in quality and, on CPU, in
 * speed. Whether a GPU execution provider reverses that is a separate unmeasured question
 * and must not be assumed here either.
 */
export const DEPTH_LIVE: ModelDescriptor = {
  id: "depth-anything-v2-small-q4f16",
  label: "Depth Anything V2 Small 4-bit",
  url: weights("model_q4f16.onnx"),
  bytes: 19_126_267,
  license: "Apache-2.0",
};

/*
 * §V827/§T965: A LABEL NAMES THE ARTEFACT, NEVER ITS SIZE.
 *
 * These read "(small download)" until T957's chooser landed, and the reason to change
 * them is not tidiness. The chooser composes `<label> (<measured MB>)` from
 * `descriptor.bytes`, so a size in the label is a SECOND, hand-written copy of a number
 * the file already measures — the shape that lets an option say 18 MB while it downloads
 * 19. And "small download" said the one thing §T753 measured as false: it is a fifth of
 * the bytes and 1.44x SLOWER. The quantisation IS the difference, so the label names it
 * and the size comes from the bytes.
 */
export const DEPTH_MODELS: readonly ModelDescriptor[] = [DEPTH_ACCURATE, DEPTH_LIVE];

/**
 * MoveNet SinglePose Lightning (T743) — the pose weights, pinned the same way.
 *
 * Chosen because it is the only permissive pose model that is SINGLE-SHOT: ViTPose and
 * RTMPose are top-down and need a separate person detector, which would make pose two
 * models and a two-stage pipeline; every YOLO-pose is Ultralytics and therefore AGPL; and
 * MediaPipe ships its own runtime with its own GPU context, which would have been a
 * parallel stack rather than a second model through the same one.
 */
const POSE_REPO = "onnx-community/movenet-lightning-web";
/** Verified 2026-09-01 against the HF model API. */
const POSE_REVISION = "b3bef58ab3f8c766f9b6b5310493e623160c2998";

const poseWeights = (file: string): string =>
  `https://huggingface.co/${POSE_REPO}/resolve/${POSE_REVISION}/onnx/${file}`;

export const POSE_ACCURATE: ModelDescriptor = {
  id: "movenet-lightning",
  label: "MoveNet SinglePose Lightning",
  url: poseWeights("model.onnx"),
  bytes: 9_366_903,
  license: "Apache-2.0",
};

/**
 * The 8-bit variant: a quarter of the download.
 *
 * ⚠ Also SLOWER, and by more: **67 ms against fp32's 18 ms** on the CPU path (§T753).
 * Same lesson as the depth pair — a size ratio is not a speed ratio.
 */
export const POSE_LIVE: ModelDescriptor = {
  id: "movenet-lightning-int8",
  label: "MoveNet SinglePose Lightning 8-bit",
  url: poseWeights("model_int8.onnx"),
  bytes: 2_598_245,
  license: "Apache-2.0",
};

export const POSE_MODELS: readonly ModelDescriptor[] = [POSE_ACCURATE, POSE_LIVE];

/**
 * T957 — MODNet person matting (the orchestrator's ruling: Apache-2.0, true soft-alpha
 * MATTING, same onnx-community conversion family as the depth model above; RVM was
 * blocked twice — GPL-3.0 weights, and the seam is single-tensor, §T981).
 * Revision verified 2026-09-03 against the HF model API; bytes from content-length at
 * that revision.
 */
const MATTE_REPO = "Xenova/modnet";
const MATTE_REVISION = "fa2fa546052fba4c08921230a26cc69a333fca12";
const matteWeights = (file: string): string =>
  `https://huggingface.co/${MATTE_REPO}/resolve/${MATTE_REVISION}/onnx/${file}`;

export const MATTE_ACCURATE: ModelDescriptor = {
  id: "modnet-photographic",
  label: "MODNet (25 MB)",
  url: matteWeights("model.onnx"),
  bytes: 25_888_640,
  license: "Apache-2.0",
};

export const MATTE_FAST: ModelDescriptor = {
  id: "modnet-photographic-quantized",
  label: "MODNet quantized (6.6 MB)",
  url: matteWeights("model_quantized.onnx"),
  bytes: 6_632_188,
  license: "Apache-2.0",
};

export const MATTE_MODELS: readonly ModelDescriptor[] = [MATTE_ACCURATE, MATTE_FAST];

export const ALL_MODELS: readonly ModelDescriptor[] = [...DEPTH_MODELS, ...POSE_MODELS, ...MATTE_MODELS];

export function modelById(id: string): ModelDescriptor | undefined {
  return ALL_MODELS.find((model) => model.id === id);
}

/**
 * WHERE DEPTH CAN RUN — the provider set, declared (T736, §T715).
 *
 * The owner asked to "pick the right thing for the right platform and use case", which
 * needs the unreachable options named rather than omitted: a provider that silently falls
 * back removes the choice by hiding it. So every slot says whether a PAGE can reach it,
 * and an unreachable one must say what would change that — otherwise a deferral becomes
 * permanent by forgetting, which is the failure §V205's declaration list exists to stop.
 *
 * Measured 2026-09-01 on the owner's machine (Chrome 151, macOS, Apple metal-3), with
 * WebGPU as a passing control so the negatives are trustworthy.
 */
export interface DepthProvider {
  readonly id: string;
  readonly label: string;
  /** Whether a PAGE can reach it. Measured, never assumed. */
  readonly reachable: boolean;
  /** What was measured, or what would have to change. Required when unreachable. */
  readonly note: string;
}

export const DEPTH_PROVIDERS: readonly DepthProvider[] = [
  {
    id: "webgpu",
    label: "WebGPU",
    reachable: true,
    // `navigator.gpu` present, adapter reports vendor "apple", architecture "metal-3".
    // This is real hardware acceleration on the Apple GPU via Metal — it is not a
    // consolation path, it is the ONLY hardware path a page has on this machine.
    note: "onnxruntime-web's webgpu execution provider, on the Metal adapter.",
  },
  {
    id: "wasm",
    label: "CPU (WASM)",
    reachable: true,
    note: "Always available. Correct and slow; the floor the ladder rests on.",
  },
  {
    id: "webnn",
    label: "WebNN",
    reachable: false,
    // MEASURED: `navigator.ml` is undefined in Chrome 151 on macOS. WebNN is behind a
    // flag in every Chromium and WebKit has taken no position (standards-positions issue 486,
    // open since April 2025). And even where it exists the spec REMOVED `deviceType` and
    // defines no device enumeration, so a page cannot request or observe an accelerator.
    note: "navigator.ml is undefined. Unblocked when a shipping browser enables WebNN by default; even then it can never report which device it used.",
  },
  {
    id: "coreml",
    label: "Core ML / Neural Engine",
    reachable: false,
    // MEASURED: onnxruntime-web contains ZERO occurrences of "coreml" and accepts exactly
    // cpu | webgpu | webnn | wasm. ONNX Runtime's own EP table marks CoreML available for
    // MacOS x64 and arm64 in the NODE binding only. Apple's Vision framework has no web
    // surface at all: window.CoreML and window.Vision are undefined, FaceDetector and
    // TextDetector are undefined, and the only Vision-backed web API present is
    // BarcodeDetector, which does not do depth.
    note: "Not in the web build and not a web API. Unblocked ONLY by a desktop shell (Electron/Tauri) running onnxruntime-node, or by WebNN shipping and routing to it invisibly.",
  },
];

/** A slot that cannot be reached must say what would change that, or it rots quietly. */
export function unreachableWithoutRemedy(): readonly DepthProvider[] {
  return DEPTH_PROVIDERS.filter(
    (provider) => !provider.reachable && !provider.note.toLowerCase().includes("unblocked"),
  );
}
