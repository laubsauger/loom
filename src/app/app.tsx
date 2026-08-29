import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandResult } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { LoadProjectSuccess, SnapshotStore } from "@domain/project/index.ts";
import { NodeInfoHost } from "@editor/inspect/index.ts";
import { KeymapProvider } from "@editor/keymap/index.ts";
import type { KeymapEnvironment } from "@editor/keymap/index.ts";
import { CommandPalette } from "@editor/palette/index.ts";
import { ProblemsPanel } from "@editor/shader-editor/index.ts";
import { Button } from "@ui/index.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { AppShell } from "./app-shell.tsx";
import { PerformancePane, ShaderPane } from "./dock-panes.tsx";
import { GraphPane } from "./graph-pane.tsx";
import type { GraphActions, PortDragOrigin } from "./graph-pane.tsx";
import type { GpuStatus } from "./gpu-status.ts";
import { sharedGpuProbe } from "./gpu-status.ts";
import type { LayoutStorage } from "./layout-storage.ts";
import { NoticeStrip } from "./notices.tsx";
import type { Notice } from "./notices.tsx";
import { InspectorPane, LibraryPane, ViewerPane } from "./side-panes.tsx";
import { TopBar } from "./top-bar.tsx";
import { useAutosave } from "./use-autosave.ts";
import { useGpuStatus } from "./use-gpu-status.ts";
import { useGpuRecovery } from "./use-gpu-recovery.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
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
 *  - no frame loop. There is no presentation surface yet (§V64, T87), so nothing would
 *    see the frames and §V28 says not to schedule invisible work.
 *  - no timing source on the hub. Timing is a GPU timer span or it is nothing (§V86);
 *    with no frame loop no pass is ever submitted, so nothing could be measured, and the
 *    panel says "unavailable" rather than showing a number nobody measured.
 *  - no GPU calls. React encodes none (§V2); the device is acquired by the runtime
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
  const compile = useGraphCompile(runtime, capabilities);
  const recovery = useGpuRecovery(status.kind === "ready" ? status.backend : null);

  /**
   * `BackendStatus.lastBuild` → the hub (T41, T143).
   *
   * Reuse accounting for the most recent STRUCTURAL build: which resources and effects
   * were carried rather than recreated (§V62b). Nothing in this root calls
   * `backend.compile()` — the frame loop and the preview host own that — so it reads
   * `undefined` today and the panel says "Nothing has been built yet", which is true.
   * The seam is wired anyway: the first real build lights the panel up without anyone
   * having to remember this file exists. Re-read on every backend report, since a
   * rebuild after device loss is exactly a structural build (§V23).
   */
  const backend = status.kind === "ready" ? status.backend : undefined;
  useEffect(() => {
    runtime.telemetry.setBuild(backend?.status.lastBuild ?? null);
  }, [backend, recovery.diagnostics, runtime]);

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

  const project = useProject(runtime, {
    flushAutosave: autosave.flush,
    onDocumentLoaded: adoptDocument,
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
      ...rejection,
      ...autosave.diagnostics,
      ...project.diagnostics,
      ...recovery.diagnostics,
    );
    return list;
  }, [
    autosave.diagnostics,
    compile.diagnostics,
    project.diagnostics,
    recovery.diagnostics,
    rejection,
    status,
  ]);

  const errorCount = problems.filter((diagnostic) => diagnostic.severity === "error").length;
  const selectedNodeId = selection[0] ?? null;

  const notices = useMemo<Notice[]>(() => {
    const list: Notice[] = [];

    if (recovery.halted) {
      list.push({
        id: "gpu-halted",
        tone: "error",
        message: "GPU submission is halted — no frames are being rendered.",
        detail:
          "The device was lost and the automatic rebuilds gave up. Your document is untouched (§V23).",
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

    if (runtime.unknownParameters.length > 0) {
      list.push({
        id: "newer-version",
        tone: "info",
        message: `This project carries ${runtime.unknownParameters.length} parameter value(s) written by a newer build.`,
        detail: "They are kept exactly as saved and shown read-only rather than edited blind (§V68).",
      });
    }

    return list;
  }, [autosave, project, recovery, runtime.unknownParameters.length]);

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
          problemCount={errorCount}
          notices={<NoticeStrip notices={notices} />}
          topBar={
            <TopBar
              projectName={project.fileName ?? runtime.project.name}
              tier={status.kind === "ready" ? status.capabilities.tier : null}
              trailing={
                <ProjectActions
                  busy={project.busy}
                  onOpen={project.open}
                  onSave={project.save}
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
          viewer={<ViewerPane status={status} compiled={compile.compiled} />}
          shaderEditor={
            <ShaderPane
              nodeId={selectedNodeId}
              graph={compile.graph}
              diagnostics={compile.diagnostics}
            />
          }
          problems={
            <ProblemsPanel
              diagnostics={problems}
              emptyHint="Compile and runtime diagnostics appear here."
            />
          }
          performance={<PerformancePane />}
        />
        <CommandPalette />
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
  onOpen,
  onSave,
}: {
  busy: boolean;
  onOpen: () => void;
  onSave: () => void;
}) {
  return (
    <>
      <Button aria-label="Open project" onClick={onOpen} disabled={busy} data-testid="project-open">
        open
      </Button>
      <Button aria-label="Save project" onClick={onSave} disabled={busy} data-testid="project-save">
        save
      </Button>
    </>
  );
}
