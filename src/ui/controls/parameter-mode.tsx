import { useEffect, useMemo, useRef, useState } from "react";
import { parseExpression } from "@domain/expressions/index.ts";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import { describeForecast, forecastClamp } from "@domain/parameters/expression-range.ts";
import type { NumericRange } from "@domain/parameters/expression-range.ts";
import { applyCompletion, completionAt } from "./expression-completion.ts";
import type { ParameterBinding, ParameterMode, ParameterSlot, ParameterValue } from "@domain/types/parameters.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { cx } from "../cx.ts";
import {
  MODE_GLYPHS,
  MODE_LABELS,
  MODE_ORDER,
  MODE_PAYLOAD_LABELS,
  bindingFromText,
  holdsRetainedValue,
  payloadText,
  withMode,
} from "./parameter-slot.ts";
import styles from "./controls.module.css";

/**
 * The parameter mode panel (T204, §V107, §V108) — TouchDesigner's affordance, matched
 * deliberately: click the parameter NAME and four square mode buttons appear.
 *
 * **The detail that carries the feature** is the corner mark. Each mode keeps its own
 * value (§V108), so an inactive button whose mode holds something shows a small square
 * in its lower-left corner. Without it, "switch to Constant to check the number" looks
 * like it might throw the expression away, and a user who is not sure simply never
 * tries. The mark is what makes the whole model safe to experiment with, which is the
 * only reason anyone uses it.
 *
 * Every parameter TYPE gets this panel — number, vector, colour, bool, enum, string
 * alike (§V107). Half of TD's power is menus and toggles driven by expressions, and a
 * mode that only some parameters have is a mode nobody trusts.
 *
 * ## Why the payload is a DRAFT
 *
 * `validateStoredParameter` refuses an unparseable expression, an empty bind ref and an
 * empty channel at WRITE time — correctly, because the resolver treats retained payloads
 * as trustworthy fallbacks. So a panel that wrote on every keystroke would have its patch
 * bounced for every prefix of `time * 2`, and a panel that seeded an empty payload on a
 * mode click would have that patch bounced too, leaving a button that visibly does
 * nothing. Both are avoided the same way: the field holds a draft, the panel checks it
 * against the same grammar the writer does, and the patch is only sent when it will land.
 * A mode with no authorable empty form (bind, driven) is held in the panel until the
 * payload exists — the choice is visible immediately, the document changes once.
 *
 * §V19: the buttons are real `<button>`s in tab order with `aria-pressed`, so the whole
 * panel is operable without a pointer; the payload field takes focus automatically when
 * the panel was opened by ctrl/cmd+E or by choosing a mode that needs one.
 */

export interface ParameterModePanelProps {
  /** Names what is being moded — the parameter, or one component (`Tint.r`). */
  label: string;
  slot: ParameterSlot;
  /** Effective value, used to seed a payload the slot has never held. */
  value: ParameterValue;
  disabled?: boolean;
  /** Focus the payload field on mount — set when ctrl/cmd+E opened the panel. */
  autoFocus?: boolean;
  /** Why the active mode is not producing a value, when the resolver said so. */
  diagnostic?: RuntimeDiagnostic | null;
  /**
   * Names an expression may read here, with their current values (§V71). Supplying it
   * turns on completion (T247); without it the field still works, it just cannot suggest.
   */
  scope?: ExpressionScope;
  /** Node names, for completing inside `op('…')`. */
  nodeNames?: readonly string[];
  /**
   * The parameter's declared bounds, when it has any (T368). Supplying it turns on the
   * clamp FORECAST: an expression that leaves the range later says so now, while it is
   * being typed, instead of at the frame where the picture quietly stops moving.
   */
  range?: NumericRange | null;
  onChange: (slot: ParameterSlot) => void;
}

/**
 * The same checks `validateStoredParameter` makes, asked before the patch instead of
 * after it. Deliberately the same grammar module the domain validator uses (§V71) —
 * a second parser here would drift, and the drift would show up as a rejected patch.
 */
function payloadProblem(binding: ParameterBinding): string | null {
  switch (binding.kind) {
    case "expression": {
      const parsed = parseExpression(binding.source);
      return parsed.ok ? null : parsed.reason;
    }
    case "bind":
      return binding.ref.trim() === "" ? "Name a parameter or parent value to read." : null;
    case "driven":
      return binding.channel.trim() === "" ? "Name a channel." : null;
    case "map":
      return binding.attribute.trim() === "" ? "Name a point attribute." : null;
    case "static":
      return null;
  }
}

export function ParameterModePanel({
  label,
  slot,
  value,
  disabled = false,
  autoFocus = false,
  diagnostic = null,
  scope,
  nodeNames,
  range = null,
  onChange,
}: ParameterModePanelProps) {
  const payloadRef = useRef<HTMLInputElement>(null);
  /** A mode chosen but not yet writable — it has no payload and no valid empty one. */
  const [pendingMode, setPendingMode] = useState<ParameterMode | null>(null);
  /** Non-null while the payload field is being edited. Null means "showing the slot". */
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Which candidate the arrow keys have moved to. Reset whenever the menu changes. */
  const [highlighted, setHighlighted] = useState(0);
  const [caret, setCaret] = useState(0);

  const active = pendingMode ?? slot.mode;

  /**
   * Completion is offered for EXPRESSIONS only. `bind` and `driven` name a parameter or a
   * channel, which are different vocabularies — suggesting `time` while someone types a
   * channel name would be worse than suggesting nothing.
   */
  const completion = useMemo(() => {
    // NOT gated on `scope`: an absent scope means "no live values to show", never "no
    // completion". Gating on it is how this shipped dead — the prop was optional, nothing
    // supplied it, and the menu could not appear (§V272).
    if (active !== "expression" || draft === null) return null;
    return completionAt(draft, caret, scope, nodeNames ?? []);
  }, [active, draft, caret, scope, nodeNames]);
  const text = draft ?? payloadText(slot.bindings[active]);

  // The document caught up with the mode the panel was holding.
  useEffect(() => {
    if (pendingMode !== null && slot.mode === pendingMode) setPendingMode(null);
  }, [pendingMode, slot.mode]);

  useEffect(() => {
    if (!autoFocus) return;
    const input = payloadRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [autoFocus]);

  const selectMode = (mode: ParameterMode): void => {
    setProblem(null);
    setDraft(null);
    if (mode === active) return;
    const next = withMode(slot, mode, value);
    if (next === null) {
      // No payload yet: show the mode as chosen and let the user author it. Nothing is
      // written, because "bound to nothing" is not a state the document should hold.
      setPendingMode(mode);
      setDraft("");
      window.requestAnimationFrame(() => payloadRef.current?.focus());
      return;
    }
    setPendingMode(null);
    onChange(next);
  };

  const commitPayload = (): void => {
    if (draft === null) return;
    const binding = bindingFromText(active, draft, value);
    const invalid = payloadProblem(binding);
    if (invalid !== null) {
      setProblem(invalid);
      return;
    }
    setProblem(null);
    setDraft(null);
    onChange({ mode: active, bindings: { ...slot.bindings, [active]: binding } });
  };

  const cancelPayload = (): void => {
    setDraft(null);
    setProblem(null);
    setPendingMode(null);
  };

  /**
   * T368 — the clamp, forecast while the expression is being typed.
   *
   * It sits behind the two facts rather than in front of them: a parse error and a live
   * resolver diagnostic are about NOW, and this is about later. §V90 keeps it here and
   * not beside the value: the panel only exists once the parameter's name is clicked, so
   * this is help on demand, and it disappears the moment the expression is fixed.
   */
  const forecast = useMemo(() => {
    if (active !== "expression" || range === null || text.trim() === "") return null;
    const found = forecastClamp(text, range);
    return found === null ? null : describeForecast(found);
  }, [active, range, text]);

  const message = problem ?? diagnostic?.message ?? forecast;

  return (
    <div className={styles.modePanel}>
      <div className={styles.modeButtons} role="group" aria-label={`${label} mode`}>
        {MODE_ORDER.map((mode) => {
          const retained = holdsRetainedValue(slot, mode);
          return (
            <button
              key={mode}
              type="button"
              className={cx(styles.modeButton, "nodrag")}
              data-mode={mode}
              aria-pressed={mode === active}
              disabled={disabled}
              // §V90: the explanation is carried by the control, on demand, not printed
              // beside it. The retained-value fact is in the accessible name too, so it
              // is not a purely visual cue (§V19).
              title={`${MODE_LABELS[mode]}${retained ? " — holds a value" : ""}`}
              aria-label={`${MODE_LABELS[mode]}${retained ? ", holds a value" : ""}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => selectMode(mode)}
            >
              <span aria-hidden>{MODE_GLYPHS[mode]}</span>
              {retained ? <span className={styles.modeRetained} aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      {active === "static" ? null : (
        <label className={styles.modePayload}>
          <span className={styles.modePayloadLabel}>{MODE_PAYLOAD_LABELS[active]}</span>
          <input
            ref={payloadRef}
            type="text"
            className={cx(styles.modePayloadInput, "nodrag")}
            value={text}
            disabled={disabled}
            spellCheck={false}
            aria-label={`${label} ${MODE_PAYLOAD_LABELS[active].toLowerCase()}`}
            {...(problem === null ? {} : { "aria-invalid": true })}
            placeholder={placeholderFor(active)}
            onPointerDown={(event) => event.stopPropagation()}
            // §V53: this is a text context; editing keys stay here rather than reaching
            // the graph keymap.
            onKeyDown={(event) => {
              event.stopPropagation();
              // §V150: the menu never takes Enter or Escape. Those commit and cancel the
              // PARAMETER, and a popup that swallows them turns every expression edit into
              // a fight with the tool. TAB accepts — which is what the owner asked for and
              // what leaves the field's own contract untouched.
              if (completion !== null && event.key === "Tab" && !event.shiftKey) {
                const candidate = completion.candidates[highlighted] ?? completion.candidates[0];
                if (candidate !== undefined) {
                  event.preventDefault();
                  const applied = applyCompletion(draft ?? "", completion, candidate);
                  setDraft(applied.source);
                  setProblem(null);
                  setHighlighted(0);
                  // The caret must land after the inserted text, and React will not move
                  // it for us — the value change alone would leave it where it was.
                  window.requestAnimationFrame(() => {
                    payloadRef.current?.setSelectionRange(applied.caret, applied.caret);
                    setCaret(applied.caret);
                  });
                  return;
                }
              }
              if (completion !== null && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const count = completion.candidates.length;
                const step = event.key === "ArrowDown" ? 1 : count - 1;
                setHighlighted((current) => (current + step) % count);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                commitPayload();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelPayload();
              }
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setHighlighted(0);
              setProblem(null);
            }}
            onBlur={commitPayload}
          />
          {completion === null ? null : (
            <ul className={styles.completion} role="listbox" aria-label="Expression completions">
              {completion.candidates.slice(0, 8).map((candidate, index) => (
                <li
                  key={`${candidate.kind}:${candidate.text}`}
                  role="option"
                  aria-selected={index === highlighted}
                  className={cx(
                    styles.completionItem,
                    index === highlighted && styles.completionItemActive,
                  )}
                  // Mouse-down, not click: the field's blur commits, and a click would
                  // land after the value had already been written away.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    const applied = applyCompletion(draft ?? "", completion, candidate);
                    setDraft(applied.source);
                    setProblem(null);
                    setHighlighted(0);
                    window.requestAnimationFrame(() => {
                      payloadRef.current?.focus();
                      payloadRef.current?.setSelectionRange(applied.caret, applied.caret);
                      setCaret(applied.caret);
                    });
                  }}
                >
                  <span className={styles.completionName}>{candidate.text}</span>
                  {candidate.detail === undefined ? null : (
                    <span className={styles.completionDetail}>{candidate.detail}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </label>
      )}

      {message === null ? null : (
        <p className={styles.modeDiagnostic} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function placeholderFor(mode: ParameterMode): string {
  switch (mode) {
    case "expression":
      return "time * 2";
    case "bind":
      return "radius | parent.blur";
    case "driven":
      return "audio.level";
    case "map":
      return "size | velocity:x";
    case "static":
      return "";
  }
}
