import { depthToRgba, packModelInput } from "./depth-runner.ts";
import { POSE_INPUT_SIDE, keypointsToTexture, packPoseInput } from "./pose-runner.ts";
import { matteToFloats, packMatteInput, smoothMatte } from "./matte-runner.ts";
import { describeRuntimeLoadFailure } from "./runtime-load-failure.ts";
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
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
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
  createSession(weights: ArrayBuffer, provider: string): Promise<InferenceSessionLike>;
  /** Builds the runtime's tensor. The real one is `new ort.Tensor(type, data, dims)`. */
  createTensor(type: string, data: Float32Array | Uint8Array, dims: readonly number[]): unknown;
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
 * The per-MODEL differences, and only these — keyed by model id since T1040, because two
 * artefacts behind one node type no longer share an IO shape. Adding a fourth model must
 * still be a row rather than a branch.
 */
export const MODEL_PLANS: Readonly<Record<string, ModelPlan>> = {
  "depth-anything-v2-small": { ...DEPTH_PACKING, picture: "predicted_depth", smoothing: 1 },
  "depth-anything-v2-small-q4f16": { ...DEPTH_PACKING, picture: "predicted_depth", smoothing: 1 },
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
};

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
  /* T957 — the matte's temporal EMA, per session: worker-local state in the SAME slot
     §T981's recurrent design would use (building this proves the slot). Cleared with
     the session. */
  const previousMatte = new Map<string, Float32Array>();
  /*
   * T1040 — the recurrent state, per session, in the slot §T957 built the EMA in to prove.
   *
   * The tensors are the RUNTIME's own, held opaquely and handed straight back: on a GPU
   * execution provider they may never be CPU-resident at all, and touching `.data` would
   * force a download this loop exists to avoid. `ratio` rides along because it decides
   * their shape (see the run path). Cleared with the session, like everything else here.
   */
  const recurrent = new Map<string, { ratio: number; tensors: Record<string, unknown> }>();
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
    weights: ArrayBuffer,
    providers: readonly string[],
  ): Promise<LoadedSession> => {
    const ladder = providers.length > 0 ? providers : ["wasm"];
    const refusals: string[] = [];
    for (const provider of ladder) {
      const started = now();
      try {
        const session = await options.createSession(weights, provider);
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
        if (request.kind === "load") {
          const { sessionKey } = request;
          let held = sessions.get(sessionKey);
          if (held === undefined) {
            held = loadSession(request.weights, request.providers);
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

        const { session, backend } = await pending;
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
         *     session it belongs to, keyed the same way.
         *  2. THE FIRST FRAME FEEDS ZEROS, shaped [1,1,1,1]. That is RVM's own documented
         *     "no memory yet" and it is not a placeholder for something better: measured,
         *     it runs clean and returns correctly-shaped state at the same cost as a warm
         *     frame.
         *  3. A RATIO CHANGE INVALIDATES THE STASH. `downsample_ratio` sets the internal
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
          const held = recurrent.get(request.sessionKey);
          const usable = held !== undefined && held.ratio === request.ratio;
          for (const inputSlot of Object.values(plan.feedback)) {
            feeds[inputSlot] = usable
              ? held!.tensors[inputSlot]
              : options.createTensor("float32", new Float32Array(1), [1, 1, 1, 1]);
          }
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
        const millis = now() - started;

        /* §V861 — BY NAME. The one line this whole task exists for; see MODEL_PLANS. */
        const data = outputs[plan.picture]?.data;
        if (data === undefined) {
          throw new Error(
            `the model returned no "${plan.picture}" — it declares ` +
              `[${session.outputNames.join(", ")}]`,
          );
        }

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
          recurrent.set(request.sessionKey, { ratio: request.ratio, tensors });
        }

        let bytes = plan.encode(
          data,
          request.width,
          request.height,
          side,
          request.sourceWidth,
          request.sourceHeight,
        );
        if (request.nodeType === "matte" && request.smoothing < 1) {
          /* Per-frame matting flickers at the edges; the EMA trades edge lag for temporal
             stability (stated on the node's Smoothing parameter, §T957). The alpha is the
             node's now, defaulted per model from the plan table — RVM asks for 1 and skips
             this entirely, because it carries the past in its recurrent state instead.
             Runs on the FLOAT view, before any consumer sees the frame. */
          const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const smoothed = smoothMatte(previousMatte.get(request.sessionKey), view, request.smoothing);
          previousMatte.set(request.sessionKey, Float32Array.from(smoothed));
          bytes = new Uint8Array(smoothed.buffer, smoothed.byteOffset, smoothed.byteLength);
        }
        // Transferred, not cloned: a 1080p depth map is 8.3 MB per frame. Copied out of
        // its view first so the transferred buffer is exactly the result and nothing else.
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        options.post(
          {
            kind: "result",
            requestId: request.requestId,
            bytes: buffer,
            backend,
            millis,
            isolated: options.isolated,
          },
          [buffer],
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
