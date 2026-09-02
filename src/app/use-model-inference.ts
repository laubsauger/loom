import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { absTimeSecondsOf, type FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { NodeMetricSink } from "@runtime/telemetry/index.ts";
import {
  DEPTH_INPUT_KEY,
  DEPTH_INPUT_SIDE,
  DEPTH_RESULT_KEY,
  MATTE_INPUT_KEY,
  MATTE_RESULT_KEY,
  POSE_INPUT_KEY,
  POSE_RESULT_KEY,
  depthSettingsFor,
} from "@nodes/definitions/index.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import {
  createInferenceSources,
  inferenceSourceIdFor,
  type InferenceEntry,
} from "@runtime/execution/inference-sources.ts";
import {
  createModelAcquisition,
  formatBytes,
  progressText,
  type AcquisitionState,
  type ModelDescriptor,
} from "@runtime/models/model-acquisition.ts";
import { cacheModelStore } from "@runtime/models/cache-model-store.ts";
import { createWorkerRunner, type WorkerRunner } from "@runtime/models/worker-runner.ts";
import type { InferenceNodeType, WorkerLike } from "@runtime/models/inference-protocol.ts";
import {
  DEPTH_ACCURATE,
  DEPTH_LIVE,
  MATTE_ACCURATE,
  MATTE_FAST,
  POSE_ACCURATE,
  POSE_LIVE,
} from "@runtime/models/model-catalogue.ts";
import {
  MATTE_INPUT_SIDE,
  matteToFloats,
  neutralMatte,
  packMatteInput,
} from "@runtime/models/matte-runner.ts";
import { depthToRgba, neutralDepth, packModelInput } from "@runtime/models/depth-runner.ts";
import {
  POSE_INPUT_CHANNELS,
  POSE_INPUT_DTYPE,
  POSE_INPUT_SIDE,
  keypointsToTexture,
  neutralPose,
  packPoseInput,
} from "@runtime/models/pose-runner.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { Notice } from "./notices.tsx";

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "runtime.resetInference": {
      input: { nodeIds?: readonly string[] };
      output: { reset: number };
    };
  }
}

/**
 * Depth inference, composed (T385, T715, §V205).
 *
 * The seam, the acquisition and the model meet here and nowhere else. Every piece below
 * existed and was tested before this file, and §V205 is why that is not enough: a factory
 * with no construction site is dead in the product, which is how B12, T264, B23 and B25
 * all happened. This is the construction site.
 *
 * ## Nothing here spends bytes on its own
 *
 * Placing a Depth node calls `refresh`, which only reads the cache. The 94 MB download
 * starts when the user presses the button in the notice strip, and not before. That is
 * the whole reason acquisition has no path from `refresh` to the network.
 *
 * ## The runtime is imported LAZILY, and that is load-bearing twice
 *
 * `await import("onnxruntime-web")` rather than a top-level import, so the runtime is a
 * separate chunk that loads only when a Depth node actually runs. §V585 says a
 * disconnected model node must cost zero; a top-level import would put the whole runtime
 * in the main bundle for every document that never mentions depth. It also means the
 * default `ort.bundle.min.mjs` entry — which carries its own wasm — needs no Vite asset
 * configuration at all.
 */

/**
 * What differs between one model node and another — and it is ONLY this.
 *
 * Adding pose to a seam built for depth needed no new resource kind, no new upload route
 * and no change to the async semantics: a second row in this table, and the acquisition,
 * the session cache, the staleness reporting and the notices all applied unchanged. That
 * is the evidence §T736's registry is general rather than a depth-shaped path wearing a
 * general name.
 */
interface InferenceKind {
  readonly nodeType: string;
  /** What to call it in a sentence a user reads. */
  readonly label: string;
  /**
   * What the node PUBLISHES when it has no result, said as a picture (B156).
   *
   * The notices used to describe the download; the owner needed them to describe the
   * SCREEN. "Depth needs Depth Anything V2" reads as an optional extra you can dismiss;
   * "this document is showing flat grey where the relief would be" reads as the reason
   * the picture looks inert — which is the same fact, aimed at the thing being looked at.
   */
  readonly neutralPicture: string;
  readonly inputKey: string;
  readonly resultKey: string;
  /** ONNX tensor element type. Depth wants normalised float; MoveNet wants int32 bytes. */
  readonly tensorType: "float32" | "int32" | "uint8";
  /** NCHW for depth's ViT, NHWC for MoveNet. Getting this backwards runs and lies. */
  dims(side: number): readonly number[];
  /**
   * HOW THIS NODE INSTANCE WANTS TO BE RUN, read from its own stored parameters (§T965).
   *
   * It used to be `descriptor(parameters)` and a constant `inputSide`, which was fine
   * while the only per-node choice was which weights. It is not fine now: the model, the
   * input size, the execution provider and the run cadence are all node parameters, and
   * they are all read HERE because this is the only place that meets a node's stored bag.
   *
   * The reading itself lives with the node definition (`depthSettingsFor`), never here —
   * a second copy of "what does an absent `rateLimit` mean" would be a second answer, and
   * the schema that declares the defaults is the one that should own them.
   */
  settings(parameters: Readonly<Record<string, unknown>>): InferenceRunSettings;
  pack(texels: Float32Array, side: number): Float32Array | Int32Array | Uint8Array;
  /** T992: `sourceSize` is the PICTURE's dims — pose un-letterboxes its joints there. */
  encode(
    output: Float32Array,
    size: readonly [number, number],
    sourceSize: readonly [number, number],
  ): Uint8Array;
  fallback(size: readonly [number, number]): Uint8Array;
}

/** What a node instance's parameters say about running it. */
interface InferenceRunSettings {
  readonly descriptor: ModelDescriptor;
  readonly inputSide: number;
  readonly providers: readonly string[];
  readonly minIntervalSeconds: number;
  readonly hold: boolean;
}

/**
 * §T957's HANDOFF, taken (the matte session's ~15 lines in this file).
 *
 * The whole entry is a table row, which is the claim §T736 has been making since pose:
 * a third model node needs no new resource kind, no new upload route and no change to
 * the async semantics — the acquisition, the session cache, the staleness reporting, the
 * timing channels and the notices all applied unchanged.
 *
 * ⚠ The handoff was FAILURE-FREE BY CONSTRUCTION and that is §T715's degrade rule paying
 * out rather than a happy accident: until this row existed the Matte node compiled,
 * published its neutral (zero everywhere — "nobody is here") and downloaded nothing. A
 * missing construction site degraded the RATE to zero and never the CONTRACT, so the
 * cross-session dependency could sit unlanded without breaking a document.
 *
 * The model id is the STORED VALUE here — the matte shipped on §V827's chooser from day
 * one, so there is no legacy string to keep parsing (contrast depth and pose below).
 */
function matteSettings(parameters: Readonly<Record<string, unknown>>): InferenceRunSettings {
  return {
    descriptor: parameters["model"] === MATTE_FAST.id ? MATTE_FAST : MATTE_ACCURATE,
    inputSide: MATTE_INPUT_SIDE,
    providers: ["webgpu", "wasm"],
    minIntervalSeconds: 0,
    hold: false,
  };
}

/**
 * Pose has no backend or cadence controls yet — the §T715 ladder, uncapped.
 *
 * ⚠ BOTH SPELLINGS, for depth's reason (§V813): `fast` is what documents written before
 * §V827's chooser hold, the model id is what a new choice writes, and reading only one of
 * them would mean picking the cheap model and downloading the expensive one.
 */
function poseSettings(parameters: Readonly<Record<string, unknown>>): InferenceRunSettings {
  const wanted = parameters["model"];
  return {
    descriptor: wanted === "fast" || wanted === POSE_LIVE.id ? POSE_LIVE : POSE_ACCURATE,
    inputSide: POSE_INPUT_SIDE,
    providers: ["webgpu", "wasm"],
    minIntervalSeconds: 0,
    hold: false,
  };
}

const INFERENCE_KINDS: readonly InferenceKind[] = [
  {
    nodeType: "depth",
    label: "Depth",
    neutralPicture: "flat grey instead of relief",
    inputKey: DEPTH_INPUT_KEY,
    resultKey: DEPTH_RESULT_KEY,
    tensorType: "float32",
    dims: (side) => [1, 3, side, side],
    settings: (parameters) => {
      const settings = depthSettingsFor(parameters);
      return {
        descriptor: settings.modelId === DEPTH_LIVE.id ? DEPTH_LIVE : DEPTH_ACCURATE,
        inputSide: settings.inputSide,
        providers: settings.providers,
        minIntervalSeconds: settings.minIntervalSeconds,
        hold: settings.hold,
      };
    },
    pack: (texels, side) => packModelInput(texels, side),
    encode: (output, size) => depthToRgba(output, DEPTH_INPUT_SIDE, size[0], size[1]),
    fallback: (size) => neutralDepth(size[0], size[1]),
  },
  {
    nodeType: "pose",
    label: "Pose",
    neutralPicture: "an empty keypoint map",
    inputKey: POSE_INPUT_KEY,
    resultKey: POSE_RESULT_KEY,
    // uint8 and FOUR channels, read from the model itself (see POSE_INPUT_DTYPE): the
    // upstream card describes int32 x 3 and the web export is neither.
    tensorType: POSE_INPUT_DTYPE,
    dims: (side) => [1, side, side, POSE_INPUT_CHANNELS],
    settings: poseSettings,
    pack: (texels, side) => packPoseInput(texels, side),
    // The keypoint map is a fixed 17x1 whatever the source is, so the node's OUTPUT size
    // is not consulted — the joints are the data, not a picture of them. The SOURCE size
    // is (T992): the joints come back in letterboxed model uv and map onto the picture.
    encode: (output, _size, sourceSize) => keypointsToTexture(output, sourceSize[0], sourceSize[1]),
    fallback: () => neutralPose(),
  },
  {
    nodeType: "matte",
    label: "Matte",
    neutralPicture: "zero everywhere — nobody is here",
    inputKey: MATTE_INPUT_KEY,
    resultKey: MATTE_RESULT_KEY,
    tensorType: "float32",
    // NCHW, like depth's ViT: MODNet takes normalised planar RGB.
    dims: (side) => [1, 3, side, side],
    settings: matteSettings,
    pack: (texels, side) => packMatteInput(texels, side),
    encode: (output, size) => matteToFloats(output, MATTE_INPUT_SIDE, size[0], size[1]),
    fallback: (size) => neutralMatte(size[0], size[1]),
  },
];

function kindFor(nodeType: string): InferenceKind | undefined {
  return INFERENCE_KINDS.find((kind) => kind.nodeType === nodeType);
}

/** One tracked model node: what it needs and how big its output is. */
interface DepthTarget {
  readonly nodeId: string;
  readonly kind: InferenceKind;
  readonly descriptor: ModelDescriptor;
  readonly size: readonly [number, number];
  /**
   * T992: the PICTURE the node reads — the preprocess pass's source texture, looked up
   * in the plan. Distinct from `size` (the OUTPUT), and the distinction is pose's whole
   * defect history: its output is the fixed 17×1 keypoint map, so without this field
   * the source aspect never reached the encoder and the joints could not be
   * un-letterboxed.
   */
  readonly sourceSize: readonly [number, number];
  /** This node's own run settings, resolved from its parameters (§T965). */
  readonly settings: InferenceRunSettings;
  /** The node's NAME — what its timing channels are addressed by (§T976, §V129). */
  readonly channel: string | undefined;
}

/**
 * What the RUN half has to say once ACQUISITION has already said "ready" (B156).
 *
 * Acquisition answers "are the bytes on this machine". It cannot answer "did they run",
 * and the two failures are pixel-for-pixel identical: both leave the node serving its
 * identity fallback. A model that downloaded and then could not start a session used to
 * produce no notice, no diagnostic and no console line — a document reduced to its
 * fallback with nothing anywhere saying why. That is the state §B156 could not be
 * distinguished from, so it gets a name and a surface.
 */
type RunHealth =
  /** Acquired, no result yet, nothing has failed — the first inference is in flight. */
  | { readonly kind: "waiting" }
  /** At least one result has landed. The node is live, at whatever rate the model runs. */
  | { readonly kind: "running" }
  /** Acquired, never produced a result, and the last attempt failed with this reason. */
  | { readonly kind: "failed"; readonly reason: string };

function sameHealth(a: RunHealth | undefined, b: RunHealth | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "failed") return b.kind === "failed" && a.reason === b.reason;
  return a.kind === b.kind;
}

function sameHealthMap(
  a: Readonly<Record<string, RunHealth>>,
  b: Readonly<Record<string, RunHealth>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!sameHealth(a[key], b[key])) return false;
  return true;
}

function sameTargets(a: readonly DepthTarget[], b: readonly DepthTarget[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((target, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      target.nodeId === other.nodeId &&
      target.descriptor.id === other.descriptor.id
    );
  });
}

export interface ModelInferenceBinding {
  /** Frame-loop observer. Publishes staleness, then queues the next inference. Stable. */
  readonly observe: (frame: FrameEvaluationInput) => void;
  /** Re-derives the tracked set. Call after each compile. Stable. */
  readonly track: (graph: GraphDocument, compiled: CompiledGraph | null) => void;
  /**
   * T747: awaited by the export path after each frame renders (§V586's blocking half).
   *
   * Live, a result arriving late is correct — §V144's "stale beats stalled". In a TAKE it
   * is a silently wrong file, so the export waits here and the lag becomes a constant.
   * Resolves immediately when no model node is tracked, so a document without one pays
   * nothing for the hook existing.
   */
  readonly settle: (frameIndex: number) => Promise<void>;
  /** Consent, progress and failure, for the strip under the top bar. */
  readonly notices: readonly Notice[];
  /**
   * §T976 — the fourth resolver in the composition root's `externalChannels` merge.
   *
   * Answers `<nodeName>:ready | :lagFrames | :delaySeconds | :fps | :realtimeFactor` and
   * NOTHING else, so it composes in front of the others without shadowing them. Stable
   * identity for the life of the hook, like analyze's, so putting it in the merge does not
   * re-key the compile memo every render.
   */
  readonly resolver: ChannelResolver;
}

export function useModelInference(
  backend: LoomBackend | null | undefined,
  sink?: NodeMetricSink | undefined,
  /**
   * The bus §T978's reset pulse fires through. Optional so a test that only wants the
   * seam can leave it out; the composition root passes the real one.
   */
  bus?: LoomBus | undefined,
): ModelInferenceBinding {
  const backendRef = useRef(backend);
  backendRef.current = backend;
  /*
   * The metric sink through a REF, for the reason `backendRef` is one: `runnerFor` builds
   * the worker and is memoised on `acquisition` alone. Putting `sink` in its dependency
   * list would tear down and rebuild the inference thread — and every loaded session with
   * it — whenever the composition root handed down a new sink identity.
   */
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  const [states, setStates] = useState<Readonly<Record<string, AcquisitionState>>>({});
  const targetsRef = useRef<readonly DepthTarget[]>([]);
  /**
   * The tracked set MIRRORED INTO STATE, and the duplication is the fix rather than the
   * sloppiness (B156).
   *
   * `observe` and `settle` read the ref because they run per frame and must not re-render
   * anything. `notices` is a render output and used to read the ref too — so a document
   * that dropped its last Depth node changed no state, the memo never recomputed, and the
   * "no model" row stayed on screen over a document that has no model node in it. A stale
   * notice is tolerable while the notice is a quiet offer and a lie once it is a warning
   * about the picture, which is exactly what this change makes it.
   */
  const [tracked, setTracked] = useState<readonly DepthTarget[]>([]);
  const healthRef = useRef<Readonly<Record<string, RunHealth>>>({});
  const [health, setHealth] = useState<Readonly<Record<string, RunHealth>>>({});
  const unregisterRef = useRef<Map<string, () => void>>(new Map());

  const store = useMemo(() => cacheModelStore(), []);

  const acquisition = useMemo(
    () =>
      createModelAcquisition({
        store: store ?? {
          // No Cache API (a non-secure context, or a private mode that withholds it).
          // A store that holds nothing is the honest stand-in: acquisition still reports
          // absent, the node still renders its identity, and nothing throws at compose
          // time — the same shape as a denied camera.
          async get() {
            return undefined;
          },
          async put() {},
          async delete() {},
          async list() {
            return [];
          },
        },
        fetch: (url, init) => globalThis.fetch(url, init),
        onStateChange: (id, state) => setStates((prior) => ({ ...prior, [id]: state })),
      }),
    [store],
  );

  /**
   * The inference thread (T382), created LAZILY on first need.
   *
   * Measured: Depth Anything at 518² takes 2599 ms under wasm on one thread, and ORT falls
   * back to one thread unless the page is cross-origin isolated, which we are not. A
   * 16.7 ms frame cannot share that — it is not a hitch to tune away, it is structurally
   * impossible. Pose at 18 ms would never have justified this on its own.
   *
   * Lazy because §V585 says a disconnected model node costs zero: a document with no Depth
   * or Pose in it starts no thread and, since the runtime is imported inside the worker,
   * never loads onnxruntime either.
   *
   * Where there is no `Worker` — jsdom, a headless harness — none is made and the runner
   * refuses by name. The seam already treats a refused run as "keep the previous value",
   * so a node shows its identity rather than a hole, and nothing silently falls back to
   * running 2.6 s of inference on the frame loop.
   */
  const workerRef = useRef<WorkerRunner | null>(null);
  const runnerFor = useCallback((): WorkerRunner => {
    const existing = workerRef.current;
    if (existing !== null) return existing;
    if (typeof Worker === "undefined") {
      throw new Error("This environment has no Worker, so inference cannot run off the frame loop.");
    }
    const worker = new Worker(new URL("../runtime/models/inference.worker.ts", import.meta.url), {
      type: "module",
    }) as unknown as WorkerLike;
    const runner = createWorkerRunner({
      worker,
      describe: (nodeId) => {
        const found = targetsRef.current.find((candidate) => candidate.nodeId === nodeId);
        if (found === undefined) return undefined;
        return {
          modelId: found.descriptor.id,
          // Widened by hand because `InferenceKind.nodeType` is a plain string; the
          // protocol's union is the authority, and a row naming a type it does not
          // declare fails here rather than reaching the worker as an unknown packing.
          nodeType: found.kind.nodeType as InferenceNodeType,
          width: found.size[0],
          height: found.size[1],
          sourceWidth: found.sourceSize[0],
          sourceHeight: found.sourceSize[1],
          side: found.settings.inputSide,
          providers: found.settings.providers,
        };
      },
      weightsFor: async (modelId) => {
        const descriptor = targetsRef.current.find((t) => t.descriptor.id === modelId)?.descriptor;
        if (descriptor === undefined) return undefined;
        return await acquisition.acquire(descriptor);
      },
      /*
       * §T715/§V672 answered on the node itself: what it GOT, and how long that took.
       *
       * Onto the per-node runtime channel rather than a notice, for `resultAgeFrames`'
       * reason exactly — it changes with every run, the channel already coalesces to
       * 10 Hz (§V16), and a permanent banner about a thing that is working is noise. The
       * backend NAME is the api onnxruntime actually built the session with; it is never
       * the value of the node's Backend parameter, which is only ever a request.
       */
      onMeasured: (nodeId, measurement) => {
        sinkRef.current?.publish(nodeId, {
          inferenceBackend: measurement.backend,
          inferenceMs: measurement.millis,
        });
      },
    });
    workerRef.current = runner;
    return runner;
  }, [acquisition]);

  useEffect(
    () => () => {
      workerRef.current?.dispose();
      workerRef.current = null;
    },
    [],
  );

  const sources = useMemo(
    () =>
      createInferenceSources({
        readBuffer: (resourceId) => {
          const live = backendRef.current;
          if (live === null || live === undefined) {
            return Promise.reject(new Error("No backend is attached; nothing to read."));
          }
          return live.readBuffer(resourceId);
        },
        // Packing, inference and encoding ALL happen on the worker: the two loops that
        // walk every pixel are the ones worth moving, not just the model call.
        run: async (nodeId, input) => runnerFor().run(nodeId, input),
      }),
    [runnerFor],
  );

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════
   * §T978 — `runtime.resetInference`, the command the Depth node's Reset pulse fires
   * ═══════════════════════════════════════════════════════════════════════════════════
   *
   * WHAT IT CLEARS, and the scope is the whole design: the inference THREAD, and with it
   * every model session, every provider ladder and every run in flight; then the named
   * nodes' published results, so each goes back to its identity fallback and computes a
   * fresh first one. §B171's arc produced the case — a rejected session promise cached
   * forever — and while that instance is fixed, a download, a worker, a session and a
   * ladder are four things that can wedge and "reload the tab" recovers none of them.
   *
   * ⚠ WHAT IT DOES NOT CLEAR: the cached weights. `acquire` reads the store before it
   * reaches the network, so the rebuilt session loads from cache and this costs nothing.
   * A reset that re-downloaded 94 MB would be worse than the state it was clearing, and
   * §B175 records the model already re-downloading per origin more than anyone expects.
   * `refresh` is called instead — the READ-ONLY half of acquisition, which is what turns a
   * `failed` download state back into `ready` when the bytes were there all along.
   *
   * ⚠ NO PULSE ON LOAD AND NO AUTO-RESET. A gesture the user did not make is not a
   * gesture — the same reasoning that rules against a completed download writing the
   * user's document.
   *
   * REGISTERED HERE and not in `runtime-commands.ts`, which is the site with the pure
   * `registerResetFeedbackCommand` so the headless MCP server registers the same body
   * (§V39). The headless server has no inference thread at all, so the same registration
   * there would be a command that lies — §V123's "a button that lies" one layer up.
   */
  const resetRef = useRef<(nodeIds: readonly string[] | undefined) => number>(() => 0);
  resetRef.current = (nodeIds) => {
    const wanted = nodeIds === undefined ? undefined : new Set(nodeIds);
    const hit = targetsRef.current.filter(
      (candidate) => wanted === undefined || wanted.has(candidate.nodeId),
    );
    // The THREAD goes first, and unconditionally: it is shared, so a wedged worker is not
    // a per-node fact and refusing to drop it because the named node happens to be gone
    // would leave the one state nothing else can clear.
    workerRef.current?.dispose();
    workerRef.current = null;
    for (const target of hit) {
      sources.reset(target.nodeId);
      // Re-READ the cache (never the network): a failed download whose bytes are actually
      // present becomes ready again instead of needing the notice's own retry.
      void acquisition.refresh(target.descriptor);
    }
    return hit.length;
  };

  useEffect(() => {
    if (bus === undefined || bus.hasCommand("runtime.resetInference")) return;
    bus.registerCommand({
      name: "runtime.resetInference",
      description:
        "Restart inference: the worker thread, model sessions and provider ladders, and the named nodes' results. Keeps the downloaded models.",
      handler: (input) => ({
        status: "applied",
        output: { reset: resetRef.current(input.nodeIds) },
        diagnostics: [],
      }),
    });
  }, [bus]);

  const track = useCallback(
    (graph: GraphDocument, compiled: CompiledGraph | null) => {
      const allocated = new Set((compiled?.resources ?? []).map((resource) => resource.id));
      const sized = new Map<string, readonly [number, number]>();
      for (const resource of compiled?.resources ?? []) {
        const entry = resource as { id?: string; size?: readonly [number, number] };
        if (entry.id !== undefined && entry.size !== undefined) sized.set(entry.id, entry.size);
      }
      // T992: which texture each model node's preprocess actually reads, from the plan
      // itself — the source aspect the un-letterbox needs, never assumed from the output.
      const sourceOf = new Map<string, string>();
      for (const pass of (compiled?.passes ?? []) as ReadonlyArray<{
        id?: string;
        textures?: ReadonlyArray<{ binding?: string; resourceId?: string }>;
      }>) {
        if (typeof pass.id !== "string" || !pass.id.endsWith(":preprocess")) continue;
        const source = pass.textures?.find((texture) => texture.binding === "sourceTexture");
        if (source?.resourceId !== undefined) {
          sourceOf.set(pass.id.slice(0, -":preprocess".length), source.resourceId);
        }
      }

      const targets: DepthTarget[] = [];
      for (const nodeId of Object.keys(graph.nodes).sort()) {
        const node = graph.nodes[nodeId];
        if (node === undefined) continue;
        const kind = kindFor(node.type);
        if (kind === undefined) continue;
        // A model node the plan did not allocate resources for is UNWIRED — §V585's
        // pruning. It must not be tracked, must not acquire and must not download.
        const resultId = scratchResourceId(nodeId, kind.resultKey);
        if (!allocated.has(resultId)) continue;
        // The node's OWN parameters, read from the stored bag: this seam sits outside the
        // parameter resolver, so the node definition applies its own defaults (§T965).
        const settings = kind.settings(node.parameters);
        targets.push({
          nodeId,
          kind,
          descriptor: settings.descriptor,
          size: sized.get(resultId) ?? [1, 1],
          sourceSize: sized.get(sourceOf.get(nodeId) ?? "") ?? [1, 1],
          settings,
          // §T976: the FLAT document's uniqued label, exactly as `analyzeChannelEntries`
          // reads it from the same graph — so `depth1:ready` names the node the canvas
          // shows and two instances of one component never collide.
          channel: node.label,
        });
      }
      targetsRef.current = targets;
      // Only when the SET changed: a values-only recompile re-derives the same targets
      // sixty times a second and must not re-render the notice strip (§V16).
      setTracked((prior) => (sameTargets(prior, targets) ? prior : targets));

      // Re-register only what changed, so a recompile does not drop and rebuild every
      // source and lose the picture for a frame.
      const wanted = new Set(targets.map((target) => inferenceSourceIdFor(target.nodeId)));
      for (const [sourceId, off] of [...unregisterRef.current.entries()]) {
        if (wanted.has(sourceId)) continue;
        off();
        unregisterRef.current.delete(sourceId);
      }
      const live = backendRef.current;
      if (live !== null && live !== undefined) {
        for (const target of targets) {
          const sourceId = inferenceSourceIdFor(target.nodeId);
          if (unregisterRef.current.has(sourceId)) continue;
          unregisterRef.current.set(
            sourceId,
            live.registerMediaSource(sourceId, {
              currentFrame: () => sources.currentFrame(target.nodeId),
            }),
          );
        }
      }

      const entries: InferenceEntry[] = targets.map((target) => ({
        nodeId: target.nodeId,
        inputResourceId: scratchResourceId(target.nodeId, target.kind.inputKey),
        sourceId: inferenceSourceIdFor(target.nodeId),
        fallback: target.kind.fallback(target.size),
        // §T384's freshness policy, carried per node rather than assumed: how often this
        // one is allowed to start, and whether it stops after its first result.
        minIntervalSeconds: target.settings.minIntervalSeconds,
        hold: target.settings.hold,
        ...(target.channel === undefined ? {} : { channel: target.channel }),
      }));
      sources.track(entries);

      // Reading the cache is free and opens no connection, so it is safe to do on every
      // compile. It is what turns "unknown" into a consent prompt or a ready node.
      for (const descriptor of new Set(targets.map((target) => target.descriptor))) {
        void acquisition.refresh(descriptor);
      }
    },
    [acquisition, sources],
  );

  const observe = useCallback(
    (frame: FrameEvaluationInput) => {
      const target = sink;
      if (target !== undefined) {
        for (const age of sources.resultAges(frame.frameIndex)) {
          target.publish(age.nodeId, { resultAgeFrames: age.ageFrames });
        }
      }
      // B156: what the RUN half is doing, from the seam that is the only thing that knows.
      // Recomputed every frame because it is three map lookups, but pushed into React
      // state ONLY on a transition — waiting → running happens once, and waiting → failed
      // happens once. A per-frame setState here would re-render the strip at 60 Hz and
      // re-arm the frame loop through this binding's identity.
      const next: Record<string, RunHealth> = {};
      for (const candidate of targetsRef.current) {
        if (states[candidate.descriptor.id]?.kind !== "ready") continue;
        const reason = sources.lastFailure(candidate.nodeId);
        next[candidate.nodeId] = sources.ready(candidate.nodeId)
          ? { kind: "running" }
          : reason === undefined
            ? { kind: "waiting" }
            : { kind: "failed", reason };
      }
      if (!sameHealthMap(healthRef.current, next)) {
        healthRef.current = next;
        setHealth(next);
      }

      // Only once the weights are actually held: `sample` would otherwise call `acquire`
      // through the runner on every frame and start a download nobody agreed to.
      const ready = targetsRef.current.some(
        (candidate) => states[candidate.descriptor.id]?.kind === "ready",
      );
      if (!ready) return;
      /*
       * Between frames, like analyze: `readBuffer` fails the frame guard from inside one.
       *
       * The ABSOLUTE clock (§T461/§T495), not the timeline one and never a wall reading
       * (§V44). Two reasons, and both bite: the timeline clock WRAPS, so a looping
       * document would report an inference rate that collapsed once a lap and a rate limit
       * that reset with it; and a wall reading would make every gate that touches
       * §T976's channels non-reproducible. `absTimeSecondsOf` falls back to `timeSeconds`
       * on a transport that publishes no absolute clock, so an unbounded timeline keeps
       * exactly the numbers it had.
       */
      queueMicrotask(() => sources.sample(frame.frameIndex, absTimeSecondsOf(frame)));
    },
    [sink, sources, states],
  );

  const settle = useCallback(
    async (frameIndex: number) => {
      // Only once weights are held. Otherwise `settle` would call `acquire` through the
      // runner and a take would start a 94 MB download nobody agreed to (§V721), and
      // block on it — the worst possible moment to ask.
      const ready = targetsRef.current.some(
        (candidate) => states[candidate.descriptor.id]?.kind === "ready",
      );
      if (!ready) return;
      await sources.settle(frameIndex);
    },
    [sources, states],
  );

  const notices = useMemo(
    () => buildNotices(tracked, states, acquisition, health),
    [tracked, states, acquisition, health],
  );

  /**
   * MEMOISED, and it is load-bearing rather than tidy.
   *
   * The composition root puts this binding in the dependency array of the frame-loop
   * observer. A fresh object literal per render therefore gave `observeFrame` a new
   * identity every render, which re-armed the loop and disturbed the CLOCK — three
   * transport suites went red with nothing to do with depth, and the control at clean
   * HEAD passed. A hook whose consumer keys effects on it must return a stable value.
   */
  const resolver = useCallback<ChannelResolver>(
    (channel, context) => sources.resolver(channel, context),
    [sources],
  );

  return useMemo(
    () => ({ observe, track, settle, notices, resolver }),
    [observe, track, settle, notices, resolver],
  );
}

/**
 * §V469: not silent, not fatal. Availability is a DECISION and gets a button; staleness
 * changes every frame and lives on the telemetry channel instead.
 *
 * ## B156 — the notice was true and the owner still could not read the screen
 *
 * The owner reported E44 Sounding as "not really doing anything". The example opens on a
 * FLAT LATTICE by design when no model is held (§T385, §T759), so the correct no-model
 * path and a broken example look identical, and the only thing separating them was one
 * quiet `info` row offering a download. §T743 called that notice load-bearing for a
 * document whose star node is unavailable. This is that warning coming true.
 *
 * Three rules came out of it, and each is a rewrite rather than a restyle:
 *
 * 1. LEAD WITH THE PICTURE, NOT THE DOWNLOAD. "Depth needs Depth Anything V2" is a fact
 *    about a file. "This document is showing flat grey where the relief would be" is a
 *    fact about what is on screen — the same fact, aimed at what the owner is looking at.
 * 2. A DEGRADED DOCUMENT IS A `warn`, NOT AN `info`. It is not an optional extra; the
 *    picture is a placeholder until it is resolved.
 * 3. THE RUN HALF GETS ITS OWN ROWS. Acquisition only knows whether the bytes are on the
 *    machine. "Downloaded and computing its first result" and "downloaded and could not
 *    run" are different states from "not downloaded", they were both SILENT, and all
 *    three previously rendered the identical flat picture. Naming them is what makes
 *    §B156's two candidate diagnoses tellable apart from the app rather than by asking.
 *
 * What is deliberately NOT here: a row for a model that is running. Its rate belongs on
 * the telemetry channel (the node info popup's "N frames behind"), because it changes
 * every frame and §V16 caps that at 10 Hz — and because a permanent row about a thing
 * that is working correctly is the noise §V537 warns about. A healthy running model is
 * therefore identified by the ABSENCE of a row plus a picture that moves.
 */
export function buildNotices(
  targets: readonly DepthTarget[],
  states: Readonly<Record<string, AcquisitionState>>,
  acquisition: { acquire(d: ModelDescriptor): unknown; cancel(id: string): void },
  health: Readonly<Record<string, RunHealth>> = {},
): readonly Notice[] {
  const notices: Notice[] = [];
  const seen = new Set<string>();

  // ACQUISITION is a fact about a MODEL, so one row however many nodes want it: two Depth
  // nodes must not ask twice for the same 94 MB. The RUN half below is a fact about a
  // NODE — one node's session can fail while another's runs — so it is a second pass with
  // no deduplication rather than a branch inside this one.
  for (const target of targets) {
    const { descriptor } = target;
    const { label } = target.kind;
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    const state = states[descriptor.id] ?? { kind: "unknown" };

    if (state.kind === "absent") {
      notices.push({
        id: `model-consent-${descriptor.id}`,
        tone: "warn",
        message: `${label} has no model — showing ${target.kind.neutralPicture}.`,
        detail: `${descriptor.label}, ${formatBytes(descriptor.bytes)}. Downloaded once per machine, kept for every project.`,
        actions: [
          { label: "Download", onSelect: () => void acquisition.acquire(descriptor), variant: "outline" },
        ],
      });
    } else if (state.kind === "downloading") {
      notices.push({
        id: `model-progress-${descriptor.id}`,
        tone: "info",
        message: `Downloading ${descriptor.label}…`,
        detail: progressText(state.received, state.total),
        actions: [{ label: "Cancel", onSelect: () => acquisition.cancel(descriptor.id), variant: "ghost" }],
      });
    } else if (state.kind === "failed") {
      notices.push({
        id: `model-failed-${descriptor.id}`,
        tone: "error",
        message: `${descriptor.label} could not be downloaded.`,
        detail: `${state.reason}. The node is publishing its neutral output, so the document still renders.`,
        actions: [
          { label: "Try again", onSelect: () => void acquisition.acquire(descriptor), variant: "outline" },
        ],
      });
    }
  }

  // The RUN half, per node (B156). Only reachable once acquisition says the bytes are
  // here, which is why it is not an `else` on the loop above: "not downloaded", "computing
  // the first one" and "downloaded and could not run" all render the identical flat
  // picture, and the whole point is that a person can tell which one they are looking at.
  for (const target of targets) {
    if ((states[target.descriptor.id] ?? { kind: "unknown" }).kind !== "ready") continue;
    const { label, neutralPicture } = target.kind;
    const run = health[target.nodeId];
    if (run?.kind === "waiting") {
      notices.push({
        id: `model-first-result-${target.nodeId}`,
        tone: "info",
        message: `${label} has its model and is computing its first result.`,
        detail: `Until it lands the node is still publishing ${neutralPicture}. Results then arrive at the model's own rate, not once per frame — the node info popup reports how many frames behind the latest one is.`,
      });
    } else if (run?.kind === "failed") {
      notices.push({
        id: `model-run-failed-${target.nodeId}`,
        tone: "error",
        /*
         * THE REASON IS THE HEADLINE, prefixed with what it belongs to.
         *
         * It used to be a banner announcing that the inference did not run — a fact the
         * grey picture had already made — with the only load-bearing sentence demoted to
         * the detail. And "the document still renders" was telling someone looking at a
         * rendered document that it renders. Two lines: what went wrong, and what they
         * are looking at instead.
         *
         * The reason arrives from the seam, and where the runtime's own wording named a
         * symptom rather than a cause the worker has already rewritten it (§B171 —
         * `runtime-load-failure.ts`), so putting it first is what makes that rewrite
         * visible instead of buried.
         */
        message: `${label} could not run: ${run.reason}`,
        detail: `Publishing ${neutralPicture}; nothing is responding to ${label.toLowerCase()}.`,
      });
    }
  }
  return notices;
}
