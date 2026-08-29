import { useCallback, useMemo, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { ShaderEditor, commitShaderSource, diagnosticsToMarkers } from "@editor/shader-editor/index.ts";
import { useAppRuntime } from "./app-context.ts";
import type { GpuStatus } from "./gpu-status.ts";
import styles from "./panes.module.css";

/** The bottom dock's two non-trivial tabs: the shader editor and the performance tab. */

export interface ShaderPaneProps {
  nodeId: NodeId | null;
  graph: GraphDocument;
  diagnostics: readonly RuntimeDiagnostic[];
}

/**
 * The `shaderEditor` slot.
 *
 * Editing is local until focus leaves, and the commit is a `setShaderSource` patch on
 * the bus — one patch, so a typing burst is one undo entry (§V29, §V34). A change made
 * to the document from anywhere else (undo, an agent) replaces the buffer, because the
 * document is the source of truth and the editor is a view of it (§V1).
 *
 * There is no live WGSL compile here yet: nothing wires a `ShaderCompiler` to the device
 * (T95). Rather than render a status strip that says "compiled" when nothing compiled,
 * the strip says what is actually true and shows the diagnostics the graph compiler did
 * produce for this node (§V27).
 */
export function ShaderPane({ nodeId, graph, diagnostics }: ShaderPaneProps) {
  const { bus, invocation, registry } = useAppRuntime();

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : registry.get(node.type);
  const parameter = definition?.parameters[SHADER_SOURCE_PARAMETER];
  const authorable = node !== undefined && parameter !== undefined && parameter.type === "string";

  const committed = useMemo(() => {
    if (!authorable) return "";
    const value = node.parameters[SHADER_SOURCE_PARAMETER];
    if (typeof value === "string") return value;
    return parameter.type === "string" ? parameter.default : "";
  }, [authorable, node, parameter]);

  // Re-sync when the subject or the stored text changes underneath the buffer.
  const [sync, setSync] = useState({ nodeId, committed });
  const [draft, setDraft] = useState(committed);
  if (sync.nodeId !== nodeId || sync.committed !== committed) {
    setSync({ nodeId, committed });
    setDraft(committed);
  }

  const commit = useCallback(() => {
    if (nodeId === null || draft === committed) return;
    void commitShaderSource({
      bus,
      context: invocation,
      nodeId,
      source: draft,
      baseRevision: bus.store.getRevision(),
    });
  }, [bus, committed, draft, invocation, nodeId]);

  const nodeDiagnostics = useMemo(
    () => diagnostics.filter((diagnostic) => diagnostic.nodeId === nodeId),
    [diagnostics, nodeId],
  );
  const markers = useMemo(
    () => diagnosticsToMarkers(draft, nodeDiagnostics),
    [draft, nodeDiagnostics],
  );

  if (!authorable || nodeId === null) {
    return (
      <div className={styles.dockEmpty}>
        <span>No shader selected</span>
        <span className={styles.note}>
          Select a node with a WGSL source parameter — Custom WGSL — to edit its shader.
        </span>
      </div>
    );
  }

  return (
    // §V53: this whole pane is a text context, so mod+z undoes typing here and never a
    // graph edit. The attribute is what the keymap engine reads.
    <div className={styles.shader} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "text" }}>
      <div className={styles.shaderStatus}>
        <span className={styles.rowName}>
          {definition?.title ?? node.type} · {nodeId}
        </span>
        <span className={styles.note}>
          {draft === committed ? "saved" : "unsaved — commits when focus leaves"}
        </span>
        <span className={styles.note}>
          WGSL is checked when the graph compiles on a device; there is no standalone
          shader compile yet.
        </span>
      </div>
      <ShaderEditor
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        markers={markers}
        label={`WGSL source for ${nodeId}`}
      />
    </div>
  );
}

export interface PerformancePaneProps {
  status: GpuStatus;
  compiled: CompiledGraph | null;
}

/**
 * The `performance` slot.
 *
 * Per-pass GPU spans are T41/T42 and are not measured yet, so this reports the plan —
 * which IS known and IS useful — and says plainly that no timing exists. A fabricated
 * frame time would be worse than an empty one.
 */
export function PerformancePane({ status, compiled }: PerformancePaneProps) {
  const timestamps = status.kind === "ready" ? status.capabilities.timestampQuery : false;

  return (
    <div className={styles.performance}>
      <section className={styles.block} aria-label="Plan">
        <h3 className={styles.blockTitle}>compiled plan</h3>
        {compiled === null ? (
          <p className={styles.note}>
            No plan: the graph is compiled against the device capability report, and none
            is available.
          </p>
        ) : (
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>passes</dt>
              <dd>{compiled.passes.length}</dd>
            </div>
            <div className={styles.fact}>
              <dt>resources</dt>
              <dd>{compiled.resources.length}</dd>
            </div>
            <div className={styles.fact}>
              <dt>nodes kept</dt>
              <dd>{compiled.order.length}</dd>
            </div>
            <div className={styles.fact}>
              <dt>nodes pruned</dt>
              <dd>{compiled.pruned.length}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className={styles.block} aria-label="Timing">
        <h3 className={styles.blockTitle}>timing</h3>
        <p className={styles.note}>
          Per-pass GPU spans are not instrumented yet.
          {timestamps
            ? " The device does support timestamp queries, so they can be."
            : " This device reports no timestamp-query support, so spans will have to be estimated (§V12)."}
        </p>
      </section>
    </div>
  );
}
