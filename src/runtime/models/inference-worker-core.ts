import { depthPro2FocalPixels, depthPro2ToInverse, depthToRgba, DEPTH_PRO2_BOXES, packDepthPro2Input, packModelInput, type DepthPro2Box } from "./depth-runner.ts";
import { POSE_INPUT_SIDE, keypointsToTexture, packPoseInput } from "./pose-runner.ts";
import { matteToFloats, packMatteInput, smoothMatte } from "./matte-runner.ts";
import { describeRuntimeLoadFailure } from "./runtime-load-failure.ts";
import { applyWeightPatch } from "./model-patch.ts";
import type { InferenceNodeType, InferenceRequest, InferenceResponse } from "./inference-protocol.ts";

/**
 * Everything the inference worker does, with no `self` and no `Worker` (T382).
 *
 * The worker FILE is a four-line shim over this. That split is not tidiness: a module that
 * can only be reached by starting a thread cannot be unit-tested, and §V220's dominant bug
 * here is "built, tested, never wired" — the variant where the thing is wired and never
 * tested is the same defect wearing the other face. The session factory is injected, so
 * the whole protocol is exercisable with a fake model in microseconds.
 */

/** What a loaded model can do. Injected so a test needs no onnxruntime and no weights. */
export interface InferenceSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /**
   * T1816b — what the artefact itself declares for each input. Read ONLY to shape a
   * recurrent model's first-frame zeros when its graph is static (§V742: the file is the
   * contract, so the zeros are shaped by the file rather than by a typed table).
   */
  readonly inputMetadata?: ReadonlyArray<{ readonly name: string; readonly type?: string; readonly shape?: readonly unknown[] }>;
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims?: readonly number[] }>>;
}

export interface WorkerCoreOptions {
  /**
   * Builds a session from weights on ONE named execution provider. The real one is
   * `ort.InferenceSession.create(weights, { executionProviders: [provider] })`.
   *
   * ONE, not a list, and that is the whole point (§T715, §V672, §T965). Handing ORT the
   * ladder `["webgpu", "wasm"]` lets it fall back internally and return a session that
   * cannot say which half of the ladder built it — so a backend readout would be echoing
   * the REQUEST. Walking the ladder out here means the provider that returned is the
   * provider that ran, measured rather than assumed.
   */
  createSession(
    weights: ArrayBuffer,
    provider: string,
    /**
     * T1816b — outputs to leave ON THE DEVICE (`preferredOutputLocation: "gpu-buffer"`),
     * asked only of the WebGPU provider. Depth Pro 2's stream cache is ~30 MB a frame; a
     * round trip through the CPU every run would cost more than the model.
     */
    placement?: { readonly gpuOutputs: readonly string[] },
  ): Promise<InferenceSessionLike>;
  /** Builds the runtime's tensor. The real one is `new ort.Tensor(type, data, dims)`. */
  createTensor(type: string, data: Float32Array | Uint8Array | Uint16Array, dims: readonly number[]): unknown;
  post(response: InferenceResponse, transfer?: Transferable[]): void;
  /**
   * T1041 — the thread's own `crossOriginIsolated`, passed by the shim because only the
   * real worker environment can measure it. Carried on every result so the regime a
   * number was measured in travels with the number.
   */
  isolated: boolean;
  /**
   * Wall clock for the DURATIONS this reports. Injected so a test can assert an exact
   * number, and named `now` rather than read directly so §V44's rule stays legible: this
   * clock never reaches a shader, a frame or a document — it only labels telemetry.
   */
  now?: () => number;
}

/** A loaded session plus the provider that actually built it. */
interface LoadedSession {
  readonly session: InferenceSessionLike;
  readonly backend: string;
  readonly millis: number;
}

interface Packing {
  readonly tensorType: string;
  pack(texels: Float32Array, side: number): Float32Array | Uint8Array;
  dims(side: number): readonly number[];
  /** Fresh, exclusively owned ArrayBuffer; the returned view covers the entire buffer.
   * Never aliases a model tensor or retained temporal state: it transfers to the caller. */
  encode(
    output: Float32Array,
    width: number,
    height: number,
    side: number,
    /** T992: the PICTURE's dims — pose un-letterboxes its joints against these. */
    sourceWidth: number,
    sourceHeight: number,
  ): Uint8Array;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §V861 — WHAT A MODEL NEEDS BEYOND ONE-IN-ONE-OUT, DECLARED
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * Every model up to RVM took one tensor and returned one, so the worker read
 * `inputNames[0]` and `outputNames[0]` and the table only had to carry a packer. RVM
 * takes six and returns six, and reading index 0 of its outputs is the single worst
 * thing this file could do:
 *
 *   RVM outputs: [ fgr, pha, r1o, r2o, r3o, r4o ]
 *                   ↑ index 0 is the three-channel COLOUR foreground
 *                        ↑ index 1 is the alpha the matte node wants
 *
 * `matteToFloats` reads `matte[sy * side + sx]` over a `side × side` window. Handed
 * `fgr` it finds a real float at every one of those offsets — the red channel of the
 * foreground — and resamples it into a correctly-shaped, finite, plausible-looking
 * picture. No crash, no NaN, no dimension error. MEASURED on the real weights: `pha`
 * puts 72% of its pixels below 0.01 and 6% in the soft band, `fgr`'s red channel puts
 * 6% below 0.01 and 87% in the soft band, and the two agree within 0.05 on 9% of pixels.
 * It would have been a wrong matte that looked like a matte, silently, forever.
 *
 * So the PICTURE IS SELECTED BY NAME, from here, and the name is not optional — every
 * row states it even where it happens to be index 0, because a fallback to index 0 is
 * the bug wearing a seatbelt. `model-signatures.test.ts` checks each name against the
 * artefact's own declared outputs.
 */
export interface ModelPlan extends Packing {
  /** The output the node PUBLISHES, by name (§V861). Never an index. */
  readonly picture: string;
  /** Model-specific output decoding before encoding and native preparation capture.
   * A decoder owns its result and never mutates the runtime's model tensor. */
  readonly decodeOutput?: (output: Float32Array) => Float32Array;
  /**
   * The recurrent loop: OUTPUT name → the INPUT name it becomes on the next run.
   *
   * RVM's temporal coherence lives in these four tensors and nowhere else; drop them and
   * the model still returns a plausible matte, just a per-frame one. MEASURED on a
   * subject moving ~6 source px/frame: mean |Δα| between consecutive mattes is 0.0151
   * fed back against 0.0264 zeroed, so the wiring is worth 1.75x of stability and its
   * absence is invisible to anything that only checks a frame.
   */
  readonly feedback?: Readonly<Record<string, string>>;
  /** The `f32[1]` scalar input the node's ratio parameter drives, if the model has one. */
  readonly ratioInput?: string;
  /**
   * T1816b — the `f32[1]` focal-length input (pixels of the model box), computed here from
   * the node's horizontal Field of View and the picture's letterbox. Depth Pro 2's `f_px`.
   * `pixels` belongs to the plan because the box does: the same field of view is a
   * different focal length in a 640-wide box than in a 672-wide one.
   */
  readonly focal?: {
    readonly input: string;
    pixels(fieldOfViewDegrees: number, sourceWidth: number, sourceHeight: number): number;
  };
  /**
   * T1816b — how a recurrent model's FIRST frame is fed. Absent: RVM's documented
   * `[1,1,1,1]` zeros. `declared`: zeros in the exact type and shape the session declares
   * for each fed-back input, for a static graph that refuses anything else.
   */
  readonly zeroState?: "declared";
  /** T1816b — keep the fed-back outputs on the GPU when the WebGPU provider runs. */
  readonly gpuFeedback?: boolean;
  /**
   * The temporal EMA's DEFAULT blend for this model — the node may override it, and 1
   * means none. Per model because the right answer is a property of the architecture:
   * MODNet is per-frame and flickers, RVM already carries the past in `feedback` above.
   */
  readonly smoothing: number;
}

const DEPTH_PACKING: Packing = {
  tensorType: "float32",
  pack: (texels, side) => packModelInput(texels, side),
  dims: (side) => [1, 3, side, side],
  encode: (output, width, height, side) => depthToRgba(output, side, width, height),
};

const POSE_PACKING: Packing = {
  // uint8 x4 NHWC, read from the weights rather than the model card (§B148/§V743).
  tensorType: "uint8",
  pack: (texels, side) => packPoseInput(texels, side),
  dims: (side) => [1, side, side, 4],
  /* T992: the joints come back in LETTERBOXED model uv; the encoder maps them onto
     the picture, which is why it needs the source dims and the output dims cannot
     stand in (they are the fixed 17×1 keypoint map). */
  encode: (output, _width, _height, _side, sourceWidth, sourceHeight) =>
    keypointsToTexture(output, sourceWidth, sourceHeight),
};

const MODNET_PACKING: Packing = {
  // float32 NCHW, (x-0.5)/0.5 — MODNet's own reference inference, not the card (§B148).
  tensorType: "float32",
  pack: (texels, side) => packMatteInput(texels, side),
  dims: (side) => [1, 3, side, side],
  encode: (output, width, height, side) => matteToFloats(output, side, width, height),
};

/**
 * T1816b — Depth Pro 2: raw sRGB [0,1] in its static box (640×480 or 672×384), `f_px`
 * beside it, metres out. `side` is ignored: the box is the artefact's shape, so it is
 * read from the plan the model id selects, never from the request.
 */
function depthPro2Plan(box: DepthPro2Box): ModelPlan {
  return {
    tensorType: "float32",
    pack: (texels) => packDepthPro2Input(texels, box),
    dims: () => [1, 3, box.height, box.width],
    encode: (output, width, height) => depthPro2ToInverse(output, width, height, box),
    picture: "depth_meters",
    focal: { input: "f_px", pixels: (fov, sourceWidth, sourceHeight) => depthPro2FocalPixels(fov, sourceWidth, sourceHeight, box) },
    smoothing: 1,
  };
}

/** The stream graph's cache, by name: every `present_<x>` is next run's `past_<x>`. */
const DEPTH_PRO2_STREAM_CACHE = ["filled", ...[5, 7, 9, 11].flatMap((layer) =>
  [`keys_${layer}`, `values_${layer}`, `prefixes_${layer}`])];

/* One frame per call attending to the three before it, the cache carried as tensors.
   No EMA (1): like RVM, the past is already in the state. The FP16 and FP32 builds share
   every name; their caches differ only in type, which `declared` zeros read from the file. */
function depthPro2StreamPlan(box: DepthPro2Box): ModelPlan {
  return {
    ...depthPro2Plan(box),
    feedback: Object.fromEntries(DEPTH_PRO2_STREAM_CACHE.map((name) => [`present_${name}`, `past_${name}`])),
    zeroState: "declared",
    gpuFeedback: true,
  };
}

const [DP2_43, DP2_169] = [DEPTH_PRO2_BOXES["640x480"], DEPTH_PRO2_BOXES["672x384"]];

/**
 * The per-MODEL differences, and only these — keyed by model id since T1040, because two
 * artefacts behind one node type no longer share an IO shape. Adding a fourth model must
 * still be a row rather than a branch.
 */
export const MODEL_PLANS: Readonly<Record<string, ModelPlan>> = {
  "topformer-ade20k": {
    // ADE20K semantic building envelope for photograph preparation. The artifact
    // takes fixed ImageNet-normalized RGB and returns 150 native logit planes.
    ...DEPTH_PACKING,
    dims: (side) => {
      if (side !== 512) throw new Error(`TopFormer requires a 512-square input; received ${side}.`);
      return [1, 3, 512, 512];
    },
    picture: "output",
    smoothing: 1,
    decodeOutput: (output) => {
      const classes = 150;
      if (output.length === 0 || output.length % classes !== 0) {
        throw new Error("TopFormer requires 150 non-empty ADE20K logit planes.");
      }
      const pixels = output.length / classes;
      const probabilities = new Float32Array(pixels);
      // Zero-based ADE20K labels: wall, building, house, column and clock.
      // Sky, window and door have separate classes and contribute no confidence.
      const envelope = new Set([0, 1, 25, 42, 148]);
      for (let i = 0; i < pixels; i += 1) {
        let maximum = Number.NEGATIVE_INFINITY;
        for (let c = 0; c < classes; c += 1) {
          const sample = c * pixels + i;
          const logit = output[sample]!;
          if (!Number.isFinite(logit)) throw new Error(`TopFormer returned a non-finite logit at sample ${sample}.`);
          maximum = Math.max(maximum, logit);
        }
        let total = 0;
        let building = 0;
        for (let c = 0; c < classes; c += 1) {
          const probability = Math.exp(output[c * pixels + i]! - maximum);
          total += probability;
          if (envelope.has(c)) building += probability;
        }
        probabilities[i] = building / total;
      }
      return probabilities;
    },
    // Keep native output resolution and independent transferable float32 storage.
    encode: (output) => new Uint8Array(Float32Array.from(output).buffer),
  },
  "birefnet-lite-dynamic": {
    // The pinned reference uses ImageNet-normalized RGB and dynamic spatial dimensions.
    ...DEPTH_PACKING,
    picture: "output_image",
    smoothing: 1,
    decodeOutput: (output) => {
      // The ONNX picture is logits. Decode exactly once for BOTH published pixels and
      // native preparation; applying sigmoid only in encode would persist wrong masks.
      const probabilities = new Float32Array(output.length);
      for (let i = 0; i < output.length; i += 1) {
        const logit = output[i]!;
        if (!Number.isFinite(logit)) throw new Error(`BiRefNet returned a non-finite logit at sample ${i}.`);
        probabilities[i] = 1 / (1 + Math.exp(-logit));
      }
      return probabilities;
    },
    encode: (output) => new Uint8Array(Float32Array.from(output).buffer),
  },
  "ormbg-quantized": {
    // The pinned processor rescales RGB to [0,1], without ImageNet normalization.
    tensorType: "float32",
    pack: (texels, side) => {
      const pixels = side * side;
      const packed = new Float32Array(3 * pixels);
      for (let i = 0; i < pixels; i += 1) {
        for (let c = 0; c < 3; c += 1) packed[c * pixels + i] = texels[4 * i + c]!;
      }
      return packed;
    },
    dims: () => [1, 3, 1024, 1024],
    picture: "alphas",
    smoothing: 1,
    encode: (output) => new Uint8Array(Float32Array.from(output).buffer),
  },
  "depth-anything-v2-small": { ...DEPTH_PACKING, picture: "predicted_depth", smoothing: 1 },
  "depth-anything-v2-small-q4f16": { ...DEPTH_PACKING, picture: "predicted_depth", smoothing: 1 },
  "depth-anything-v2-large-q4f16": { ...DEPTH_PACKING, picture: "predicted_depth", smoothing: 1 },
  "depth-anything-v2-large-fp16": { ...DEPTH_PACKING, picture: "predicted_depth", smoothing: 1 },
  "movenet-lightning": { ...POSE_PACKING, picture: "keypoints", smoothing: 1 },
  "movenet-lightning-int8": { ...POSE_PACKING, picture: "keypoints", smoothing: 1 },
  /* §T957's measured default: MODNet is per-frame, its edges flicker, and 0.55 is what
     shipped. Stated on the node's Smoothing parameter with what it costs. */
  "modnet-photographic": { ...MODNET_PACKING, picture: "output", smoothing: 0.55 },
  "modnet-photographic-quantized": { ...MODNET_PACKING, picture: "output", smoothing: 0.55 },
  "rvm-mobilenetv3": {
    /*
     * RAW [0,1], not MODNet's (x−0.5)/0.5 — RVM's reference inference (`inference.py`)
     * is `transforms.ToTensor()` and nothing else, and §B148's rule is that the reference
     * code is the contract. Measured on the same portrait through the same letterbox, the
     * two normalisations do not merely differ in tone: coverage 0.2425 raw against 0.2120
     * signed, so feeding it MODNet's packing loses a fifth of the subject.
     */
    tensorType: "float32",
    pack: (texels, side) => {
      const pixels = side * side;
      const out = new Float32Array(3 * pixels);
      for (let i = 0; i < pixels; i += 1) {
        const base = i * 4;
        for (let c = 0; c < 3; c += 1) out[c * pixels + i] = texels[base + c] ?? 0;
      }
      return out;
    },
    dims: (side) => [1, 3, side, side],
    // The alpha comes back in the same letterboxed square MODNet's does, so the matte
    // encoder is shared unchanged — the difference between these models is which tensor
    // it is handed, which is exactly the point.
    encode: (output, width, height, side) => matteToFloats(output, side, width, height),
    picture: "pha",
    feedback: { r1o: "r1i", r2o: "r2i", r3o: "r3i", r4o: "r4i" },
    ratioInput: "downsample_ratio",
    /* 1 = NO EMA, and it is a stated consequence rather than an omission (§T1040).
       Averaging frames on top of a recurrent network counts the past twice, and the
       recurrence already delivers most of what the EMA was bought for (0.0151 against
       0.0264 zeroed, measured). It is not free: MODNet+EMA measured steadier still, at
       0.0117, so this is a real trade and the Smoothing knob is where a user takes the
       other side of it. */
    smoothing: 1,
  },
  "depthpro2-s-fp32": depthPro2Plan(DP2_43),
  "depthpro2-b-fp16": depthPro2Plan(DP2_43),
  "depthpro2-s-fp32-672x384": depthPro2Plan(DP2_169),
  "depthpro2-b-fp16-672x384": depthPro2Plan(DP2_169),
  "depthpro2-s-stream4-fp16": depthPro2StreamPlan(DP2_43),
  "depthpro2-s-stream4-fp32": depthPro2StreamPlan(DP2_43),
  "depthpro2-s-stream4-fp16-672x384": depthPro2StreamPlan(DP2_169),
  "depthpro2-s-stream4-fp32-672x384": depthPro2StreamPlan(DP2_169),
};

/** T1816b — release a device-resident tensor the loop no longer holds; a CPU one is left to GC. */
function releaseIfOnDevice(tensor: unknown): void {
  const held = tensor as { location?: string; dispose?: () => void } | null;
  if (held !== null && typeof held === "object" && held.location === "gpu-buffer" && typeof held.dispose === "function") held.dispose();
}

/** T1816b — zeros in the exact type and static shape the artefact declares for `name`. */
function declaredZeros(
  session: InferenceSessionLike,
  name: string,
  createTensor: WorkerCoreOptions["createTensor"],
): unknown {
  const declared = session.inputMetadata?.find((entry) => entry.name === name);
  const dims = declared?.shape?.map(Number);
  if (dims === undefined || dims.some((axis) => !Number.isInteger(axis) || axis < 1)) {
    throw new Error(`the model declares no static shape for its recurrent input "${name}"`);
  }
  const count = dims.reduce((product, axis) => product * axis, 1);
  if (declared!.type === "float16") return createTensor("float16", new Uint16Array(count), dims);
  if (declared!.type === "float32") return createTensor("float32", new Float32Array(count), dims);
  throw new Error(`the recurrent input "${name}" is ${declared!.type ?? "untyped"}, which has no zero state here`);
}

/** The plan for a run. Unknown ids fail LOUDLY — the alternative is guessing by index. */
function planFor(modelId: string, nodeType: InferenceNodeType): ModelPlan {
  const plan = MODEL_PLANS[modelId];
  if (plan === undefined) {
    throw new Error(
      `no inference plan for model "${modelId}" (${nodeType}) — a model must declare ` +
        `its picture output by name before it can run`,
    );
  }
  return plan;
}

export function createWorkerCore(options: WorkerCoreOptions) {
  const sessions = new Map<string, Promise<LoadedSession>>();
  // Node-owned containers are also lifetime tokens. Deletion removes the container;
  // an already running inference may hold it, but cannot publish it into a new node.
  const streams = new Map<string, {
    previousMatte: Map<string, Float32Array>;
    recurrent: Map<string, { ratio: number; side: number; tensors: Record<string, unknown> }>;
  }>();
  /*
   * T1040/T1319 — recurrent state per node/session, never shared with another node.
   *
   * The tensors are the RUNTIME's own, held opaquely and handed straight back: on a GPU
   * execution provider they may never be CPU-resident at all, and touching `.data` would
   * force a download this loop exists to avoid. Both input side and downsample ratio
   * decide their shape. Node deletion retires history without unloading shared weights.
   */
  const now = options.now ?? (() => (typeof performance === "undefined" ? 0 : performance.now()));

  /**
   * Walk the requested ladder, one provider at a time, and report the one that answered.
   *
   * Every refusal is KEPT and, if the whole ladder fails, they are reported together with
   * the provider that produced each — a bare "no available backend found" is exactly the
   * message §B171 spent an afternoon on. `describeRuntimeLoadFailure` gets first refusal
   * on each reason so an asset-path failure is named as one rather than as a missing GPU.
   */
  const loadSession = async (
    modelId: string,
    weights: ArrayBuffer,
    providers: readonly string[],
  ): Promise<LoadedSession> => {
    let ladder = providers.length > 0 ? providers : ["wasm"];
    const refusals: string[] = [];

    /*
     * T1084 — the in-memory weight patch, applied HERE because this is the one place that
     * holds both the bytes and the ladder.
     *
     * A refusal is not a warning: the un-patched bytes are what run, and the providers the
     * patch was required for come OFF the ladder. That ordering matters. RVM's WebGPU
     * session CREATES and then throws on every run, so a rung left in place would be
     * walked successfully, reported as the backend, and never produce a frame — §V672's
     * echo bug arriving through the one door that was supposed to be measurement-proof.
     * Dropping the rung with the reason attached is what keeps the readout honest.
     */
    const outcome = await applyWeightPatch(modelId, weights);
    let bytes = weights;
    if (outcome.kind === "patched") {
      bytes = outcome.bytes;
    } else if (outcome.kind === "refused") {
      const dropped = ladder.filter((provider) => outcome.providers.includes(provider));
      ladder = ladder.filter((provider) => !outcome.providers.includes(provider));
      for (const provider of dropped) refusals.push(`[${provider}] ${outcome.reason}`);
    }

    /* T1816b: only a plan that asks, and only of the provider that has a device. */
    const plan = MODEL_PLANS[modelId];
    const gpuOutputs = plan?.gpuFeedback === true && plan.feedback !== undefined ? Object.keys(plan.feedback) : [];
    for (const provider of ladder) {
      const started = now();
      try {
        const session = provider === "webgpu" && gpuOutputs.length > 0
          ? await options.createSession(bytes, provider, { gpuOutputs })
          : await options.createSession(bytes, provider);
        return { session, backend: provider, millis: now() - started };
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        refusals.push(`[${provider}] ${describeRuntimeLoadFailure(raw) ?? raw}`);
      }
    }
    throw new Error(
      `no execution provider could load this model. ${refusals.join(" ")}`.trim(),
    );
  };

  return {
    async handle(request: InferenceRequest): Promise<void> {
      try {
        if (request.kind === "forget") {
          for (const nodeId of request.nodeIds) {
            const stream = streams.get(nodeId);
            stream?.previousMatte.clear();
            for (const held of stream?.recurrent.values() ?? []) Object.values(held.tensors).forEach(releaseIfOnDevice);
            stream?.recurrent.clear();
            streams.delete(nodeId);
          }
          return;
        }
        if (request.kind === "load") {
          const { sessionKey } = request;
          let held = sessions.get(sessionKey);
          if (held === undefined) {
            held = loadSession(request.modelId, request.weights, request.providers);
            sessions.set(sessionKey, held);
            // A FAILED load must not be remembered as done. It used to be: the rejected
            // promise stayed in the map, so every later attempt replayed the same stale
            // rejection and no retry could ever succeed — the worker-side twin of the
            // guard `worker-runner.ts` already keeps on its own half.
            void held.catch(() => sessions.delete(sessionKey));
          }
          const loaded = await held;
          options.post({
            kind: "loaded",
            sessionKey,
            backend: loaded.backend,
            millis: loaded.millis,
            isolated: options.isolated,
          });
          return;
        }

        const pending = sessions.get(request.sessionKey);
        if (pending === undefined) {
          // Running before loading is a caller error, and it must come back ATTACHED to
          // the request rather than as a bare worker crash.
          options.post({
            kind: "error",
            requestId: request.requestId,
            message: `no session for "${request.sessionKey}" — send a load before a run`,
          });
          return;
        }

        let stream = streams.get(request.nodeId);
        if (stream === undefined) {
          stream = { previousMatte: new Map(), recurrent: new Map() };
          streams.set(request.nodeId, stream);
        }
        const { session, backend } = await pending;
        if (streams.get(request.nodeId) !== stream) throw new Error("inference node was retired");
        const { previousMatte, recurrent } = stream;
        const temporalKey = request.sessionKey;
        const plan = planFor(request.modelId, request.nodeType);
        const side = request.side === 0 ? POSE_INPUT_SIDE : request.side;
        const packed = plan.pack(new Float32Array(request.texels), side);
        const inputName = session.inputNames[0];
        if (inputName === undefined) throw new Error("the session declares no input");

        /*
         * The RECURRENT FEED. Three things have to be true for this to be correct rather
         * than merely present:
         *
         *  1. The state stays in the WORKER. It never crosses the message boundary — the
         *     protocol carries texels in and bytes out, and a 6.13 MB structured clone
         *     twice a frame would cost more than the model. It lives here, beside the
         *     shared session, but keyed by node AND session so unrelated images never
         *     inherit one another's history.
         *  2. THE FIRST FRAME FEEDS ZEROS, shaped [1,1,1,1]. That is RVM's own documented
         *     "no memory yet" and it is not a placeholder for something better: measured,
         *     it runs clean and returns correctly-shaped state at the same cost as a warm
         *     frame.
         *  3. A RATIO OR INPUT-SIZE CHANGE INVALIDATES THE STASH. `downsample_ratio` sets the internal
         *     resolution, so the state tensors change shape with it (0.38 MB at 0.25,
         *     6.13 MB at 1.0). Feeding last frame's state after the dial moved hands the
         *     model tensors it will refuse — an error at the worst moment, on a control
         *     the user just touched. So the ratio is stashed with the state and a
         *     mismatch starts the sequence over, which costs one frame of coherence and
         *     is invisible.
         */
        const feeds: Record<string, unknown> = {
          [inputName]: options.createTensor(plan.tensorType, packed, plan.dims(side)),
        };
        if (plan.feedback !== undefined) {
          const held = recurrent.get(temporalKey);
          const usable = held !== undefined && held.ratio === request.ratio && held.side === side;
          for (const inputSlot of Object.values(plan.feedback)) {
            feeds[inputSlot] = usable
              ? held!.tensors[inputSlot]
              : plan.zeroState === "declared"
                ? declaredZeros(session, inputSlot, options.createTensor)
                : options.createTensor("float32", new Float32Array(1), [1, 1, 1, 1]);
          }
        }
        if (plan.focal !== undefined) {
          feeds[plan.focal.input] = options.createTensor(
            "float32",
            new Float32Array([plan.focal.pixels(request.fieldOfView ?? 60, request.sourceWidth, request.sourceHeight)]),
            [1],
          );
        }
        if (plan.ratioInput !== undefined) {
          feeds[plan.ratioInput] = options.createTensor(
            "float32",
            new Float32Array([request.ratio]),
            [1],
          );
        }

        const started = now();
        const outputs = await session.run(feeds);
        if (streams.get(request.nodeId) !== stream) throw new Error("inference node was retired");
        const millis = now() - started;

        /* §V861 — BY NAME. The one line this whole task exists for; see MODEL_PLANS. */
        const modelData = outputs[plan.picture]?.data;
        if (modelData === undefined) {
          throw new Error(
            `the model returned no "${plan.picture}" — it declares ` +
              `[${session.outputNames.join(", ")}]`,
          );
        }
        const data = plan.decodeOutput === undefined ? modelData : plan.decodeOutput(modelData);

        if (plan.feedback !== undefined) {
          const tensors: Record<string, unknown> = {};
          for (const [outputSlot, inputSlot] of Object.entries(plan.feedback)) {
            const carried = outputs[outputSlot];
            // A model that declared feedback and returned none is a wiring error, not a
            // frame to publish anyway with the loop quietly open.
            if (carried === undefined) {
              throw new Error(`the model returned no recurrent "${outputSlot}"`);
            }
            tensors[inputSlot] = carried;
          }
          /* T1816b: the state just fed in is spent. On WebGPU it is device memory that only
             an explicit dispose returns — ~30 MB a frame for Depth Pro 2's stream. */
          const spent = recurrent.get(temporalKey);
          if (spent !== undefined) Object.values(spent.tensors).forEach(releaseIfOnDevice);
          recurrent.set(temporalKey, { ratio: request.ratio, side, tensors });
        }

        const bytes = plan.encode(
          data,
          request.width,
          request.height,
          side,
          request.sourceWidth,
          request.sourceHeight,
        );
        // Validate ownership before smoothing can mutate the encoder's storage or
        // replace retained history. An invalid encoder must leave both untouched.
        const buffer = bytes.buffer;
        if (!(buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength || buffer === data.buffer || buffer === modelData.buffer) {
          throw new Error(`inference encoder for "${request.modelId}" must return an owned exact ArrayBuffer`);
        }
        if (request.nodeType === "matte" && request.smoothing < 1) {
          /* Per-frame matting flickers at the edges; the EMA trades edge lag for temporal
             stability (stated on the node's Smoothing parameter, §T957). The alpha is the
             node's now, defaulted per model from the plan table — RVM asks for 1 and skips
             this entirely, because it carries the past in its recurrent state instead.
             Runs on the FLOAT view, before any consumer sees the frame. */
          const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const smoothed = smoothMatte(previousMatte.get(temporalKey), view, request.smoothing);
          previousMatte.set(temporalKey, Float32Array.from(smoothed));
        }
        // Every encoder owns a fresh exact buffer. Smoothing retains a separate copy
        // above, so transferring this result detaches neither model nor temporal state.
        // A copy here would allocate and move another 8.3 MB for a 1080p result.
        let raw: { bytes: ArrayBuffer; width: number; height: number } | undefined;
        if (request.captureRaw === true) {
          const shape = outputs[plan.picture]!.dims;
          if (shape === undefined || shape.length < 2) throw new Error("Raw preparation requires the model output's native dimensions.");
          const width = shape[shape.length - 1]!;
          const height = shape[shape.length - 2]!;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) {
            throw new Error("Raw preparation requires a single-channel model output with matching dimensions.");
          }
          raw = { bytes: Float32Array.from(data).buffer, width, height };
        }
        options.post(
          {
            kind: "result",
            requestId: request.requestId,
            bytes: buffer,
            backend,
            millis,
            isolated: options.isolated,
            ...(raw === undefined ? {} : { raw }),
          },
          raw === undefined ? [buffer] : [buffer, raw.bytes],
        );
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        options.post({
          kind: "error",
          requestId: request.kind === "run" ? request.requestId : null,
          // §B171/§V469: the runtime's own wording names the SYMPTOM. Where the bytes say
          // what actually happened, say that instead.
          message: describeRuntimeLoadFailure(raw) ?? raw,
        });
      }
    },
  };
}
