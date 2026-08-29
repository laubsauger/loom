import type { ReactNode } from "react";
import { cx } from "@ui/cx.ts";
import styles from "./pane.module.css";

export interface PaneProps {
  /** Header label. Also the accessible name of the pane region. */
  title: string;
  /** Trailing header controls (filters, pin, menu). */
  actions?: ReactNode;
  /** Set false when the slot manages its own scrolling (canvas, editor). */
  scroll?: boolean;
  children?: ReactNode;
}

/**
 * Pane chrome: one hairline header, one body. The header is the only chrome a
 * pane gets — everything else in the rectangle belongs to the slot content.
 */
export function Pane({ title, actions, scroll = true, children }: PaneProps) {
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <span className={styles.title}>{title}</span>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      <div className={cx(styles.body, scroll && styles.bodyScroll)}>{children}</div>
    </section>
  );
}

export interface PaneEmptyProps {
  label: string;
  hint?: string;
}

/** Placeholder for a slot another track has not filled yet. */
export /**
 * Empty state. The label names the STATE ("No selection"), not the pane's purpose or its
 * implementation — a user reading "CodeMirror 6 WGSL editor mounts here" learns nothing
 * they can act on. `hint` exists for the case where the next action is genuinely
 * non-obvious; leave it out otherwise (§V90).
 */
function PaneEmpty({ label, hint }: PaneEmptyProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyLabel}>{label}</span>
      {hint ? <span className={styles.emptyHint}>{hint}</span> : null}
    </div>
  );
}
