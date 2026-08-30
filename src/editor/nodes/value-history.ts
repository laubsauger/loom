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
}

export const EMPTY_VALUE_HISTORY: ValueHistory = Object.freeze({
  channels: [],
  series: [],
  latest: null,
});

export interface ValueHistorySource {
  get(nodeId: NodeId): ValueHistory;
  subscribe(nodeId: NodeId, listener: () => void): () => void;
}
