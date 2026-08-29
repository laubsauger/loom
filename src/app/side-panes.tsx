import { useCallback, useMemo } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { Inspector } from "@editor/inspector/index.ts";
import type { InputResolution } from "@editor/inspector/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { NodeLibrary } from "@editor/library/index.ts";
import type { PortDragQuery } from "@editor/library/index.ts";
import { useAppRuntime } from "./app-context.ts";
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

export function InspectorPane({ nodeId, graph, compiled, diagnostics, status }: InspectorPaneProps) {
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

  return (
    <div className={styles.fill} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "inspector" }}>
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

export interface ViewerPaneProps {
  status: GpuStatus;
  compiled: CompiledGraph | null;
}

/**
 * The viewer (§I.ui).
 *
 * There is no presentation surface yet — handing a canvas to the runtime is T87/§V64,
 * and the preview atlas is T34 — so this pane shows what IS known: the device the app
 * got, and the outputs the compiler resolved. What it must never do is show a black
 * rectangle that looks like a render, or nothing at all when WebGPU is missing (§V12).
 */
export function ViewerPane({ status, compiled }: ViewerPaneProps) {
  return (
    <div className={styles.viewer} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "viewer" }}>
      <GpuStatusCard status={status} />

      <section className={styles.block} aria-label="Resolved outputs">
        <h3 className={styles.blockTitle}>outputs</h3>
        {compiled === null || compiled.outputs.length === 0 ? (
          <p className={styles.note}>
            Nothing to render yet. Add a node and connect it to an Output.
          </p>
        ) : (
          <ul className={styles.list}>
            {compiled.outputs.map((output) => (
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
        <p className={styles.note}>
          Live pixels arrive with the preview system; the runtime owns the surface, not
          this pane.
        </p>
      </section>
    </div>
  );
}

export function GpuStatusCard({ status }: { status: GpuStatus }) {
  if (status.kind === "probing") {
    return (
      <section className={styles.block} aria-label="GPU status">
        <h3 className={styles.blockTitle}>gpu</h3>
        <p className={styles.note}>Requesting a WebGPU device…</p>
      </section>
    );
  }

  if (status.kind === "unavailable") {
    return (
      <section className={styles.block} data-tone="error" aria-label="GPU status" role="status">
        <h3 className={styles.blockTitle}>gpu unavailable</h3>
        <p className={styles.alert}>{status.reason}</p>
        <p className={styles.note}>
          The graph, the inspector and the shader editor still work — the document is the
          source of truth and does not need a device. Rendering and compile validation stay
          off until one is available.
        </p>
      </section>
    );
  }

  const { capabilities, baseline } = status;
  return (
    <section className={styles.block} aria-label="GPU status">
      <h3 className={styles.blockTitle}>gpu</h3>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>tier</dt>
          <dd>{capabilities.tier}</dd>
        </div>
        <div className={styles.fact}>
          <dt>timestamp query</dt>
          <dd>{capabilities.timestampQuery ? "yes" : "no"}</dd>
        </div>
        <div className={styles.fact}>
          <dt>formats</dt>
          <dd>{capabilities.formats.join(", ")}</dd>
        </div>
      </dl>
      {baseline ? null : (
        <p className={styles.alert} role="status">
          This device is below the Tier B baseline (rgba16float, compute, storage
          buffers). Expect missing features rather than a working render.
        </p>
      )}
    </section>
  );
}
