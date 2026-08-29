import type { FrameEvaluationInput, TransportSource } from "../../domain/types/frame.ts";

export interface OfflineTransportOptions {
  /** Frames per second of the rendered sequence. */
  readonly fps: number;
  readonly seed?: number;
  readonly startFrame?: number;
  /** "fixed-step" for a deterministic timeline; "offline" for a render queue (§I.frame). */
  readonly mode?: "fixed-step" | "offline";
}

/**
 * Exact-frame transport: no clock, no jitter, no wall time (§V44, §V49).
 *
 * This is the other half of the headless seam. The same graph, the same compiler and the
 * same `FrameDriver.step()` produce a deterministic sequence when driven by this instead of
 * `liveClock()` — which is what makes offline rendering a swap rather than a rewrite (§V47).
 */
export function offlineTransport(options: OfflineTransportOptions): TransportSource {
  const deltaSeconds = 1 / options.fps;
  const mode = options.mode ?? "offline";
  const startFrame = options.startFrame ?? 0;

  let seed = options.seed ?? 0;
  let frameIndex = startFrame;

  return {
    next(): FrameEvaluationInput {
      const current = frameIndex;
      frameIndex += 1;
      return {
        // Divided, not accumulated: frame N always lands on exactly N/fps.
        timeSeconds: current / options.fps,
        deltaSeconds: current === startFrame ? 0 : deltaSeconds,
        frameIndex: current,
        mode,
        randomSeed: seed,
      };
    },
    reset(nextSeed?: number): void {
      if (nextSeed !== undefined) seed = nextSeed;
      frameIndex = startFrame;
    },
  };
}
