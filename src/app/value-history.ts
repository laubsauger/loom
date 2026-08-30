import type { NodeId } from "@domain/types/ids.ts";
import { MAX_PLOTTED_CHANNELS, EMPTY_VALUE_HISTORY } from "@editor/nodes/value-history.ts";
import type { ValueHistory, ValueHistorySource } from "@editor/nodes/value-history.ts";

/**
 * A rolling window of every value node's channels, for the plot in its body (T344, §V275).
 *
 * ## The one sample point
 *
 * §V275: this reads the SAME channels the resolver reads, sampled once per frame at the
 * point the value graph is already evaluated. It never evaluates anything itself, and that
 * is not an optimisation — a second evaluation of a STATEFUL stage would advance it twice
 * per frame, so a Lag would run at double rate purely because someone was looking at it.
 * A plot that disagrees with the number driving the parameter is worse than no plot.
 *
 * ## §V16
 *
 * Producers push at frame rate; consumers are notified at most once per `intervalMs`
 * (100 ms, the same cap the node runtime channel uses). The coalescing is here rather than
 * in each plot, because a plot that forgot to throttle would put sixty React renders a
 * second on a node body and nothing would catch it.
 *
 * Samples are written into a preallocated ring per node, so a frame costs no allocation
 * and an idle graph costs nothing at all (§V8's spirit on the CPU side).
 */

/** Frames retained per node: two seconds at 60fps, which is what a small plot can show. */
export const VALUE_HISTORY_FRAMES = 120;

/** Matches `METRIC_TICK_MS` in the canvas's runtime channel; restated, not imported. */
export const VALUE_HISTORY_TICK_MS = 100;

export interface ValueHistoryStore extends ValueHistorySource {
  /** One node's channels for one frame. Call once per frame, per node. */
  push(nodeId: NodeId, channels: Readonly<Record<string, number>>): void;
  /** Drops every node's window. Transport reset and backward seek (§V181, §V170). */
  clear(): void;
  /** Forgets nodes that are no longer in the graph, so a deleted node frees its ring. */
  retain(nodeIds: ReadonlySet<NodeId>): void;
  dispose(): void;
}

export interface ValueHistoryOptions {
  readonly frames?: number | undefined;
  readonly intervalMs?: number | undefined;
  /** Injected so tests drive the flush clock; never a timing source. */
  readonly now?: (() => number) | undefined;
}

interface Ring {
  channels: string[];
  /** Parallel to `channels`; each is a preallocated buffer used circularly. */
  buffers: Float64Array[];
  /** Samples written so far, saturating at the window size. */
  length: number;
  /** Index of the next write. */
  cursor: number;
  latest: Record<string, number> | null;
  /** Cached projection handed to React; nulled on write, rebuilt on read. */
  view: ValueHistory | null;
}

export function createValueHistoryStore(options: ValueHistoryOptions = {}): ValueHistoryStore {
  const frames = Math.max(2, options.frames ?? VALUE_HISTORY_FRAMES);
  const intervalMs = options.intervalMs ?? VALUE_HISTORY_TICK_MS;
  const now = options.now ?? (() => Date.now());

  const rings = new Map<NodeId, Ring>();
  const listeners = new Map<NodeId, Set<() => void>>();
  const dirty = new Set<NodeId>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let disposed = false;

  function flush(): void {
    timer = null;
    lastFlush = now();
    if (dirty.size === 0) return;
    const woken = [...dirty];
    dirty.clear();
    for (const nodeId of woken) {
      for (const listener of [...(listeners.get(nodeId) ?? [])]) listener();
    }
  }

  function schedule(nodeId: NodeId): void {
    dirty.add(nodeId);
    if (disposed || timer !== null) return;
    timer = setTimeout(flush, Math.max(0, intervalMs - (now() - lastFlush)));
  }

  /** Rebuilds `channels`/`buffers` when a node's published set changes shape. */
  function reshape(ring: Ring, names: readonly string[]): void {
    ring.channels = [...names];
    ring.buffers = names.map(() => new Float64Array(frames));
    ring.length = 0;
    ring.cursor = 0;
  }

  return {
    push(nodeId, channels) {
      // Publication order is the node's own; the cap keeps a bag of twenty channels from
      // turning a 2cm plot into a smear (see `MAX_PLOTTED_CHANNELS`).
      const names = Object.keys(channels).slice(0, MAX_PLOTTED_CHANNELS);
      let ring = rings.get(nodeId);
      if (ring === undefined) {
        ring = { channels: [], buffers: [], length: 0, cursor: 0, latest: null, view: null };
        rings.set(nodeId, ring);
      }
      const sameShape =
        ring.channels.length === names.length &&
        ring.channels.every((name, index) => name === names[index]);
      // A node that starts publishing a different set is a different signal: keeping the
      // old window would draw two unrelated histories as one continuous line.
      if (!sameShape) reshape(ring, names);

      for (let index = 0; index < names.length; index += 1) {
        const value = channels[names[index] as string];
        (ring.buffers[index] as Float64Array)[ring.cursor] =
          typeof value === "number" && Number.isFinite(value) ? value : 0;
      }
      ring.cursor = (ring.cursor + 1) % frames;
      if (ring.length < frames) ring.length += 1;
      ring.latest = { ...channels };
      ring.view = null;
      schedule(nodeId);
    },

    get(nodeId) {
      const ring = rings.get(nodeId);
      if (ring === undefined || ring.length === 0) return EMPTY_VALUE_HISTORY;
      // Identity is stable between pushes, which is what `useSyncExternalStore` requires:
      // a fresh object per read would re-render every node on every tick.
      if (ring.view !== null) return ring.view;
      const start = (ring.cursor - ring.length + frames) % frames;
      const series = ring.buffers.map((buffer) => {
        const out = new Array<number>(ring.length);
        for (let index = 0; index < ring.length; index += 1) {
          out[index] = buffer[(start + index) % frames] as number;
        }
        return out;
      });
      ring.view = { channels: [...ring.channels], series, latest: ring.latest };
      return ring.view;
    },

    subscribe(nodeId, listener) {
      const set = listeners.get(nodeId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(nodeId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(nodeId);
      };
    },

    clear() {
      for (const [nodeId, ring] of rings) {
        ring.length = 0;
        ring.cursor = 0;
        ring.latest = null;
        ring.view = null;
        schedule(nodeId);
      }
    },

    retain(nodeIds) {
      for (const nodeId of [...rings.keys()]) {
        if (!nodeIds.has(nodeId)) rings.delete(nodeId);
      }
    },

    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      rings.clear();
      listeners.clear();
      dirty.clear();
    },
  };
}
