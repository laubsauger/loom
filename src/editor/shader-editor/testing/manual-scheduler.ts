import type { CompileScheduler } from "../compile-pipeline.ts";

/**
 * A `CompileScheduler` the test drives by hand.
 *
 * Debounce tests that wait on real timers are slow and flaky; this makes "the quiet
 * window elapsed" an explicit statement in the test rather than a race with the clock.
 * Test-only helper, mirroring `src/ui/testing/` — nothing in the app imports it.
 */
export interface ManualScheduler extends CompileScheduler {
  /** Number of callbacks currently waiting. */
  readonly pending: number;
  /** Fire every waiting callback, in the order it was scheduled. */
  advance(): void;
}

export function createManualScheduler(): ManualScheduler {
  let nextId = 0;
  const queued = new Map<number, () => void>();

  return {
    get pending() {
      return queued.size;
    },
    schedule(callback) {
      const id = nextId;
      nextId += 1;
      queued.set(id, callback);
      return () => {
        queued.delete(id);
      };
    },
    advance() {
      const due = [...queued.entries()];
      queued.clear();
      for (const [, callback] of due) callback();
    },
  };
}
