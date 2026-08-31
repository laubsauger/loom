import type { NumericRangeKind } from "../../domain/types/parameters.ts";

/**
 * Shared vocabulary for the parameter control kit (T37).
 *
 * Every control reports a value with a phase. That single distinction is what makes
 * §V15 work: a continuous gesture emits many `"live"` values and exactly one
 * `"commit"`, so the editor can hold one transaction open for the gesture and close
 * it at the end — one undo entry, live intermediate values applied throughout.
 */

/**
 * `"live"`   — an intermediate value from a gesture still in progress (drag, held
 *              arrow key). Applied immediately, coalesced to an animation frame.
 * `"commit"` — the value the gesture settled on, or a one-shot edit (typed entry,
 *              checkbox, select, double-click reset). Ends the gesture.
 */
export type EditPhase = "live" | "commit";

export type ValueListener<T> = (value: T, phase: EditPhase) => void;

/**
 * The numeric constraints a control needs, structurally.
 *
 * `NumberParameter` satisfies it directly; `VectorParameter` (whose `default` is an
 * array) contributes its min/max/step. Keeping the numeric maths keyed to this shape
 * rather than to `ParameterDefinition` is what lets the resolution width/height fields
 * in the Common section reuse exactly the same drag behaviour (T73).
 */
export interface NumericSpec {
  min?: number;
  max?: number;
  /**
   * §B111 — which ends of `min`/`max` are a LIMIT rather than the slider's travel.
   *
   * Structural, like the rest of this shape: a `NumberParameter` or `VectorParameter`
   * carries it and satisfies `NumericSpec` unchanged. The ad-hoc specs built here (the
   * Common section's resolution fields) declare nothing and get `bounded`, which is what
   * they mean — a render target of -1 pixels is not a wide shot.
   */
  range?: NumericRangeKind;
  step?: number;
  precision?: number;
  scale?: "linear" | "log";
}
