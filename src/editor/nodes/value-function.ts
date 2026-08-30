import { isPureValueSource } from "@domain/types/node-definition.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";

/**
 * Drawing what a value node's curve IS, rather than where it has been (T459).
 *
 * ## The bug this replaces
 *
 * The plot recorded sampled HISTORY at frame rate, and that is two failures wearing one
 * symptom. A 5 Hz LFO at 60 fps gets twelve samples per cycle, so a sine draws as a
 * dodecagon and a 40 Hz one draws as noise — ALIASING, and no amount of smoothing fixes
 * it because the samples genuinely are not there. And more fundamentally a history tail
 * is not a curve: it shows where the value has been, never the SHAPE it makes. The owner
 * reported both halves as one complaint, which is what they are.
 *
 * ## Why evaluating ahead is allowed
 *
 * §V143: `valueChannel` is a pure function of its own parameter values and the frame
 * clock. Nothing else — no inputs, no state, no wall clock. So a frame the app has not
 * reached is as evaluable as the current one, and sampling one cycle at whatever
 * resolution the box can show is exact rather than approximate.
 *
 * That is a CONTRACT, not an observation, so `value-function.test.ts` checks it holds for
 * every shipped pure source: same frame twice gives the same number, and evaluating out
 * of order gives the same numbers as in order. A node that memoised or read the wall
 * clock would pass every existing test and break this quietly.
 *
 * ## Where it does NOT apply
 *
 * A stateful `valueEvaluate` node — Lag, Filter, Slope, Trigger — has an output that is
 * a function of its whole history, not of the frame, and cannot be evaluated ahead at
 * all. Those keep the history plot, which for them is the truthful picture: what it has
 * been IS what it is. `isPureValueSource` is the split.
 */

/** Samples across one cycle. Enough that the box's own pixel grid is the limit. */
export const FUNCTION_PLOT_SAMPLES = 96;

export interface ValueFunctionPlot {
  /** One cycle, `FUNCTION_PLOT_SAMPLES` points, first point at phase 0. */
  readonly series: readonly number[];
  readonly periodSeconds: number;
  /**
   * Where in the cycle the graph is right now, 0..1 — the playhead. NULL when no frame
   * time is known, and the renderer then draws no marker: the curve is still true, and
   * the position on it is simply not a thing this plot can claim (§V123).
   */
  readonly phase: number | null;
}

export interface SampleOptions {
  /**
   * The frame time the playhead marks, or null when the graph has not told us one.
   *
   * Null is a real case and it must not become zero (T459's look pass). A value node in
   * a graph with no output never has its channels advanced at all —
   * `frame-driver.ts` returns before `onBeforeFrame` when there is no compiled plan — so
   * the history carries no frame time while the transport's clock visibly runs. Defaulting
   * to 0 there would pin the playhead at the start of the cycle and, on a curve that looks
   * perfectly alive, read as "we are at phase zero" rather than "we do not know".
   */
  readonly timeSeconds: number | null;
  /** §V45: the seed reaches sample-and-hold shapes, so the plot matches the render. */
  readonly randomSeed: number;
  readonly samples?: number;
}

/**
 * A frame input for a hypothetical time.
 *
 * Deliberately NOT a partial cast: `valueChannel` receives the same shape it receives in
 * the render, so a node reading `deltaSeconds` or `frameIndex` gets a coherent answer
 * rather than an undefined that happens not to crash today.
 */
function frameAt(timeSeconds: number, deltaSeconds: number, randomSeed: number): FrameEvaluationInput {
  return {
    timeSeconds,
    deltaSeconds,
    frameIndex: Math.max(0, Math.round(timeSeconds / (deltaSeconds || 1))),
    mode: "fixed-step",
    randomSeed,
    wallSeconds: timeSeconds,
    wallDeltaSeconds: deltaSeconds,
  };
}

/**
 * The curve for one cycle, or null when this node has no curve to draw ahead — a
 * stateful node, a node with no declared period, or a period that is not a real number.
 * Null is the signal to fall back to history, which is always available.
 */
export function sampleValueFunction(
  definition: NodeDefinition | undefined,
  values: Readonly<Record<string, ParameterValue>>,
  options: SampleOptions,
): ValueFunctionPlot | null {
  if (definition === undefined) return null;
  if (!isPureValueSource(definition)) return null;
  const channel = definition.valueChannel;
  if (channel === undefined) return null;

  const period = definition.plotPeriod?.(values) ?? null;
  if (period === null || !Number.isFinite(period) || period <= 0) return null;

  const count = Math.max(2, options.samples ?? FUNCTION_PLOT_SAMPLES);
  const step = period / count;
  const series: number[] = [];
  // Anchored at t=0, not at "now": the picture of the shape must hold still while the
  // playhead moves across it. A window that slid with the clock would reintroduce exactly
  // the drift the history plot had, at higher resolution.
  for (let index = 0; index < count; index += 1) {
    const value = channel(values, frameAt(index * step, step, options.randomSeed));
    series.push(Number.isFinite(value) ? value : 0);
  }

  if (options.timeSeconds === null) return { series, periodSeconds: period, phase: null };
  const cycles = options.timeSeconds / period;
  const phase = cycles - Math.floor(cycles);
  return { series, periodSeconds: period, phase: Number.isFinite(phase) ? phase : null };
}

/**
 * The node's effective values for plotting: the definition's defaults, overridden by
 * whatever the document stores statically.
 *
 * A parameter in `driven` or `expression` mode has no static number to read, and this
 * leaves the default in place rather than guessing. Stated because it is visible: an LFO
 * whose frequency is itself driven draws the curve for its DEFAULT frequency while the
 * playhead moves at the real one. Falling back to history there would be worse — history
 * is the aliased picture this exists to replace — and inventing a resolved value would
 * mean running the value graph at frames it has not reached, which for a driven parameter
 * is exactly the thing purity does not promise.
 */
export function plotValues(
  definition: NodeDefinition,
  stored: Readonly<Record<string, unknown>>,
): Record<string, ParameterValue> {
  const values: Record<string, ParameterValue> = {};
  for (const [key, spec] of Object.entries(definition.parameters ?? {})) {
    const declared = (spec as { default?: unknown }).default;
    if (declared !== undefined) values[key] = declared as ParameterValue;
  }
  for (const [key, raw] of Object.entries(stored)) {
    if (typeof raw === "object" && raw !== null && "bindings" in raw) {
      const slot = raw as { mode?: string; bindings?: { static?: { value?: unknown } } };
      const value = slot.bindings?.static?.value;
      // Only a STATIC binding carries a number the plot may use.
      if (slot.mode === "static" && value !== undefined) values[key] = value as ParameterValue;
      continue;
    }
    if (raw !== undefined) values[key] = raw as ParameterValue;
  }
  return values;
}
