/**
 * T1226 — online adaptive peak picking on a flux stream.
 *
 * The v1 event (`ONSET_EVENT_THRESHOLD` in `audio-features.ts`) is a FIXED level: a
 * rising crossing of 0.02 mean positive flux. A fixed level is the right recorded
 * contract (§V352) and the wrong detector — a quiet passage never crosses it and a
 * dense one never drops below it. This picker is Böck's rule restated for a stream
 * with NO lookahead: an event is a rising crossing of `mean(recent flux) + delta`, at
 * least `minGapHops` after the last one. The mean is over the `historyHops` values
 * BEFORE the current one, so a loud hop cannot raise the bar it is measured against.
 *
 * No lookahead on purpose: the offline form picks the local maximum by looking a few
 * hops ahead, which is a few hops of latency on a live input. A rising crossing fires on
 * the hop the rise starts, and what it costs — the peak's height is not known at the
 * event — the per-hop flux value itself carries.
 *
 * Pure and clock-free: hops in, booleans out.
 */

export interface PeakPickerOptions {
  /** How many previous hops the adaptive mean spans. */
  readonly historyHops: number;
  /** How far above the mean a hop must rise. Also the floor: over silence the bar IS delta. */
  readonly delta: number;
  /** Minimum hops between two events; a retrigger inside the gap is dropped. */
  readonly minGapHops: number;
}

export interface PeakPicker {
  /** Feed one hop's flux; true when this hop is an event. */
  push(value: number): boolean;
  /** The bar the NEXT value is measured against: `mean(history) + delta`. */
  threshold(): number;
  reset(): void;
}

export function createPeakPicker(options: PeakPickerOptions): PeakPicker {
  const { historyHops, delta, minGapHops } = options;
  if (!(historyHops >= 1) || !(delta >= 0) || !(minGapHops >= 0)) {
    throw new Error(`createPeakPicker: bad options ${JSON.stringify(options)}`);
  }
  const history = new Float64Array(historyHops);
  let filled = 0;
  let index = 0;
  let sum = 0;
  let previousAbove = false;
  let sinceEvent = Number.POSITIVE_INFINITY;

  const threshold = (): number => (filled === 0 ? delta : sum / filled + delta);

  return {
    push(value) {
      const above = value > threshold();
      const event = above && !previousAbove && sinceEvent >= minGapHops;
      previousAbove = above;
      sinceEvent = event ? 1 : sinceEvent + 1;

      if (filled === historyHops) sum -= history[index] as number;
      else filled += 1;
      history[index] = value;
      sum += value;
      index = (index + 1) % historyHops;
      return event;
    },
    threshold,
    reset() {
      history.fill(0);
      filled = 0;
      index = 0;
      sum = 0;
      previousAbove = false;
      sinceEvent = Number.POSITIVE_INFINITY;
    },
  };
}
