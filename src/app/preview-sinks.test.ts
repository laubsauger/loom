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
    // T924(3): the ref is past its grace, so it is on its way out — but a DEPARTURE is
    // published once the SET has stopped moving, so it lands one quiet window later. The
    // invariant T620 exists for is untouched: the wait is bounded by a CLOCK, not by a
    // number of `set()` calls, and 1500 + SETTLE_MS gets there whether rAF ran once or
    // never. This is the whole of the 1000 -> 1400 ms `sink-unknown` span the store
    // documents — four tenths of a second longer, still finite, still on a clock.
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    clock = 1900;
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
    // 1900 - 900 is exactly the grace, and the grace is exclusive: still a sink.
    expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    clock = 2000;
    store.set([]);
    clock = 2400; // …and then the quiet window, as above
    store.set([]);
    expect(store.get()).toEqual([]);
  });
});

/**
 * T924(3) / T919 — RECOMPILES PER PAN, which is the number the profile measured.
 *
 * T919 drove E34-Lidar through a scripted 5 s pan on Dawn and counted **13 sink-set
 * changes**, each one a `compileGraph` + `backend.compile` AND (because `useGraphCompile`
 * is called from the App root) a full App re-render. Reading the timeline it printed, they
 * split in two: a handful early, as nodes crossed into the viewport, and then a steady drip
 * for the rest of the gesture as each one aged out of `REMOVAL_GRACE_MS` a second behind the
 * camera. The drip is the majority and it is pure release — nothing is waiting on it.
 *
 * So the two directions are treated as what they are. An ARRIVAL is published immediately:
 * a ref that is not yet a sink has no materialized output, so anything that delays it delays
 * a PICTURE, and T501's first-paint reservation depends on landing on the next frame. A
 * DEPARTURE waits for the set to stop moving: the ref already has its output, its tile and
 * its picture (§V455), and the compile that drops it only releases (T143 carry).
 *
 * Reproduce the real thing (the numbers below are derived from it):
 *   node --import ./src/tooling/alias-hooks.ts scratchpad/t919/preview-profile.ts \
 *     --example=E34-Lidar --gesture=pan --frames=300 --settle=0     # 13, what shipped
 *   ...                                                --settle=200 # 10
 *   ...                                                --settle=400 # 4, the shipped window
 * and at every one of those windows the harness reports the SAME 0.01 on-screen previews
 * per frame with no picture — the hysteresis costs no pixels, which is the constraint.
 */
describe("T924 — a departing sink waits for the gesture to end; an arriving one never does", () => {
  function refsFor(count: number, offset: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      nodeId: `n${String(index + offset)}`,
      portId: "out",
    }));
  }

  const FRAME_MS = 1000 / 60;

  /**
   * A camera that brings twelve nodes on screen one at a time, moves past them one at a
   * time, and then stops — the shape of T919's own timeline, sampled the way the real store
   * is sampled.
   *
   * `dripMs` is the interval between one node crossing the viewport edge and the next, and
   * it is the parameter the whole ruling turns on: E34-Lidar's pan drips at ~385 ms. The
   * store is called EVERY FRAME in between, because it is — the preview tick calls `set()`
   * once per rAF whether or not anything moved, and a quiet window that only ever saw the
   * moments of change could never elapse at all.
   */
  function pan(settleMs: number | undefined, dripMs: number) {
    let clock = 0;
    const store =
      settleMs === undefined
        ? createPreviewSinkStore(() => clock)
        : createPreviewSinkStore(() => clock, settleMs);
    let recompiles = 0;
    store.subscribe(() => (recompiles += 1));

    let asked = refsFor(6, 0);
    store.set(asked);
    const open = recompiles;
    const holdFor = (ms: number) => {
      for (let tick = 0; tick < Math.round(ms / FRAME_MS); tick += 1) {
        clock += FRAME_MS;
        store.set(asked);
      }
    };

    for (let step = 1; step <= 12; step += 1) {
      asked = refsFor(6 + step, 0);
      store.set(asked);
      holdFor(dripMs);
    }
    const arrived = recompiles;
    for (let step = 1; step <= 12; step += 1) {
      asked = refsFor(18 - step, step);
      store.set(asked);
      holdFor(dripMs);
    }
    // The gesture ends and the view is held still, long enough for the last removal grace
    // to expire and the window to close behind it.
    holdFor(3000);
    return {
      open,
      arrivals: arrived - open,
      departures: recompiles - arrived,
      sinks: store.get(),
    };
  }

  /**
   * THE RULING, AT THE DRIP RATE IT WAS RULED ON.
   *
   * 300 ms is E34-Lidar's own spacing to the nearest bracket (~385 ms measured), and it is
   * where 200 ms and 400 ms part company: a quiet window collapses only churn arriving
   * FASTER THAN ITSELF, so 200 ms leaves all twelve departures standing and 400 ms folds
   * them into one. That is the miniature of the harness result the window was chosen from
   * (13 -> 10 at 200 ms, 13 -> 4 at 400 ms, at an identical 0.01 on-screen previews per
   * frame with no picture), and it is why lowering `SETTLE_MS` back to 200 must go red here
   * rather than quietly costing eleven recompiles a gesture.
   */
  it("collapses a departure drip at E34's rate, which 200 ms does not, and leaves arrivals alone", () => {
    // `settleMs: 0` IS the pre-T924 behaviour: a zero quiet window publishes on the spot.
    const before = pan(0, 300);
    const tooNarrow = pan(200, 300);
    const after = pan(400, 300);

    // Opening the document is one compile either way.
    expect(before.open).toBe(1);
    expect(after.open).toBe(1);

    // ARRIVALS ARE UNTOUCHED, and that is the constraint, not a side effect: twelve nodes
    // came on screen and twelve compiles materialized them, at the same frame as before.
    expect(before.arrivals).toBe(12);
    expect(tooNarrow.arrivals).toBe(12);
    expect(after.arrivals).toBe(12);

    // DEPARTURES are where the drip was. One per node before; one for the whole gesture now.
    expect(before.departures).toBe(12);
    expect(after.departures).toBe(1);
    // And the window the brief first named buys NOTHING at this rate — the measurement, not
    // the preference, is what picked 400.
    expect(tooNarrow.departures).toBe(12);

    // It converges on the SAME set: hysteresis delays the answer, never changes it.
    expect(after.sinks).toEqual(before.sinks);

    // The SHIPPED default does it too. Without this the gate would pass against a store
    // whose own constant had been set back to 200 or to zero, which is exactly the
    // regression it is here to catch.
    expect(pan(undefined, 300).departures).toBe(after.departures);
  });

  /**
   * THE LIMIT OF ANY WINDOW, STATED RATHER THAN LEFT TO BE REDISCOVERED.
   *
   * Widening the window is not free forever and it is not a fix for everything: a drip
   * SLOWER than the window is still one recompile per node, and the answer there is not a
   * bigger number — it is that a gesture that leisurely is not the one anybody reported.
   */
  it("does not collapse a drip slower than the window", () => {
    const before = pan(0, 600);
    const after = pan(400, 600);
    expect(after.departures).toBe(before.departures);
  });

  /**
   * The price, asserted rather than assumed: a lone DEPARTURE on a graph nobody is moving
   * costs one quiet window. 400 ms sits under what reads as lag, and no picture is waiting
   * on it — the ref being dropped is one nothing can see any more.
   */
  it("lands a departure one quiet window later, on the timer if nothing calls back", () => {
    vi.useFakeTimers();
    try {
      const store = createPreviewSinkStore(() => Date.now(), 400);
      store.set([
        { nodeId: "n1", portId: "out" },
        { nodeId: "n2", portId: "out" },
      ]);
      let recompiles = 0;
      store.subscribe(() => (recompiles += 1));

      vi.advanceTimersByTime(60_000);
      store.set([{ nodeId: "n1", portId: "out" }]);
      expect(recompiles).toBe(0);

      // T620's lesson, carried forward: rAF stops in a hidden window, so the window must
      // close on a TIMER too — not only on the next `set()` that may never come.
      vi.advanceTimersByTime(400);
      expect(recompiles).toBe(1);
      expect(store.get().map((sink) => sink.nodeId)).toEqual(["n1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never publishes a set the scheduler has already taken back", () => {
    let clock = 0;
    const store = createPreviewSinkStore(() => clock, 400);
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
