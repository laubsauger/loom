import { useCallback, useMemo } from "react";
import { isDeclaredSink } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { UnknownParameter } from "@domain/project/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { Inspector } from "@editor/inspector/index.ts";
import type { InputResolution } from "@editor/inspector/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { NodeLibrary } from "@editor/library/index.ts";
import type { PortDragQuery } from "@editor/library/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { useAppRuntime } from "./app-context.ts";
import { useOutputPresentation } from "./use-output-presentation.ts";
import type { GraphActions, PortDragOrigin } from "./graph-pane.tsx";
import type { GpuStatus } from "./gpu-status.ts";
import styles from "./panes.module.css";

/** The three panes around the canvas: catalogue, inspector, viewer. */

export interface LibraryPaneProps {
  portDrag: PortDragOrigin | null;
  onClearPortDrag: () => void;
  actions: () => GraphActions | null;
}

export function LibraryPane({ portDrag, onClearPortDrag, actions }: LibraryPaneProps) {
  const { registry } = useAppRuntime();
  const definitions = useMemo(() => [...registry.list()], [registry]);

  // The library filters on the port TYPE and the end being dragged; which node the drag
  // started from is the canvas's business (§V13).
  const query = useMemo<PortDragQuery | null>(
    () => (portDrag === null ? null : { type: portDrag.type, direction: portDrag.direction }),
    [portDrag],
  );

  const onAddNode = useCallback(
    (type: string, connectTo?: Parameters<GraphActions["addNode"]>[1]) => {
      actions()?.addNode(type, connectTo);
    },
    [actions],
  );

  return (
    <div className={styles.fill}>
      <NodeLibrary
        definitions={definitions}
        portDrag={query}
        onAddNode={onAddNode}
        onClearPortDrag={onClearPortDrag}
      />
    </div>
  );
}

export interface InspectorPaneProps {
  nodeId: NodeId | null;
  graph: GraphDocument;
  compiled: CompiledGraph | null;
  diagnostics: readonly RuntimeDiagnostic[];
  status: GpuStatus;
  /** Values the open file carried that this build cannot read (§V68, §V69). */
  unknownParameters?: readonly UnknownParameter[];
}

/**
 * Resolved size and format of whatever feeds each input of `nodeId`.
 *
 * The Common section needs this to answer "inherit from input" honestly (§V50, §V51).
 * It comes from the compiled plan, which is the only thing that knows — the document
 * stores overrides, not results.
 */
function inputResolutionsFor(
  nodeId: NodeId | null,
  graph: GraphDocument,
  compiled: CompiledGraph | null,
  ports: readonly { id: string; label: string }[],
): InputResolution[] {
  if (nodeId === null) return [];
  const upstream = new Map<string, { nodeId: NodeId; portId: string }>();
  for (const edge of Object.values(graph.edges)) {
    if (edge.target.nodeId !== nodeId) continue;
    upstream.set(edge.target.portId, edge.source);
  }

  return ports.map((port) => {
    const source = upstream.get(port.id);
    if (source === undefined) return { portId: port.id, label: port.label, connected: false };
    const output = compiled?.outputs.find(
      (candidate) => candidate.nodeId === source.nodeId && candidate.portId === source.portId,
    );
    if (output === undefined) return { portId: port.id, label: port.label, connected: true };
    return {
      portId: port.id,
      label: port.label,
      connected: true,
      size: { width: output.size[0], height: output.size[1] },
      format: output.format,
    };
  });
}

export function InspectorPane({
  nodeId,
  graph,
  compiled,
  diagnostics,
  status,
  unknownParameters = [],
}: InspectorPaneProps) {
  const { bus, invocation, registry, settings } = useAppRuntime();

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : registry.get(node.type);
  const inputs = useMemo(
    () => (definition?.inputs ?? []).map((port) => ({ id: port.id, label: port.label })),
    [definition],
  );

  const inputResolutions = useMemo(
    () => inputResolutionsFor(nodeId, graph, compiled, inputs),
    [compiled, graph, inputs, nodeId],
  );

  const unknownHere = useMemo(
    () => (nodeId === null ? [] : unknownParameters.filter((entry) => entry.nodeId === nodeId)),
    [nodeId, unknownParameters],
  );

  if (unknownHere.length > 0 && nodeId !== null) {
    return (
      <div
        className={styles.scrollFill}
        data-testid="inspector-scroll"
        {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "inspector" }}
      >
        <FutureParameters nodeId={nodeId} unknown={unknownHere} />
      </div>
    );
  }

  // `scrollFill`, not `fill`: a node with twenty parameters is taller than the right dock,
  // and a pane that grows past its dock has its overflow clipped rather than scrolled —
  // the parameters below the fold simply cannot be reached. See `panes.module.css`.
  return (
    <div
      className={styles.scrollFill}
      data-testid="inspector-scroll"
      {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "inspector" }}
    >
      <Inspector
        bus={bus}
        context={invocation}
        nodeId={nodeId}
        settings={settings}
        diagnostics={diagnostics}
        capabilities={status.kind === "ready" ? { formats: status.capabilities.formats } : undefined}
        inputResolutions={inputResolutions}
      />
    </div>
  );
}

/**
 * A node whose parameters this build cannot read (§V68, §V69, §T139).
 *
 * `loadProject` reports these and keeps the values byte-for-byte; the one thing that must
 * NOT happen is a control rendered over them. A slider does not know the value is a
 * shape it has never seen — it falls back to the definition's default, shows a number
 * that was never in the file, and the first drag writes that number over the user's data
 * on the next save. So the pane says what is true and offers nothing to drag.
 *
 * This is per-NODE rather than per-parameter because `Inspector` has no way to be told
 * "render every control except this one". The precise ask for that track is an
 * `unresolvedParameters?: readonly string[]` prop; until then, suppressing the node's
 * controls is the conservative reading of §V69 and the only one available from here.
 */
function FutureParameters({
  nodeId,
  unknown,
}: {
  nodeId: NodeId;
  unknown: readonly UnknownParameter[];
}) {
  return (
    <div className={styles.viewer} data-testid="future-parameters">
      <section className={styles.block} aria-label="Parameters from a newer version">
        <h3 className={styles.blockTitle}>set by a newer version</h3>
        <p className={styles.note}>
          {nodeId} carries {unknown.length === 1 ? "a parameter value" : "parameter values"} written
          by a newer build of Shaderloom. {unknown.length === 1 ? "It is" : "They are"} kept exactly
          as saved and written back unchanged, so nothing is lost — but this build cannot
          show a control over {unknown.length === 1 ? "it" : "them"} without inventing a value.
        </p>
        <ul className={styles.list}>
          {unknown.map((entry) => (
            <li key={entry.key} className={styles.row}>
              <span className={styles.rowName}>{entry.key}</span>
              <span className={styles.rowValue}>
                {entry.kind === undefined ? "unreadable value" : `kind: ${entry.kind}`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export interface ViewerPaneProps {
  compiled: CompiledGraph | null;
  /** Needed only to tell a declared Output node from a preview sink — see below. */
  graph: GraphDocument;
  /** The live backend, when there is one. The runtime is handed the surface (§V64). */
  backend?: ShaderloomBackend | null;
}

/**
 * The viewer (§I.ui, T87/T161, §V64, §V70).
 *
 * A content surface shows content, or names its empty state (§V91, §V92a) — device and
 * build diagnostics (tier, formats, memory, reuse) belong on the performance surface
 * instead (`PerformancePane`, `dock-panes.tsx`).
 *
 * The picture is a presentation surface HANDED to the runtime, never a canvas React
 * draws into (§V64): `backend.present(canvas, { outputId })` attaches it and the runtime
 * blits into it with every frame (§V7 — GPU to GPU, no readback). The canvas is never
 * remounted when the pane moves (T193), so the presentation survives being dragged to
 * another dock or floated into its own window, which is what §V64's "opening or closing a
 * pane must not stall the output" requires — and the same seam multi-window perform mode
 * (T110) is built on.
 *
 * Which output: the graph's DECLARED sink, not simply the first resolved output. Every
 * visible texture node is a preview sink (§V28b), so `compiled.outputs` is the whole
 * graph; showing its first entry would put an arbitrary intermediate node on the viewer.
 * With no Output node there is nothing to show, and the pane says so.
 */
export function ViewerPane({ compiled, graph, backend = null }: ViewerPaneProps) {
  const { registry } = useAppRuntime();

  const sink = useMemo(() => {
    for (const output of compiled?.outputs ?? []) {
      const type = graph.nodes[output.nodeId]?.type;
      const definition = type === undefined ? undefined : registry.get(type);
      if (definition !== undefined && isDeclaredSink(definition)) return output;
    }
    return null;
  }, [compiled, graph, registry]);

  const { canvasRef } = useOutputPresentation(backend, sink?.resourceId ?? null);
  const outputs = compiled?.outputs ?? [];

  return (
    <div className={styles.viewer} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "viewer" }}>
      <div className={styles.surface} data-testid="viewer-surface">
        {sink === null ? (
          <p className={styles.note}>No output</p>
        ) : (
          <canvas ref={canvasRef} className={styles.canvas} aria-label="Rendered output" />
        )}
      </div>
      <section className={styles.block} aria-label="Resolved outputs">
        <h3 className={styles.blockTitle}>outputs</h3>
        {outputs.length === 0 ? (
          <p className={styles.note}>No output</p>
        ) : (
          <ul className={styles.list}>
            {outputs.map((output) => (
              <li key={`${output.nodeId}:${output.portId}`} className={styles.row}>
                <span className={styles.rowName}>
                  {output.nodeId}:{output.portId}
                </span>
                <span className={styles.rowValue}>
                  {output.size[0]} × {output.size[1]} · {output.format}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
