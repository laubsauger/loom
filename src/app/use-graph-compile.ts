import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { compileGraph } from "@compiler/index.ts";
import type { ActiveSink, CompiledGraph, ParameterResolution } from "@compiler/index.ts";
import { graphChannelResolver, hasAnimatedParameters } from "@domain/channels/graph-channels.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { analyzeReadbacks, nodeCategories, telemetryPlan } from "@runtime/telemetry/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { PreviewSinkStore } from "./preview-sinks.ts";

/** A stable no-op store so the hook's subscription arity never changes. */
const EMPTY_SINKS: ReadonlyArray<ActiveSink> = [];
const NO_STORE = { subscribe: () => () => {}, get: () => EMPTY_SINKS };

/** Shared empty default, so omitting the argument does not re-key the compile memo. */
const NO_CHANNELS: readonly ChannelResolver[] = [];
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRunStatus, NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { registerCompileCommand } from "./compile-command.ts";
import type { CompileResultView } from "./compile-command.ts";

/**
 * Compiles the document and routes the result to the two places that need it: the
 * problems tab (whole-graph diagnostics) and each node's badge (§V27).
 *
 * The compiler is pure and cheap, so it runs on every revision. Its diagnostics reach a
 * node through the runtime channel, NOT through the document — per-node status is
 * derived state and must not enter the store or re-render the tree (§V16). Each node
 * component subscribes to its own id, so a diagnostic on one node repaints one node.
 *
 * With no capability report there is no compile: the format rules are validated against
 * the device (§V51), and inventing a device to validate against is exactly what §V12
 * forbids. That state reports itself instead of guessing.
 */

export interface GraphCompileResult {
  readonly graph: GraphDocument;
  /** Null while the capability report is missing — see §V12 note above. */
  readonly compiled: CompiledGraph | null;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly errorCount: number;
  /**
   * Re-resolves this graph AT a frame, for the per-frame values-only push (T259, §V163).
   *
   * NULL when nothing in the document animates — no expression, no driven slot, no bind.
   * That is the gate, and it is why a static project pays literally nothing per frame:
   * the frame loop has no function to call, not a function that returns early.
   *
   * The plan that comes back is the same plan structurally; only its pass uniform VALUES
   * move. The caller pushes those with `updateUniforms` (§V5) — see
   * `animate-parameters.ts`. It never reaches `backend.compile`.
   */
  readonly animate: ((frame: FrameEvaluationInput) => CompiledGraph | null) | null;
}

/**
 * Every visible texture-producing node previews by default (§V28b) — TD parity: a
 * disconnected node shows its output rather than a blank box until it is wired to an
 * Output. VISIBILITY, not `ui.preview`, is what makes a node a preview sink; `ui.preview`
 * is an explicit PIN now (§V28b), not the on-switch, so it plays no part here.
 *
 * "Visible" at this layer means "exists in the graph with a texture output" — the
 * compiler has no notion of scroll position, and recompiling on every pan would defeat
 * §V16. On-screen visibility is a presentation-layer concern: §V28's scheduler (already
 * built) suspends offscreen/collapsed previews cheaply, per frame, without touching the
 * compiled plan (§V28c) — that is what makes this affordable for a 200-node graph.
 *
 * §V28a: this list is AUTHORITATIVE and passed on every compile, never partial.
 */
function visiblePreviewSinks(graph: GraphDocument, registry: NodeRegistryView): ActiveSink[] {
  const sinks: ActiveSink[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    const texturePort = definition.outputs.find((port) => port.type.kind === "texture2d");
    if (texturePort === undefined) continue;
    sinks.push({ nodeId, portId: texturePort.id, kind: "preview" });
  }
  return sinks;
}

/**
 * §V12: with no capability report there is nothing to validate formats against, and
 * inventing a device is exactly what that invariant forbids. A caller is told that,
 * rather than handed an empty plan that reads as "your graph compiles to nothing".
 */
const NO_DEVICE_DIAGNOSTIC: RuntimeDiagnostic = {
  severity: "error",
  code: "compile.noDevice",
  message: "No GPU capability report, so nothing was compiled.",
  suggestion:
    "Compilation validates resolutions and formats against the live device. Open this where WebGPU is available.",
};

function statusFor(errors: number, warnings: number, compiled: boolean): NodeRunStatus {
  if (errors > 0) return "error";
  if (warnings > 0) return "warning";
  return compiled ? "valid" : "idle";
}

function compileSafely(
  graph: GraphDocument,
  runtime: AppRuntime,
  capabilities: BackendCapabilities,
  resolution: ParameterResolution = {},
  previewSinks?: ReadonlyArray<ActiveSink>,
): { compiled: CompiledGraph | null; diagnostics: RuntimeDiagnostic[] } {
  try {
    const compiled = compileGraph({
      graph,
      settings: runtime.settings,
      registry: runtime.registry,
      capabilities,
      // T252 (§V158, B18): the scheduler's KEPT set when a store is wired — the
      // partition that stops every off-screen node rendering every frame. The old
      // every-texture-node fallback stands only where no scheduler exists (tests,
      // project.compile): over-rendering is safe there; under-rendering never is.
      sinks: previewSinks ?? visiblePreviewSinks(graph, runtime.registry),
      resolution,
    });
    return { compiled, diagnostics: [...compiled.diagnostics] };
  } catch (error) {
    // A compiler crash is a bug, but it is not a reason to unmount the editor: report
    // it where every other problem is reported and keep the document editable.
    return {
      compiled: null,
      diagnostics: [
        {
          severity: "error",
          code: "compiler.crashed",
          message: `The compiler threw: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/** Publishes per-node diagnostic counts onto the runtime channel (§V16, §V27). */
function publishNodeStatus(
  store: NodeRuntimeStore,
  graph: GraphDocument,
  diagnostics: readonly RuntimeDiagnostic[],
  compiled: boolean,
  previous: Set<NodeId>,
): Set<NodeId> {
  const byNode = new Map<NodeId, { errors: number; warnings: number; message: string | null }>();
  for (const nodeId of Object.keys(graph.nodes)) {
    byNode.set(nodeId, { errors: 0, warnings: 0, message: null });
  }
  for (const diagnostic of diagnostics) {
    const nodeId = diagnostic.nodeId;
    if (nodeId === undefined) continue;
    const entry = byNode.get(nodeId);
    if (entry === undefined) continue;
    if (diagnostic.severity === "error") entry.errors += 1;
    else if (diagnostic.severity === "warning") entry.warnings += 1;
    else continue;
    // Highest severity wins the one line the node badge can show.
    if (entry.message === null || diagnostic.severity === "error") entry.message = diagnostic.message;
  }

  for (const [nodeId, entry] of byNode) {
    store.publish(nodeId, {
      status: statusFor(entry.errors, entry.warnings, compiled),
      errorCount: entry.errors,
      warningCount: entry.warnings,
      message: entry.message,
    });
  }
  for (const nodeId of previous) {
    if (!byNode.has(nodeId)) store.clear(nodeId);
  }
  return new Set(byNode.keys());
}

export function useGraphCompile(
  runtime: AppRuntime,
  capabilities: BackendCapabilities | null,
  previewSinks?: PreviewSinkStore,
  /**
   * Channel resolvers consulted BEFORE the graph one, in order (T305, §V144).
   *
   * Analyze publishes its node's name as a channel from a readback, and the graph resolver
   * publishes value-source nodes from their parameters. They share one namespace (§V129:
   * names are identifiers), so the merge order is the contract: an Analyze named `meter1`
   * wins over anything else called `meter1`, because a readback is a measurement of the
   * running program and the other is a computation about it.
   *
   * Each must keep a stable identity — they key the compile memo.
   */
  extraChannels: readonly ChannelResolver[] = NO_CHANNELS,
): GraphCompileResult {
  const graph = useSyncExternalStore<GraphDocument>(
    runtime.bus.store.subscribe,
    runtime.bus.store.getGraph,
    runtime.bus.store.getGraph,
  );
  // T252 (§V158): the scheduler's kept set gates PREVIEW-ONLY materialization. The
  // store notifies only on genuine change, so pans and idle ticks recompile nothing.
  const scheduledPreviews = useSyncExternalStore(
    previewSinks?.subscribe ?? NO_STORE.subscribe,
    previewSinks?.get ?? NO_STORE.get,
    previewSinks?.get ?? NO_STORE.get,
  );

  // Cache for `project.compile`, keyed by the revision it was produced from. Only a
  // compile that actually ran is cached: "no device report" must stay a live answer, not
  // a remembered empty one.
  const cacheRef = useRef<{ revision: number; view: CompileResultView } | null>(null);

  /**
   * The channel resolver, for BOTH compiles (T238, T259).
   *
   * The structural compile gets it too, with no frame — so a driven parameter resolves at
   * its zero-frame value rather than reporting "channel lfo1 is not attached". It IS
   * attached; only the moment differs. Without this the problems tab tells the user their
   * LFO is unwired on every compile of a graph that animates perfectly well, which is the
   * kind of false alarm that teaches people to ignore the panel.
   */
  const channels = useMemo(() => {
    const graphChannels = graphChannelResolver(graph, runtime.registry);
    if (extraChannels.length === 0) return graphChannels;
    const merged: ChannelResolver = (channel, context) => {
      for (const resolver of extraChannels) {
        const value = resolver(channel, context);
        // FIRST NON-UNDEFINED WINS. `undefined` means "not mine", which is different from
        // a channel that exists and is momentarily 0 — collapsing the two would let a
        // silent Analyze fall through to a same-named LFO and animate from the wrong source.
        if (value !== undefined) return value;
      }
      return graphChannels(channel, context);
    };
    return merged;
  }, [extraChannels, graph, runtime]);

  /**
   * §V163's gate. `hasAnimatedParameters` is a scan of stored parameter modes — cheap,
   * and run once per document revision rather than once per frame.
   */
  const animate = useMemo(() => {
    if (capabilities === null || !hasAnimatedParameters(graph)) return null;
    return (frame: FrameEvaluationInput): CompiledGraph | null =>
      compileSafely(graph, runtime, capabilities, { frame, channels }).compiled;
  }, [capabilities, channels, graph, runtime]);

  const result = useMemo<GraphCompileResult>(() => {
    if (capabilities === null) {
      return { graph, compiled: null, diagnostics: [], errorCount: 0, animate: null };
    }
    const { compiled, diagnostics } = compileSafely(
      graph,
      runtime,
      capabilities,
      { channels },
      previewSinks === undefined ? undefined : scheduledPreviews,
    );
    cacheRef.current = { revision: graph.revision, view: { compiled, diagnostics } };
    return {
      graph,
      compiled,
      diagnostics,
      errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
      animate,
    };
  }, [animate, channels, graph, runtime, capabilities, previewSinks, scheduledPreviews]);

  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;

  /**
   * What `project.compile` answers with (T220).
   *
   * Reads the store rather than the rendered `result`: a command handler runs inside
   * `bus.execute`, synchronously after a patch, and React has not necessarily re-rendered
   * yet — so an agent that patched and then compiled would otherwise be handed the plan
   * from before its own edit. When the revision has not moved this returns the very
   * object the UI is rendering, which is what keeps it one compile path and not two.
   */
  const compileNow = useCallback((): CompileResultView => {
    const current = runtime.bus.store.getGraph();
    const cached = cacheRef.current;
    if (cached !== null && cached.revision === current.revision) return cached.view;
    const capability = capabilitiesRef.current;
    if (capability === null) {
      return { compiled: null, diagnostics: [NO_DEVICE_DIAGNOSTIC] };
    }
    const view = compileSafely(current, runtime, capability);
    cacheRef.current = { revision: current.revision, view };
    return view;
  }, [runtime]);

  useEffect(() => {
    const holder = registerCompileCommand(runtime.bus);
    holder.current = { compileNow };
    return () => {
      if (holder.current?.compileNow === compileNow) holder.current = null;
    };
  }, [compileNow, runtime]);

  // The static half of the performance tab and of every node info popup (T41, §V85).
  // Once per compile, never per frame: the plan does not change between frames, and
  // pushing it at frame rate is exactly the §V16 mistake the hub exists to prevent.
  useEffect(() => {
    runtime.telemetry.setPlan(
      result.compiled === null
        ? null
        : telemetryPlan(result.compiled, {
            memoryBudgetBytes: runtime.settings.limits.memoryBudgetBytes,
            // T278/§V185: what this graph costs per frame in readbacks. Derived from the
            // graph the plan was built from, so the count moves the moment an Analyze node
            // is added — which is the point: the cost has to be visible where it is made.
            readbacks: analyzeReadbacks(result.graph, runtime.registry),
            // T256: the rollup dimension. From the DOCUMENT, because the plan carries node
            // ids and never node types.
            categories: nodeCategories(result.graph, runtime.registry),
          }),
    );
    // `result.graph` moves with `result.compiled` — both come out of the same compile —
    // so listing it costs no extra pushes and keeps the dependency honest.
  }, [result.compiled, result.graph, runtime]);

  const publishedRef = useRef<Set<NodeId>>(new Set());
  useEffect(() => {
    publishedRef.current = publishNodeStatus(
      runtime.nodeRuntime,
      result.graph,
      result.diagnostics,
      result.compiled !== null,
      publishedRef.current,
    );
  }, [runtime.nodeRuntime, result]);

  return result;
}
