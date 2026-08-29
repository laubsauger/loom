import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandResult } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { KeymapProvider } from "@editor/keymap/index.ts";
import type { KeymapEnvironment } from "@editor/keymap/index.ts";
import { CommandPalette } from "@editor/palette/index.ts";
import { ProblemsPanel } from "@editor/shader-editor/index.ts";
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
import { InspectorPane, LibraryPane, ViewerPane } from "./side-panes.tsx";
import { TopBar } from "./top-bar.tsx";
import { useGpuStatus } from "./use-gpu-status.ts";
import { useGraphCompile } from "./use-graph-compile.ts";

/**
 * The composition root (T51).
 *
 * This is the map of the system. Read top to bottom it says: there is ONE registry, ONE
 * document store, ONE command bus and ONE actor identity; every pane receives them from
 * one context; and every edit any pane makes — a dragged connection, an inspector
 * field, a hotkey, the palette, a library drop — becomes a command on that bus (§V29).
 * If a second mutation path is ever introduced, it will be visible here as a second
 * thing being constructed.
 *
 * What is NOT here, on purpose:
 *  - no frame loop. There is no presentation surface yet (§V64, T87), so nothing would
 *    see the frames and §V28 says not to schedule invisible work.
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
}

const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function App({ runtime: providedRuntime, storage, gpuProbe }: AppProps = {}) {
  const [ownedRuntime] = useState(() => (providedRuntime === undefined ? createAppRuntime() : null));
  const runtime = providedRuntime ?? (ownedRuntime as AppRuntime);

  useEffect(() => () => ownedRuntime?.dispose(), [ownedRuntime]);

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
    list.push(...compile.diagnostics, ...rejection);
    return list;
  }, [compile.diagnostics, rejection, status]);

  const errorCount = problems.filter((diagnostic) => diagnostic.severity === "error").length;
  const selectedNodeId = selection[0] ?? null;

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
          topBar={
            <TopBar
              projectName="untitled"
              tier={status.kind === "ready" ? status.capabilities.tier : null}
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
            <GraphPane
              selection={selection}
              onSelectionChange={onSelectionChange}
              onHoveredNodeChange={setHoveredNodeId}
              portDrag={portDrag}
              onPortDragChange={onPortDragChange}
              onPatchResult={onPatchResult}
              actionsRef={actionsRef}
            />
          }
          inspector={
            <InspectorPane
              nodeId={selectedNodeId}
              graph={compile.graph}
              compiled={compile.compiled}
              diagnostics={compile.diagnostics}
              status={status}
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
          performance={<PerformancePane status={status} compiled={compile.compiled} />}
        />
        <CommandPalette />
      </KeymapProvider>
    </AppRuntimeContext.Provider>
  );
}
