/**
 * Structural enforcement of §V8: no render-target (or effect / sampler / buffer)
 * allocation inside the frame loop.
 *
 * Every allocation site in the backend goes through `assertOutsideFrame`. While a frame
 * is being encoded the guard is "inside", so an allocation attempt throws instead of
 * quietly stalling the pipeline. Documentation cannot be violated silently; this can't
 * be violated at all.
 */
export class FrameEncodingViolation extends Error {
  readonly what: string;

  constructor(what: string) {
    super(
      `${what} was allocated while a frame was being encoded. ` +
        "Effects, targets, samplers and buffers are created at compile time, never inside the frame loop (V8).",
    );
    this.name = "FrameEncodingViolation";
    this.what = what;
  }
}

export interface FrameGuard {
  readonly encoding: boolean;
  /** Throws when called during frame encoding. */
  assertOutsideFrame(what: string): void;
  /** Runs `body` with the guard closed. Reentrant calls are rejected by vgpu itself. */
  duringFrame<T>(body: () => T): T;
}

export function createFrameGuard(): FrameGuard {
  let depth = 0;

  return {
    get encoding() {
      return depth > 0;
    },
    assertOutsideFrame(what) {
      if (depth > 0) throw new FrameEncodingViolation(what);
    },
    duringFrame(body) {
      depth += 1;
      try {
        return body();
      } finally {
        depth -= 1;
      }
    },
  };
}
