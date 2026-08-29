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

export function clampToRange(value: number, spec: NumericSpec): number {
  let result = value;
  if (spec.min !== undefined && Number.isFinite(spec.min)) result = Math.max(result, spec.min);
  if (spec.max !== undefined && Number.isFinite(spec.max)) result = Math.min(result, spec.max);
  return result;
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

export interface DragInput {
  /** Value the gesture started from — never the current value, or the drag drifts. */
  startValue: number;
  /** Horizontal travel in pixels since the gesture started. */
  deltaX: number;
  spec: NumericSpec;
  modifier: DragModifier;
}

/**
 * Absolute drag mapping: the value is a pure function of where the pointer started
 * and where it is now. Accumulating per-move deltas would make the value depend on
 * event granularity, so dragging out and back would not return to the start value.
 */
export function valueFromDrag({ startValue, deltaX, spec, modifier }: DragInput): number {
  const factor = DRAG_MODIFIER_FACTOR[modifier];

  // A log-scaled parameter moves multiplicatively: equal travel is equal ratio, which
  // is the only way a 0.001..1000 range is draggable at both ends.
  if (spec.scale === "log" && startValue > 0) {
    const decades = (deltaX / PIXELS_PER_DECADE) * factor;
    return normalizeValue(startValue * 10 ** decades, spec);
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
}

/**
 * Keyboard equivalent of a drag (§V19): the control must be operable without a pointer.
 *
 * The modifier scales the number of steps, and never below one: the manifest's step is
 * the author's statement of the smallest meaningful increment, so "finer than a step"
 * is not a thing a key press can ask for. (A drag expresses fine mode as travel
 * instead — ten times the distance for the same step — which needs no sub-step values.)
 */
export function nudge({ value, direction, spec, modifier, steps = 1 }: NudgeInput): number {
  const factor = DRAG_MODIFIER_FACTOR[modifier];
  const count = Math.max(1, Math.round(steps * factor));
  if (spec.scale === "log" && value > 0) {
    return normalizeValue(value * 10 ** (direction * 0.05 * count), spec);
  }
  return normalizeValue(value + direction * stepFor(spec) * count, spec);
}

/** Display text for a value: fixed decimals, so digits do not jitter under a drag. */
export function formatNumber(value: number, spec: NumericSpec): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(decimalsFor(spec));
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
