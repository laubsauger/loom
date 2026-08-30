import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createValueHistoryStore } from "./value-history.ts";

/**
 * The rolling window behind a value node's plot (T344, §V16).
 *
 * Every assertion here is about a way the plot could lie: a window that keeps drawing
 * after a reset, two unrelated signals joined into one line, a node's ring outliving the
 * node, or sixty React renders a second on a node body.
 */

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  clock += ms;
  vi.advanceTimersByTime(ms);
};

describe("the window keeps the last N frames, oldest first", () => {
  it("returns samples in the order they happened", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    for (const value of [1, 2, 3]) store.push("a", { value });
    advance(200);
    expect(store.get("a").series[0]).toEqual([1, 2, 3]);
    expect(store.get("a").latest).toEqual({ value: 3 });
    store.dispose();
  });

  it("drops the oldest once the window is full, rather than growing forever", () => {
    const store = createValueHistoryStore({ frames: 3, now });
    for (const value of [1, 2, 3, 4, 5]) store.push("a", { value });
    advance(200);
    // A ring, not an array that grows: an hour of playback must not accumulate.
    expect(store.get("a").series[0]).toEqual([3, 4, 5]);
    store.dispose();
  });

  it("reports NO history before the first sample, not a zero", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    // A flat line at zero is a claim the node produced zero. It produced nothing.
    expect(store.get("a")).toMatchObject({ channels: [], series: [], latest: null });
    store.dispose();
  });
});

describe("multi-channel nodes keep their channels apart", () => {
  it("retains one series per channel, in publication order", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    store.push("m", { x: 0.1, y: 0.5, buttons: 0 });
    store.push("m", { x: 0.2, y: 0.5, buttons: 1 });
    advance(200);
    const history = store.get("m");
    expect(history.channels).toEqual(["x", "y", "buttons"]);
    expect(history.series[0]).toEqual([0.1, 0.2]);
    expect(history.series[2]).toEqual([0, 1]);
    store.dispose();
  });

  it("restarts the window when the channel SET changes", () => {
    const store = createValueHistoryStore({ frames: 8, now });
    store.push("n", { value: 1 });
    store.push("n", { value: 2 });
    store.push("n", { x: 9, y: 9 });
    advance(200);
    // Two unrelated signals drawn as one continuous line would be a lie about what the
    // node did; a node that starts publishing a different bag IS a different signal.
    expect(store.get("n").channels).toEqual(["x", "y"]);
    expect(store.get("n").series[0]).toEqual([9]);
    store.dispose();
  });

  it("keeps a wide bag from smearing the plot", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    store.push("w", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    advance(200);
    expect(store.get("w").channels).toEqual(["a", "b", "c", "d"]);
    store.dispose();
  });
});

describe("§V16 — consumers are notified at most once per tick", () => {
  it("coalesces a frame burst into one notification", () => {
    const store = createValueHistoryStore({ frames: 120, intervalMs: 100, now });
    let ticks = 0;
    const off = store.subscribe("a", () => {
      ticks += 1;
    });
    for (let frame = 0; frame < 60; frame += 1) {
      store.push("a", { value: frame });
      advance(1000 / 60);
    }
    // A second of 60fps pushes must not be 60 renders of a node body.
    expect(ticks).toBeLessThanOrEqual(11);
    expect(ticks).toBeGreaterThan(0);
    off();
    store.dispose();
  });

  it("hands back a STABLE object between pushes, as useSyncExternalStore requires", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    store.push("a", { value: 1 });
    advance(200);
    const first = store.get("a");
    expect(store.get("a")).toBe(first);
    // A fresh object per read would re-render every value node on every tick, which is
    // the §V16 mistake arriving through the back door.
    store.push("a", { value: 2 });
    expect(store.get("a")).not.toBe(first);
    store.dispose();
  });

  it("notifies only the nodes that changed", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    let a = 0;
    let b = 0;
    store.subscribe("a", () => (a += 1));
    store.subscribe("b", () => (b += 1));
    store.push("a", { value: 1 });
    advance(200);
    expect(a).toBe(1);
    expect(b).toBe(0);
    store.dispose();
  });
});

describe("the window belongs to the history it was recorded from", () => {
  it("clears on reset, so a replayed seek does not draw the abandoned trajectory", () => {
    const store = createValueHistoryStore({ frames: 8, now });
    for (const value of [1, 2, 3]) store.push("a", { value });
    advance(200);
    expect(store.get("a").series[0]).toHaveLength(3);

    store.clear();
    advance(200);
    // §V170/§V181: the state was discarded, so the picture of it must be too.
    expect(store.get("a").latest).toBeNull();
    store.dispose();
  });

  it("forgets a node that left the graph", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    store.push("a", { value: 1 });
    store.push("b", { value: 1 });
    advance(200);
    store.retain(new Set(["a"]));
    expect(store.get("a").latest).toEqual({ value: 1 });
    expect(store.get("b").latest).toBeNull();
    store.dispose();
  });

  it("keeps a non-finite sample out of the window", () => {
    const store = createValueHistoryStore({ frames: 4, now });
    store.push("a", { value: Number.NaN });
    advance(200);
    // NaN in a series makes the whole plot's auto-range NaN and the line vanishes, which
    // reads as the node being broken rather than as one bad sample.
    expect(store.get("a").series[0]).toEqual([0]);
    store.dispose();
  });
});
