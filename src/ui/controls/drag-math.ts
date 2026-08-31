import type { NumericSpec } from "./types.ts";

/**
 * Drag → value maths for the numeric control (T37, doc §8.1).
 *
 * Pure on purpose: this is where the invariants live (modifier scaling, clamping to
 * the manifest range, step quantisation, precision), and a pure module is where they
 * can be tested without a DOM, a pointer, or React.
 */

export type DragModifier = "fine" | "normal" | "coarse";

/**
 * doc §8.1: "Shift modifies slowly and Alt or Option modifies quickly."
 * A decade either side of the default keeps the three speeds distinguishable without
 * making the fine mode useless on a short range.
 */
export const DRAG_MODIFIER_FACTOR: Readonly<Record<DragModifier, number>> = {
  fine: 0.1,
  normal: 1,
  coarse: 10,
};

/** Horizontal pixels that advance the value by one step at normal speed. */
export const PIXELS_PER_STEP = 2;

/** Travel before a press is treated as a drag rather than a click-to-edit. */
export const DRAG_THRESHOLD_PX = 3;

/** Pixels that move a log-scaled value by one decade at normal speed. */
export const PIXELS_PER_DECADE = 200;

/** Decimals used for a log-scaled parameter that declares no precision. */
const LOG_DECIMALS = 4;

const MAX_DECIMALS = 6;

export interface ModifierState {
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Shift wins when both are held. The spec leaves the collision open; resolving it
 * toward the *slower* speed is the safe default — an accidental double modifier
 * should never make the value move ten times faster than intended.
 */
export function dragModifierFrom(event: ModifierState): DragModifier {
  if (event.shiftKey) return "fine";
  if (event.altKey) return "coarse";
  return "normal";
}

function usableRange(spec: NumericSpec): { min: number; max: number } | null {
  const { min, max } = spec;
  if (min === undefined || max === undefined) return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

/**
 * The manifest step, or one derived from the declared range. A bounded parameter with
 * no step gets 1/100 of its range, so a full-range drag is a comfortable 200 px.
 */
export function stepFor(spec: NumericSpec): number {
  const { step } = spec;
  if (step !== undefined && Number.isFinite(step) && step > 0) return step;
  const range = usableRange(spec);
  if (range !== null) return (range.max - range.min) / 100;
  return 0.01;
}

function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(Math.abs(value));
  const exponent = text.indexOf("e-");
  if (exponent >= 0) {
    // 1e-7 and friends: the exponent is the decimal count, capped below anyway.
    return Number(text.slice(exponent + 2));
  }
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Decimals a value is displayed and stored with: the manifest's, or the step's. */
export function decimalsFor(spec: NumericSpec): number {
  const { precision } = spec;
  if (precision !== undefined && Number.isInteger(precision) && precision >= 0) {
    return Math.min(precision, MAX_DECIMALS);
  }
  if (spec.scale === "log") return LOG_DECIMALS;
  return Math.min(decimalsOf(stepFor(spec)), MAX_DECIMALS);
}

export function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  // The extra round-trip through the factor is what kills 0.1 + 0.2 artefacts.
  return Math.round(value * factor) / factor;
}

/**
 * Pins to the ends the spec declares as LIMITS — not to the slider's travel (§B111).
 *
 * The fourth clamp site, and the one the user meets first: before this, typing 725 into a
 * Rotate field silently became 360 on commit, so the resolver could have been fixed and
 * the parameter still could not hold the number. `cyclic` and `soft` pin neither end,
 * `floor` pins the minimum only.
 *
 * `rangeFraction` deliberately still saturates at 0…1. A slider that renders 725° a
 * hundred bar-widths to the right is not more honest, it is unusable — the BAR is the
 * declared travel and pegs at its end, while the NUMERIC READOUT beside it shows 725. TD
 * does exactly this, and it is why the two ideas are separable at all.
 */
export function clampToRange(value: number, spec: NumericSpec): number {
  const kind = spec.range ?? "bounded";
  if (kind === "cyclic" || kind === "soft") return value;
  let result = value;
  if (spec.min !== undefined && Number.isFinite(spec.min)) result = Math.max(result, spec.min);
  if (kind !== "floor" && spec.max !== undefined && Number.isFinite(spec.max)) {
    result = Math.min(result, spec.max);
  }
  return result;
}

/**
 * What "reset to default" commits (T652).
 *
 * The author's own number, clamped into the declared range — and deliberately NOT
 * quantised. `quantize` snaps to `anchor + k·step`, and when no step was declared that
 * grid is an artifact of the range rather than anything anyone stated, so an author's
 * default routinely does not sit on it. Reset therefore returned a value the author never
 * wrote: a Transform's Scale default of 1 reset to 0.96, a Blur's 8px to 7.68, a camera's
 * 55° FOV to 54.4. Measured across the catalogue and the starter components, 46 of 300
 * numeric defaults could not survive their own reset.
 *
 * A DECLARED step does not change the answer either, and that is the point rather than an
 * oversight: `step: 5` with `default: 3` means the author wants 3 and drags in fives, and
 * reset restores what they wrote. Whether a derived step should be a grid AT ALL is
 * T567's open design call; this needs no part of it, because the value being restored was
 * never the user's entry to quantise. T648 gated the MANIFEST round trip; this is the path
 * no manifest can reach.
 *
 * `parameter-precision.test.ts` gates it over the whole catalogue.
 */
export function resetValue(defaultValue: number, spec: NumericSpec): number {
  if (!Number.isFinite(defaultValue)) return clampToRange(0, spec);
  return clampToRange(defaultValue, spec);
}

/**
 * Snap to the step grid, anchored at `min` when there is one so a range like
 * [0.5, 2.5] with step 0.5 lands on the values the author actually meant.
 */
export function quantize(value: number, spec: NumericSpec): number {
  const step = stepFor(spec);
  const anchor = spec.min !== undefined && Number.isFinite(spec.min) ? spec.min : 0;
  const snapped = anchor + Math.round((value - anchor) / step) * step;
  return roundToDecimals(snapped, decimalsFor(spec));
}

/**
 * The single funnel every numeric value passes through before it reaches the
 * document: quantised to the step grid, clamped into the declared range, rounded to
 * the declared precision. A non-finite input collapses to the range minimum (or 0)
 * rather than poisoning the graph with NaN.
 */
export function normalizeValue(value: number, spec: NumericSpec): number {
  if (!Number.isFinite(value)) return clampToRange(0, spec);
  const quantized = spec.scale === "log" ? roundToDecimals(value, decimalsFor(spec)) : quantize(value, spec);
  return roundToDecimals(clampToRange(quantized, spec), decimalsFor(spec));
}

/* ---- the magnitude ladder (T228, §V133, §V134) ------------------------------------ */

/**
 * §V133's magnitude ladder: the decades a numeric drag can be performed at.
 *
 * Precision has to span decades. The same field must reach 0.0001 and 100 without the
 * user going and editing a `step` setting, and three fixed modifier levels cannot do
 * that — they give one decade either side of whatever the manifest happened to declare.
 * Nuke and Houdini solved this by making the reach a THING YOU PICK: press and hold,
 * a ladder of magnitudes appears, choose one, drag at it. The win over more modifier
 * keys is that the reach becomes visible rather than memorised.
 *
 * Fixed rungs, identical in every field, so the gesture means the same thing everywhere.
 * The manifest `step` picks which rung a field STARTS on — a default, never a cap.
 */
export const DECADE_LADDER: readonly number[] = [0.001, 0.01, 0.1, 1, 10, 100];

/** The rung a field starts on: the manifest step snapped down onto the ladder. */
export function defaultDecade(spec: NumericSpec): number {
  const step = stepFor(spec);
  let chosen = DECADE_LADDER[0] as number;
  for (const rung of DECADE_LADDER) {
    if (rung <= step + Number.EPSILON) chosen = rung;
  }
  return chosen;
}

/** Index of `decade` on the ladder, or the nearest rung's index. */
export function decadeIndex(decade: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < DECADE_LADDER.length; index += 1) {
    const rung = DECADE_LADDER[index] as number;
    const gap = Math.abs(Math.log10(rung) - Math.log10(decade));
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  }
  return best;
}

/** Moves `decade` `steps` rungs along the LADDER, clamped at both ends — what the picker walks. */
export function shiftDecade(decade: number, steps: number): number {
  const index = decadeIndex(decade) + steps;
  const clamped = Math.min(DECADE_LADDER.length - 1, Math.max(0, index));
  return DECADE_LADDER[clamped] as number;
}

/**
 * §V133: the modifiers still give ±1 decade, now expressed against the CHOSEN rung
 * rather than against the manifest step. Shift is one finer, Alt one coarser — the same
 * gesture as before, reaching wherever the ladder was left.
 *
 * Deliberately NOT clamped to the ladder. The rungs are what you can PICK; the modifier
 * is a decade either side of the pick, and clamping it would put 0.0001 out of reach
 * from a ladder whose finest rung is 0.001 — which is precisely the reach §V133 names.
 */
export function decadeForModifier(decade: number, modifier: DragModifier): number {
  if (modifier === "fine") return decade / 10;
  if (modifier === "coarse") return decade * 10;
  return decade;
}

/**
 * Decimals a value on `decade`'s grid needs to be written EXACTLY.
 *
 * §V134: changing the reach must not cost exactness. The manifest's precision is a
 * floor, not a ceiling — capping at it would make a 0.001 rung on a `precision: 2`
 * parameter round every value to the same number, which is the ladder doing nothing.
 */
export function decimalsForDecade(spec: NumericSpec, decade: number): number {
  return Math.min(MAX_DECIMALS, Math.max(decimalsFor(spec), decimalsOf(decade)));
}

/**
 * §V134's funnel: snap onto the chosen decade's grid, clamp into the declared range,
 * round so the result is exactly representable. `0.30000000000000004` reaching a saved
 * document is the failure this exists to prevent.
 */
export function normalizeAtDecade(value: number, spec: NumericSpec, decade: number): number {
  if (!Number.isFinite(value)) return clampToRange(0, spec);
  const decimals = decimalsForDecade(spec, decade);
  const anchor = spec.min !== undefined && Number.isFinite(spec.min) ? spec.min : 0;
  const snapped = anchor + Math.round((value - anchor) / decade) * decade;
  return roundToDecimals(clampToRange(roundToDecimals(snapped, decimals), spec), decimals);
}

export interface DragInput {
  /** Value the gesture started from — never the current value, or the drag drifts. */
  startValue: number;
  /** Horizontal travel in pixels since the gesture started. */
  deltaX: number;
  spec: NumericSpec;
  modifier: DragModifier;
  /**
   * Magnitude picked from the ladder (§V133). Absent = the manifest's own step, which
   * is exactly what this control did before the ladder existed.
   */
  decade?: number | undefined;
}

/**
 * Absolute drag mapping: the value is a pure function of where the pointer started
 * and where it is now. Accumulating per-move deltas would make the value depend on
 * event granularity, so dragging out and back would not return to the start value.
 */
export function valueFromDrag({ startValue, deltaX, spec, modifier, decade }: DragInput): number {
  const factor = DRAG_MODIFIER_FACTOR[modifier];

  // A log-scaled parameter moves multiplicatively: equal travel is equal ratio, which
  // is the only way a 0.001..1000 range is draggable at both ends.
  if (spec.scale === "log" && startValue > 0) {
    const decades = (deltaX / PIXELS_PER_DECADE) * factor;
    return normalizeValue(startValue * 10 ** decades, spec);
  }

  // A picked rung replaces the manifest step as the drag granularity, and the modifier
  // moves it one rung rather than scaling it (§V133). Every emitted value still lands on
  // that rung's grid (§V134).
  if (decade !== undefined) {
    const effective = decadeForModifier(decade, modifier);
    return normalizeAtDecade(startValue + (deltaX / PIXELS_PER_STEP) * effective, spec, effective);
  }

  return normalizeValue(startValue + (deltaX / PIXELS_PER_STEP) * stepFor(spec) * factor, spec);
}

export interface NudgeInput {
  value: number;
  /** +1 for ArrowUp / PageUp, -1 for ArrowDown / PageDown. */
  direction: 1 | -1;
  spec: NumericSpec;
  modifier: DragModifier;
  /** Steps per press. PageUp/PageDown pass 10. */
  steps?: number;
  /** Magnitude picked from the ladder (§V133); absent = the manifest step. */
  decade?: number | undefined;
}

/**
 * Keyboard equivalent of a drag (§V19): the control must be operable without a pointer.
 *
 * The modifier scales the number of steps, and never below one: the manifest's step is
 * the author's statement of the smallest meaningful increment, so "finer than a step"
 * is not a thing a key press can ask for. (A drag expresses fine mode as travel
 * instead — ten times the distance for the same step — which needs no sub-step values.)
 */
export function nudge({ value, direction, spec, modifier, steps = 1, decade }: NudgeInput): number {
  const factor = DRAG_MODIFIER_FACTOR[modifier];
  const count = Math.max(1, Math.round(steps * factor));
  if (spec.scale === "log" && value > 0) {
    return normalizeValue(value * 10 ** (direction * 0.05 * count), spec);
  }
  // The keyboard reaches the same decades the ladder does: a rung chosen with the
  // pointer or with mod+arrow is the increment the arrow keys then step by (§V19).
  if (decade !== undefined) {
    const effective = decadeForModifier(decade, modifier);
    return normalizeAtDecade(value + direction * effective * Math.max(1, steps), spec, effective);
  }
  return normalizeValue(value + direction * stepFor(spec) * count, spec);
}

/**
 * Display text for a value: fixed decimals, so digits do not jitter under a drag. A
 * chosen decade widens the display the same way it widens storage (§V134) — a field
 * dragging at 0.001 that still prints two decimals would look frozen.
 */
export function formatNumber(value: number, spec: NumericSpec, decade?: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(decade === undefined ? decimalsFor(spec) : decimalsForDecade(spec, decade));
}

/** A ladder rung as its label: "0.001", "1", "100" — never "1e-3". */
export function formatDecade(decade: number): string {
  const decimals = decimalsOf(decade);
  return decade.toFixed(decimals);
}

/**
 * doc §8.1 — "Parameters show units and constrained ranges". Null when the manifest
 * declares no bound, so an unconstrained parameter does not grow a meaningless hint.
 */
export function describeRange(spec: NumericSpec): string | null {
  const { min, max } = spec;
  const has = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value);
  if (has(min) && has(max)) return `${min}…${max}`;
  if (has(min)) return `≥ ${min}`;
  if (has(max)) return `≤ ${max}`;
  return null;
}

/** 0..1 position of a value inside its declared range, or null when unbounded. */
export function rangeFraction(value: number, spec: NumericSpec): number | null {
  const range = usableRange(spec);
  if (range === null) return null;
  if (spec.scale === "log" && range.min > 0 && value > 0) {
    const span = Math.log10(range.max / range.min);
    return Math.min(1, Math.max(0, Math.log10(value / range.min) / span));
  }
  return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
}
