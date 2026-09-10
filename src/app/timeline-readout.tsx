import { useCallback, useEffect, useState } from "react";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameClockVerdict } from "@runtime/telemetry/frame-clock.ts";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import styles from "./timeline-readout.module.css";

/**
 * Frame, time and fps, from the frame that was actually rendered (T265, §V169, §V16).
 *
 * ## One clock
 *
 * §V169: frame and time come from the SAME `FrameEvaluationInput` the render
 * consumed. If the loop stalls, those numbers stop; they never count on their own.
 *
 * ## Which clock each number uses (T271)
 *
 * `frame` and `time` are the TIMELINE — where the animation is, which is the clock
 * expressions and shaders read, so the readout and the picture always agree.
 *
 * `fps` counts ALL rendered frames in the frame clock's wall-time window. Sampling
 * only the latest frame's wall delta at 10 Hz aliases uneven presentation intervals:
 * 60 FPS on a 100 Hz display can read 50 or 100. The existing telemetry clock owns
 * throughput; this component only samples its verdict, never estimates a second rate.
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
 *
 * ## What this deliberately does NOT show (T433)
 *
 * A "go to start" button used to sit at the end of this strip, running `onSeek(0)`. The
 * top bar's Reset time control is the same command with the same argument, two inches to
 * the left, and the header is the densest strip in the app — so it is gone rather than
 * duplicated (§V90). `frame`, `time` and `fps` stay: a scrubber shows you WHERE the
 * playhead is and none of these three, and typing a frame is still how you go to one.
 */

/** §V16: <= 10 Hz. A readout that updates per frame is per-frame data in the tree. */
export const READOUT_INTERVAL_MS = 100;

export interface TimelineReadoutProps {
  /** Reads the last rendered frame. A REF read, never a subscription (§V16). */
  readonly latestFrame: () => FrameInputs | null;
  /**
   * T304: why-is-nothing-moving, judged in frame-clock.ts and read on the same 10 Hz
   * sample as everything else. Also owns the rendered-frame throughput measurement.
   */
  readonly frameClock: () => FrameClockVerdict;
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

export function TimelineReadout({ latestFrame, frameClock, onSeek, intervalMs = READOUT_INTERVAL_MS }: TimelineReadoutProps) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [clock, setClock] = useState<FrameClockVerdict | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const verdict = frameClock();
      setClock(verdict);
      const frame = latestFrame();
      if (frame === null) return;
      setSample({
        frameIndex: frame.frame.frameIndex,
        timeSeconds: frame.frame.timeSeconds,
        fps: verdict.kind === "paused" ? null : verdict.observedFps,
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [frameClock, intervalMs, latestFrame]);

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
    <div className={styles.readout} role="group" aria-label="Timeline readout">
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

      {/* T304: the frame clock's verdict, BY NAME (§V541) — "throttled" is the browser
          suspending a hidden window's clock (bring it to the front), "behind" is the
          machine missing the project rate. Not a problems-pane entry on purpose: it
          changes per second and would eat the ring (§V537); this strip and
          get_runtime_metrics are its two homes (§V437). */}
      {clock !== null && (clock.kind === "browser-throttled" || clock.kind === "running-behind") ? (
        <Tooltip label={clock.suggestion}>
          <span
            className={styles.clockNotice}
            data-kind={clock.kind}
            data-testid="frame-clock-notice"
            role="status"
          >
            {clock.kind === "browser-throttled" ? "throttled by the browser" : "running behind"}
          </span>
        </Tooltip>
      ) : null}

    </div>
  );
}
