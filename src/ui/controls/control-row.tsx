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
  /**
   * §V146 — the reason this parameter cannot affect the output right now, or null.
   *
   * The row DIMS; it does not disable. The reason joins the description on the label's
   * hover and focus, which is where every other explanation in this kit lives (§V90) —
   * no badge, no icon, no inline sentence under the control.
   */
  inactive?: string | null;
  /** The effective value comes from a driver, not the document (doc §8.2 seam). */
  driven?: boolean;
  variant?: ControlVariant;
  /** Renders the label above the control — for multiline text and wide controls. */
  stacked?: boolean;
  /** Id of the control the label names, when it is a real form control. */
  controlId?: string | undefined;
  descriptionId?: string | undefined;
  /**
   * T204: clicking the parameter NAME expands the mode panel, TD's affordance. Passing
   * this turns the label text into a toggle button; omitting it leaves the plain
   * `<label htmlFor>` every other row has always had, so the node-embedded variant and
   * the Common section are untouched.
   */
  onToggleModes?: (() => void) | undefined;
  expanded?: boolean;
  /** Rendered full width beneath the row when `expanded` — the mode panel. */
  expansion?: ReactNode;
  children: ReactNode;
}

/** `<label>` when the name names a control, a plain box when the name is a button. */
function LabelBox({
  as,
  htmlFor,
  className,
  children,
}: {
  as: "label" | "div";
  htmlFor?: string;
  className: string | undefined;
  children: ReactNode;
}) {
  if (as === "label") {
    return (
      <label className={className} {...(htmlFor === undefined ? {} : { htmlFor })}>
        {children}
      </label>
    );
  }
  return <div className={className}>{children}</div>;
}

export function ControlRow({
  label,
  hint,
  description,
  compileTime = false,
  inactive = null,
  driven = false,
  variant = "inspector",
  stacked = false,
  controlId,
  descriptionId,
  onToggleModes,
  expanded = false,
  expansion,
  children,
}: ControlRowProps) {
  const compact = variant === "node";
  // Node-embedded controls stay bare: the inspector is where the full set lives.
  const hasDescription = !compact && description !== undefined && description !== "";
  // One string on the label carries both (§V90): a parameter that is inactive AND
  // documented must not sprout a second hover target.
  const help = [description, inactive].filter((part) => part !== undefined && part !== null && part !== "");
  const hasHelp = !compact && help.length > 0;
  const describedProps = {
    ...(hasHelp ? { title: help.join(" — ") } : {}),
    ...(hasDescription && descriptionId !== undefined ? { id: descriptionId } : {}),
  };
  return (
    <div
      className={cx(
        styles.row,
        compact && styles.rowCompact,
        stacked && styles.rowStacked,
        expanded && styles.rowExpanded,
        inactive !== null && styles.rowInactive,
      )}
      data-inactive={inactive === null ? undefined : true}
    >
      {/*
        A row that can disclose modes is NOT a `<label>`: the name is a button, and a
        `<label>` claims its descendant's accessible name, which left the disclosure
        anonymous to a screen reader (and to the tests standing in for one).
      */}
      <LabelBox
        as={onToggleModes === undefined ? "label" : "div"}
        className={styles.label}
        {...(controlId === undefined || onToggleModes !== undefined ? {} : { htmlFor: controlId })}
      >
        {/*
          The description lives on the LABEL — hover or focus it and you get the text.
          An earlier version put a `?` handle after the control, which wrapped onto its own
          line because the row is a two-column grid, and it added an indicator for
          something the label already implies. Fewer elements, same information.

          When the row can show modes the name becomes the disclosure (T204, TD parity).
          It is still the same text carrying the same description on hover and focus — the
          affordance is added to the label, not put beside it (§V90).
        */}
        {onToggleModes === undefined ? (
          <span className={cx(styles.labelText, hasHelp && styles.labelDescribed)} {...describedProps}>
            {label}
          </span>
        ) : (
          <button
            type="button"
            className={cx(styles.labelText, styles.labelToggle, hasHelp && styles.labelDescribed, "nodrag")}
            aria-expanded={expanded}
            {...describedProps}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onToggleModes}
          >
            {label}
          </button>
        )}
        {!compact && compileTime ? (
          <span className={styles.compileBadge} title="Changing this recompiles the node">
            rc
          </span>
        ) : null}
        {driven ? (
          <span className={styles.drivenBadge} title="Driven — the shown value comes from a driver">
            drv
          </span>
        ) : null}
        {!compact && hint ? <span className={styles.hint}>{hint}</span> : null}
      </LabelBox>
      <div className={styles.control}>{children}</div>
      {expanded && expansion !== undefined ? (
        <div className={styles.expansion}>{expansion}</div>
      ) : null}
    </div>
  );
}
