import { useCallback, useRef, useSyncExternalStore } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { stickyRange } from "./plot-range.ts";
import type { PlotRange } from "./plot-range.ts";
import type { ValueHistory, ValueHistorySource } from "./value-history.ts";
import { sampleValueFunction } from "./value-function.ts";
import type { ValueFunctionPlot } from "./value-function.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import styles from "./value-plot.module.css";

/**
 * A value node's channel, drawn in its body (T344, §V275).
 *
 * TD draws a CHOP's channel in the node, and that is why a TD network reads at a glance:
 * you see the SIGNAL, not just the wire. Ours rendered an empty box, so the half of the
 * graph that MOVES was the half nobody could see — an LFO, a Lag, a Mouse and an Analyze
 * looked identical and all looked inert.
 *
 * This is CONTENT, not chrome. §V90-§V92 push decoration out of a dense pane, and a plot
 * of what the node produces is the same kind of thing a texture preview is: the node's
 * output, in the node. A row of buttons here would not earn its place; this does.
 *
 * ## Every channel, overlaid — the decision, stated
 *
 * Mouse publishes x, y and buttons. This plots ALL of them on one shared scale rather
 * than picking the first, because "x is moving and y is not" is exactly the thing you
 * open a plot to see, and choosing one channel hides it. That is also what TD does. The
 * count is capped (`MAX_PLOTTED_CHANNELS`) so a wide bag cannot turn two centimetres of
 * node into a smear.
 *
 * ## Scale
 *
 * Auto-ranged over the visible window, not pinned to 0..1: Slope and Math produce
 * arbitrary numbers and a fixed range would flatten them into the axis. A constant signal
 * has no range at all, so it is drawn as a centred flat line rather than amplified noise.
 *
 * The range is STICKY (T352, §V296, `plot-range.ts`). Auto-ranging per frame made a stable
 * sine BREATHE: the sliding window's min and max wobble in the last decimal, the scale
 * followed, and the wave expanded and contracted while the signal did not. The range now
 * holds exactly still until the signal leaves it.
 *
 * ## The FUNCTION, where there is one (T459)
 *
 * A pure `valueChannel` node is a function of the frame, so the plot evaluates it across
 * one whole cycle and draws the real waveform instead of the sampled tail. That fixes two
 * complaints at once: a fast LFO no longer ALIASES into a polygon (the resolution stops
 * depending on the frame rate), and the shape is legible at a glance because a whole
 * cycle is on screen rather than whatever the last two seconds happened to contain.
 *
 * A playhead marks the current phase. It is what keeps this a live instrument rather than
 * a diagram, and it is the only part that moves — the curve deliberately holds still.
 *
 * Stateful nodes keep the history plot, and for them that is the truthful picture: a Lag's
 * output is a function of everything that came before, so where it has been IS what it is.
 *
 * ## No history is not zero
 *
 * A node that has not been sampled yet renders the empty state, never a flat line at
 * zero — a line at zero is a claim that the node produced zero, which is a different and
 * wrong statement about a node that has produced nothing.
 */

export interface ValuePlotProps {
  readonly nodeId: NodeId;
  readonly history: ValueHistorySource;
  /**
   * What this node IS, so the plot can draw its curve rather than its tail (T459).
   *
   * The sampling happens HERE rather than in the caller because the playhead has to
   * advance: the phase comes from the newest sample's frame time, which arrives on this
   * component's own history subscription. A caller computing the curve once per graph
   * render would draw a playhead frozen wherever it happened to be.
   *
   * Absent, or not a pure periodic source, and the plot falls back to history.
   */
  readonly source?: ValuePlotSource | null;
  /**
   * This node is OFF (T576) — why, or null when it is running.
   *
   * §V504: a muted node is NOT COOKED. The value graph skips it before inputs,
   * parameters, state or diagnostics (T541), so it publishes no bag and nothing here has
   * anything to draw. The FUNCTION plot did not notice, because T459 evaluates a pure
   * source's curve independently of the value graph — the curve is a property of the
   * node, and a property survives being switched off. So a muted LFO kept drawing a live
   * waveform with a moving playhead, in the node body, which is the one place in this app
   * that means LIVE OUTPUT (§V91: a display that keeps reading when its source is off is
   * a display that lies). A stateful node's history plot had the matching defect from the
   * other side: the ring stops being pushed and the last window just freezes there.
   *
   * One question — "what does a value node show while it is off" — and now one answer for
   * both halves (§V109). The curve as a DIAGRAM of the node is still a good idea; the node
   * body, beside a running graph, is not where it belongs.
   */
  readonly silence?: ValueSilence | null;
}

/** Why a value node is off. The word the body prints, and the reason it is off. */
export type ValueSilence = "muted" | "bypassed";

export interface ValuePlotSource {
  readonly definition: NodeDefinition;
  /** Effective values for plotting — see `plotValues`. */
  readonly values: Readonly<Record<string, ParameterValue>>;
  /** §V45: reaches sample-and-hold shapes, so the plot matches what renders. */
  readonly randomSeed: number;
}

/** Viewbox units. The plot scales to its box; these only set the sampling resolution. */
const WIDTH = 100;
const HEIGHT = 32;

/** Distinct strokes, in order. Tokens only (§V17) — the CSS maps these to variables. */
const CHANNEL_CLASS = [styles.seriesA, styles.seriesB, styles.seriesC, styles.seriesD] as const;

/** A degenerate range would divide by zero; a constant signal draws down the middle. */
function project(series: readonly number[], low: number, span: number): string {
  if (series.length === 0) return "";
  const step = series.length === 1 ? 0 : WIDTH / (series.length - 1);
  let path = "";
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index] as number;
    const unit = span === 0 ? 0.5 : (value - low) / span;
    // SVG y grows downward; the signal should not be drawn upside down.
    const y = HEIGHT - unit * HEIGHT;
    path += `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)} ${y.toFixed(2)}`;
    if (index < series.length - 1) path += " ";
  }
  return path;
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(3);
}

/** The window's range across EVERY channel, so overlaid series stay comparable. */
function rangeOf(history: ValueHistory): PlotRange {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const series of history.series) {
    for (const value of series) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 0 };
  return { low, high };
}

export function ValuePlot({ nodeId, history, source = null, silence = null }: ValuePlotProps) {
  const subscribe = useCallback(
    (listener: () => void) => history.subscribe(nodeId, listener),
    [history, nodeId],
  );
  const snapshot = useCallback(() => history.get(nodeId), [history, nodeId]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Held across renders, per node, because the whole point is that it does NOT follow
  // every window. Declared above the empty-state return so the hook order is fixed.
  const heldRange = useRef<PlotRange | null>(null);

  // T576: OFF, before either picture. Ahead of the function plot because that one does
  // not need the value graph to draw and would otherwise keep running; ahead of the
  // history plot because the ring holds the window this node had when it was switched off
  // and a frozen tail reads as a live-but-still signal. Named, never blank (§V91) — the
  // same shape a preview's OFF state uses rather than an empty box.
  if (silence !== null) {
    return (
      <div className={styles.plot} data-testid={`value-plot-${nodeId}`}>
        <span className={styles.empty}>{silence}</span>
      </div>
    );
  }

  // Re-sampled per tick rather than memoised: 96 evaluations of a pure arithmetic
  // function, ten times a second, is beneath measurement, and a memo keyed on a fresh
  // values object would not hold anyway.
  const fn =
    source === null
      ? null
      : sampleValueFunction(source.definition, source.values, {
          timeSeconds: value.timeSeconds ?? 0,
          randomSeed: source.randomSeed,
        });
  if (fn !== null) return <FunctionPlot nodeId={nodeId} fn={fn} latest={value.latest} />;

  if (value.latest === null || value.series.length === 0) {
    // Named state, not a zeroed plot (§V91): this node has produced nothing yet, which is
    // a different fact from producing zero.
    return (
      <div className={styles.plot} data-testid={`value-plot-${nodeId}`}>
        <span className={styles.empty}>no signal yet</span>
      </div>
    );
  }

  const range = stickyRange(heldRange.current, rangeOf(value));
  heldRange.current = range;
  const low = range.low;
  const span = range.high - range.low;

  return (
    <div className={styles.plot} data-testid={`value-plot-${nodeId}`}>
      <svg
        className={styles.canvas}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {value.series.map((series, index) => (
          <path
            key={value.channels[index] ?? index}
            className={CHANNEL_CLASS[index % CHANNEL_CLASS.length]}
            d={project(series, low, span)}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <dl className={styles.values} aria-label={`Channels of ${nodeId}`}>
        {value.channels.map((channel, index) => (
          <div key={channel} className={styles.reading}>
            <dt className={cxChannel(index)}>{channel}</dt>
            <dd className={styles.number}>{formatValue(value.latest?.[channel] ?? 0)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * One cycle of a pure node's curve, with the playhead on it (T459).
 *
 * Its own component so the hook order stays fixed and the sticky range is held PER MODE —
 * a node that switched between function and history would otherwise carry a range fitted
 * to the other picture.
 *
 * ## Ranging: the same rule as history, deliberately
 *
 * The function's range is exact and known, so ranging it is easier than ranging a sliding
 * window and it would be tempting to just use min/max directly. It uses `stickyRange`
 * anyway, for the reason T352 exists: two plots in one graph must agree about what full
 * height MEANS, or a user comparing an LFO against the Lag it feeds reads two different
 * scales as if they were one. Consistency beats the easier rule. It costs nothing here —
 * the samples only change when a parameter does, so the range holds perfectly still and
 * §V296's breathing cannot recur.
 */
function FunctionPlot({
  nodeId,
  fn,
  latest,
}: {
  readonly nodeId: NodeId;
  readonly fn: ValueFunctionPlot;
  readonly latest: Readonly<Record<string, number>> | null;
}) {
  const heldRange = useRef<PlotRange | null>(null);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const sample of fn.series) {
    if (sample < low) low = sample;
    if (sample > high) high = sample;
  }
  const measured: PlotRange =
    Number.isFinite(low) && Number.isFinite(high) ? { low, high } : { low: 0, high: 0 };
  const range = stickyRange(heldRange.current, measured);
  heldRange.current = range;
  const span = range.high - range.low;

  const playX = fn.phase === null ? 0 : fn.phase * WIDTH;
  const index =
    fn.phase === null ? 0 : Math.min(fn.series.length - 1, Math.round(fn.phase * fn.series.length));
  const current = fn.series[index] ?? 0;
  const unit = span === 0 ? 0.5 : (current - range.low) / span;
  const playY = HEIGHT - unit * HEIGHT;
  /*
   * The CURVE is drawn before the graph has ever run, and the NUMBER is not.
   *
   * They are different claims. "This node makes a sine at 2 Hz" is true of a pure
   * function whether or not a frame has been rendered — it is what the node IS — so
   * drawing it immediately is honest and is the whole point of showing the shape at a
   * glance. "This node's value is 0.500" is a claim about something it PRODUCED, and
   * before the first sample it has produced nothing. §V91's rule survives intact by
   * applying it to the half it was actually about.
   */
  const reading = latest === null ? null : latest["value"] ?? current;

  return (
    <div className={styles.plot} data-testid={`value-plot-${nodeId}`}>
      <svg
        className={styles.canvas}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          className={CHANNEL_CLASS[0]}
          d={project(fn.series, range.low, span)}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        {fn.phase === null ? null : (
          <line
          className={styles.playhead}
          data-testid={`value-playhead-${nodeId}`}
          x1={playX.toFixed(2)}
          y1={0}
          x2={playX.toFixed(2)}
          y2={HEIGHT}
          vectorEffect="non-scaling-stroke"
          />
        )}
        {fn.phase === null ? null : (
          <circle className={styles.playdot} cx={playX.toFixed(2)} cy={playY.toFixed(2)} r={1.6} />
        )}
      </svg>
      <dl className={styles.values} aria-label={`Channels of ${nodeId}`}>
        <div className={styles.reading}>
          <dt className={cxChannel(0)}>value</dt>
          <dd className={styles.number}>{reading === null ? "—" : formatValue(reading)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The swatch beside a reading uses the same stroke class as its line. */
function cxChannel(index: number): string {
  return `${styles.channel} ${CHANNEL_CLASS[index % CHANNEL_CLASS.length] ?? ""}`.trim();
}
