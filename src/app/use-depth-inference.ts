import { useCallback, useMemo, useRef, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { NodeMetricSink } from "@runtime/telemetry/index.ts";
import { DEPTH_INPUT_KEY, DEPTH_INPUT_SIDE, DEPTH_RESULT_KEY } from "@nodes/definitions/index.ts";
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
import { DEPTH_ACCURATE, DEPTH_LIVE } from "@runtime/models/model-catalogue.ts";
import { depthToRgba, neutralDepth, packModelInput } from "@runtime/models/depth-runner.ts";
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

const DEPTH_TYPE = "depth";

function descriptorFor(parameters: Record<string, unknown>): ModelDescriptor {
  return parameters["model"] === "fast" ? DEPTH_LIVE : DEPTH_ACCURATE;
}

/** One tracked Depth node: what it needs and how big its picture is. */
interface DepthTarget {
  readonly nodeId: string;
  readonly descriptor: ModelDescriptor;
  readonly size: readonly [number, number];
}

export interface DepthInferenceBinding {
  /** Frame-loop observer. Publishes staleness, then queues the next inference. Stable. */
  readonly observe: (frame: FrameEvaluationInput) => void;
  /** Re-derives the tracked set. Call after each compile. Stable. */
  readonly track: (graph: GraphDocument, compiled: CompiledGraph | null) => void;
  /** Consent, progress and failure, for the strip under the top bar. */
  readonly notices: readonly Notice[];
}

export function useDepthInference(
  backend: ShaderloomBackend | null | undefined,
  sink?: NodeMetricSink | undefined,
): DepthInferenceBinding {
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

  /** Model id -> a loaded session, kept so a second node pays nothing. */
  const sessionsRef = useRef<Map<string, Promise<unknown>>>(new Map());

  const sessionFor = useCallback(
    async (descriptor: ModelDescriptor): Promise<unknown> => {
      const existing = sessionsRef.current.get(descriptor.id);
      if (existing !== undefined) return existing;
      const started = (async () => {
        const weights = await acquisition.acquire(descriptor);
        if (weights === undefined) throw new Error(`${descriptor.label} is not available`);
        const ort = await import("onnxruntime-web");
        // The ladder, as the runtime expresses it (T736). WebGPU first; a machine without
        // it falls to wasm rather than failing. What gets REPORTED is whichever one
        // actually produced a result, never the one that was asked for (§V672).
        return await ort.InferenceSession.create(weights, {
          executionProviders: ["webgpu", "wasm"],
        });
      })();
      sessionsRef.current.set(descriptor.id, started);
      return started;
    },
    [acquisition],
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
        run: async (nodeId, input) => {
          const target = targetsRef.current.find((candidate) => candidate.nodeId === nodeId);
          if (target === undefined) throw new Error(`No depth target for "${nodeId}".`);
          const session = (await sessionFor(target.descriptor)) as {
            run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
            inputNames: readonly string[];
            outputNames: readonly string[];
          };
          const ort = await import("onnxruntime-web");
          const pixels = packModelInput(new Float32Array(input), DEPTH_INPUT_SIDE);
          const tensor = new ort.Tensor("float32", pixels, [1, 3, DEPTH_INPUT_SIDE, DEPTH_INPUT_SIDE]);
          const inputName = session.inputNames[0] ?? "pixel_values";
          const outputs = await session.run({ [inputName]: tensor });
          const outputName = session.outputNames[0] ?? "predicted_depth";
          const depth = outputs[outputName]?.data;
          if (depth === undefined) throw new Error("The model returned no depth output.");
          return depthToRgba(depth, DEPTH_INPUT_SIDE, target.size[0], target.size[1]);
        },
      }),
    [sessionFor],
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
        if (node === undefined || node.type !== DEPTH_TYPE) continue;
        // A Depth node the plan did not allocate resources for is UNWIRED — §V585's
        // pruning. It must not be tracked, must not acquire and must not download.
        const resultId = scratchResourceId(nodeId, DEPTH_RESULT_KEY);
        if (!allocated.has(resultId)) continue;
        targets.push({
          nodeId,
          descriptor: descriptorFor(node.parameters),
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
        inputResourceId: scratchResourceId(target.nodeId, DEPTH_INPUT_KEY),
        sourceId: inferenceSourceIdFor(target.nodeId),
        fallback: neutralDepth(target.size[0], target.size[1]),
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
  return useMemo(() => ({ observe, track, notices }), [observe, track, notices]);
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
        message: `Depth needs ${descriptor.label}.`,
        detail: `${formatBytes(descriptor.bytes)}, downloaded once per machine and kept for every project. Until then Depth publishes a flat map, so the document still renders.`,
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
        detail: `${state.reason}. Depth is publishing a flat map, so the document still renders.`,
        actions: [
          { label: "Try again", onSelect: () => void acquisition.acquire(descriptor), variant: "outline" },
        ],
      });
    }
  }
  return notices;
}
