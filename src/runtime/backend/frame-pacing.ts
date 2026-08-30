/**
 * The fps gate (T351, §V290): which rAF ticks become frames when the display refreshes
 * faster than the target.
 *
 * The naive gate — `elapsed >= interval`, reset to the tick's own timestamp — has no
 * phase carry and no tolerance, so the due tick routinely lands a fraction of a
 * millisecond EARLY, gets skipped, and the frame runs a whole refresh late. On a
 * 120 Hz display asking for 60 that alternates 16.6 ms and 25 ms frames and averages
 * 45-55 fps on every graph — cost that looks like mystery per-frame overhead and is
 * actually arithmetic.
 *
 * This gate runs the tick CLOSEST to the due time (half-a-tick tolerance, measured
 * from the live tick spacing) and advances the due time by the exact interval, so the
 * long-run rate is the target BY CONSTRUCTION. A large gap — a hidden tab, a debugger
 * pause — resyncs instead of bursting to catch up.
 */
export interface PacedGate {
  /**
   * True when this tick should render. Call once per scheduler tick, in order.
   * `intervalMs` is taken per call so a live fps change needs no gate rebuild.
   */
  due(nowMs: number, intervalMs: number): boolean;
}

export function createPacedGate(): PacedGate {
  let nextDueMs: number | undefined;
  let lastTickMs: number | undefined;
  return {
    due(nowMs, intervalMs) {
      const tickDelta = lastTickMs === undefined ? 0 : nowMs - lastTickMs;
      lastTickMs = nowMs;
      nextDueMs ??= nowMs;
      const tolerance = Math.min(tickDelta / 2, intervalMs / 2);
      if (nowMs < nextDueMs - tolerance) return false;
      nextDueMs += intervalMs;
      if (nextDueMs < nowMs - intervalMs) nextDueMs = nowMs + intervalMs;
      return true;
    },
  };
}
