import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { compileGraph } from "@compiler/index.ts";
import { classifyGraphChange, isValuesOnly } from "./classify-revision.ts";
import type { ActiveSink, CompiledGraph, ParameterResolution } from "@compiler/index.ts";
import { graphChannelResolver, hasAnimatedParameters } from "@domain/channels/graph-channels.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { analyzeReadbacks, nodeCategories, telemetryPlan } from "@runtime/telemetry/index.ts";
import { structuralSettingsKey } from "@domain/project/settings-change.ts";
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
  /**
   * The channel resolver this compile used — published so the INSPECTOR reads through it
   * too (B46, T374, §V61).
   *
   * §V61 says there is one parameter read path, and the inspector has always been on it.
   * What it did not have was this OPTION, so `resolveParameters` ran there with no
   * channel resolver at all and every `driven` parameter in the panel fell back to its
   * retained static and reported `parameter.driven`: "channel lfo1 is not attached", on a
   * project whose LFO was visibly animating the same parameter a few pixels away. That is
   * B8 with the sides swapped — the inspector showing the fallback while the GPU shows the
   * reference — and the fix B8 recorded is that the two must not be two resolvers.
   *
   * So it is the same object, not an equivalent one. Handing the panel its own merge of
   * the same inputs would be a second resolver that agrees today by inspection.
   *
   * Frameless on the inspector's side: `useValueGraph`'s resolver answers a no-frame read
   * from a THROWAWAY zero-frame session keyed on the document revision, so rendering a
   * panel cannot advance a stateful stage (a Lag must not move because someone opened the
   * inspector). Stable identity, so it does not re-key anything downstream.
   */
  readonly channels: ChannelResolver;
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
  /**
   * True when this revision changed VALUES ONLY, so the backend may be handed new
   * uniforms instead of a new plan (T308, §V5).
   *
   * Deliberately a separate channel rather than a suppressed `compiled`: the fresh plan
   * still reaches the telemetry hub, the per-node status badges (§V27), the
   * `project.compile` cache and the preview request builder exactly as before. Only the
   * BACKEND behaves differently, which keeps the blast radius of this optimisation to the
   * one seam it is about.
   *
   * False whenever there is any doubt — see `classify-revision.ts`. And it is a
   * suggestion, not an instruction: the consumer verifies it against the real plans
   * before acting on it.
   */
  readonly valuesOnly: boolean;
  /**
   * True when temporal history can no longer be reused (§V22) — this revision must land
   * on cleared feedback pairs and rings (T519, B106).
   *
   * `RecompileDecision.resetFeedback` has been computed since T31 and read by NOTHING:
   * `grep` finds it produced at eight sites in `recompile.ts` and consumed at zero. So
   * "a resolution change resets feedback" was a documented property of a value nobody
   * looked at. This is the wire, and the case that forced it is the one where being
   * wrong is visible: `backend.compile` carries resources over BY RESOURCE ID and a
   * carried ping-pong keeps its CONTENTS (§V62b, T143) — correct within one document,
   * cross-document contamination the moment two projects share a node name.
   *
   * Acted on AFTER the new plan is installed, never before: `resetTemporalHistory`
   * clears the ACTIVE program's rings, and the active program is still the previous
   * document's until `backend.compile` resolves (`use-frame-loop.ts`).
   */
  readonly resetFeedback: boolean;
}

/**
 * Every visible texture-producing node previews by default (§V28b) — TD parity: a
 * disconnected node shows its output rather than a blank box until it is wired to an
 * Output. VISIBILITY is what makes a node a preview sink; the DEFAULT is on, so this
 * asks only whether someone has switched a node's preview off (T353, §V297).
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
    // OFF means off everywhere, including on the path that has no scheduler to ask
    // (§V297): a node nobody is previewing must not be materialized for one.
    if (node.ui?.preview === false) continue;
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
      /**
       * B29 — the component catalogue, which this call did not pass for the whole life of
       * the feature.
       *
       * `compileGraph` flattens ONLY when this field is supplied (§V82), and nothing in
       * `src/` supplied it. So every component instance fell through to the manifest's
       * `component.notFlattened` tripwire and contributed no passes: the starter set
       * (Bloom, FeedbackEcho, Kaleidoscope, DisplacementStack, MediaGrade) was visible in
       * the library, instantiable from it, and produced a graph that did not compile.
       * Measured on a Bloom instance wired between a Solid and an Output — before:
       * `error:component.notFlattened`, 2 passes; after: no errors, 7.
       *
       * `registry` is the component-AWARE node view, so an instance already typed and
       * connected correctly (§V13) — which is exactly why this was invisible until
       * someone tried to render one.
       */
      components: runtime.components.view(),
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

/**
 * §V210(c) — a component-catalogue edit is a structural trigger with NO document edit.
 *
 * Editing a component's internal graph changes what flattening produces for every host
 * that instantiates it, while the host document is untouched: same nodes, same edges,
 * same revision. A gate keyed on the document (T308) would classify that as "nothing
 * changed" and keep serving a plan built from the old internals — and it would do it
 * silently, because the host looks exactly the same before and after.
 *
 * This was harmless in the only sense that matters least: it was harmless while components
 * never reached the compiler at all (B29). Fixing that is what makes this necessary, so
 * the two halves land together.
 *
 * The registry notifies but keeps no revision of its own, so one is counted here. A
 * counter rather than `all()`: `useSyncExternalStore` demands a snapshot that is stable
 * when nothing has changed, and `all()` builds a fresh array on every call — which would
 * spin the render loop rather than fix anything.
 */
function useCatalogueRevision(components: AppRuntime["components"]): number {
  const revision = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) =>
      components.subscribe(() => {
        revision.current += 1;
        onChange();
      }),
    [components],
  );
  const snapshot = useCallback(() => revision.current, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
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
  const catalogueRevision = useCatalogueRevision(runtime.components);

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
   *
   * B95 — the SAME sinks as the structural compile, never the fallback. This call used
   * to omit the sink argument, so `compileSafely` fell back to every-visible-node while
   * the base plan below compiles against the preview SCHEDULER's kept set. The two
   * agreed on a fresh load, so animation worked — until the scheduler suspended one
   * offscreen preview, the base plan lost a pass, and every per-frame plan from here
   * was no longer a values-only variation of it: `push` returned null, one
   * `animation/structuralDrift` warning fired, and every driven parameter in the
   * project sat at its last value for the rest of the session. Measured live (E28: the
   * orbiting caster froze the moment a pane covered part of the graph). The sink set is
   * DERIVED from the one store both compiles read, so they cannot disagree again.
   */
  const animate = useMemo(() => {
    if (capabilities === null || !hasAnimatedParameters(graph)) return null;
    return (frame: FrameEvaluationInput): CompiledGraph | null =>
      compileSafely(
        graph,
        runtime,
        capabilities,
        { frame, channels },
        previewSinks === undefined ? undefined : scheduledPreviews,
      ).compiled;
  }, [capabilities, channels, graph, runtime, previewSinks, scheduledPreviews]);

  /**
   * The inputs of the LAST compile, for classifying the next one (T308).
   *
   * §V210 is the reason this holds four things and not just the graph: the compile gate
   * has several independent structural triggers and the document revision is only one of
   * them. An input that changes without producing a document edit is invisible to a
   * revision-keyed gate, so each one is compared explicitly and any of them forces a full
   * compile:
   *
   *  (a) the SINK SET — opening or closing a preview is not a document edit at all, so
   *      there is nothing to classify and a document diff would answer "nothing changed"
   *      while the plan needs a sink materialized;
   *  (b) BACKEND CAPABILITIES — a device recovery can hand back a different adapter, and
   *      a plan compiled against the old one is not valid against the new;
   *  (d) SETTINGS — but only the STRUCTURAL ones (§V178, T272). Settings are live now,
   *      and comparing the OBJECT would make every settings edit structural: dragging an
   *      fps field would recompile the graph sixty times a second, and it would do so
   *      BECAUSE the user was adjusting how often it draws. `structuralSettingsKey`
   *      projects the fields a plan actually depends on — resolution, working format,
   *      limits, seed — so a rate change produces an identical key and cannot reach the
   *      compiler.
   *
   * (c), component-catalogue edits, is the one trigger with nothing to do: `compileSafely`
   * passes no `components` to `compileGraph`, so component flattening is not part of this
   * compile path at all and an edit to a component definition cannot reach it. That is a
   * gap worth its own task; it is not one this gate can widen.
   */
  const lastCompile = useRef<{
    graph: GraphDocument;
    /**
     * (e) the DOCUMENT the graph above belongs to (T519, B106).
     *
     * The fifth independent trigger, and the one whose absence was a correctness bug
     * rather than a wasted compile. Every other entry here asks "did an input change";
     * this one asks "is this even the same document", and without it the diff below
     * compared two unrelated projects by NODE ID and answered from whatever their names
     * happened to have in common.
     */
    documentIdentity: string;
    sinks: unknown;
    capabilities: BackendCapabilities | null;
    /** The STRUCTURAL projection, not the object: §V178's gate (T272). */
    settingsKey: string;
    catalogue: number;
    view: CompileResultView;
  } | null>(null);

  const result = useMemo<GraphCompileResult>(() => {
    if (capabilities === null) {
      // No device, no plan (§V12) — but the panel still resolves, so the resolver still
      // travels. Dropping it here would make "the inspector says lfo1 is not attached"
      // true again on exactly the machines that cannot compile.
      return {
        graph,
        channels,
        compiled: null,
        diagnostics: [],
        errorCount: 0,
        animate: null,
        valuesOnly: false,
        resetFeedback: false,
      };
    }
    const previous = lastCompile.current;
    const settingsKey = structuralSettingsKey(runtime.settings);
    const sameInputs =
      previous !== null &&
      // T519 — belt and braces with the classifier below. Both gates that can reuse
      // work (`valuesOnly`, and the editor-only plan reuse) hang off this flag, so
      // pinning the document here means neither can span a load even if the
      // classification is later softened.
      previous.documentIdentity === runtime.documentIdentity &&
      previous.sinks === scheduledPreviews &&
      previous.capabilities === capabilities &&
      previous.settingsKey === settingsKey &&
      previous.catalogue === catalogueRevision;
    const change =
      previous === null
        ? null
        : classifyGraphChange(
            { identity: previous.documentIdentity, graph: previous.graph },
            { identity: runtime.documentIdentity, graph },
            runtime.registry,
          );
    const valuesOnly = sameInputs && change !== null && isValuesOnly(change);

    // §V178 ENFORCED rather than documented. A non-structural settings edit bumps the
    // revision (§V177) and so hands this memo a NEW graph object — while the document's
    // content is exactly what it was, so there is nothing to compile. Reusing the previous
    // plan is what makes "an fps edit does not recompile" true rather than intended.
    if (sameInputs && previous !== null && change !== null && change.work === "editor-only") {
      cacheRef.current = { revision: graph.revision, view: previous.view };
      lastCompile.current = { ...previous, graph };
      return {
        graph,
        channels,
        compiled: previous.view.compiled,
        diagnostics: previous.view.diagnostics,
        errorCount: previous.view.diagnostics.filter((entry) => entry.severity === "error").length,
        animate,
        valuesOnly: false,
        // The plan is the one already installed, so there is nothing new to land on.
        resetFeedback: false,
      };
    }

    const { compiled, diagnostics } = compileSafely(
      graph,
      runtime,
      capabilities,
      { channels },
      previewSinks === undefined ? undefined : scheduledPreviews,
    );
    cacheRef.current = { revision: graph.revision, view: { compiled, diagnostics } };
    lastCompile.current = {
      graph,
      documentIdentity: runtime.documentIdentity,
      sinks: scheduledPreviews,
      capabilities,
      settingsKey,
      catalogue: catalogueRevision,
      view: { compiled, diagnostics },
    };
    return {
      graph,
      channels,
      compiled,
      diagnostics,
      errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
      animate,
      valuesOnly,
      // False on the FIRST compile (`change === null`): there is no history yet, and
      // asking the backend to clear a program it has not been given would be a call
      // into nothing.
      resetFeedback: change?.resetFeedback === true,
    };
  }, [animate, channels, graph, runtime, capabilities, previewSinks, scheduledPreviews, catalogueRevision]);

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
