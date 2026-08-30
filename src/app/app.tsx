import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scopeFromFrame } from "@domain/expressions/index.ts";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { CommandResult } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { LoadProjectSuccess, SnapshotStore } from "@domain/project/index.ts";
import { HelpHost, OPEN_HELP_COMMAND } from "@editor/help/index.ts";
import { NodeInfoHost } from "@editor/inspect/index.ts";
import { KeymapProvider } from "@editor/keymap/index.ts";
import type { KeymapEnvironment } from "@editor/keymap/index.ts";
import { ComponentLibrary, ExampleLibrary, useDocumentDirty } from "@editor/library/index.ts";
import { CommandPalette } from "@editor/palette/index.ts";
import { ProblemsPanel } from "@editor/shader-editor/index.ts";
import { Button } from "@ui/index.ts";
import { UnsavedChangesDialog } from "@ui/primitives/unsaved-changes-dialog.tsx";
import { AppRuntimeContext } from "./app-context.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { AgentToolSurface } from "@agent/index.ts";
import { AppShell } from "./app-shell.tsx";
import { AgentPane, PerformancePane, ShaderPane } from "./dock-panes.tsx";
import type { CookPolicyValue } from "@editor/inspect/index.ts";
import { GraphPane } from "./graph-pane.tsx";
import type { GraphActions, PortDragOrigin } from "./graph-pane.tsx";
import type { GpuStatus } from "./gpu-status.ts";
import { sharedGpuProbe } from "./gpu-status.ts";
import { PANE_TITLES } from "./layout-storage.ts";
import type { LayoutStorage, PaneId } from "./layout-storage.ts";
import type { OpenPaneWindow } from "./pane-window.tsx";
import { NoticeStrip } from "./notices.tsx";
import type { Notice } from "./notices.tsx";
import { InspectorPane, LibraryPane, ViewerPane } from "./side-panes.tsx";
import { TimelineReadout } from "./timeline-readout.tsx";
import { TopBar } from "./top-bar.tsx";
import { useAgentSurface } from "./use-agent-surface.ts";
import { useAgentPorts } from "./agent-ports.ts";
import { usePulseFiring } from "./pulse-firing.ts";
import { useRuntimeCommands } from "./runtime-commands.ts";
import { createPreviewSinkStore } from "./preview-sinks.ts";
import { useAutosave } from "./use-autosave.ts";
import { useGpuStatus } from "./use-gpu-status.ts";
import { useGpuRecovery } from "./use-gpu-recovery.ts";
import { useFrameLoop } from "./use-frame-loop.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createPointerSource } from "@runtime/execution/index.ts";
import { useAnalyzeChannels } from "./use-analyze-channels.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
import { useValueGraph } from "./use-value-graph.ts";
import { useMediaSources } from "./use-media-sources.ts";
import { useProject } from "./use-project.ts";

/**
 * The composition root (T51, T139).
 *
 * This is the map of the system. Read top to bottom it says: there is ONE registry, ONE
 * document store, ONE command bus, ONE telemetry hub and ONE actor identity; every pane
 * receives them from one context; and every edit any pane makes — a dragged connection,
 * an inspector field, a hotkey, the palette, a library drop, a save, an open — becomes a
 * command on that bus (§V29). If a second mutation path is ever introduced, it will be
 * visible here as a second thing being constructed.
 *
 * ## What this file exists to prevent
 *
 * Every subsystem in this repo has passed its own suite while being unreachable from the
 * running app. The seam between a finished track and the product is nobody's task by
 * default, so it is this file's task by construction: the telemetry hub is built here,
 * fed here and read here; the node info popup is hosted here so all three of its routes
 * reach it; autosave is subscribed here because only here is the store; the project I/O
 * commands are registered here because only here is there a window to open a picker in.
 *
 * ## What is NOT here, on purpose
 *  - no timing source on the hub. Timing is a GPU timer span or it is nothing (§V86);
 *    the frame loop (T184, `useFrameLoop`) submits work, but a span only exists once
 *    the device reports timestamp-query (§V12), so the panel still says "unavailable"
 *    rather than showing a number nobody measured.
 *  - no GPU calls made directly. React encodes none (§V2); the device is acquired by the runtime
 *    adapter and only its capability report reaches this tree (§V12).
 *  - no per-frame data in the document. Node status and timings ride the runtime
 *    channel, which repaints one node instead of the tree (§V16).
 */

export interface AppProps {
  /** Injectable for tests; production builds one at mount. */
  runtime?: AppRuntime;
  /** Layout persistence override (`null` disables it). Defaults to `localStorage` (§V18). */
  storage?: LayoutStorage | null;
  /** Capability probe override, so a test can drive the WebGPU-missing path. */
  gpuProbe?: () => Promise<GpuStatus>;
  /**
   * Autosave storage factory. Defaults to the IndexedDB adapter, which answers
   * `undefined` where IndexedDB does not exist — that is surfaced, never swallowed.
   * MUST be stable across renders.
   */
  createSnapshotStore?: () => SnapshotStore | undefined;
  /**
   * Notified when opening a project REPLACES the runtime. See `project-commands.ts` for
   * why opening rebuilds rather than mutating a store in place.
   */
  onRuntimeChange?: (runtime: AppRuntime) => void;
  /**
   * Notified with the agent tool surface this root constructs (T220).
   *
   * The surface is headless and has no other handle into the tree, so an adapter — a
   * WebMCP bridge, a test asserting that B12 stays closed — needs one place to take it
   * from. Same shape and same reason as `onRuntimeChange`.
   */
  onAgentSurface?: (surface: AgentToolSurface) => void;
  /** Window opener for a floated pane (§V97). Injectable so a test needs no popup. */
  openPaneWindow?: OpenPaneWindow;
}

const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function App({
  runtime: providedRuntime,
  storage,
  gpuProbe,
  createSnapshotStore,
  onRuntimeChange,
  onAgentSurface,
  openPaneWindow,
}: AppProps = {}) {
  // The runtime is STATE, not a constant: opening a project replaces it wholesale.
  const [runtime, setRuntime] = useState<AppRuntime>(() => providedRuntime ?? createAppRuntime());
  // A runtime this component built is a runtime this component disposes; one handed in
  // by a caller is that caller's to dispose. Read when the effect RUNS, so the flag
  // describes the runtime the cleanup will actually be tearing down.
  const owned = useRef(providedRuntime === undefined);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  useEffect(() => {
    const disposeOnTeardown = owned.current;
    return () => {
      if (disposeOnTeardown) runtime.dispose();
    };
  }, [runtime]);

  // ---- view state the panes share --------------------------------------------------
  // Selection and hover are not document state — the graph models neither — but the
  // keymap resolves selection-driven command input against them (§T77).
  const [selection, setSelection] = useState<readonly NodeId[]>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<NodeId | null>(null);
  const [portDrag, setPortDrag] = useState<PortDragOrigin | null>(null);
  const [rejection, setRejection] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  /** A pane the browser refused to open a window for (§V97). It is docked again. */
  const [floatBlocked, setFloatBlocked] = useState<PaneId | null>(null);
  const actionsRef = useRef<GraphActions | null>(null);

  const onSelectionChange = useCallback((nodeIds: readonly NodeId[]) => {
    setSelection((previous) => (sameIds(previous, nodeIds) ? previous : [...nodeIds]));
  }, []);

  const onPortDragChange = useCallback((next: PortDragOrigin | null) => {
    setPortDrag((previous) => (previous === next ? previous : next));
  }, []);

  const clearPortDrag = useCallback(() => setPortDrag(null), []);

  const graphActions = useCallback(() => actionsRef.current, []);

  /**
   * A refused gesture must say so. The bus rejects an illegal connection (§V13) or a
   * stale patch (§V33) with diagnostics; without this they would vanish and the user
   * would see an edit that simply did not happen.
   */
  const onPatchResult = useCallback((result: CommandResult<"graph.applyPatch">) => {
    // A shared empty array, so a stream of successful edits does not churn state.
    setRejection(result.status === "applied" ? NO_DIAGNOSTICS : result.diagnostics);
  }, []);

  // ---- device, compile, diagnostics -------------------------------------------------
  const probe = gpuProbe ?? sharedGpuProbe;
  const status = useGpuStatus(probe);
  const capabilities = status.kind === "ready" ? status.capabilities : null;
  // T252 (§V158): one store links the preview scheduler's kept set to the compiler's
  // preview sinks — what is watched is what materializes, and nothing else renders.
  const previewSinks = useMemo(() => createPreviewSinkStore(), []);
  const backend = status.kind === "ready" ? status.backend : undefined;

  /**
   * B25/T305 — the CPU half of Analyze, constructed. Before this, `createAnalyzeChannels`
   * had exactly one construction site in the tree (its own GPU test), so an Analyze node
   * published no channel and the image→parameter loop was not closed in the product.
   *
   * It is built ABOVE the compile because the compile consumes its resolver, and it reads
   * the backend through a ref so a device-loss rebuild does not lose the latest values.
   */
  const analyze = useAnalyzeChannels(backend, runtime.registry);

  /**
   * B27/T305 — the value graph, constructed. `createValueGraphSession` had no caller, so
   * value EDGES, `valueEvaluate` and every stateful stage were dead in the product:
   * `mouse1 → lag1 → param` did nothing and the `stateful.reset` declarations pointed at
   * nothing. (T238's single-channel shorthand WAS live, so an LFO always worked — the bug
   * is smaller than "the value graph does nothing" and still real.)
   */
  const valueGraph = useValueGraph(runtime);

  /**
   * THE pointer (T324, B30, §V182, §V236).
   *
   * `PointerSource.set` had no caller: the frame loop created its own instance, nothing
   * outside that file could reach it, and so `FrameEvaluationInput.pointer` was a frozen
   * zero — every shader reading the shared block's pointer got (0,0), and Mouse, the only
   * wirable value source, read that same zero. Built here so the ONE surface that publishes
   * and the loop that samples hold the same object.
   */
  const pointer = useMemo(() => createPointerSource(), []);

  /**
   * The cook policy, CONSTRUCTED (T326, B32, §V157).
   *
   * `setCookPolicy` had no production caller, so T254's static-plan gate was unreachable
   * and the backend sat on its `"always"` default forever — a gate that shipped, was
   * tested, and could not be entered.
   *
   * It defaults to ALWAYS, and that is measured rather than cautious. §V157 requires
   * "auto" to be byte-identical to "always" at EVERY frame index; today it is not. The
   * uniform push runs in the frame callback, AFTER `render` has already asked the gate
   * whether to skip, so the first frame of new motion is skipped and its value lands one
   * frame late — the signature failure §V157 names. Making "auto" safe means pushing
   * values before the encode they belong to, which is a driver-ordering change with its
   * own risks and its own task. Until then this is a switch someone chooses.
   */
  const [cookPolicy, setCookPolicy] = useState<CookPolicyValue>("always");
  useEffect(() => {
    backend?.setCookPolicy(cookPolicy);
  }, [backend, cookPolicy]);

  /**
   * The channel ladder, in order (first non-undefined wins).
   *
   * Analyze is a MEASUREMENT of the running program; the value graph is a computation
   * about it; `graphChannelResolver`, inside `useGraphCompile`, is the shorthand behind
   * both. Names are unique per document (§V129/T221) so they never actually collide —
   * the order states which KIND of answer outranks which, not a tiebreak.
   */
  const driverChannels = useMemo(
    () => [analyze.resolver, valueGraph.resolver],
    [analyze.resolver, valueGraph.resolver],
  );
  const compile = useGraphCompile(runtime, capabilities, previewSinks, driverChannels);
  const recovery = useGpuRecovery(status.kind === "ready" ? status.backend : null);

  // The tracked set is a function of the DOCUMENT (which nodes are Analyze) and of the
  // PLAN (whether the reduction buffer was actually allocated), so it is re-derived where
  // both are known — after every compile, never per frame.
  useEffect(() => {
    analyze.track(compile.graph, compile.compiled);
  }, [analyze, compile.graph, compile.compiled]);

  /**
   * `BackendStatus.lastBuild` → the hub (T41, T143).
   *
   * Reuse accounting for the most recent STRUCTURAL build: which resources and effects
   * were carried rather than recreated (§V62b). `useFrameLoop` below is what actually
   * calls `backend.compile()` (T184); this reads whatever that produced off the backend's
   * own status, so the panel lights up without anyone having to remember this file
   * exists. Re-read on every backend report, since a rebuild after device loss is
   * exactly a structural build (§V23).
   */
  useEffect(() => {
    runtime.telemetry.setBuild(backend?.status.lastBuild ?? null);
    // T278: the OBSERVED half of the readback budget. The plan half says what the graph
    // asks for per frame; this says what has actually crossed the bus. Null when there is
    // no backend — nobody is counting, which is not the same as "none happened" (§V7).
    runtime.telemetry.setReadbacksPerformed(backend?.status.readbacks ?? null);
  }, [backend, recovery.diagnostics, runtime]);

  // The frame loop (T184): the only caller of `backend.loop()` in the app. Without it
  // the compiler, the backend and the renderer each pass their own suite while zero
  // frames are ever submitted — see `use-frame-loop.ts`.
  // T259/§V163 — `compile.animate` is non-null only when the document has an animated
  // parameter, so a static project pays nothing per frame.
  /**
   * T264/§V135 — a Movie File In or a Webcam node is black until something registers a
   * source behind it. This is that something; the node contract already says a node with
   * no source shows black, and a denied camera reports rather than throwing.
   */
  // T312: the resolved sizes, so a generated source (Text) draws at the node's target
  // extent rather than the project resolution.
  const media = useMediaSources(runtime, backend ?? null, compile.graph, compile.compiled);

  // T214/§V125: an expression on a pulse parameter fires it on its rising edge. The
  // watcher needs a frame, so it rides the frame loop's observer seam.
  const pulses = usePulseFiring(runtime.bus, runtime.invocation);

  /**
   * The frame observer, shared (T214, T305).
   *
   * Two riders, both needing a frame and neither producing a uniform value: the pulse
   * watcher fires on a rising edge, and Analyze queues its between-frames readback. One
   * seam rather than two parameters, so a third rider is a line here and not another
   * argument on the frame loop.
   */
  const observeFrame = useCallback(
    (frame: FrameEvaluationInput) => {
      pulses.observe(frame);
      analyze.observe(frame);
    },
    [analyze, pulses],
  );
  const frameLoop = useFrameLoop({
    bus: runtime.bus,
    backend: backend ?? null,
    compiled: compile.compiled,
    settings: runtime.settings,
    animate: compile.animate,
    // Before `animate` reads the channels, every rendered frame (§V179, §V155).
    advanceChannels: valueGraph.evaluate,
    observe: observeFrame,
    onReset: valueGraph.reset,
    pointer,
    valuesOnly: compile.valuesOnly,
  });

  // §V29/§V52 — the same two commands the keymap binds `space` and `.` to (T184):
  // the button and the hotkey cannot drift into two different code paths for one action.
  const onPlayPause = useCallback(() => {
    void runtime.bus.execute("transport.togglePlay", {}, runtime.invocation);
  }, [runtime]);
  const onStepFrame = useCallback(() => {
    void runtime.bus.execute("transport.stepFrame", { frames: 1 }, runtime.invocation);
  }, [runtime]);
  // T265/§V170 — the readout's frame field and the bar's reset button are the same
  // command, and it replays rather than jumping a counter.
  const onSeek = useCallback(
    (frameIndex: number) => {
      void runtime.bus.execute("transport.seek", { frameIndex }, runtime.invocation);
    },
    [runtime],
  );
  const onResetTime = useCallback(() => onSeek(0), [onSeek]);

  // ---- persistence ------------------------------------------------------------------
  const autosave = useAutosave(
    runtime,
    createSnapshotStore === undefined ? {} : { createStore: createSnapshotStore },
  );

  /**
   * Adopting a loaded document (§T139).
   *
   * `GraphStore` takes `initialGraph` at construction and has no `replaceGraph`, so a
   * project opens by building a new runtime around the loaded document and dropping the
   * old one. Chosen over reaching into the store because §V29's "one mutation path" is
   * the invariant this whole file exists to make checkable, and because the alternative
   * needs a change in `src/domain/commands` — enumerated in `project-commands.ts`.
   *
   * The cost, stated plainly: undo history does not survive an open. Given §V41 makes
   * history actor-local and entries name node ids from the PREVIOUS document, carrying
   * it across would let undo restore a node into a project that never had one.
   */
  const adoptDocument = useCallback(
    (result: LoadProjectSuccess) => {
      // Built outside the state updater on purpose: an updater must be pure, and React
      // is free to call it twice. Constructing a runtime twice would leave one orphaned
      // with a live telemetry timer and a second identity on the same bus.
      const next = createAppRuntime({
        ...(storage === undefined ? {} : { identityStorage: storage }),
        document: result.document,
        unknownParameters: result.unknownParameters,
        actor: runtimeRef.current.invocation.actor,
      });
      owned.current = true;
      setRuntime(next);
      setSelection([]);
      setHoveredNodeId(null);
      setRejection(NO_DIAGNOSTICS);
      onRuntimeChange?.(next);
    },
    [onRuntimeChange, storage],
  );

  // T189/§V93: "is there unsaved work" is the one thing that makes OPEN ask first. The
  // example library asks it; `markSaved` after a successful write is the other half.
  const dirty = useDocumentDirty(runtime.bus);
  // Read through a ref: the command handler asks at the moment it runs, not at the
  // moment it was registered.
  const dirtyRef = useRef(dirty.dirty);
  dirtyRef.current = dirty.dirty;

  /**
   * A new, empty project (§V165).
   *
   * The same replacement an open performs, minus the file: a fresh runtime, so the new
   * project cannot inherit the old one's undo history, unknown parameters or settings.
   * It keeps the browser-local project id, which is exactly what launching the app fresh
   * does — a new id would orphan the autosave slot this machine has been writing to.
   */
  const startNewProject = useCallback(() => {
    const next = createAppRuntime({
      ...(storage === undefined ? {} : { identityStorage: storage }),
      actor: runtimeRef.current.invocation.actor,
    });
    owned.current = true;
    setRuntime(next);
    setSelection([]);
    setHoveredNodeId(null);
    setRejection(NO_DIAGNOSTICS);
    onRuntimeChange?.(next);
  }, [onRuntimeChange, storage]);

  const isDirty = useCallback(() => dirtyRef.current, []);

  const project = useProject(runtime, {
    flushAutosave: autosave.flush,
    onDocumentLoaded: adoptDocument,
    onNewProject: startNewProject,
    isDirty,
    onSaved: dirty.markSaved,
  });

  const problems = useMemo<RuntimeDiagnostic[]>(() => {
    const list: RuntimeDiagnostic[] = [];
    if (status.kind === "unavailable") {
      list.push({
        severity: "error",
        code: "gpu.unavailable",
        message: status.reason,
        suggestion:
          "Editing still works. Open this in Chrome or Edge 128+ on a machine with WebGPU to render.",
      });
    }
    list.push(
      ...compile.diagnostics,
      ...valueGraph.diagnostics,
      ...media.diagnostics,
      ...rejection,
      ...autosave.diagnostics,
      ...project.diagnostics,
      ...recovery.diagnostics,
      ...frameLoop.diagnostics,
    );
    return list;
  }, [
    autosave.diagnostics,
    compile.diagnostics,
    frameLoop.diagnostics,
    valueGraph.diagnostics,
    media.diagnostics,
    project.diagnostics,
    recovery.diagnostics,
    rejection,
    status,
  ]);

  const errorCount = problems.filter((diagnostic) => diagnostic.severity === "error").length;
  const selectedNodeId = selection[0] ?? null;

  /**
   * The agent tool surface (B12/T220), constructed HERE because there is nowhere else it
   * could be: it needs the one bus, and the state sources it publishes — selection,
   * diagnostics, metrics, project — exist only in this file. `attachStateSources` inside
   * the hook is what turns them into bus queries an out-of-process adapter can read
   * (§V39), and `AgentPane` below is what makes the agent's activity visible (§V42).
   */
  // T291: the pixel ports — export interface over the live backend and the CURRENT
  // plan, so render_preview and describe_output work in the product, not only in tests.
  const agentPorts = useAgentPorts({ backend, compiled: compile.compiled, playing: frameLoop.playing, graph: runtime.bus.store.getGraph });
  useRuntimeCommands({ bus: runtime.bus, backend, compiled: compile.compiled });
  const agentSurface = useAgentSurface(runtime, { selection, diagnostics: problems }, agentPorts);

  /** The installed catalogue, for the library panes and the help panel's node reference. */
  const definitions = useMemo(() => [...runtime.registry.list()], [runtime]);
  const componentsView = useMemo(() => runtime.components.view(), [runtime]);

  /**
   * What an expression sees, SAMPLED at render (§V16, §V71).
   *
   * The help panel lists `time`, `delta` and `frame` with their current values. Those
   * change every frame, so they are read from the frame loop's ref when this renders —
   * never pushed into state, which would re-render the whole tree at 60 Hz. With no frame
   * rendered yet there is no scope, and the panel says so rather than showing zeroes.
   */
  const lastFrame = frameLoop.latestFrame();
  const helpScope: ExpressionScope | undefined =
    lastFrame === null ? undefined : scopeFromFrame(lastFrame.frame);

  const openHelp = useCallback(() => {
    void runtime.bus.execute(OPEN_HELP_COMMAND, {}, runtime.invocation);
  }, [runtime]);
  useEffect(() => {
    onAgentSurface?.(agentSurface);
  }, [agentSurface, onAgentSurface]);

  const notices = useMemo<Notice[]>(() => {
    const list: Notice[] = [];

    if (recovery.halted) {
      list.push({
        id: "gpu-halted",
        tone: "error",
        message: "GPU submission is halted — no frames are being rendered.",
        detail:
          "The device was lost and the automatic rebuilds gave up. Your document is untouched.",
        actions: [
          {
            label: recovery.retrying ? "Retrying…" : "Retry GPU",
            onSelect: recovery.retry,
            variant: "outline",
          },
        ],
      });
    }

    if (autosave.unavailable) {
      list.push({
        id: "autosave-unavailable",
        tone: "warn",
        message: "Autosave is off: this browser context has no IndexedDB.",
        detail: "Save to a file to keep your work — nothing is being snapshotted in the background.",
      });
    }

    if (autosave.restore !== null) {
      const when = new Date(autosave.restore.meta.savedAt);
      list.push({
        id: "restore-autosave",
        tone: "info",
        message: `An autosave from ${when.toLocaleString()} is newer than what is open.`,
        detail: `Revision ${autosave.restore.meta.revision}. Restoring replaces the open project.`,
        actions: [
          {
            label: "Restore",
            variant: "outline",
            onSelect: () => {
              const record = autosave.restore;
              if (record === null) return;
              autosave.dismissRestore();
              project.openText(record.record.body, "autosave");
            },
          },
          { label: "Dismiss", onSelect: autosave.dismissRestore },
        ],
      });
    }

    if (floatBlocked !== null) {
      list.push({
        id: "float-blocked",
        tone: "warn",
        message: `Your browser blocked the window for the ${PANE_TITLES[floatBlocked]} pane.`,
        detail: "Allow pop-ups for this site to float a pane.",
        actions: [{ label: "Dismiss", onSelect: () => setFloatBlocked(null) }],
      });
    }

    if (runtime.unknownParameters.length > 0) {
      list.push({
        id: "newer-version",
        tone: "info",
        message: `This project carries ${runtime.unknownParameters.length} parameter value(s) written by a newer build.`,
        detail: "They are kept exactly as saved and shown read-only rather than edited blind.",
      });
    }

    return list;
  }, [autosave, floatBlocked, project, recovery, runtime.unknownParameters.length]);

  const environment = useMemo<KeymapEnvironment>(
    () => ({ context: "global", selection, hoveredNodeId }),
    [hoveredNodeId, selection],
  );

  return (
    <AppRuntimeContext.Provider value={runtime}>
      <KeymapProvider
        bus={runtime.bus}
        invocationContext={runtime.invocation}
        environment={environment}
      >
        <AppShell
          {...(storage === undefined ? {} : { storage })}
          {...(openPaneWindow === undefined ? {} : { openPaneWindow })}
          onFloatBlocked={setFloatBlocked}
          problemCount={errorCount}
          notices={<NoticeStrip notices={notices} />}
          topBar={
            <TopBar
              projectName={project.fileName ?? runtime.project.name}
              tier={status.kind === "ready" ? status.capabilities.tier : null}
              playing={frameLoop.playing}
              onPlayPause={onPlayPause}
              onStep={onStepFrame}
              onResetTime={onResetTime}
              timeline={
                <TimelineReadout latestFrame={frameLoop.latestFrame} onSeek={onSeek} />
              }
              trailing={
                <ProjectActions
                  busy={project.busy}
                  onNew={project.create}
                  onOpen={project.open}
                  onSave={project.save}
                  onHelp={openHelp}
                />
              }
            />
          }
          nodeLibrary={
            <LibraryPane
              portDrag={portDrag}
              onClearPortDrag={clearPortDrag}
              actions={graphActions}
            />
          }
          componentLibrary={
            <ComponentLibrary
              bus={runtime.bus}
              context={runtime.invocation}
              components={componentsView}
              selection={selection}
              onPlaced={onSelectionChange}
            />
          }
          exampleLibrary={
            <ExampleLibrary
              bus={runtime.bus}
              context={runtime.invocation}
              dirty={dirty.dirty}
            />
          }
          graphCanvas={
            // T145: ONE popup for the pane, opened by ONE command. Middle click is
            // handled inside the host; the `?` binding and the node menu's Info item
            // both execute `ui.showNodeInfo`, so all three routes are the same surface.
            <NodeInfoHost
              bus={runtime.bus}
              registry={runtime.registry}
              compiled={compile.compiled}
              telemetry={runtime.telemetry}
              runtime={runtime.nodeRuntime}
              fallbackNodeId={selectedNodeId}
            >
              <GraphPane
                selection={selection}
                onSelectionChange={onSelectionChange}
                onHoveredNodeChange={setHoveredNodeId}
                portDrag={portDrag}
                onPortDragChange={onPortDragChange}
                onPatchResult={onPatchResult}
                actionsRef={actionsRef}
                previewBackend={backend ?? null}
                graph={compile.graph}
                compiledOutputs={compile.compiled?.outputs ?? []}
                previewFps={runtime.settings.previewFps}
                previewLongEdge={runtime.settings.previewLongEdge}
                previewSinks={previewSinks}
              />
            </NodeInfoHost>
          }
          inspector={
            <InspectorPane
              nodeId={selectedNodeId}
              graph={compile.graph}
              compiled={compile.compiled}
              diagnostics={compile.diagnostics}
              status={status}
              unknownParameters={runtime.unknownParameters}
            />
          }
          viewer={
            <ViewerPane
              compiled={compile.compiled}
              graph={compile.graph}
              backend={backend ?? null}
              pointer={pointer}
              probe={agentPorts.probe}
            />
          }
          shaderEditor={
            <ShaderPane
              nodeId={selectedNodeId}
              graph={compile.graph}
              diagnostics={compile.diagnostics}
              stale={backend?.status.stale ?? false}
            />
          }
          problems={<ProblemsPanel diagnostics={problems} />}
          performance={
            <PerformancePane
              status={status}
              cookPolicy={cookPolicy}
              onCookPolicyChange={setCookPolicy}
            />
          }
          agent={<AgentPane surface={agentSurface} />}
        />
        {/* §V166: three outcomes, Save first. One dialog for every destructive verb, so
            New and Open cannot drift into asking two different questions. */}
        <UnsavedChangesDialog
          open={project.confirm !== null}
          action={project.confirm?.action ?? ""}
          onSave={() => project.confirm?.save()}
          onDiscard={() => project.confirm?.discard()}
          onCancel={() => project.confirm?.cancel()}
          busy={project.busy}
        />
        <CommandPalette />
        {/* Inside the KeymapProvider on purpose: the shortcuts tab reads the RESOLVED
            keymap from its context, so mounting it outside would list nothing (T200). */}
        <HelpHost
          bus={runtime.bus}
          nodes={definitions}
          {...(helpScope === undefined ? {} : { scope: helpScope })}
        />
      </KeymapProvider>
    </AppRuntimeContext.Provider>
  );
}

/**
 * Open / Save in the top bar.
 *
 * Buttons, not handlers: each one executes the bus command the keymap already names, so
 * the button and mod+s cannot drift apart and the palette lists the same two (§V29,
 * §V52, §V55). Native `<button>`s, so they are in tab order with a focus ring (§V19).
 */
function ProjectActions({
  busy,
  onNew,
  onOpen,
  onSave,
  onHelp,
}: {
  busy: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onHelp: () => void;
}) {
  return (
    <>
      <Button aria-label="New project" onClick={onNew} disabled={busy} data-testid="project-new">
        new
      </Button>
      <Button aria-label="Open project" onClick={onOpen} disabled={busy} data-testid="project-open">
        open
      </Button>
      <Button aria-label="Save project" onClick={onSave} disabled={busy} data-testid="project-save">
        save
      </Button>
      {/* The owner looked for help in the top bar and did not find it. Same command as
          mod+/ and the palette entry — one route, three doors (§V29, §V52). */}
      <Button aria-label="Help" onClick={onHelp} data-testid="open-help">
        help
      </Button>
    </>
  );
}
