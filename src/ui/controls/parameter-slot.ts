import type {
  ParameterBinding,
  ParameterMode,
  ParameterSlot,
  ParameterValue,
} from "@domain/types/parameters.ts";
import { isParameterSlot, slotFromValue, PARAMETER_MODES } from "@domain/parameters/slots.ts";

/**
 * Slot EDITING — the write half of the mode model (T204, §V107, §V108).
 *
 * `src/domain/parameters/slots.ts` owns reading a stored parameter (what shape is it,
 * what does its static binding hold); nothing here re-implements any of that, and the
 * mode list itself is imported rather than re-declared so a fifth mode cannot appear in
 * the domain and be missing from the buttons.
 *
 * What this module adds is the one rule the UI is responsible for: **a mode switch is
 * never destructive** (§V108). Every function here returns a slot whose `bindings` is a
 * superset of the one it was given. That is not a nicety — it is what the corner mark on
 * an inactive button promises, and the reason flipping to Constant to read a number is
 * safe to do with an expression half-written.
 */

/** Display order of the mode buttons — TD's row, left to right. */
export const MODE_ORDER: readonly ParameterMode[] = PARAMETER_MODES;

/** Button captions. Short because four of them share one control row. */
export const MODE_LABELS: Readonly<Record<ParameterMode, string>> = {
  static: "Constant",
  expression: "Expression",
  bind: "Bind",
  driven: "Driven",
};

/** Single-glyph face of each button — the row is four ~18px squares. */
export const MODE_GLYPHS: Readonly<Record<ParameterMode, string>> = {
  static: "C",
  expression: "E",
  bind: "B",
  driven: "D",
};

/** What the active mode's payload is called in its editor's label. */
export const MODE_PAYLOAD_LABELS: Readonly<Record<ParameterMode, string>> = {
  static: "Value",
  expression: "Expression",
  bind: "Bound to",
  driven: "Channel",
};

/** The slot a stored parameter already is, or the one a bare value means. */
export function slotOf(
  stored: ParameterSlot | undefined,
  value: ParameterValue,
): ParameterSlot {
  return stored ?? slotFromValue(value);
}

/** Reads a binding's payload as the string its editor edits. Static has no string form. */
export function payloadText(binding: ParameterBinding | undefined): string {
  if (binding === undefined) return "";
  switch (binding.kind) {
    case "expression":
      return binding.source;
    case "bind":
      return binding.ref;
    case "driven":
      return binding.channel;
    case "static":
      return "";
  }
}

/**
 * A `ParameterValue` as the number an expression would produce for it (§V107's coercion,
 * read backwards). Seeds a fresh expression with the value the user is looking at, so
 * switching to Expression starts where Constant left off instead of at zero.
 */
export function numericLiteralFor(value: ParameterValue): string {
  const scalar = ((): number => {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      return typeof first === "number" && Number.isFinite(first) ? first : 0;
    }
    return 0;
  })();
  return String(Number.isFinite(scalar) ? scalar : 0);
}

/**
 * The payload a mode gets when it is activated for the first time.
 *
 * It has to be one the WRITE validator accepts, or the button is inert: an empty
 * expression does not parse and an empty bind ref is refused, so seeding those would
 * make the patch bounce and the mode switch would silently do nothing. Expression seeds
 * a literal of the current value; `bind` and `driven` have no meaningful empty form at
 * all, so they seed nothing and the panel holds the choice until a payload is typed.
 */
export function seedBinding(mode: ParameterMode, value: ParameterValue): ParameterBinding | null {
  switch (mode) {
    case "static":
      return { kind: "static", value };
    case "expression":
      return { kind: "expression", source: numericLiteralFor(value) };
    case "bind":
    case "driven":
      return null;
  }
}

/** Builds a binding of `mode` carrying `text` — the inverse of `payloadText`. */
export function bindingFromText(
  mode: ParameterMode,
  text: string,
  value: ParameterValue,
): ParameterBinding {
  switch (mode) {
    case "static":
      return { kind: "static", value };
    case "expression":
      return { kind: "expression", source: text };
    case "bind":
      return { kind: "bind", ref: text };
    case "driven":
      return { kind: "driven", channel: text };
  }
}

/**
 * Switches the active mode, KEEPING every other mode's payload (§V108).
 *
 * The mode being left keeps what it held; the mode being entered keeps what it held
 * last time, or is seeded empty. `value` is the parameter's effective value and is used
 * only to seed a missing static payload, so that switching to Constant on a parameter
 * that has only ever been an expression lands on the number the user was just looking
 * at rather than on the manifest default.
 */
export function withMode(
  slot: ParameterSlot,
  mode: ParameterMode,
  value: ParameterValue,
): ParameterSlot | null {
  const existing = slot.bindings[mode];
  const retained = existing !== undefined && existing.kind === mode ? existing : null;
  const binding = retained ?? seedBinding(mode, value);
  // Null = this mode has no payload yet and no sensible empty one. The caller keeps the
  // choice in the UI and writes once the user has authored something.
  if (binding === null) return null;
  return { mode, bindings: { ...slot.bindings, [mode]: binding } };
}

/**
 * Replaces one mode's payload without changing which mode is active.
 *
 * Editing the expression while the parameter sits in Constant is a real thing to do —
 * it is half of why the retained payload exists — so writing a payload must not flip
 * the mode behind the user's back.
 */
export function withBinding(slot: ParameterSlot, binding: ParameterBinding): ParameterSlot {
  return { mode: slot.mode, bindings: { ...slot.bindings, [binding.kind]: binding } };
}

/** The static payload a slot should carry once the control below it writes `value`. */
export function withStaticValue(slot: ParameterSlot, value: ParameterValue): ParameterSlot {
  return withBinding(slot, { kind: "static", value });
}

/**
 * §V108's corner mark, as a predicate: does this INACTIVE mode hold something?
 *
 * Active modes never mark — the button is already lit — and an empty payload does not
 * count. A mark on "Expression" that means "there is an empty string in there" would
 * teach the user the mark means nothing.
 */
export function holdsRetainedValue(slot: ParameterSlot, mode: ParameterMode): boolean {
  if (slot.mode === mode) return false;
  const binding = slot.bindings[mode];
  if (binding === undefined || binding.kind !== mode) return false;
  if (binding.kind === "static") return true;
  return payloadText(binding).trim() !== "";
}

/** True when the stored parameter is a mode envelope rather than a bare value. */
export { isParameterSlot };
