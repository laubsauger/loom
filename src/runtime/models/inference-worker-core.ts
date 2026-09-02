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
 * The per-model differences, and ONLY these — the same table the main thread keeps, for
 * the same reason: adding a third model must be a row, not a branch.
 */
const PACKING: Readonly<Record<InferenceNodeType, Packing>> = {
  depth: {
    tensorType: "float32",
    pack: (texels, side) => packModelInput(texels, side),
    dims: (side) => [1, 3, side, side],
    encode: (output, width, height, side) => depthToRgba(output, side, width, height),
  },
  pose: {
    // uint8 x4 NHWC, read from the weights rather than the model card (§B148/§V743).
    tensorType: "uint8",
    pack: (texels, side) => packPoseInput(texels, side),
    dims: (side) => [1, side, side, 4],
    /* T992: the joints come back in LETTERBOXED model uv; the encoder maps them onto
       the picture, which is why it needs the source dims and the output dims cannot
       stand in (they are the fixed 17×1 keypoint map). */
    encode: (output, _width, _height, _side, sourceWidth, sourceHeight) =>
      keypointsToTexture(output, sourceWidth, sourceHeight),
  },
  matte: {
    // float32 NCHW, (x-0.5)/0.5 — MODNet's own reference inference, not the card (§B148).
    tensorType: "float32",
    pack: (texels, side) => packMatteInput(texels, side),
    dims: (side) => [1, 3, side, side],
    encode: (output, width, height, side) => matteToFloats(output, side, width, height),
  },
};

export function createWorkerCore(options: WorkerCoreOptions) {
  const sessions = new Map<string, Promise<LoadedSession>>();
  /* T957 — the matte's temporal EMA, per session: worker-local state in the SAME slot
     §T981's recurrent design would use (building this proves the slot). Cleared with
     the session. */
  const previousMatte = new Map<string, Float32Array>();
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
        const packing = PACKING[request.nodeType];
        const side = request.side === 0 ? POSE_INPUT_SIDE : request.side;
        const packed = packing.pack(new Float32Array(request.texels), side);
        const inputName = session.inputNames[0];
        if (inputName === undefined) throw new Error("the session declares no input");
        const started = now();
        const outputs = await session.run({
          [inputName]: options.createTensor(packing.tensorType, packed, packing.dims(side)),
        });
        const millis = now() - started;
        const outputName = session.outputNames[0];
        const data = outputName === undefined ? undefined : outputs[outputName]?.data;
        if (data === undefined) throw new Error("the model returned no output");

        let bytes = packing.encode(
          data,
          request.width,
          request.height,
          side,
          request.sourceWidth,
          request.sourceHeight,
        );
        if (request.nodeType === "matte") {
          /* Per-frame matting flickers at the edges; the EMA trades a few frames of
             edge lag for temporal stability (stated on the node's parameter, §T957).
             Runs on the FLOAT view, before any consumer sees the frame. */
          const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const smoothed = smoothMatte(previousMatte.get(request.sessionKey), view, 0.55);
          previousMatte.set(request.sessionKey, Float32Array.from(smoothed));
          bytes = new Uint8Array(smoothed.buffer, smoothed.byteOffset, smoothed.byteLength);
        }
        // Transferred, not cloned: a 1080p depth map is 8.3 MB per frame. Copied out of
        // its view first so the transferred buffer is exactly the result and nothing else.
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        options.post(
          { kind: "result", requestId: request.requestId, bytes: buffer, backend, millis },
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
