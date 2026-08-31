import type { NodeId } from "@domain/types/ids.ts";

/**
 * The READ side of a value node's rolling channel window (T344).
 *
 * Declared in the editor because the editor is what renders it, and the composition root
 * is what fills it — so the dependency runs app → editor, never back. `src/app/value-history.ts`
 * holds the ring buffers and the §V16 coalescing; nothing here knows they exist.
 */

/** At most this many channels are plotted per node — see `ValuePlot` for why. */
export const MAX_PLOTTED_CHANNELS = 4;

export interface ValueHistory {
  /** Channel names in publication order, capped at `MAX_PLOTTED_CHANNELS`. */
  readonly channels: readonly string[];
  /**
   * One series per channel, oldest sample first. Shorter than the window until it fills;
   * a node with no history has EMPTY series rather than a run of zeros, so the plot can
   * say "no signal yet" instead of drawing a flat line at a value nobody produced.
   */
  readonly series: ReadonlyArray<readonly number[]>;
  /** The most recent sample per channel, or null before the first. */
  readonly latest: Readonly<Record<string, number>> | null;
  /**
   * ABSOLUTE seconds of the most recent sample, or null before the first (T459, T495).
   *
   * The FUNCTION plot's playhead needs to know where in the cycle the graph is, and the
   * only honest source for that is the frame the sample came from — not a wall clock,
   * which would drift from the render the moment the transport paused (§V143, §V44).
   *
   * T495: which of the frame's clocks, though, is the whole of that bug. A free-running
   * LFO reads `absTimeSecondsOf` so a timeline lap cannot snap its phase, and the curve
   * is drawn from the same function — so a marker placed by TIMELINE position walks a
   * curve it does not belong to, and at each lap it jumps back to the left edge while the
   * value carries smoothly on. The value was never wrong; the picture of it was keyed to
   * the wrong clock. The stamp is therefore absolute, and it is the SAME clock on both
   * sides of the comparison, which is the only form in which a phase means anything.
   */
  readonly timeSeconds: number | null;
}

export const EMPTY_VALUE_HISTORY: ValueHistory = Object.freeze({
  channels: [],
  series: [],
  latest: null,
  timeSeconds: null,
});

export interface ValueHistorySource {
  get(nodeId: NodeId): ValueHistory;
  subscribe(nodeId: NodeId, listener: () => void): () => void;
}
