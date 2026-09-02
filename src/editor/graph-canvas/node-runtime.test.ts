import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeId } from "@domain/types/ids.ts";

import { createNodeRuntimeStore, METRIC_TICK_MS } from "./node-runtime.ts";

/**
 * T924(1) / T919 — THE PREVIEW CHANNEL MAY NOT REPAINT THE GRAPH WHEN IT HAS NOTHING TO SAY.
 *
 * This is the gate for the largest single finding in T919's profile, and it asserts the
 * number that profile measured rather than the shape of the fix: RE-RENDERS PER NODE PER
 * SECOND, driven through the real store with the real producer shape.
 *
 * `use-node-previews.ts` rebuilds a `NodePreviewRuntime` object literal for every candidate
 * node on every rAF tick — active, suspended, idle and off alike, because §V28's suspension
 * is a GPU policy and the producer has no cache to compare against. While `sameSnapshot`
 * compared `preview` by IDENTITY that could never dedupe, so `scheduleFlush` fired on the
 * 100 ms metric tick forever and every node on the canvas re-rendered 10 times a second
 * while the published value never changed. Each of those renders re-measured the node and
 * every one of its handles (`node-view.tsx`'s `useHandleBoundsInSync`).
 *
 * WHY THE NUMBER MATTERS, not just the dedupe: §V16 caps UI metric refresh at 10 Hz, and
 * the shipped behaviour sat exactly ON that cap while idle — the ceiling was being spent
 * on nothing, leaving none of it for the case it exists for. A test that only asserted
 * "publishing the same value twice does not notify" could not fail when the producer starts
 * allocating again, which is precisely how this shipped.
 *
 * The measured harness is `scratchpad/t919/runtime-store-churn.ts` (44 nodes, 3 s, real
 * timers): 1320 listener calls = 10.0 re-renders per node per second before, 44 = 0.3 after.
 */

const NODES = 44;
const SECONDS = 3;
const FRAMES = SECONDS * 60;

function ids(count: number): NodeId[] {
  return Array.from({ length: count }, (_unused, index) => `n${String(index)}` as NodeId);
}

/** What the preview tick publishes: a fresh object, identical in content, every frame. */
function freshPreview(nodeId: NodeId) {
  return {
    output: { nodeId, portId: "out" },
    state: { kind: "live" as const },
    facts: { width: 1280, height: 720, format: "rgba16float" },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("node runtime store — preview coalescing (T924, §V16)", () => {
  it("holds an idle graph under 1 re-render per node per second while the preview tick runs at 60 Hz", () => {
    vi.useFakeTimers();
    const store = createNodeRuntimeStore({});
    const nodes = ids(NODES);
    let notifications = 0;
    for (const nodeId of nodes) store.subscribe(nodeId, () => (notifications += 1));

    for (let frame = 0; frame < FRAMES; frame += 1) {
      for (const nodeId of nodes) store.publish(nodeId, { preview: freshPreview(nodeId) });
      vi.advanceTimersByTime(1000 / 60);
    }
    // Let any flush still on the metric tick land, so nothing is hidden by the run ending.
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    store.dispose();

    const perNodePerSecond = notifications / NODES / SECONDS;
    // One flush for the first publish (idle -> live) is the whole legitimate cost:
    // 44 / 44 / 3 = 0.33. The shipped identity compare gave 10.0.
    expect(perNodePerSecond).toBeLessThan(1);
    expect(notifications).toBe(NODES);
  });

  it("still delivers a preview state change, and still rate-limits it to the 10 Hz cap", () => {
    vi.useFakeTimers();
    const store = createNodeRuntimeStore({});
    const nodeId = ids(1)[0] as NodeId;
    let notifications = 0;
    store.subscribe(nodeId, () => (notifications += 1));

    store.publish(nodeId, { preview: freshPreview(nodeId) });
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    expect(notifications).toBe(1);
    expect(store.get(nodeId).preview?.state).toEqual({ kind: "live" });

    // A real change — the scheduler suspended this preview — must get through. This is the
    // half a stability fix can silently break, and the reason previews are worth publishing
    // at all (§V28b: a suspended slot names its state instead of going blank).
    store.publish(nodeId, {
      preview: { ...freshPreview(nodeId), state: { kind: "suspended", reason: "offscreen" } },
    });
    // Not immediately: preview is not `isStructural`, so it rides the metric tick (§V16).
    expect(notifications).toBe(1);
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    expect(notifications).toBe(2);
    expect(store.get(nodeId).preview?.state).toEqual({ kind: "suspended", reason: "offscreen" });

    // ...and the reason itself is part of the value: two different suspensions are two
    // different sentences on the node (`off-screen` vs `over budget`).
    store.publish(nodeId, {
      preview: { ...freshPreview(nodeId), state: { kind: "suspended", reason: "budget" } },
    });
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    expect(notifications).toBe(3);

    // The resolved facts are part of it too (§V100 — the slot shows what compiled).
    store.publish(nodeId, {
      preview: {
        ...freshPreview(nodeId),
        state: { kind: "suspended", reason: "budget" },
        facts: { width: 640, height: 360, format: "rgba16float" },
      },
    });
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    expect(notifications).toBe(4);
    store.dispose();
  });

  it("keeps the preview OBJECT stable across a tick where a number beside it moved", () => {
    vi.useFakeTimers();
    const store = createNodeRuntimeStore({});
    const nodeId = ids(1)[0] as NodeId;

    store.publish(nodeId, { preview: freshPreview(nodeId) });
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    const first = store.get(nodeId).preview;

    // gpuMs ticks on the metric channel; the preview slot must not be handed a new object
    // because of it, or every consumer memoised on `preview` re-renders anyway.
    store.publish(nodeId, { gpuMs: 1.5, preview: freshPreview(nodeId) });
    vi.advanceTimersByTime(METRIC_TICK_MS * 2);
    expect(store.get(nodeId).gpuMs).toBe(1.5);
    expect(store.get(nodeId).preview).toBe(first);
    store.dispose();
  });
});
