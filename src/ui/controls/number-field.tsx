import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { NumberParameter } from "@domain/types/parameters.ts";
import { cx } from "../cx.ts";
import {
  DRAG_THRESHOLD_PX,
  dragModifierFrom,
  formatNumber,
  normalizeValue,
  nudge,
  rangeFraction,
  valueFromDrag,
} from "./drag-math.ts";
import { evaluateExpression } from "./expression.ts";
import type { EditPhase, NumericSpec, ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * The draggable numeric control (T37) — the piece of the tool the user touches most.
 *
 * Interaction model (doc §8.1):
 *   drag left/right   change the value, absolute from where the press started
 *   shift / alt       fine (×0.1) / coarse (×10)
 *   click             start typing; the field accepts arithmetic
 *   double-click      reset to the manifest default
 *   Tab, then ↑ ↓     nudge one step; PageUp/PageDown ten; Home/End the range ends
 *   Enter             start typing (or commit what was typed); Escape cancels
 *
 * §V20 is why the pointer handling looks so deliberate. A parameter drag must never
 * become a graph pan, a node drag or a selection: the press is stopped from
 * propagating, its default (focus and text selection) is prevented, and the pointer is
 * captured so the gesture keeps working when it leaves the field. The `nodrag` class
 * is React Flow's own opt-out and is belt to that braces — if either mechanism is
 * removed the control still cannot start a node drag.
 *
 * §V15/§V5: intermediate values are reported as `"live"` and the settled value as
 * `"commit"`. The editor holds one transaction across a gesture, so a drag applies
 * continuously but collapses into a single undo entry.
 */

/** doc §8.1 — "Parameters show units". Symbols, not words: the row is 20 px tall. */
const UNIT_SUFFIX: Readonly<Record<NonNullable<NumberParameter["unit"]>, string>> = {
  px: "px",
  percent: "%",
  degrees: "°",
  radians: "rad",
  seconds: "s",
  hz: "Hz",
};

export function unitSuffix(unit: NumberParameter["unit"]): string | null {
  return unit === undefined ? null : UNIT_SUFFIX[unit];
}

export interface NumberFieldProps {
  /** Accessible name. The visible label lives in the row; this names the control. */
  label: string;
  value: number;
  spec: NumericSpec;
  /** Value a double-click restores (doc §8.1). */
  defaultValue: number;
  unit?: NumberParameter["unit"];
  disabled?: boolean;
  id?: string;
  describedBy?: string;
  className?: string;
  onChange: ValueListener<number>;
}

interface DragState {
  pointerId: number;
  startX: number;
  startValue: number;
  moved: boolean;
  last: number;
}

export function NumberField({
  label,
  value,
  spec,
  defaultValue,
  unit,
  disabled = false,
  id,
  describedBy,
  className,
  onChange,
}: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  /** Value emitted by an in-flight keyboard repeat, awaiting its commit on keyup. */
  const keyRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Non-null while the user is typing. Null means "showing the value". */
  const [text, setText] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const editing = text !== null;
  const display = text ?? formatNumber(value, spec);
  const fraction = rangeFraction(value, spec);

  const emit = useCallback(
    (next: number, phase: EditPhase) => {
      onChange(next, phase);
    },
    [onChange],
  );

  const beginTextEntry = useCallback(() => {
    setText(formatNumber(value, spec));
    setInvalid(false);
    const input = inputRef.current;
    if (input === null) return;
    // Focus first: an input can only be selected once it is focusable and focused.
    input.focus();
    input.select();
  }, [spec, value]);

  const commitText = useCallback(
    (raw: string): boolean => {
      const parsed = evaluateExpression(raw);
      if (!parsed.ok) {
        setInvalid(true);
        return false;
      }
      setInvalid(false);
      setText(null);
      emit(normalizeValue(parsed.value, spec), "commit");
      return true;
    },
    [emit, spec],
  );

  const cancelTextEntry = useCallback(() => {
    setText(null);
    setInvalid(false);
  }, []);

  // ---- pointer (§V20) ------------------------------------------------

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || event.button !== 0) return;
      // While typing the pointer belongs to the caret, not to the drag.
      if (editing) {
        event.stopPropagation();
        return;
      }
      // §V20: this gesture is the control's, and nothing above it may interpret it as
      // a pan, a node drag or a selection.
      event.stopPropagation();
      event.preventDefault();
      const target = event.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId);
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startValue: value,
        moved: false,
        last: value,
      };
    },
    [disabled, editing, value],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const deltaX = event.clientX - drag.startX;
      if (!drag.moved) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        setDragging(true);
      }
      const next = valueFromDrag({
        startValue: drag.startValue,
        deltaX,
        spec,
        modifier: dragModifierFrom(event),
      });
      if (next === drag.last) return;
      drag.last = next;
      emit(next, "live");
    },
    [emit, spec],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      dragRef.current = null;
      setDragging(false);
      const target = event.currentTarget;
      if (
        typeof target.hasPointerCapture === "function" &&
        target.hasPointerCapture(event.pointerId) &&
        typeof target.releasePointerCapture === "function"
      ) {
        target.releasePointerCapture(event.pointerId);
      }
      if (drag.moved) {
        // One commit closes the gesture — and with it the undo group (§V15).
        emit(drag.last, "commit");
        return;
      }
      // A press that never moved is a click: hand the field to the keyboard.
      if (!disabled) beginTextEntry();
    },
    [beginTextEntry, disabled, emit],
  );

  const onDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.stopPropagation();
      event.preventDefault();
      cancelTextEntry();
      inputRef.current?.blur();
      emit(normalizeValue(defaultValue, spec), "commit");
    },
    [cancelTextEntry, defaultValue, disabled, emit, spec],
  );

  // ---- keyboard (§V19) -----------------------------------------------

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (disabled) return;

      if (editing) {
        // §V53: while typing, this is a text context — editing keys are swallowed here
        // rather than reaching the graph keymap.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          if (commitText(text ?? "")) inputRef.current?.select();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelTextEntry();
        }
        return;
      }

      const modifier = dragModifierFrom(event);
      const current = keyRef.current ?? value;

      const step = (direction: 1 | -1, steps: number): void => {
        event.preventDefault();
        // Only the keys this control actually handles are withheld from the keymap;
        // mod+z and friends must still reach the graph while a field has focus.
        event.stopPropagation();
        const next = nudge({ value: current, direction, spec, modifier, steps });
        keyRef.current = next;
        // Held keys repeat; reporting them as live keeps the repeat in one undo group.
        emit(next, "live");
      };

      switch (event.key) {
        case "ArrowUp":
          step(1, 1);
          return;
        case "ArrowDown":
          step(-1, 1);
          return;
        case "PageUp":
          step(1, 10);
          return;
        case "PageDown":
          step(-1, 10);
          return;
        case "Home":
          if (spec.min === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          emit(normalizeValue(spec.min, spec), "commit");
          return;
        case "End":
          if (spec.max === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          emit(normalizeValue(spec.max, spec), "commit");
          return;
        case "Enter":
        case "F2":
          event.preventDefault();
          event.stopPropagation();
          beginTextEntry();
          return;
        default:
          return;
      }
    },
    [beginTextEntry, cancelTextEntry, commitText, disabled, editing, emit, spec, text, value],
  );

  const flushKeyboard = useCallback(() => {
    const pending = keyRef.current;
    if (pending === null) return;
    keyRef.current = null;
    emit(pending, "commit");
  }, [emit]);

  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (keyRef.current === null) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) flushKeyboard();
    },
    [flushKeyboard],
  );

  // A field that loses focus mid-gesture must still close its undo group.
  useEffect(() => flushKeyboard, [flushKeyboard]);

  const onBlur = useCallback(() => {
    flushKeyboard();
    if (text === null) return;
    if (!commitText(text)) cancelTextEntry();
  }, [cancelTextEntry, commitText, flushKeyboard, text]);

  const valueText = unitSuffix(unit) === null ? display : `${display} ${unitSuffix(unit)}`;

  return (
    // `nodrag` is React Flow's opt-out class; the handlers below are the real guarantee.
    <div
      className={cx(styles.number, invalid && styles.numberInvalid, "nodrag", className)}
      data-dragging={dragging}
      data-editing={editing}
      data-disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      {fraction === null ? null : (
        <span className={styles.numberFill} style={{ width: `${fraction * 100}%` }} aria-hidden />
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        className={styles.numberInput}
        value={display}
        readOnly={!editing}
        disabled={disabled}
        aria-label={label}
        aria-valuenow={value}
        aria-valuetext={valueText}
        {...(spec.min === undefined ? {} : { "aria-valuemin": spec.min })}
        {...(spec.max === undefined ? {} : { "aria-valuemax": spec.max })}
        {...(id === undefined ? {} : { id })}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
        {...(invalid ? { "aria-invalid": true } : {})}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
      />
      {unitSuffix(unit) === null ? null : (
        <span className={styles.numberUnit} aria-hidden>
          {unitSuffix(unit)}
        </span>
      )}
    </div>
  );
}
