import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { NodeMetricSink } from "@runtime/telemetry/index.ts";
import {
  DEPTH_INPUT_KEY,
  DEPTH_INPUT_SIDE,
  DEPTH_RESULT_KEY,
  POSE_INPUT_KEY,
  POSE_RESULT_KEY,
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
import type { WorkerLike } from "@runtime/models/inference-protocol.ts";
import { DEPTH_ACCURATE, DEPTH_LIVE, POSE_ACCURATE, POSE_LIVE } from "@runtime/models/model-catalogue.ts";
import { depthToRgba, neutralDepth, packModelInput } from "@runtime/models/depth-runner.ts";
import {
  POSE_INPUT_CHANNELS,
  POSE_INPUT_DTYPE,
  POSE_INPUT_SIDE,
  keypointsToTexture,
  neutralPose,
  packPoseInput,
} from "@runtime/models/pose-runner.ts";
import type { Notice } from "./notices.tsx";

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
  readonly inputKey: string;
  readonly resultKey: string;
  readonly inputSide: number;
  /** ONNX tensor element type. Depth wants normalised float; MoveNet wants int32 bytes. */
  readonly tensorType: "float32" | "int32" | "uint8";
  /** NCHW for depth's ViT, NHWC for MoveNet. Getting this backwards runs and lies. */
  dims(side: number): readonly number[];
  descriptor(parameters: Record<string, unknown>): ModelDescriptor;
  pack(texels: Float32Array, side: number): Float32Array | Int32Array | Uint8Array;
  encode(output: Float32Array, size: readonly [number, number]): Uint8Array;
  fallback(size: readonly [number, number]): Uint8Array;
}

const INFERENCE_KINDS: readonly InferenceKind[] = [
  {
    nodeType: "depth",
    inputKey: DEPTH_INPUT_KEY,
    resultKey: DEPTH_RESULT_KEY,
    inputSide: DEPTH_INPUT_SIDE,
    tensorType: "float32",
    dims: (side) => [1, 3, side, side],
    descriptor: (parameters) => (parameters["model"] === "fast" ? DEPTH_LIVE : DEPTH_ACCURATE),
    pack: (texels, side) => packModelInput(texels, side),
    encode: (output, size) => depthToRgba(output, DEPTH_INPUT_SIDE, size[0], size[1]),
    fallback: (size) => neutralDepth(size[0], size[1]),
  },
  {
    nodeType: "pose",
    inputKey: POSE_INPUT_KEY,
    resultKey: POSE_RESULT_KEY,
    inputSide: POSE_INPUT_SIDE,
    // uint8 and FOUR channels, read from the model itself (see POSE_INPUT_DTYPE): the
    // upstream card describes int32 x 3 and the web export is neither.
    tensorType: POSE_INPUT_DTYPE,
    dims: (side) => [1, side, side, POSE_INPUT_CHANNELS],
    descriptor: (parameters) => (parameters["model"] === "fast" ? POSE_LIVE : POSE_ACCURATE),
    pack: (texels, side) => packPoseInput(texels, side),
    // The keypoint map is a fixed 17x1 whatever the source is, so the node's size is not
    // consulted — the joints are the data, not a picture of them.
    encode: (output) => keypointsToTexture(output),
    fallback: () => neutralPose(),
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
}

export function useModelInference(
  backend: ShaderloomBackend | null | undefined,
  sink?: NodeMetricSink | undefined,
): ModelInferenceBinding {
  const backendRef = useRef(backend);
  backendRef.current = backend;

  const [states, setStates] = useState<Readonly<Record<string, AcquisitionState>>>({});
  const targetsRef = useRef<readonly DepthTarget[]>([]);
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
          nodeType: found.kind.nodeType as "depth" | "pose",
          width: found.size[0],
          height: found.size[1],
          side: found.kind.inputSide,
        };
      },
      weightsFor: async (modelId) => {
        const descriptor = targetsRef.current.find((t) => t.descriptor.id === modelId)?.descriptor;
        if (descriptor === undefined) return undefined;
        return await acquisition.acquire(descriptor);
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

  const track = useCallback(
    (graph: GraphDocument, compiled: CompiledGraph | null) => {
      const allocated = new Set((compiled?.resources ?? []).map((resource) => resource.id));
      const sized = new Map<string, readonly [number, number]>();
      for (const resource of compiled?.resources ?? []) {
        const entry = resource as { id?: string; size?: readonly [number, number] };
        if (entry.id !== undefined && entry.size !== undefined) sized.set(entry.id, entry.size);
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
        targets.push({
          nodeId,
          kind,
          descriptor: kind.descriptor(node.parameters),
          size: sized.get(resultId) ?? [1, 1],
        });
      }
      targetsRef.current = targets;

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
      // Only once the weights are actually held: `sample` would otherwise call `acquire`
      // through the runner on every frame and start a download nobody agreed to.
      const ready = targetsRef.current.some(
        (candidate) => states[candidate.descriptor.id]?.kind === "ready",
      );
      if (!ready) return;
      // Between frames, like analyze: `readBuffer` fails the frame guard from inside one.
      queueMicrotask(() => sources.sample(frame.frameIndex));
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
    () => buildNotices(targetsRef.current, states, acquisition),
    [states, acquisition],
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
  return useMemo(() => ({ observe, track, settle, notices }), [observe, track, settle, notices]);
}

/**
 * §V469: not silent, not fatal. Availability is a DECISION and gets a button; staleness
 * changes every frame and lives on the telemetry channel instead.
 */
export function buildNotices(
  targets: readonly DepthTarget[],
  states: Readonly<Record<string, AcquisitionState>>,
  acquisition: { acquire(d: ModelDescriptor): unknown; cancel(id: string): void },
): readonly Notice[] {
  const notices: Notice[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const { descriptor } = target;
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    const state = states[descriptor.id] ?? { kind: "unknown" };

    if (state.kind === "absent") {
      notices.push({
        id: `model-consent-${descriptor.id}`,
        tone: "info",
        message: `${target.kind.nodeType === "pose" ? "Pose" : "Depth"} needs ${descriptor.label}.`,
        detail: `${formatBytes(descriptor.bytes)}, downloaded once per machine and kept for every project. Until then the node publishes its neutral output, so the document still renders.`,
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
  return notices;
}
