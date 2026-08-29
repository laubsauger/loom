import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameInputs } from "@domain/types/backend.ts";
import { wallDeltaSecondsOf } from "@domain/types/frame.ts";
import { Button } from "@ui/primitives/button.tsx";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import styles from "./timeline-readout.module.css";

/**
 * Frame, time and fps, from the frame that was actually rendered (T265, §V169, §V16).
 *
 * ## One clock
 *
 * §V169: every number here comes from the SAME `FrameEvaluationInput` the render
 * consumed. Wiring any of them to `performance.now()` is the obvious shortcut and produces
 * a display that drifts from the picture — worst precisely when it matters, because a
 * readout is what someone looks at once they have stopped trusting what they see. If the
 * loop stalls, these numbers stop; they never keep counting on their own.
 *
 * ## Which clock each number uses (T271)
 *
 * `frame` and `time` are the TIMELINE — where the animation is, which is the clock
 * expressions and shaders read, so the readout and the picture always agree.
 *
 * `fps` is the WALL delta, and it has to be: the timeline step is the constant `1/fps` by
 * construction, so an fps computed from it would read a flat 60 while the app was
 * actually managing 50 and dropping every sixth frame. A throughput meter that cannot
 * report a drop is not a meter. Both readings ride on the one frame input (§V172), so
 * this is still one clock source with two hands, not a second clock.
 *
 * ## Its own component, on purpose
 *
 * §V16 caps UI metric refresh at 10 Hz and forbids per-frame data from re-rendering the
 * tree. The value is SAMPLED from a ref on an interval and lives in this component's
 * state, so ten times a second exactly this strip re-renders and nothing else does. The
 * frame loop pushes nothing.
 *
 * ## Seeking (§V170)
 *
 * The frame field is editable, and committing it runs `transport.seek` — which REPLAYS
 * from the start rather than jumping a counter. That is not a limitation to hide: a graph
 * with feedback has no state at a frame it has never reached, so the alternative is a
 * scrub that shows a picture from a different history and looks like it works. The label
 * says as much, and the command reports rather than freezing when the replay would be
 * absurdly long.
 */

/** §V16: <= 10 Hz. A readout that updates per frame is per-frame data in the tree. */
export const READOUT_INTERVAL_MS = 100;

/** Enough samples to stop the number flickering, few enough to still feel live. */
const FPS_WINDOW = 8;

export interface TimelineReadoutProps {
  /** Reads the last rendered frame. A REF read, never a subscription (§V16). */
  readonly latestFrame: () => FrameInputs | null;
  /** Runs `transport.seek`. Absent = the field is read-only, because nothing can seek. */
  readonly onSeek?: ((frameIndex: number) => void) | undefined;
  readonly intervalMs?: number;
}

const EM_DASH = "—";

interface Sample {
  readonly frameIndex: number;
  readonly timeSeconds: number;
  readonly fps: number | null;
}

export function TimelineReadout({ latestFrame, onSeek, intervalMs = READOUT_INTERVAL_MS }: TimelineReadoutProps) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const deltasRef = useRef<number[]>([]);
  const lastIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const frame = latestFrame();
      if (frame === null) return;
      // Only count a frame once: while paused the same inputs stay in the ref, and
      // averaging them again would make a stopped loop report a rising fps.
      if (lastIndexRef.current !== frame.frame.frameIndex) {
        lastIndexRef.current = frame.frame.frameIndex;
        const deltas = deltasRef.current;
        deltas.push(wallDeltaSecondsOf(frame.frame));
        if (deltas.length > FPS_WINDOW) deltas.shift();
      }
      const deltas = deltasRef.current;
      const mean = deltas.length === 0 ? 0 : deltas.reduce((a, b) => a + b, 0) / deltas.length;
      setSample({
        frameIndex: frame.frame.frameIndex,
        timeSeconds: frame.frame.timeSeconds,
        fps: mean > 0 ? 1 / mean : null,
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, latestFrame]);

  const commit = useCallback(() => {
    const text = draft;
    setDraft(null);
    if (text === null || onSeek === undefined) return;
    const parsed = Number.parseInt(text.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onSeek(parsed);
  }, [draft, onSeek]);

  const shown = draft ?? (sample === null ? "" : String(sample.frameIndex));

  return (
    <div className={styles.readout} role="group" aria-label="Timeline">
      <div className={styles.field}>
        <span className={styles.label}>frame</span>
        {/* §V170 on the surface, in one line: the field says a seek REPLAYS, so nobody
            reads a scrub that re-runs a simulation as a free jump. */}
        <Tooltip label="Type a frame to seek — a seek replays from the start">
          <input
            className={styles.input}
            aria-label="Frame"
            inputMode="numeric"
            value={shown}
            placeholder={EM_DASH}
            readOnly={onSeek === undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
                event.currentTarget.blur();
              }
            }}
          />
        </Tooltip>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>time</span>
        <span className={styles.value} aria-label="Elapsed time">
          {sample === null ? EM_DASH : `${sample.timeSeconds.toFixed(2)}s`}
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>fps</span>
        <span className={styles.value} aria-label="Frames per second">
          {sample?.fps == null ? EM_DASH : sample.fps.toFixed(1)}
        </span>
      </div>

      {onSeek === undefined ? null : (
        <Tooltip label="Back to frame 0">
          <Button aria-label="Go to start" onClick={() => onSeek(0)}>
            <span className={styles.glyph} aria-hidden="true">
              ❙◀
            </span>
          </Button>
        </Tooltip>
      )}
    </div>
  );
}
