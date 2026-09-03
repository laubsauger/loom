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
 * ⚠ IT WAS NOT THE FAST ONE, AND SINCE T1084 THAT IS NO LONGER WHY. This block used to
 * say RVM could not reach the WebGPU provider at all, and carried a `cannotRun` row
 * blaming a kernel MobileNetV3 needs. Both halves were wrong: the backbone's pooling is
 * 9x `GlobalAveragePool` and carries no `ceil_mode`, and the three nodes that do carry it
 * are the recurrent decoder's source pyramid. `model-patch.ts` clears them in memory
 * after the download's hash is checked, and RVM runs on WebGPU — 16 ms at the default
 * ratio, against 126 ms on one wasm thread.
 *
 * The CPU table below is kept because it is still the floor a machine without WebGPU
 * pays, and because it was measured on a different machine and day than the T1084
 * numbers; two honest measurements are data, and reconciling them by overwriting one
 * would destroy the comparison. Measured 2026-09-03, wasm, one thread, this artefact,
 * the app's own 512² letterbox, median of five warm runs with the recurrent state fed
 * back —
 *
 *   downsample_ratio   internal   ms     state/frame
 *   0.25               128 px      61    0.38 MB     speckle below the subject
 *   0.375              192 px     100    0.86 MB     clean
 *   0.5                256 px     172    1.53 MB     clean  ← the node's default
 *   0.75               384 px     409    3.45 MB     clean
 *   1.0                512 px     724    6.13 MB     clean
 *
 * On WebGPU, patched, the same five ratios measured 12 / 12 / 16 / 24 / 36 ms — so
 * against MODNet's 30 ms on the same provider it is now roughly a WASH, and the choice
 * between them is back to being the character choice this block calls it. What RVM buys:
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
   * ⚠ THE DOWNLOAD IS THE AUTHOR'S ASSET AND STAYS THAT WAY — the three-byte edit that
   * puts this model on the GPU happens IN MEMORY, on the way into the runtime, and is
   * `model-patch.ts`'s job (T1084). Read that file for the equivalence proof; the short
   * version is that onnxruntime-web's WebGPU AveragePool refuses the `ceil_mode`
   * attribute before it looks at any shape, RVM carries it on three decoder pooling
   * nodes, and on every extent this app can ask for the attribute provably changes
   * nothing — so clearing it yields a graph measured BIT-IDENTICAL to this one.
   *
   * `bytes` and `sha256` therefore keep describing what this URL serves, unmodified, and
   * the cache keeps storing exactly that. There is no `cannotRun` row any more: it said
   * "webgpu", it was true of these bytes and false of the bytes that run, and a
   * declaration that outlives its subject is worse than none. The contingent half — what
   * happens if the patch ever fails to apply — lives in `WeightPatch.requiredFor`, which
   * takes WebGPU off the ladder at load time with the reason attached, because that is a
   * fact about a step that can fail on a user's machine rather than about an artefact.
   */
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1088 — MediaPipe SelfieSegmenter, and it is a SECOND RUNTIME, not a fourth ONNX file
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's complaint was that MATTE_FAST measures 400 ms on WebGPU against 311 ms on
 * threaded wasm, and that his own `muse-eeg-web` mattes far quicker without Electron.
 * Measured on this machine (M3 Max, Chrome, the app's own COOP+COEP regime, 120 timed
 * iterations after 20 warm), this artefact answers that directly:
 *
 *   fed    inference only   inference + mask read   DELIVERED to a WebGPU texture
 *   256²   3.73 ms          5.01 ms                 5.46 ms
 *   512²   3.71 ms          5.35 ms                 6.05 ms
 *   720²   3.60 ms          5.65 ms                 6.84 ms
 *
 * The middle column is the region the ONNX numbers time (`session.run` plus downloading
 * the output), so it is the one that compares: against MODNet's 30 ms and RVM's 20 ms on
 * WebGPU and MATTE_FAST's 400 ms, this is ~6x, ~4x and ~75x. The right-hand column is the
 * one that DECIDES, because MediaPipe's GPU delegate is WebGL and this app is WebGPU:
 * crossing costs 1.3-2.4 ms and the total still lands under 7 ms. The win survives the
 * crossing, which was the open question and is why this row exists.
 *
 * ⚠ INFERENCE IS FLAT IN THE INPUT SIZE — 3.7 ms at every side above. The model works at
 * 256² internally and UPSAMPLES its mask to whatever it was fed, so feeding it a bigger
 * square buys no detail and costs only delivery. That is why this row is absent from the
 * input-size table (`inferenceAcceptsInputSize` reads ONNX signatures and finds none) and
 * always runs at the node's default square.
 *
 * ⚠ IT IS NOT BETTER THAN MODNet, AND THE NAIVE READING OF WHY IS BACKWARDS. The
 * expectation was "MediaPipe coarse, MODNet a soft alpha matte with hair detail".
 * Measured on one frame, both at 512²: MODNet leaves 1.08% of pixels strictly between 0.1
 * and 0.9, this leaves 2.23% — MODNet is the HARDER of the two here, not the softer.
 * Their IoU above half is 0.90. What MODNet genuinely buys is fine detail: it resolves
 * hair strands this does not. What this buys is REJECTION: on the test frame MODNet
 * segments a painting of a figure as a person and this correctly ignores it. Neither is
 * strictly better, so this is an added option and the default is untouched (§V831).
 *
 * LICENCE — Apache-2.0, verified from Google's own model card rather than assumed
 * ("LICENSED UNDER: Apache License, Version 2.0"; Hou, Pisarchyk, Raveendran, 2021-05-06).
 * That is a materially different footing from MATTE_RVM's GPL-3.0: Apache-2.0 permits
 * REDISTRIBUTION, so shipping these bytes would be legitimate where shipping RVM's is
 * not. We still fetch at run time — not because we must, but so this row inherits the one
 * consent, progress, failure and cache surface every other artefact uses, and so the repo
 * carries no weights. The retained notice for what we do ship — the Apache-2.0 runtime in
 * `node_modules/@mediapipe/tasks-vision` — is that package's own header, and this comment
 * is the attribution for the model.
 *
 * ⚠ THE URL IS MUTABLE AND THE HASH IS WHAT PINS IT. Every other row here is
 * revision-pinned; Google publishes this under `/latest/`, and there is no tagged
 * alternative. So the pin is the SHA-256 below, read off the downloaded file, and a
 * republish upstream fails the acquisition loudly rather than silently changing the bytes
 * under a document. That is a supply-chain property and holds regardless of the licence.
 */
export const MATTE_MEDIAPIPE: ModelDescriptor = {
  id: "mediapipe-selfie-segmenter",
  label: "MediaPipe SelfieSegmenter",
  url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
  bytes: 249_537,
  /* Read off the downloaded file 2026-09-03; identical to the copy in the owner's
     `muse-eeg-web`, which is where this artefact was first identified. */
  sha256: "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b",
  license: "Apache-2.0",
  /* No `cannotRun` row, and its absence is not an oversight: that field names ONNX
     execution providers, and this artefact never reaches one. It is a TFLite file run by
     MediaPipe's own wasm with its own GPU delegate, which is exactly why it needs the
     second runner rather than a fourth entry in the worker's ladder. */
};

export const MATTE_MODELS: readonly ModelDescriptor[] = [
  MATTE_ACCURATE,
  MATTE_FAST,
  MATTE_RVM,
  MATTE_MEDIAPIPE,
];

/**
 * WHICH RUNTIME a matte model needs — the ONE place that partition is decided (T1088).
 *
 * `matteDescriptorFor` above exists because the same `=== MATTE_FAST.id` ternary was
 * written twice and silently resolved a stored RVM id to MODNet. This is the same hazard
 * one level up and it bites harder: the ORT hook tracks every matte node and this one
 * tracks its own, so a partition that is not exactly complementary makes a node run
 * TWICE (two runners racing to fill one media source) or NEVER (a node that compiles,
 * allocates and publishes its fallback forever). Both callers read this function, and
 * `mediapipe-matte.test.ts` asserts the two sides are disjoint and cover `MATTE_MODELS`.
 */
export function isMediaPipeMatte(modelId: string): boolean {
  return modelId === MATTE_MEDIAPIPE.id;
}

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
