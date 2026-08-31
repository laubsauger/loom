import { describe, expect, it } from "vitest";

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
    clock = 2000;
    store.set([]);
    expect(store.get()).toEqual([]);
  });
});
