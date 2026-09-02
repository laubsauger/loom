import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { NumberParameter } from "@domain/types/parameters.ts";
import { cx } from "../cx.ts";
import {
  DECADE_LADDER,
  DRAG_THRESHOLD_PX,
  defaultDecade,
  resetValue,
  dragModifierFrom,
  formatDecade,
  formatNumber,
  normalizeAtDecade,
  normalizeValue,
  nudge,
  rangeFraction,
  shiftDecade,
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
 *   0-9 - . +         start typing, WITH that key as the first character (§V776)
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
 *
 * ## The magnitude ladder (T228, §V133, §V134)
 *
 * Precision spans decades, and three modifier levels cannot cover that: the same field
 * has to reach 0.0001 and 100 without anyone editing a `step` setting. Press and hold
 * and a ladder of magnitudes appears — 0.001 · 0.01 · 0.1 · 1 · 10 · 100 — pick one and
 * drag at it; mod+↑/↓ does the same from the keyboard (§V19). Shift and Alt keep giving
 * ±1 decade from wherever the ladder was left. The manifest `step` chooses the rung the
 * field starts on; it is a default, not a cap. Every value emitted still lands exactly
 * on the chosen rung's grid (§V134) — reach must not cost exactness.
 *
 * ### The way in (T912)
 *
 * Those three paths all existed and only one of them was visible, which is to say none:
 * the hold is invisible by construction and the chord is invisible until you already know
 * it. `LadderSwatch` is the fourth thing that opens the SAME `ladderOpen` state — a mark
 * at the field's left edge, revealed on hover and on keyboard focus. There is one piece
 * of state and now three ways to reach it; the hold stays because it is the drag
 * surface's own gesture and it is muscle memory.
 */

/** How long a press has to sit still before it means "show me the magnitudes". */
const LADDER_HOLD_MS = 400;

/**
 * §B159/§V776 — the keys that MEAN "I am typing a number", so pressing one opens text
 * entry seeded with it.
 *
 * The field is `readOnly` until an edit is open, so before this existed the keydown's
 * `default: return` dropped every printable key: a focused field, `5`, and nothing
 * happened and nothing said why. Deliberately narrow — anything outside this set (`z`
 * and every chord) still falls through to the graph keymap, because undo has to keep
 * working while a field has focus.
 */
const TYPED_ENTRY_START = /^[0-9+.-]$/;

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

interface LadderProps {
  label: string;
  current: number;
  onPick: (decade: number) => void;
  onDismiss: () => void;
}

/**
 * The ladder itself: one button per magnitude, the current rung marked. A listbox
 * rather than a menu because it is a choice among values, and real buttons because the
 * whole thing must work from the keyboard (§V19).
 */
function DecadeLadder({ label, current, onPick, onDismiss }: LadderProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.ladder}
      role="listbox"
      aria-label={`${label} drag magnitude`}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDismiss();
      }}
    >
      {DECADE_LADDER.map((rung) => (
        <button
          key={rung}
          type="button"
          role="option"
          aria-selected={rung === current}
          className={cx(styles.ladderRung, "nodrag")}
          {...(rung === current ? { ref: selectedRef } : {})}
          onClick={() => onPick(rung)}
        >
          {formatDecade(rung)}
        </button>
      ))}
    </div>
  );
}

/**
 * T912 — the deliberate way into the ladder, and the reason it is a SIBLING of the drag
 * surface rather than a child of it.
 *
 * The row is 20 px tall and the two-column grid it sits in has no third slot (§V90 — a
 * third child wraps onto its own line), so this cannot be a button beside the field. It
 * is an overlay on the field's LEFT edge, which is the only part of the box that is
 * permanently empty: the value is right-aligned and the unit suffix is right of that, so
 * nothing here crowds the label, the value or the unit.
 *
 * Rendered outside `.number` on purpose. The drag surface's `onPointerDown` opens a drag
 * and arms the hold, and its `onDoubleClick` resets the parameter to the manifest
 * default — a button INSIDE it would have to remember to stop both, forever, and one
 * missed handler means clicking the swatch destroys the user's value. As a sibling that
 * is structurally impossible. `nodrag` is then not belt-and-braces but load-bearing:
 * being outside `.number` means it is outside the class that opts the field out of React
 * Flow's node drag, so it carries its own (§V20, §T228). `stopPropagation` is the braces.
 *
 * The mark is a three-step stair, not a `▾`: a caret promises a dropdown, and reading the
 * popout as a full-width `<select>` is half of what T912 is about.
 */
function LadderSwatch({ label, open, onOpen }: { label: string; open: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={cx(styles.ladderSwatch, "nodrag")}
      data-open={open}
      aria-label={`${label} drag magnitude`}
      aria-haspopup="listbox"
      aria-expanded={open}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onOpen}
    >
      {/* §V99: the mark is 8px; the button around it is the field's full height. */}
      <svg className={styles.ladderSwatchMark} viewBox="0 0 8 8" aria-hidden focusable="false">
        <rect x="0" y="6" width="8" height="2" />
        <rect x="0" y="3" width="5" height="2" />
        <rect x="0" y="0" width="2" height="2" />
      </svg>
    </button>
  );
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
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Value emitted by an in-flight keyboard repeat, awaiting its commit on keyup. */
  const keyRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Null = the manifest step decides the drag, exactly as before the ladder existed. */
  const [decade, setDecade] = useState<number | null>(null);
  const [ladderOpen, setLadderOpen] = useState(false);
  /** Non-null while the user is typing. Null means "showing the value". */
  const [text, setText] = useState<string | null>(null);
  /**
   * T652 — the exact string this field OPENED with, so an untouched entry commits nothing.
   *
   * A click that never moved opens the field for typing (`beginTextEntry`) and seeds it
   * with `formatNumber(value)`. Blurring then ran that string back through the commit
   * path — parsed, quantised, emitted — for a user who typed NOTHING. Since a derived
   * step's grid is an artifact of the declared range rather than anything an author
   * stated, the author's own value routinely does not sit on it: a Transform's Scale of
   * 1 came back as 0.96, a Blur's 8px as 7.68, a camera's 55° FOV as 54.4. Measured
   * across the catalogue, 46 of 300 numeric defaults could not survive a click and a
   * click away. Display rounding is the other half of the same path — a drift of
   * -0.0008 shows as "-0.00" and committed as 0.
   *
   * This is deliberately NOT a quantisation policy change (that is T567's call, and it
   * is open): committing a number the user did not enter is not a commit, whatever the
   * grid says. Escape already means "I changed nothing"; so does typing nothing.
   */
  const openedWith = useRef<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const editing = text !== null;
  const display = text ?? formatNumber(value, spec, decade ?? undefined);
  const fraction = rangeFraction(value, spec);
  /** What the ladder marks as current: the picked rung, or the one the manifest implies. */
  const shownDecade = decade ?? defaultDecade(spec);

  const cancelHold = useCallback(() => {
    if (holdRef.current === null) return;
    clearTimeout(holdRef.current);
    holdRef.current = null;
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const emit = useCallback(
    (next: number, phase: EditPhase) => {
      onChange(next, phase);
    },
    [onChange],
  );

  /**
   * Opens text entry. With no `seed` the field shows its current value, selected, so the
   * next keystroke replaces it — the click and `Enter`/`F2` gestures.
   *
   * `seed` is the keystroke that STARTED the edit (§V776): it becomes the first
   * character of the entry rather than being discarded in favour of the old value. Such
   * an entry carries no `openedWith`, because T652's "the user typed nothing" guard is
   * about a string the FIELD wrote — a seeded one is a character the user pressed, so
   * committing it is a real commit.
   */
  const beginTextEntry = useCallback(
    (seed: string | null = null) => {
      const opened = seed ?? formatNumber(value, spec, decade ?? undefined);
      openedWith.current = seed === null ? opened : null;
      setText(opened);
      setInvalid(false);
      const input = inputRef.current;
      if (input === null) return;
      // Focus first: an input can only be selected once it is focusable and focused.
      input.focus();
      if (seed === null) {
        input.select();
        return;
      }
      // The caret goes AFTER the seed so the next digit appends. Set on the string the
      // input still holds — React re-reads the selection when it commits the new value
      // and restores these offsets, which land at the end of the one-character seed.
      input.setSelectionRange(seed.length, seed.length);
    },
    [decade, spec, value],
  );

  const commitText = useCallback(
    (raw: string): boolean => {
      const parsed = evaluateExpression(raw);
      if (!parsed.ok) {
        setInvalid(true);
        return false;
      }
      setInvalid(false);
      setText(null);
      // T652: the text is exactly what the field was opened with, so the user entered
      // nothing and there is nothing to commit. Guarded HERE rather than in the blur
      // handler so Enter and blur cannot disagree — Enter on an untouched field would
      // otherwise destroy the value the same way, just less accidentally. Reported as
      // valid, because "no change" is a successful outcome and Enter still re-selects.
      if (raw === openedWith.current) {
        openedWith.current = null;
        return true;
      }
      openedWith.current = null;
      // Typed entry is unchanged on a field nobody has touched the ladder on — the
      // manifest step still quantises it. Once a rung IS picked it quantises there
      // instead, because a field that drags to 0.0001 and then rounds a TYPED 0.0001 to
      // zero would be two controls wearing one box (§V134).
      emit(
        decade === null ? normalizeValue(parsed.value, spec) : normalizeAtDecade(parsed.value, spec, decade),
        "commit",
      );
      return true;
    },
    [decade, emit, spec],
  );

  const cancelTextEntry = useCallback(() => {
    setText(null);
    setInvalid(false);
    openedWith.current = null;
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
      // A press that sits still is asking for the reach, not for a value (§V133). The
      // drag is dropped when the ladder opens, so the release that follows neither
      // commits a value nor falls through to click-to-type.
      cancelHold();
      holdRef.current = setTimeout(() => {
        holdRef.current = null;
        if (dragRef.current?.moved === true) return;
        dragRef.current = null;
        setDragging(false);
        setLadderOpen(true);
      }, LADDER_HOLD_MS);
    },
    [cancelHold, disabled, editing, value],
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
        cancelHold();
        setDragging(true);
      }
      const next = valueFromDrag({
        startValue: drag.startValue,
        deltaX,
        spec,
        modifier: dragModifierFrom(event),
        ...(decade === null ? {} : { decade }),
      });
      if (next === drag.last) return;
      drag.last = next;
      emit(next, "live");
    },
    [cancelHold, decade, emit, spec],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      cancelHold();
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
    [beginTextEntry, cancelHold, disabled, emit],
  );

  const onDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.stopPropagation();
      event.preventDefault();
      cancelTextEntry();
      inputRef.current?.blur();
      // T652: the AUTHOR'S number, clamped into range — never snapped onto a grid they
      // did not declare. `normalizeValue` here made "reset" a lie for every default off
      // the derived step: double-clicking a Transform's Scale reset it to 0.96.
      emit(resetValue(defaultValue, spec), "commit");
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

      // mod+↑/↓ walks the magnitude ladder and shows it, so the reach the pointer gets
      // by pressing and holding is reachable — and VISIBLE — without a pointer (§V19).
      if ((event.metaKey || event.ctrlKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopPropagation();
        setDecade(shiftDecade(shownDecade, event.key === "ArrowUp" ? 1 : -1));
        setLadderOpen(true);
        return;
      }

      const modifier = dragModifierFrom(event);
      const current = keyRef.current ?? value;

      const step = (direction: 1 | -1, steps: number): void => {
        event.preventDefault();
        // Only the keys this control actually handles are withheld from the keymap;
        // mod+z and friends must still reach the graph while a field has focus.
        event.stopPropagation();
        const next = nudge({
          value: current,
          direction,
          spec,
          modifier,
          steps,
          ...(decade === null ? {} : { decade }),
        });
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
          // §B159/§V776 — a key that could BEGIN a number starts the edit and becomes its
          // first character. Held with a modifier it is a chord, not a digit, so it is
          // left to the keymap; so is every other printable key, which is what keeps
          // mod+z (and plain hotkeys) working while a field has focus.
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (!TYPED_ENTRY_START.test(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          beginTextEntry(event.key);
          return;
      }
    },
    [
      beginTextEntry,
      cancelTextEntry,
      commitText,
      decade,
      disabled,
      editing,
      emit,
      shownDecade,
      spec,
      text,
      value,
    ],
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

  // A field that unmounts mid-gesture must still close its undo group. Kept in a ref
  // with EMPTY deps on purpose (B10's sibling): `flushKeyboard` changes identity on
  // every render, because the parent hands a fresh `onChange` down each time. With
  // `[flushKeyboard]` the cleanup fired on every render — so a held arrow key committed
  // once per repaint, turning one gesture into a pile of undo entries (§V15).
  const flushRef = useRef(flushKeyboard);
  flushRef.current = flushKeyboard;
  useEffect(() => () => flushRef.current(), []);

  const onBlur = useCallback(() => {
    flushKeyboard();
    if (text === null) return;
    if (!commitText(text)) cancelTextEntry();
  }, [cancelTextEntry, commitText, flushKeyboard, text]);

  const valueText = unitSuffix(unit) === null ? display : `${display} ${unitSuffix(unit)}`;

  return (
    <div className={styles.numberHost}>
    {/* `nodrag` is React Flow's opt-out class; the handlers below are the real guarantee. */}
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
    {disabled ? null : (
      <LadderSwatch
        label={label}
        open={ladderOpen}
        onOpen={() => {
          setLadderOpen(true);
        }}
      />
    )}
    {ladderOpen ? (
      <DecadeLadder
        label={label}
        current={shownDecade}
        onPick={(rung) => {
          setDecade(rung);
          setLadderOpen(false);
          inputRef.current?.focus();
        }}
        onDismiss={() => {
          setLadderOpen(false);
          inputRef.current?.focus();
        }}
      />
    ) : null}
    </div>
  );
}
