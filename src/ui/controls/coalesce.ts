/**
 * Frame coalescing for parameter updates (doc §8.1: "Parameter updates must be
 * coalesced to animation frames", §V5).
 *
 * A drag produces pointer events far faster than the document needs to change. This
 * keeps only the newest value per key and flushes once per frame, so a 400-event drag
 * becomes ~60 patches instead of 400 — and, because they share one transaction, one
 * undo entry (§V15).
 *
 * The scheduler is injected so the coalescer is testable without a browser; the
 * default is `requestAnimationFrame`.
 */

/** Schedules `callback` for the next frame and returns a cancel function. */
export type FrameScheduler = (callback: () => void) => () => void;

export const rafScheduler: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  }
  /*
   * T634 (T620's audit): rAF is SUSPENDED, not slow, for a hidden or occluded window —
   * and an agent driving the app through CDP delivers pointer gestures to exactly such
   * a window, so a value queued here would stay pending until the tab is next looked
   * at. The backstop flushes it anyway; while rAF runs it always wins, so the visible
   * cadence is untouched.
   */
  let settled = false;
  const fire = (): void => {
    if (settled) return;
    settled = true;
    cancelAnimationFrame(handle);
    clearTimeout(backstop);
    callback();
  };
  const handle = requestAnimationFrame(fire);
  const backstop = setTimeout(fire, 250);
  return () => {
    settled = true;
    cancelAnimationFrame(handle);
    clearTimeout(backstop);
  };
};

export interface FrameCoalescer<T> {
  /** Queue `value` under `key`, replacing anything queued this frame. */
  schedule: (key: string, value: T) => void;
  /** Drop a pending entry — used when a commit supersedes it. */
  cancel: (key: string) => void;
  /** Apply everything pending right now. */
  flush: () => void;
  /** Pending value for a key, or undefined. */
  peek: (key: string) => T | undefined;
  hasPending: () => boolean;
  dispose: () => void;
}

export function createFrameCoalescer<T>(
  commit: (entries: ReadonlyArray<readonly [string, T]>) => void,
  schedule: FrameScheduler = rafScheduler,
): FrameCoalescer<T> {
  // Insertion-ordered: parameters are applied in the order they were first touched,
  // which keeps a multi-field gesture (a vector drag) deterministic.
  const pending = new Map<string, T>();
  let cancelFrame: (() => void) | null = null;
  let disposed = false;

  const flush = (): void => {
    if (cancelFrame !== null) {
      cancelFrame();
      cancelFrame = null;
    }
    if (pending.size === 0) return;
    const entries = [...pending.entries()];
    pending.clear();
    commit(entries);
  };

  return {
    schedule(key: string, value: T): void {
      if (disposed) return;
      pending.set(key, value);
      cancelFrame ??= schedule(() => {
        cancelFrame = null;
        flush();
      });
    },
    cancel(key: string): void {
      pending.delete(key);
    },
    flush,
    peek: (key: string) => pending.get(key),
    hasPending: () => pending.size > 0,
    dispose(): void {
      disposed = true;
      pending.clear();
      if (cancelFrame !== null) {
        cancelFrame();
        cancelFrame = null;
      }
    },
  };
}
