import { describe, expect, it } from "vitest";
import {
  TIMING_SMOOTHING_ALPHA,
  createNodeTimingScaleStore,
  smoothGpuMs,
  timingShare,
} from "./node-timing.ts";

/**
 * The overlay's arithmetic (T1010). Each block is one of the three things the owner asked
 * for, asserted as a property of the numbers rather than of the pixels.
 */

describe("smoothing — 'the variability is the same'", () => {
  it("moves toward a new sample instead of jumping to it", () => {
    // The complaint in one assertion: the raw number doubled, and the readout must move a
    // quarter of the way rather than showing a doubled figure for one tenth of a second.
    const smoothed = smoothGpuMs(4, 8);
    expect(smoothed).toBeCloseTo(4 + TIMING_SMOOTHING_ALPHA * 4, 10);
    expect(smoothed).toBeLessThan(8);
    expect(smoothed).toBeGreaterThan(4);
  });

  it("converges on a steady value rather than lagging it forever", () => {
    // A readout that never arrives is as unreadable as one that jitters. Ten ticks — one
    // second on the 10 Hz channel — must be within a few percent of the true cost.
    let value: number | null = 1;
    for (let tick = 0; tick < 10; tick += 1) value = smoothGpuMs(value, 12);
    expect(value).toBeGreaterThan(11.3);
    expect(value).toBeLessThan(12);
  });

  it("takes the FIRST sample whole rather than ramping up from zero", () => {
    // Averaging from an implied zero would show every node as cheap for the first second
    // after a graph opens — the exact opposite of what the overlay is for.
    expect(smoothGpuMs(null, 9)).toBe(9);
  });

  it("forgets the average when the measurement stops (§V86)", () => {
    // A pass that reports nothing must show nothing. Decaying the last number toward zero
    // would draw a fading measurement of something that is not being measured.
    expect(smoothGpuMs(7, null)).toBeNull();
    // And the next real sample starts clean rather than resuming the old average.
    expect(smoothGpuMs(null, 2)).toBe(2);
  });

  it("refuses a non-finite sample the same way it refuses a missing one", () => {
    expect(smoothGpuMs(3, Number.NaN)).toBeNull();
    expect(smoothGpuMs(3, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("proportion — 'whether that's a lot compared to the others'", () => {
  it("gives a node its share of the graph, so the bar length IS the comparison", () => {
    expect(timingShare(3, 12)).toBeCloseTo(0.25, 10);
    expect(timingShare(9, 12)).toBeCloseTo(0.75, 10);
  });

  it("grows for the node that got more expensive, at a fixed total (§V839)", () => {
    // The metric must move the way its name says. A share can fall while the absolute cost
    // RISES (if the rest of the graph rose faster), so this pins the direction with the
    // denominator held still: more milliseconds, longer bar.
    const cheap = timingShare(2, 20);
    const dear = timingShare(8, 20);
    expect(dear).toBeGreaterThan(cheap);
  });

  it("shows nothing rather than everything when there is no measurement (§V86)", () => {
    // `null / 0` would be NaN and a NaN width renders as a full bar in some engines: a
    // node with no timing would read as the whole frame. Zero is the honest length.
    expect(timingShare(null, 0)).toBe(0);
    expect(timingShare(null, 12)).toBe(0);
    expect(timingShare(4, 0)).toBe(0);
  });

  it("clamps a share above 1, which a lagging denominator can produce", () => {
    expect(timingShare(30, 20)).toBe(1);
  });
});

describe("the denominator", () => {
  const scale = () => createNodeTimingScaleStore({ intervalMs: 0 });

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  it("sums what the mounted overlays report", async () => {
    const store = scale();
    store.report("a", 3);
    store.report("b", 5);
    await settle();
    expect(store.total()).toBe(8);
  });

  it("drops a node that stopped reporting, so the total is of LIVE passes (§V86)", async () => {
    const store = scale();
    store.report("a", 3);
    store.report("b", 5);
    await settle();
    store.report("b", null);
    await settle();
    expect(store.total()).toBe(3);
  });

  it("drops a node whose overlay unmounted", async () => {
    const store = scale();
    store.report("a", 3);
    store.report("b", 5);
    await settle();
    store.forget("a");
    await settle();
    expect(store.total()).toBe(5);
  });

  it("does not notify when the sum did not change", async () => {
    // §V836's arithmetic: the denominator is shared by every overlay on screen, so a
    // notification is N re-renders. A tick that changed nothing must cost none of them.
    const store = scale();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.report("a", 3);
    await settle();
    expect(notifications).toBe(1);

    // Two nodes trading cost: each moved, the sum did not.
    store.report("a", 1);
    store.report("b", 2);
    await settle();
    expect(store.total()).toBe(3);
    expect(notifications).toBe(1);
  });

  it("holds a stable number between notifications, as useSyncExternalStore requires", async () => {
    // A sum recomputed on every read would hand React a different value mid-render, which
    // is the tearing that `useSyncExternalStore` exists to refuse.
    const store = scale();
    store.report("a", 3);
    await settle();
    const first = store.total();
    store.report("b", 5);
    expect(store.total()).toBe(first);
    await settle();
    expect(store.total()).toBe(8);
  });

  it("stops scheduling once disposed", async () => {
    const store = scale();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.dispose();
    store.report("a", 3);
    await settle();
    expect(notifications).toBe(0);
  });
});
