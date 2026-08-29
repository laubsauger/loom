import type { FrameEvaluationInput, TransportSource } from "../types/frame.ts";

export interface LiveClockOptions {
  seed?: number;
  maxDeltaSeconds?: number;
  now?: () => number;
}

/**
 * Live transport: derives frame input from the browser clock (§I.frame, T63).
 *
 * This is the ONLY place allowed to read wall-clock time. Nodes receive
 * FrameEvaluationInput instead, so a timeline or offline renderer can swap this
 * out without touching node semantics (§V44, §V49).
 */
export function liveClock(options: LiveClockOptions = {}): TransportSource {
  const now = options.now ?? (() => performance.now());
  const maxDelta = options.maxDeltaSeconds ?? 0.25;

  let seed = options.seed ?? 0;
  let frameIndex = 0;
  let lastMs: number | null = null;

  return {
    next(): FrameEvaluationInput {
      const nowMs = now();
      const rawDelta = lastMs === null ? 0 : (nowMs - lastMs) / 1000;
      lastMs = nowMs;

      // Clamp so a backgrounded tab does not hand simulations an enormous step.
      const deltaSeconds = Math.min(Math.max(rawDelta, 0), maxDelta);

      return {
        timeSeconds: nowMs / 1000,
        deltaSeconds,
        frameIndex: frameIndex++,
        mode: "realtime",
        randomSeed: seed,
      };
    },
    reset(nextSeed?: number): void {
      if (nextSeed !== undefined) seed = nextSeed;
      frameIndex = 0;
      lastMs = null;
    },
  };
}
