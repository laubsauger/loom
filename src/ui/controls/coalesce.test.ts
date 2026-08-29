import { describe, expect, it, vi } from "vitest";
import { createFrameCoalescer } from "./coalesce.ts";
import type { FrameScheduler } from "./coalesce.ts";

/**
 * doc §8.1 — "Parameter updates must be coalesced to animation frames" (§V5).
 *
 * A drag emits values far faster than the document needs to change. The coalescer is
 * what turns that stream into one write per frame; without it every pointer event
 * becomes a patch, a revision and an audit entry.
 */

function manualScheduler(): { schedule: FrameScheduler; frame: () => void; pending: () => number } {
  let queued: Array<() => void> = [];
  return {
    schedule: (callback) => {
      queued.push(callback);
      return () => {
        queued = queued.filter((entry) => entry !== callback);
      };
    },
    frame: () => {
      const due = queued;
      queued = [];
      for (const callback of due) callback();
    },
    pending: () => queued.length,
  };
}

describe("frame coalescing", () => {
  it("collapses a burst of values into one commit carrying the newest", () => {
    const commit = vi.fn();
    const scheduler = manualScheduler();
    const coalescer = createFrameCoalescer<number>(commit, scheduler.schedule);

    for (const value of [1, 2, 3, 4, 5]) coalescer.schedule("radius", value);
    expect(commit).not.toHaveBeenCalled();

    scheduler.frame();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toEqual([["radius", 5]]);
  });

  it("keeps distinct keys distinct, in the order they were first touched", () => {
    const commit = vi.fn();
    const scheduler = manualScheduler();
    const coalescer = createFrameCoalescer<number>(commit, scheduler.schedule);

    coalescer.schedule("x", 1);
    coalescer.schedule("y", 2);
    coalescer.schedule("x", 3);
    scheduler.frame();

    expect(commit.mock.calls[0]?.[0]).toEqual([
      ["x", 3],
      ["y", 2],
    ]);
  });

  it("schedules one frame per burst, not one per value", () => {
    const scheduler = manualScheduler();
    const coalescer = createFrameCoalescer<number>(() => {}, scheduler.schedule);
    coalescer.schedule("a", 1);
    coalescer.schedule("a", 2);
    coalescer.schedule("b", 3);
    expect(scheduler.pending()).toBe(1);
  });

  it("lets a commit supersede a queued live value", () => {
    const commit = vi.fn();
    const scheduler = manualScheduler();
    const coalescer = createFrameCoalescer<number>(commit, scheduler.schedule);

    coalescer.schedule("radius", 7);
    // This is what the editor does when a drag ends: the final value is sent directly,
    // and the stale intermediate must not land after it.
    coalescer.cancel("radius");
    scheduler.frame();
    expect(commit).not.toHaveBeenCalled();
  });

  it("flushes on demand and reports what is pending", () => {
    const commit = vi.fn();
    const scheduler = manualScheduler();
    const coalescer = createFrameCoalescer<number>(commit, scheduler.schedule);

    coalescer.schedule("radius", 2);
    expect(coalescer.hasPending()).toBe(true);
    expect(coalescer.peek("radius")).toBe(2);

    coalescer.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(coalescer.hasPending()).toBe(false);

    // A flush must also drop the frame it had booked, or the commit runs twice.
    scheduler.frame();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("goes quiet after dispose, so an unmounted pane cannot write", () => {
    const commit = vi.fn();
    const scheduler = manualScheduler();
    const coalescer = createFrameCoalescer<number>(commit, scheduler.schedule);

    coalescer.schedule("radius", 1);
    coalescer.dispose();
    coalescer.schedule("radius", 2);
    scheduler.frame();
    expect(commit).not.toHaveBeenCalled();
  });
});
