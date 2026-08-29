import type { ReactNode } from "react";
import { cx } from "../cx.ts";
import styles from "./controls.module.css";

/**
 * Label / control / hint layout shared by every parameter row (T37, T38).
 *
 * `variant` is the compact-versus-complete axis doc §8.1 asks for: a node-embedded
 * control keeps only the label and the control, while the inspector adds the range
 * hint, the description and the compile-time badge. Same components, same behaviour,
 * different density — never a second implementation.
 */
export type ControlVariant = "inspector" | "node";

export interface ControlRowProps {
  label: string;
  /** Range/unit hint. Inspector only. */
  hint?: string | null;
  description?: string | undefined;
  /** §V5: marks a parameter whose change forces a targeted recompile. */
  compileTime?: boolean;
  /** The effective value comes from a driver, not the document (doc §8.2 seam). */
  driven?: boolean;
  variant?: ControlVariant;
  /** Renders the label above the control — for multiline text and wide controls. */
  stacked?: boolean;
  /** Id of the control the label names, when it is a real form control. */
  controlId?: string | undefined;
  descriptionId?: string | undefined;
  children: ReactNode;
}

export function ControlRow({
  label,
  hint,
  description,
  compileTime = false,
  driven = false,
  variant = "inspector",
  stacked = false,
  controlId,
  descriptionId,
  children,
}: ControlRowProps) {
  const compact = variant === "node";
  // Node-embedded controls stay bare: the inspector is where the full set lives.
  const hasDescription = !compact && description !== undefined && description !== "";
  return (
    <div className={cx(styles.row, compact && styles.rowCompact, stacked && styles.rowStacked)}>
      <label className={styles.label} {...(controlId === undefined ? {} : { htmlFor: controlId })}>
        <span className={styles.labelText}>{label}</span>
        {!compact && compileTime ? (
          <span className={styles.compileBadge} title="Changing this recompiles the node (§V5)">
            rc
          </span>
        ) : null}
        {driven ? (
          <span className={styles.drivenBadge} title="Driven — the shown value comes from a driver">
            drv
          </span>
        ) : null}
        {!compact && hint ? <span className={styles.hint}>{hint}</span> : null}
      </label>
      <div className={styles.control}>{children}</div>
      {/*
        A parameter's description is available ON DEMAND, never rendered inline. A node has
        ten to fifteen parameters; a sentence under each is a wall of prose that buries the
        values the user came to read, and it is read once and then permanently in the way.
        It stays reachable by hover, by focus, and by screen reader — the text is not lost,
        only the ambient noise is.
      */}
      {hasDescription ? (
        <span
          className={styles.descriptionHandle}
          tabIndex={0}
          role="note"
          aria-label={`About ${label}`}
          title={description}
          {...(descriptionId === undefined ? {} : { id: descriptionId })}
        >
          <span aria-hidden="true">?</span>
          <span className={styles.visuallyHidden}>{description}</span>
        </span>
      ) : null}
    </div>
  );
}
