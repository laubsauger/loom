import { useCallback, useMemo, useState } from "react";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { PerformancePanel } from "@editor/inspect/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { ShaderEditor, commitShaderSource, diagnosticsToMarkers } from "@editor/shader-editor/index.ts";
import { useAppRuntime } from "./app-context.ts";
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

/**
 * The `performance` slot (T41, §V16, §V86).
 *
 * This used to be a hand-rolled placeholder that re-derived the plan's counts from
 * `CompiledGraph` and printed a paragraph about timing not existing. The real panel had
 * shipped and tested behind it the whole time. It reads the telemetry hub — the same
 * snapshot the node info popup reads, at the same <= 10 Hz — so there is one answer to
 * "how many passes" and one answer to "how long did they take" rather than two.
 *
 * With no timing source attached every ms field reads "unavailable", which is the
 * truthful state and the one §V86 requires: not 0.000, and not a CPU-side number wearing
 * a GPU label.
 */
export function PerformancePane() {
  const { telemetry } = useAppRuntime();
  return <PerformancePanel telemetry={telemetry} />;
}
