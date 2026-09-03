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
 * MATTING, same onnx-community conversion family as the depth model above). RVM was
 * blocked here twice, on GPL-3.0 weights and on a single-tensor worker seam; T1040
 * cleared both — §V858 ruled the licence no bar for a runtime fetch, and the seam now
 * reads a declaration table, so RVM sits beside these as `MATTE_RVM` below.
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

/**
 * ⚠ THE QUANTIZED BUILD TRADES ROBUSTNESS, NOT SPEED, AND IT BREAKS ON A DIM PICTURE.
 *
 * Measured 2026-09-03, both builds, same portrait, same letterboxed 512² packing, wasm.
 * The number that matters is the MEAN INPUT LEVEL, and coverage is the fraction of the
 * frame each one claims (the subject occupies about 0.28 of it):
 *
 *   mean in   accurate            quantized
 *   0.651     0.281  (0.50,0.70)  0.288  (0.50,0.70)   both correct
 *   0.427     0.275  (0.51,0.69)  0.284  (0.50,0.69)   both correct
 *   0.228     0.289  (0.49,0.70)  0.157  (0.48,0.71)   quantized half strength
 *   0.095     0.287  (0.50,0.70)  0.037  (0.32,0.80)   quantized 8x down, WRONG PLACE
 *   0.046     0.272  (0.51,0.70)  0.007  (0.45,0.10)   quantized 41x down, WRONG PLACE
 *
 * The accurate build is FLAT across the whole range — every centroid within a texel of
 * every other. The quantized one falls off a cliff below about 0.2 and what survives is
 * no longer on the subject. A webcam frame arrives here in the LINEAR working space, so
 * its mean is roughly a stop and a half below its display-referred value: measured live
 * in the app, the matte's own input buffer read mean 0.049 and 0.103 — both in the
 * collapse zone. That is the whole of "we see something in the matte, but it is not
 * correct", and it is why this build's copy names the trade instead of implying speed.
 *
 * It is not faster, either: 928 ms against the accurate build's 818 ms on the same input
 * under wasm. What it buys is 19 MB of download and nothing else.
 */
export const MATTE_FAST: ModelDescriptor = {
  id: "modnet-photographic-quantized",
  label: "MODNet quantized (6.6 MB)",
  url: matteWeights("model_quantized.onnx"),
  bytes: 6_632_188,
  license: "Apache-2.0",
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1040 — Robust Video Matting, and it is a CHARACTER choice, not a speed one
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: "Make it so that we can choose it as a model, right?" — a third option
 * beside the two MODNet builds, never a replacement for them (§V831: an added option is
 * safe, a removed one silently rewrites documents standing on it).
 *
 * ⚠ IT IS NOT THE FAST ONE, AND THE MEASUREMENT IS EMPHATIC. MODNet's `session.run` at
 * 512² on the WebGPU provider is 30 ms (§T1044). RVM cannot use that provider at all
 * (see `cannotRun` below), so its floor is the CPU: measured 2026-09-03, wasm, one
 * thread, this artefact, the app's own 512² letterbox, median of five warm runs with the
 * recurrent state fed back —
 *
 *   downsample_ratio   internal   ms     state/frame
 *   0.25               128 px      61    0.38 MB     speckle below the subject
 *   0.375              192 px     100    0.86 MB     clean
 *   0.5                256 px     172    1.53 MB     clean  ← the node's default
 *   0.75               384 px     409    3.45 MB     clean
 *   1.0                512 px     724    6.13 MB     clean
 *
 * So against MODNet-on-WebGPU it is 6x to 24x SLOWER. What it buys instead:
 *
 *  - TEMPORAL COHERENCE THAT IS LEARNED, carried in four recurrent tensors rather than
 *    bolted on as an average over frames. Measured on a subject moving ~6 source px per
 *    frame, mean |Δα| between consecutive published mattes: 0.0151 with the state fed
 *    back against 0.0264 with it zeroed — the recurrence is doing 1.75x of real work, and
 *    `matte-rvm.test.ts` is what stops that wiring being dropped silently.
 *  - FIRST-PARTY WEIGHTS with a recorded hash. The MODNet above is a community conversion
 *    with no hash on record; this is the author's own v1.0.0 release asset and its bytes
 *    are checked on arrival.
 *  - 40% SMALLER than the MODNet it sits beside.
 *
 * Licence GPL-3.0, and §V858 rules it not a bar: the weights are fetched by the user's
 * browser at run time and never redistributed by us, and the GPL restricts distribution
 * rather than use.
 */
export const MATTE_RVM: ModelDescriptor = {
  id: "rvm-mobilenetv3",
  label: "Robust Video Matting",
  /* The AUTHOR's own release asset at a tagged version — the closest thing to a revision
     pin a GitHub release offers, and the hash below is what actually checks it. */
  url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx",
  bytes: 14_975_696,
  /* Read off the downloaded file 2026-09-03, twice, on two different days' downloads. */
  sha256: "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828",
  license: "GPL-3.0",
  /*
   * ⚠ MEASURED 2026-09-03, Chromium on the Metal adapter, onnxruntime-web 1.29.0: the
   * session CREATES on WebGPU in 533 ms and reports its outputs, and then the first
   * `run` throws. The refusal is quoted rather than paraphrased because it names a
   * missing KERNEL, which is a version fact that could stop being true:
   *
   *   "ceil_mode output-shape is computed, but ceil_mode kernel execution
   *    (padding/divisor) is not yet implemented in the WebGPU AveragePool kernel"
   *
   * MobileNetV3's average pools carry `ceil_mode`, so this is structural to the backbone
   * rather than an artefact of one input size — reproduced at ratio 1.0 and 0.5. The same
   * weights on the same page run on `wasm` (create 56 ms, run 313 ms threaded). That
   * split is exactly why this is declared: create-succeeds/run-fails is invisible to a
   * ladder that walks providers by creating sessions.
   */
  cannotRun: [
    {
      provider: "webgpu",
      reason:
        "onnxruntime-web 1.29.0 has no ceil_mode AveragePool kernel for WebGPU, which " +
        "MobileNetV3 needs — the session starts and then every run throws.",
    },
  ],
};

export const MATTE_MODELS: readonly ModelDescriptor[] = [MATTE_ACCURATE, MATTE_FAST, MATTE_RVM];

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
