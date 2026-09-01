import { depthToRgba, packModelInput } from "./depth-runner.ts";
import { POSE_INPUT_SIDE, keypointsToTexture, packPoseInput } from "./pose-runner.ts";
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
  /** Builds a session from weights. The real one is `ort.InferenceSession.create`. */
  createSession(weights: ArrayBuffer): Promise<InferenceSessionLike>;
  /** Builds the runtime's tensor. The real one is `new ort.Tensor(type, data, dims)`. */
  createTensor(type: string, data: Float32Array | Uint8Array, dims: readonly number[]): unknown;
  post(response: InferenceResponse, transfer?: Transferable[]): void;
}

interface Packing {
  readonly tensorType: string;
  pack(texels: Float32Array, side: number): Float32Array | Uint8Array;
  dims(side: number): readonly number[];
  encode(output: Float32Array, width: number, height: number, side: number): Uint8Array;
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
    encode: (output) => keypointsToTexture(output),
  },
};

export function createWorkerCore(options: WorkerCoreOptions) {
  const sessions = new Map<string, Promise<InferenceSessionLike>>();

  return {
    async handle(request: InferenceRequest): Promise<void> {
      try {
        if (request.kind === "load") {
          if (!sessions.has(request.modelId)) {
            sessions.set(request.modelId, options.createSession(request.weights));
          }
          await sessions.get(request.modelId);
          options.post({ kind: "loaded", modelId: request.modelId });
          return;
        }

        const pending = sessions.get(request.modelId);
        if (pending === undefined) {
          // Running before loading is a caller error, and it must come back ATTACHED to
          // the request rather than as a bare worker crash.
          options.post({
            kind: "error",
            requestId: request.requestId,
            message: `no session for "${request.modelId}" — send a load before a run`,
          });
          return;
        }

        const session = await pending;
        const packing = PACKING[request.nodeType];
        const side = request.side === 0 ? POSE_INPUT_SIDE : request.side;
        const packed = packing.pack(new Float32Array(request.texels), side);
        const inputName = session.inputNames[0];
        if (inputName === undefined) throw new Error("the session declares no input");
        const outputs = await session.run({
          [inputName]: options.createTensor(packing.tensorType, packed, packing.dims(side)),
        });
        const outputName = session.outputNames[0];
        const data = outputName === undefined ? undefined : outputs[outputName]?.data;
        if (data === undefined) throw new Error("the model returned no output");

        const bytes = packing.encode(data, request.width, request.height, side);
        // Transferred, not cloned: a 1080p depth map is 8.3 MB per frame. Copied out of
        // its view first so the transferred buffer is exactly the result and nothing else.
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        options.post({ kind: "result", requestId: request.requestId, bytes: buffer }, [buffer]);
      } catch (error) {
        options.post({
          kind: "error",
          requestId: request.kind === "run" ? request.requestId : null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
