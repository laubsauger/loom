import { useMemo } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { ShaderEditor } from "./shader-editor.tsx";
import { diagnosticsToMarkers } from "./shader-diagnostics.ts";
import type { ShaderCompileState } from "./compile-pipeline.ts";
import styles from "./shader-editor.module.css";

export interface ShaderEditorPanelProps {
  /** `null` when nothing shader-authorable is selected. */
  nodeId: NodeId | null;
  /** Node title for the status strip. Falls back to the id. */
  nodeTitle?: string | undefined;
  source: string;
  state: ShaderCompileState;
  onSourceChange: (next: string) => void;
  /** Commit point — the editor calls this when focus leaves. */
  onBlur?: (() => void) | undefined;
  readOnly?: boolean | undefined;
}

const PHASE_LABEL: Record<ShaderCompileState["phase"], string> = {
  idle: "compiled",
  pending: "edited",
  compiling: "compiling…",
};

/**
 * The `shaderEditor` slot of the bottom dock (§I.ui, T20/T21/T22).
 *
 * The status strip carries the one thing §V9 makes non-negotiable: when a compile fails,
 * the render did not stop and did not go black — it is still running the last shader
 * that compiled — and the user must be able to see that, or they will read a working
 * output as proof their broken edit was fine.
 */
export function ShaderEditorPanel({
  nodeId,
  nodeTitle,
  source,
  state,
  onSourceChange,
  onBlur,
  readOnly = false,
}: ShaderEditorPanelProps) {
  const markers = useMemo(
    () => diagnosticsToMarkers(source, [...state.errors, ...state.warnings, ...state.info]),
    [source, state.errors, state.warnings, state.info],
  );

  if (nodeId === null) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>
          <span>No shader selected</span>
          <span className={styles.emptyHint}>
            Select a node with a WGSL source parameter to edit its shader.
          </span>
        </div>
      </div>
    );
  }

  const errorCount = state.errors.length;
  const warningCount = state.warnings.length;

  return (
    <div className={styles.panel}>
      <div className={styles.status}>
        <span className={styles.node}>{nodeTitle ?? nodeId}</span>
        <span
          className={state.phase === "compiling" ? `${styles.phase} ${styles.phaseBusy}` : styles.phase}
        >
          {PHASE_LABEL[state.phase]}
        </span>
        {state.stale ? (
          <span className={styles.stale} role="status">
            <span className={styles.staleDot} aria-hidden="true" />
            output stale — last valid shader still rendering
          </span>
        ) : null}
        <span className={styles.counts}>
          <span
            className={errorCount > 0 ? styles.countError : styles.countOk}
            aria-label={`${errorCount} errors`}
          >
            {errorCount} err
          </span>
          <span
            className={warningCount > 0 ? styles.countWarning : undefined}
            aria-label={`${warningCount} warnings`}
          >
            {warningCount} warn
          </span>
        </span>
      </div>

      <ShaderEditor
        className={styles.editor}
        value={source}
        onChange={onSourceChange}
        markers={markers}
        readOnly={readOnly}
        label={`WGSL source for ${nodeTitle ?? nodeId}`}
        {...(onBlur === undefined ? {} : { onBlur })}
      />
    </div>
  );
}
