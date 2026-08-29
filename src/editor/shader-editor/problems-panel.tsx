import { useMemo } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { cx } from "@ui/cx.ts";
import { formatDiagnosticLocation, partitionDiagnostics } from "./shader-diagnostics.ts";
import styles from "./problems-panel.module.css";

export interface ProblemsPanelProps {
  /** Every diagnostic to show — shader compile messages, and later runtime ones. */
  diagnostics: readonly RuntimeDiagnostic[];
  /** Jump to a diagnostic's source position. */
  onSelect?: ((diagnostic: RuntimeDiagnostic) => void) | undefined;
  /** Copy for the "nothing wrong" state. */
  emptyHint?: string | undefined;
}

type Tone = "error" | "warning" | "info";

const TONE_CLASS: Record<Tone, string> = {
  error: styles.errorTone ?? "",
  warning: styles.warningTone ?? "",
  info: styles.infoTone ?? "",
};

const ROW_CLASS: Record<Tone, string> = {
  error: styles.rowError ?? "",
  warning: styles.rowWarning ?? "",
  info: styles.rowInfo ?? "",
};

/**
 * The `problems` slot of the bottom dock (§V27).
 *
 * Errors and warnings are separate groups with separate headings, not one list sorted by
 * severity: a warning that scrolls in among twelve errors is a warning nobody reads, and
 * §V27 asks for them to display separately for exactly that reason.
 */
export function ProblemsPanel({ diagnostics, onSelect, emptyHint }: ProblemsPanelProps) {
  const { errors, warnings, info } = useMemo(
    () => partitionDiagnostics(diagnostics),
    [diagnostics],
  );

  if (errors.length === 0 && warnings.length === 0 && info.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>
          <span>No problems</span>
          <span className={styles.emptyHint}>
            {emptyHint ?? "Shader compile messages and runtime diagnostics appear here."}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} aria-label="Problems">
      <DiagnosticGroup tone="error" label="errors" items={errors} {...(onSelect ? { onSelect } : {})} />
      <DiagnosticGroup tone="warning" label="warnings" items={warnings} {...(onSelect ? { onSelect } : {})} />
      <DiagnosticGroup tone="info" label="info" items={info} {...(onSelect ? { onSelect } : {})} />
    </div>
  );
}

interface DiagnosticGroupProps {
  tone: Tone;
  label: string;
  items: readonly RuntimeDiagnostic[];
  onSelect?: (diagnostic: RuntimeDiagnostic) => void;
}

function DiagnosticGroup({ tone, label, items, onSelect }: DiagnosticGroupProps) {
  if (items.length === 0) return null;
  return (
    <section className={styles.group} aria-label={label}>
      <header className={cx(styles.groupHeader, TONE_CLASS[tone])}>
        <span>{label}</span>
        <span className={styles.groupCount}>{items.length}</span>
      </header>
      {items.map((diagnostic, index) => (
        <DiagnosticRow
          // Diagnostics have no identity of their own; position within the group is
          // stable for as long as the group is on screen.
          key={`${diagnostic.code}:${index}`}
          tone={tone}
          diagnostic={diagnostic}
          {...(onSelect ? { onSelect } : {})}
        />
      ))}
    </section>
  );
}

interface DiagnosticRowProps {
  tone: Tone;
  diagnostic: RuntimeDiagnostic;
  onSelect?: (diagnostic: RuntimeDiagnostic) => void;
}

/** A real `<button>`: focusable, Enter/Space activated, announced (V19). */
function DiagnosticRow({ tone, diagnostic, onSelect }: DiagnosticRowProps) {
  const location = formatDiagnosticLocation(diagnostic);
  return (
    <button
      type="button"
      className={cx(styles.row, ROW_CLASS[tone], TONE_CLASS[tone])}
      onClick={() => onSelect?.(diagnostic)}
    >
      <span className={styles.marker} aria-hidden="true" />
      <span className={styles.message}>
        {diagnostic.message}
        <span className={styles.code}>{diagnostic.code}</span>
        {diagnostic.suggestion === undefined ? null : (
          <span className={styles.suggestion}>{diagnostic.suggestion}</span>
        )}
      </span>
      <span className={styles.location}>{location ?? ""}</span>
    </button>
  );
}
