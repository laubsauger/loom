import { useCallback, useRef, useSyncExternalStore } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { stickyRange } from "./plot-range.ts";
import type { PlotRange } from "./plot-range.ts";
import type { ValueHistory, ValueHistorySource } from "./value-history.ts";
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
 * ## No history is not zero
 *
 * A node that has not been sampled yet renders the empty state, never a flat line at
 * zero — a line at zero is a claim that the node produced zero, which is a different and
 * wrong statement about a node that has produced nothing.
 */

export interface ValuePlotProps {
  readonly nodeId: NodeId;
  readonly history: ValueHistorySource;
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

export function ValuePlot({ nodeId, history }: ValuePlotProps) {
  const subscribe = useCallback(
    (listener: () => void) => history.subscribe(nodeId, listener),
    [history, nodeId],
  );
  const snapshot = useCallback(() => history.get(nodeId), [history, nodeId]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Held across renders, per node, because the whole point is that it does NOT follow
  // every window. Declared above the empty-state return so the hook order is fixed.
  const heldRange = useRef<PlotRange | null>(null);

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

/** The swatch beside a reading uses the same stroke class as its line. */
function cxChannel(index: number): string {
  return `${styles.channel} ${CHANNEL_CLASS[index % CHANNEL_CLASS.length] ?? ""}`.trim();
}
