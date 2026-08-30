/**
 * The value plot's vertical range, made STICKY (T352, §V296).
 *
 * The auto-range decision stands (§V275): Slope and Math produce arbitrary numbers and a
 * fixed 0..1 axis would flatten them into the line. What was wrong was recomputing the
 * range from the visible window on every frame. As the window slides, the visible min and
 * max wobble in the last decimal, the scale follows, and a perfectly stable sine appears
 * to breathe. A visualisation that MOVES WHEN THE SIGNAL DOES NOT is worse than a wrong
 * fixed range, because it invents motion — and "is this moving?" is the question the plot
 * exists to answer.
 *
 * The rule here is hysteresis, not smoothing. A slow decay would still be continuous
 * motion; this holds the range EXACTLY still until the signal genuinely leaves it:
 *
 *  - the window fits inside the range and is not much smaller  → nothing changes, at all;
 *  - the window escapes the range                              → refit immediately;
 *  - the window collapses to less than half the range          → refit, once.
 *
 * Refits quantise outward to a 1-2-5-style step, so the warm-up frames — where the window
 * grows by one sample at a time and every frame technically escapes — mostly land on the
 * SAME bounds instead of stepping through hundreds of them.
 */

export interface PlotRange {
  readonly low: number;
  readonly high: number;
}

/**
 * How far the signal must collapse before the range follows it down. A sliding window
 * over a periodic signal varies by a fraction of a percent, so half is far outside the
 * noise and well inside "the amplitude actually dropped".
 */
const SHRINK_THRESHOLD = 0.5;

/** A 1-2-5 step at the span's own magnitude: the bounds a person would have chosen. */
export function niceStep(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const normalized = span / magnitude;
  const factor = normalized < 2 ? 0.25 : normalized < 5 ? 0.5 : 1;
  return factor * magnitude;
}

/** Widen to the nearest nice bounds. A degenerate span stays degenerate (see `project`). */
function fit(window: PlotRange): PlotRange {
  const span = window.high - window.low;
  const step = niceStep(span);
  if (step === 0) return window;
  return {
    low: Math.floor(window.low / step) * step,
    high: Math.ceil(window.high / step) * step,
  };
}

/**
 * The range to draw with, given the range last drawn with and the window in hand.
 *
 * `previous` is null on the first sample, or after the plot has been remounted. Returning
 * the SAME OBJECT when nothing changed is deliberate: a caller holding it in a ref can
 * compare by identity to know whether the axis moved.
 */
export function stickyRange(previous: PlotRange | null, window: PlotRange): PlotRange {
  if (!Number.isFinite(window.low) || !Number.isFinite(window.high)) {
    return previous ?? { low: 0, high: 0 };
  }
  const ordered: PlotRange =
    window.low <= window.high ? window : { low: window.high, high: window.low };
  if (previous === null) return fit(ordered);

  const held = previous.high - previous.low;
  const inside = ordered.low >= previous.low && ordered.high <= previous.high;
  // A held range of zero is a constant signal that has started to move: any window with
  // width escapes it, so `inside` is already false and this only guards the divide.
  const collapsed = held > 0 && ordered.high - ordered.low < held * SHRINK_THRESHOLD;
  if (inside && !collapsed) return previous;
  return fit(ordered);
}
