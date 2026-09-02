import { describe, expect, it, vi } from "vitest";

import { createPreviewSinkStore } from "./preview-sinks.ts";

/**
 * T620 — removal grace is a CLOCK, not a call count.
 *
 * The grace exists for a pan: a node swept off screen and back must not recompile
 * twice mid-gesture, so an absent ref survives about a second. It was measured in
 * `set()` calls — 60 of them — written when every call was one rAF tick. Chrome
 * suspends rAF for a hidden page, where the store is driven once per landed plan
 * instead, and "60 ticks ≈ a second" silently became "60 recompiles ≈ forever": a
 * deleted node's sink poisoned every subsequent compile with `sink-unknown` for the
 * rest of the session. Time passes whether rAF runs or not, so the grace does too.
 */
describe("T620 — sink removal grace is wall-clock", () => {
  const ref = { nodeId: "n1", portId: "out" };

  it("one absent set() call PAST the grace drops the ref — no 60-call wait", () => {
    let clock = 0;
    const store = createPreviewSinkStore(() => clock);
    store.set([ref]);
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);

    // The hidden-page cadence: the NEXT call is a whole recompile later.
    clock = 1500;
    store.set([]);
    // T924(3): the ref is past its grace, so it is on its way out — but a change is
    // published once the SET has stopped moving, so it lands one quiet window later. The
    // invariant T620 exists for is untouched: the wait is bounded by a CLOCK, not by a
    // number of `set()` calls, and 1500 + 200 gets there whether rAF ran once or never.
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    clock = 1700;
    store.set([]);
    expect(store.get()).toEqual([]);
  });

  it("a pan's transient absence still survives: absent within the grace stays", () => {
    let clock = 0;
    const store = createPreviewSinkStore(() => clock);
    store.set([ref]);
    clock = 500;
    store.set([]);
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    // …and coming back refreshes the clock rather than inheriting the old one.
    clock = 900;
    store.set([ref]);
    clock = 1800;
    store.set([]);
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    clock = 1900;
    store.set([]);
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    clock = 2000;
    store.set([]);
    clock = 2200; // the quiet window, as above
    store.set([]);
    expect(store.get()).toEqual([]);
  });
});

/**
 * T924(3) / T919 — RECOMPILES PER PAN, which is the number the profile measured.
 *
 * T919 drove E34-Lidar through a scripted 5 s pan on Dawn and counted **13 sink-set
 * changes**, each one a `compileGraph` + `backend.compile` AND (because `useGraphCompile`
 * is called from the App root) a full App re-render. Each was a single node crossing the
 * viewport edge: an addition published the instant it appeared, or a removal published the
 * instant its own grace expired — a steady drip a second behind the camera.
 *
 * This replays that shape against the store directly: one node enters or leaves every
 * ~250 ms while the camera moves, then the gesture stops. It asserts RECOMPILES, not the
 * mechanism, because the mechanism is a tuning parameter and the recompile count is what
 * the user feels.
 *
 * Reproduce the real thing (the numbers this is derived from):
 *   node --import ./src/mcp/alias-hooks.ts scratchpad/t919/preview-profile.ts \
 *     --example=E34-Lidar --gesture=pan --frames=300 --settle=0     # 13, what shipped
 *   ...                                                --settle=200 # 10
 *   ...                                                --settle=400 # 3
 */
describe("T924 — the sink set is published when it settles, not while it churns", () => {
  function refsFor(count: number, offset: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      nodeId: `n${String(index + offset)}`,
      portId: "out",
    }));
  }

  /** A camera moving a node's worth of graph every `stepMs`, then stopping. */
  function pan(settleMs: number | undefined, stepMs: number) {
    let clock = 0;
    const store =
      settleMs === undefined
        ? createPreviewSinkStore(() => clock)
        : createPreviewSinkStore(() => clock, settleMs);
    let recompiles = 0;
    store.subscribe(() => (recompiles += 1));

    store.set(refsFor(6, 0));
    const afterOpen = recompiles;
    for (let step = 1; step <= 12; step += 1) {
      clock += stepMs;
      store.set(refsFor(6, step));
    }
    // The gesture ends and the view is held still, at the store's own rAF cadence.
    for (let tick = 0; tick < 90; tick += 1) {
      clock += 1000 / 60;
      store.set(refsFor(6, 12));
    }
    return { duringOpen: afterOpen, total: recompiles, sinks: store.get() };
  }

  it("collapses a pan whose churn is faster than the window into ONE recompile", () => {
    // `settleMs: 0` IS the pre-T924 behaviour: a zero quiet window publishes on the spot.
    const before = pan(0, 100);
    const after = pan(200, 100);

    // Opening the document is one compile either way — nothing is churning yet, and making
    // the canvas wait for its first picture would buy nothing.
    expect(before.duringOpen).toBe(1);
    expect(after.duringOpen).toBe(1);

    // One recompile per node crossing the edge, plus one more as each ages out of its
    // removal grace a second behind the camera. This is the shape T919 measured.
    expect(before.total).toBeGreaterThanOrEqual(12);
    // One for the open, one when the gesture settles, and nothing at all in between.
    expect(after.total).toBe(2);

    // And it converges on the SAME set: hysteresis delays the answer, never changes it.
    expect(after.sinks).toEqual(before.sinks);

    // The SHIPPED default does it too. Without this the gate would pass against a store
    // whose own constant had been set back to zero, which is exactly the regression it is
    // here to catch.
    expect(pan(undefined, 100).total).toBe(after.total);
  });

  /**
   * THE LIMIT OF THE SHIPPED NUMBER, STATED RATHER THAN LEFT TO BE REDISCOVERED.
   *
   * A quiet window only collapses churn ARRIVING FASTER THAN ITSELF. E34-Lidar's 5 s pan
   * changes the set every ~385 ms on average — 41 previewable nodes spread across a very
   * wide graph — so a 200 ms window merges only the close pairs and the measured count goes
   * 13 -> 10, not 13 -> 1. Widening it moves the number a great deal (400 ms -> 3,
   * 1000 ms -> 2) at the cost of that much delay before an entering node's picture appears.
   * The harness sweeps it: `--settle=` on `scratchpad/t919/preview-profile.ts`.
   */
  it("does not collapse churn arriving more slowly than the window", () => {
    const before = pan(0, 250);
    const after = pan(200, 250);
    expect(before.total).toBeGreaterThan(after.total);
    expect(after.total).toBeGreaterThan(2);
    expect(after.sinks).toEqual(before.sinks);
  });

  /**
   * The price, asserted rather than assumed: EVERY change after the first costs one quiet
   * window, including a lone edit on a graph nobody is moving. 200 ms is chosen to sit
   * under what reads as lag, and the compile a document edit triggers on its own is
   * unaffected — this delays only when the new node becomes a preview SINK.
   */
  it("lands one quiet window after a lone change, and lands it on the timer if nothing calls back", async () => {
    vi.useFakeTimers();
    try {
      const store = createPreviewSinkStore(() => Date.now(), 200);
      let recompiles = 0;
      store.set([{ nodeId: "n1", portId: "out" }]);
      store.subscribe(() => (recompiles += 1));

      vi.advanceTimersByTime(60_000);
      store.set([
        { nodeId: "n1", portId: "out" },
        { nodeId: "n2", portId: "out" },
      ]);
      expect(recompiles).toBe(0);

      // T620's lesson, carried forward: rAF stops in a hidden window, so the window must
      // close on a TIMER too — not only on the next `set()` that may never come.
      vi.advanceTimersByTime(200);
      expect(recompiles).toBe(1);
      expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1", "n2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never publishes a set the scheduler has already taken back", () => {
    let clock = 0;
    const store = createPreviewSinkStore(() => clock, 200);
    store.set([{ nodeId: "n1", portId: "out" }]);
    let recompiles = 0;
    store.subscribe(() => (recompiles += 1));

    // A node swept off screen and back inside its removal grace. It was never NOT a sink,
    // so it keeps its materialized output and its tile (§V455) — the case the quiet window
    // must not turn into a blank preview.
    clock = 100;
    store.set([]);
    clock = 200;
    store.set([{ nodeId: "n1", portId: "out" }]);
    clock = 5000;
    store.set([{ nodeId: "n1", portId: "out" }]);
    expect(recompiles).toBe(0);
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
  });
});
