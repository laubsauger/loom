import type { NodeId } from "@domain/types/ids.ts";

/**
 * The arithmetic behind the per-node timing overlay (T1010), as pure functions so the
 * claims the overlay makes can be tested rather than eyeballed.
 *
 * Three separate asks from the owner live here, and each is a function:
 *
 *  - SMOOTHING. "The variability is the same" — a raw per-pass number sampled at 10 Hz
 *    jumps by more than it moves, so the digits change faster than anyone can read them
 *    and the reader learns nothing. `smoothGpuMs` is an exponential average with a ~0.4 s
 *    time constant: fast enough that dragging a resolution up shows within half a second,
 *    slow enough that the last digit stops flickering.
 *  - PROPORTION. "So we don't just have an absolute value but also know whether that's a
 *    lot compared to the others." `timingShare` is that second number, and the bar's
 *    LENGTH is the encoding — a share is a ratio and a ratio reads as a length.
 *  - A DENOMINATOR THAT EXISTS. Nothing in the editor knew the graph-wide total, so
 *    `createNodeTimingScaleStore` collects it from the overlays themselves and hands back
 *    one coalesced number.
 *
 * §V86 runs through all three: an unmeasured pass is `null`, never `0`. A zero that means
 * "not measured" is the exact class of lie this project has spent the day removing, so a
 * null never becomes a number here — not by smoothing into one, not by contributing to a
 * total, and not by claiming a share.
 */

/**
 * Weight of a new sample in the average. At the runtime channel's 10 Hz tick this is a
 * time constant of ~0.4 s to 63 % and ~0.9 s to 90 %.
 */
export const TIMING_SMOOTHING_ALPHA = 0.25;

/**
 * One EMA step. `previous` is the last smoothed value, `next` the raw sample.
 *
 * TWO CASES ARE NOT AVERAGING, deliberately:
 *
 *  - `next === null` returns null and FORGETS the average. A pass that stopped reporting
 *    must stop showing a number; decaying the old one toward zero would draw a fading
 *    measurement of nothing (§V86).
 *  - `previous === null` returns `next` whole. Starting the average at zero would ramp
 *    every node up from "free" over the first second, so a graph that had just opened
 *    would read as cheap — the opposite of what the overlay exists to say.
 */
export function smoothGpuMs(
  previous: number | null,
  next: number | null,
  alpha: number = TIMING_SMOOTHING_ALPHA,
): number | null {
  if (next === null || !Number.isFinite(next)) return null;
  if (previous === null || !Number.isFinite(previous)) return next;
  return previous + alpha * (next - previous);
}

/**
 * This node's share of the graph's GPU time, 0..1 — the bar's length.
 *
 * `0` for an unmeasured pass and for a total that is not yet a number: an empty bar reads
 * as "nothing to say", which is true, where a full one would read as "this node is
 * everything". Clamped because a node's own smoothed value can briefly exceed a total
 * that has not caught up with it, and a bar longer than its track is a rendering bug.
 */
export function timingShare(gpuMs: number | null, totalMs: number): number {
  if (gpuMs === null || !Number.isFinite(gpuMs) || gpuMs <= 0) return 0;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  const share = gpuMs / totalMs;
  return share > 1 ? 1 : share;
}

/**
 * The cost ramp's four steps, keyed to the SHARE and never to a millisecond figure.
 *
 * The owner's constraint is *"at a distance"* — scanning a whole graph zoomed out for the
 * node to look at first — and that is what forces the ramp to be proportional. An absolute
 * ladder (say, red above 8 ms) paints a uniformly cheap graph entirely green and a
 * uniformly expensive one entirely red, so in both cases the colour says something about
 * the MACHINE and nothing about which node to open. A share says "this one, out of these"
 * on any hardware, which is the question being asked.
 *
 * Four steps rather than a continuous gradient because the bar is a few screen pixels wide
 * when zoomed out: a smooth ramp is unreadable at that size, while four steps are four
 * distinguishable things. They are unevenly spaced on purpose — most nodes in a real graph
 * sit under a tenth of the frame, so the bottom step has to be wide or everything lands in
 * it, and the top step has to start well below "half the frame" to ever be reached on a
 * graph with a dozen passes.
 */
export type CostTier = "low" | "moderate" | "high" | "dominant";

export const COST_TIER_THRESHOLDS: ReadonlyArray<{ tier: CostTier; atLeast: number }> = [
  { tier: "dominant", atLeast: 0.45 },
  { tier: "high", atLeast: 0.25 },
  { tier: "moderate", atLeast: 0.1 },
  { tier: "low", atLeast: 0 },
];

/** Which step of the ramp a share lands on. Monotonic by construction (see the test). */
export function costTier(share: number): CostTier {
  for (const step of COST_TIER_THRESHOLDS) {
    if (share >= step.atLeast) return step.tier;
  }
  return "low";
}

/**
 * What an OVERLAY needs — and it both reads and writes, which is the unusual part.
 *
 * Every other channel in the editor has a producer somewhere else and a read-only view
 * here. This one has no producer: the total is a sum over exactly the overlays that are
 * mounted, so the readers ARE the writers. Splitting a read-only face off it would only
 * hand a node half of an interface it needs all of.
 */
export interface NodeTimingScaleSource {
  /** Sum of every reported node's smoothed GPU ms. `0` when nothing is measured. */
  total(): number;
  subscribe(listener: () => void): () => void;
  /** One node's smoothed cost. `null` withdraws it from the total (§V86). */
  report(nodeId: NodeId, gpuMs: number | null): void;
  /** The node's overlay unmounted. */
  forget(nodeId: NodeId): void;
}

/** Owner side. The canvas that created it is the only thing that may tear it down. */
export interface NodeTimingScaleStore extends NodeTimingScaleSource {
  dispose(): void;
}

/**
 * §V16 again, one level up: the per-node channel already caps repaints at 10 Hz, and the
 * DENOMINATOR is shared by every overlay on screen, so notifying it at that rate would
 * repaint N overlays N times a second for a number that barely moves. 250 ms is slow
 * enough to be cheap and far faster than a human reads a bar.
 */
export const TIMING_SCALE_TICK_MS = 250;

export interface NodeTimingScaleOptions {
  intervalMs?: number;
  now?: () => number;
}

/**
 * The graph-wide denominator, collected from the overlays that draw against it.
 *
 * WHY IT IS COLLECTED HERE rather than read off the telemetry hub, which already sums the
 * frame: the hub lives in `src/runtime` and reaches the editor only as a prop threaded
 * from the composition root. Threading it would put this feature's wiring in a file two
 * other tracks are editing today, for a number the overlays already hold between them.
 * When that seam exists for another reason, this store is the one place to swap.
 *
 * The total is PUBLISHED, not computed on read: `useSyncExternalStore` requires a snapshot
 * that does not change identity between notifications, and a sum recomputed per call would
 * hand React a different number mid-render.
 */
export function createNodeTimingScaleStore(
  options: NodeTimingScaleOptions = {},
): NodeTimingScaleStore {
  const intervalMs = options.intervalMs ?? TIMING_SCALE_TICK_MS;
  const now = options.now ?? (() => Date.now());

  const reported = new Map<NodeId, number>();
  const listeners = new Set<() => void>();
  let published = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let disposed = false;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastFlush = now();
    let sum = 0;
    for (const value of reported.values()) sum += value;
    // No change, no notification. Without this the interval alone would repaint every
    // overlay four times a second on a graph that is perfectly steady.
    if (sum === published) return;
    published = sum;
    for (const listener of [...listeners]) listener();
  }

  function schedule(): void {
    if (disposed || timer !== null) return;
    const wait = Math.max(0, intervalMs - (now() - lastFlush));
    timer = setTimeout(flush, wait);
  }

  return {
    total: () => published,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report(nodeId, gpuMs) {
      if (gpuMs === null || !Number.isFinite(gpuMs) || gpuMs <= 0) {
        if (!reported.delete(nodeId)) return;
        schedule();
        return;
      }
      if (reported.get(nodeId) === gpuMs) return;
      reported.set(nodeId, gpuMs);
      schedule();
    },
    forget(nodeId) {
      if (!reported.delete(nodeId)) return;
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      reported.clear();
      listeners.clear();
    },
  };
}
