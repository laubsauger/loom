import { useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cx } from "../cx.ts";
import { DRAG_THRESHOLD_PX, dragModifierFrom } from "./drag-math.ts";
import type { LabelDragHandlers } from "./label-drag.ts";
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
  /**
   * §V830 — the short name of the MODE deciding this parameter (`expr`, `bind`, `chan`,
   * `map`), or null when the stored constant decides it.
   *
   * A positive statement, and the row-level half of the same mark the field carries: a
   * driven parameter must be identifiable without expanding the mode panel to find out
   * which of the four things is moving it. It outranks `driven`'s generic `drv`, which
   * only ever meant "a driver, somewhere".
   */
  drivenBadge?: string | null;
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
  /**
   * T1026 — what dragging the NAME does, in the same hover text the description uses (§V90).
   *
   * Separate from `labelDrag` on purpose: the sentence is written even when the gesture is
   * NOT offered, because "this name cannot drag its channels, and here is which mode owns
   * each of them" is the honest refusal §V830 asks for, and an inert label that says
   * nothing is the failure it names.
   */
  labelHint?: string | null;
  /**
   * T1026 — the label as a drag surface for a compound (§V113, §V114).
   *
   * Present = the name adjusts every eligible channel at once; the click that toggles the
   * mode panel still works, because a press that never travels `DRAG_THRESHOLD_PX` is a
   * click exactly as it is in `NumberField`. Absent = the label is what it always was.
   */
  labelDrag?: LabelDragHandlers | undefined;
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

interface LabelDragState {
  pointerId: number;
  startX: number;
  moved: boolean;
  lastDelta: number;
}

/**
 * The pointer/keyboard plumbing for a label drag (T1026). Deliberately shaped like
 * `NumberField`'s: absolute travel from the press (accumulating per-move deltas would make
 * the result depend on event granularity, so dragging out and back would not return to the
 * start), a `DRAG_THRESHOLD_PX` dead zone so a click stays a click, and pointer capture so
 * the gesture survives leaving the 60px-wide label.
 *
 * §V20: the press is the control's. Nothing above may read it as a pan, a node drag or a
 * selection — hence `stopPropagation` and the `nodrag` class the label already carries.
 */
function useLabelDragGesture(labelDrag: LabelDragHandlers | undefined) {
  const dragRef = useRef<LabelDragState | null>(null);
  /** Set by a drag that actually moved, so the click it is followed by does not toggle. */
  const suppressClickRef = useRef(false);
  /** True while an arrow key is held, so key-up knows there is an undo group to close. */
  const nudgingRef = useRef(false);

  const consumeClick = (): boolean => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  if (labelDrag === undefined) return { props: {}, consumeClick };

  const end = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const target = event.currentTarget;
    if (
      typeof target.hasPointerCapture === "function" &&
      target.hasPointerCapture(event.pointerId) &&
      typeof target.releasePointerCapture === "function"
    ) {
      target.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    // One commit closes the gesture, and with it the undo group (§V15).
    suppressClickRef.current = true;
    labelDrag.onDrag(drag.lastDelta, dragModifierFrom(event), "commit");
  };

  const props = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
      event.stopPropagation();
      if (event.button !== 0) return;
      const target = event.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId);
      }
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false, lastDelta: 0 };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const deltaX = event.clientX - drag.startX;
      if (!drag.moved) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // The snapshot has to be taken before the first value is emitted, or the second
        // move would read a value the first one wrote and the drag would accelerate.
        labelDrag.onDrag(0, dragModifierFrom(event), "start");
      }
      drag.lastDelta = deltaX;
      labelDrag.onDrag(deltaX, dragModifierFrom(event), "live");
    },
    onPointerUp: end,
    onPointerCancel: end,
    onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      // Only the keys this handles are withheld; mod+z must still reach the graph keymap.
      event.stopPropagation();
      nudgingRef.current = true;
      labelDrag.onNudge(event.key === "ArrowUp" ? 1 : -1, dragModifierFrom(event), "live");
    },
    onKeyUp: (event: KeyboardEvent<HTMLElement>): void => {
      if (!nudgingRef.current) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      nudgingRef.current = false;
      labelDrag.onNudge(event.key === "ArrowUp" ? 1 : -1, dragModifierFrom(event), "commit");
    },
  };

  return { props, consumeClick };
}

export function ControlRow({
  label,
  hint,
  description,
  compileTime = false,
  inactive = null,
  driven = false,
  drivenBadge = null,
  variant = "inspector",
  stacked = false,
  controlId,
  descriptionId,
  onToggleModes,
  labelHint = null,
  labelDrag,
  expanded = false,
  expansion,
  children,
}: ControlRowProps) {
  const { props: dragProps, consumeClick } = useLabelDragGesture(labelDrag);
  const compact = variant === "node";
  // Node-embedded controls stay bare: the inspector is where the full set lives.
  const hasDescription = !compact && description !== undefined && description !== "";
  // One string on the label carries both (§V90): a parameter that is inactive AND
  // documented must not sprout a second hover target.
  const help = [description, inactive, labelHint].filter(
    (part) => part !== undefined && part !== null && part !== "",
  );
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
          <span
            className={cx(
              styles.labelText,
              hasHelp && styles.labelDescribed,
              labelDrag !== undefined && styles.labelDraggable,
              labelDrag !== undefined && "nodrag",
            )}
            {...describedProps}
            {...dragProps}
          >
            {label}
          </span>
        ) : (
          <button
            type="button"
            className={cx(
              styles.labelText,
              styles.labelToggle,
              hasHelp && styles.labelDescribed,
              labelDrag !== undefined && styles.labelDraggable,
              "nodrag",
            )}
            aria-expanded={expanded}
            {...describedProps}
            onPointerDown={(event) => event.stopPropagation()}
            {...dragProps}
            onClick={() => {
              // A drag that moved is not a click, so it must not also toggle the panel.
              if (consumeClick()) return;
              onToggleModes();
            }}
          >
            {label}
          </button>
        )}
        {!compact && compileTime ? (
          <span className={styles.compileBadge} title="Changing this recompiles the node">
            rc
          </span>
        ) : null}
        {drivenBadge !== null ? (
          <span
            className={styles.drivenBadge}
            title={`${drivenBadge} — this value is decided by its mode, not by editing the field. It updates with the render.`}
          >
            {drivenBadge}
          </span>
        ) : driven ? (
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
