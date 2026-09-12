import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameRange } from "@domain/types/graph.ts";
import { frameRangeLength, projectFps } from "@domain/types/graph.ts";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { clamp01, frameAtFraction, fractionOfRange } from "./scrubber-math.ts";
import styles from "./timeline-scrubber.module.css";

/**
 * The timeline, in the header (T433).
 *
 * ## Why it is a strip and not a panel
 *
 * The owner's constraint was the whole shape of this: the header does not get taller. So
 * the timeline is a STRIP that occupies the horizontal slack the header already had
 * between the centred transport and the right-hand readouts — one `--control-h` row, the
 * same height as the frame field beside it. A timeline that needed its own band would be
 * a second header, and a second header is the thing that gets reported.
 *
 * ## One value, three meanings
 *
 * `range.end` is the render length, the loop end AND the scrub extent, and it is one
 * number in one place (`ProjectSettings.frameRange`, §V177). Three fields for those three
 * jobs can disagree, and a user who shortened the render and then watched the loop run
 * past it would be right to call that broken. This component neither owns the range nor
 * keeps a copy: it renders the document's value and asks for a new one.
 *
 * ## Why the scrub commits on RELEASE (§V170)
 *
 * A seek REPLAYS from frame zero — that is not this component's choice, it is the only
 * honest answer for a graph with feedback, a Cache or a point simulation, whose state is
 * not a function of frame index. Replaying is O(frames), so issuing a seek per pointer
 * sample would replay the whole graph a few hundred times across one drag and lock the
 * tab solid. The playhead therefore follows the pointer live — that is the feedback the
 * gesture needs — and exactly one seek is issued, on release. The tooltip says so, in the
 * same words the frame field uses, because a scrub that silently re-runs a simulation is
 * precisely the thing §V170 forbids leaving unsaid.
 *
 * ## §V16
 *
 * The playhead position is SAMPLED from a ref on an interval, like the readout beside it,
 * so ten times a second this strip re-renders and nothing else does. The frame loop
 * pushes nothing.
 */

/** §V16: <= 10 Hz. Matched to the readout's tick so the two never disagree on screen. */
export const SCRUBBER_INTERVAL_MS = 100;

/**
 * T1259 — how far the compositor's playhead may drift from the RENDERED frame before it is
 * put back, in frames. Playing, 1.5: the 10 Hz sample lags the frame it reads by up to one
 * frame, and the loop's wrap adds one frame a lap, so a tolerance under 1 would re-sync on
 * every sample and a tolerance of several would let a seek go unnoticed. Paused, 0.5: a
 * still playhead must sit on its frame.
 */
const DRIFT_PLAYING_FRAMES = 1.5;
const DRIFT_PAUSED_FRAMES = 0.5;

export interface TimelineScrubberProps {
  /** Reads the last rendered frame. A REF read, never a subscription (§V16). */
  readonly latestFrame: () => FrameInputs | null;
  /** The document's in/out points — the ONE range (§V177). */
  readonly range: FrameRange;
  /** Runs `transport.seek`. Absent = the track is inert, because nothing can seek. */
  readonly onSeek?: ((frameIndex: number) => void) | undefined;
  /** Writes `frameRange` through `project.setSettings`. Absent = the ends are read-only. */
  readonly onChangeRange?: ((range: FrameRange) => void) | undefined;
  /** Whether the transport is playing (T1259): only then does the compositor move the playhead. */
  readonly playing?: boolean | undefined;
  /** The timeline's frame rate, which is the speed the compositor runs the playhead at (T1259). */
  readonly fps?: number | undefined;
  readonly intervalMs?: number;
}

export function TimelineScrubber({
  latestFrame,
  range,
  onSeek,
  onChangeRange,
  playing = false,
  fps,
  intervalMs = SCRUBBER_INTERVAL_MS,
}: TimelineScrubberProps) {
  /**
   * The frame the READOUT of this strip reports — `aria-valuenow` and the keyboard
   * handler's starting point. Sampled at 10 Hz (§V16). The PLAYHEAD does not come from
   * here; see the animations below.
   */
  const [frameIndex, setFrameIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  /** Where the pointer is during a drag, as a fraction. Null when nobody is dragging. */
  const dragRef = useRef<number | null>(null);

  /**
   * T1259 — THE PLAYHEAD IS A COMPOSITOR ANIMATION, NOT A SCRIPT WRITE PER FRAME.
   *
   * T456 made the playhead move on the display's clock instead of a 10 Hz sample, and
   * T1239 made those per-frame writes transforms instead of `left`/`width`. That was still
   * a SCRIPT write every animation frame, and T1239 measured what one costs on Chromium
   * 151: a full compositor Update, about 0.5 ms, with Layerize at 249–370 ms per 5 s of
   * idle playback. `will-change` and a lone `translateX` did not change it; the write
   * itself is the cost.
   *
   * So each bar runs ONE looping Web Animation over the range, and the compositor moves it.
   * Script touches it only on EVENTS: play and pause, a change of range or rate (a new
   * animation), a drag (`currentTime` follows the pointer), and a drift of more than
   * `DRIFT_PLAYING_FRAMES` between the animation and the frame that was actually RENDERED
   * (§V169). A drift is a seek, a step, or the loop's wrap, which lands once per lap
   * because the out point is shown for a frame before the in point. The check runs on
   * the readout's 10 Hz tick (§V16). No style property is written while it plays, and
   * none while it stands still.
   */
  const animationsRef = useRef<readonly Animation[]>([]);
  // Read inside the sync, which must not be rebuilt on every render to pick these up.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const rate = projectFps(fps === undefined ? {} : { fps });
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const durationMs = (Math.max(frameRangeLength(range) - 1, 1) / rate) * 1000;
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;

  const sync = useCallback((): void => {
    const animations = animationsRef.current;
    if (animations.length === 0) return;
    const duration = durationRef.current;
    const dragging = dragRef.current;
    let target: number;
    if (dragging !== null) {
      target = dragging * duration;
    } else {
      const frame = latestFrame();
      if (frame === null) return;
      target = fractionOfRange(rangeRef.current, frame.frame.frameIndex) * duration;
    }
    const run = playingRef.current && dragging === null;
    const tolerance = (run ? DRIFT_PLAYING_FRAMES : DRIFT_PAUSED_FRAMES) * (1000 / rateRef.current);
    for (const animation of animations) {
      if (!run && animation.playState === "running") animation.pause();
      const at = Number(animation.currentTime ?? 0) % duration;
      if (Math.abs(at - target) > tolerance) animation.currentTime = target;
      if (run && animation.playState !== "running") animation.play();
    }
  }, [latestFrame]);

  useEffect(() => {
    const elapsed = elapsedRef.current;
    const playhead = playheadRef.current;
    if (elapsed === null || playhead === null || typeof playhead.animate !== "function") return;
    const timing: KeyframeAnimationOptions = {
      duration: durationMs,
      iterations: Infinity,
      easing: "linear",
      fill: "both",
    };
    const animations = [
      elapsed.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], timing),
      playhead.animate([{ transform: "translateX(0%)" }, { transform: "translateX(100%)" }], timing),
    ];
    for (const animation of animations) animation.pause();
    animationsRef.current = animations;
    sync();
    return () => {
      for (const animation of animations) animation.cancel();
      animationsRef.current = [];
    };
  }, [durationMs, sync]);

  // Play and pause land at once, not on the next sample.
  useEffect(() => {
    sync();
  }, [playing, sync]);

  useEffect(() => {
    const tick = () => {
      const frame = latestFrame();
      if (frame !== null) setFrameIndex(frame.frame.frameIndex);
      sync();
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, latestFrame, sync]);

  const fractionAt = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return 0;
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return clamp01((clientX - box.left) / box.width);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (onSeek === undefined || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = fractionAt(event.clientX);
      sync();
    },
    [fractionAt, onSeek, sync],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null) return;
      dragRef.current = fractionAt(event.clientX);
      sync();
    },
    [fractionAt, sync],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null || onSeek === undefined) return;
      const fraction = fractionAt(event.clientX);
      dragRef.current = null;
      // ONE seek per gesture (§V170) — see the note at the top of the file. The playhead
      // re-syncs to the replayed frame on the next sample.
      onSeek(frameAtFraction(range, fraction));
    },
    [fractionAt, onSeek, range],
  );

  const shownFrame = frameIndex;
  const seekable = onSeek !== undefined;

  return (
    <div className={styles.scrubber} role="group" aria-label="Timeline">
      <RangeEnd
        label="In point"
        value={range.start}
        onCommit={
          onChangeRange === undefined
            ? undefined
            : (next) => {
                // The out point must stay after the in point; the schema refuses an
                // inverted range, so clamping here is what stops the field reporting an
                // error the user cannot act on.
                if (next < range.end) onChangeRange({ start: next, end: range.end });
              }
        }
      />

      <Tooltip label="Drag to scrub — a seek replays from the start">
        <div
          ref={trackRef}
          className={cx(styles.track, seekable && styles.trackLive)}
          role="slider"
          tabIndex={seekable ? 0 : -1}
          aria-label="Playhead"
          aria-valuemin={range.start}
          aria-valuemax={range.end}
          aria-valuenow={shownFrame ?? range.start}
          aria-disabled={!seekable}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onKeyDown={(event) => {
            if (onSeek === undefined || frameIndex === null) return;
            // Both directions go through `seek`, including forward. `stepFrame` would be
            // cheaper for +1 and would ALSO advance past the out point, which is a second
            // meaning for the arrow key nobody asked for.
            const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (delta === 0) return;
            event.preventDefault();
            const next = Math.min(range.end, Math.max(range.start, frameIndex + delta));
            onSeek(next);
          }}
        >
          {/* Positioned ONLY by their Web Animations (T1259) — React must not write a style
              on these, or it would fight the compositor for the transform. */}
          <div ref={elapsedRef} className={styles.elapsed} />
          <div ref={playheadRef} className={styles.playhead} />
        </div>
      </Tooltip>

      <RangeEnd
        label="Out point"
        value={range.end}
        onCommit={
          onChangeRange === undefined
            ? undefined
            : (next) => {
                if (next > range.start) onChangeRange({ start: range.start, end: next });
              }
        }
      />
    </div>
  );
}

/**
 * One end of the range, as a bare editable number.
 *
 * Styled as text until it is hovered or focused, for the reason §V90 gives: this sits in
 * the densest strip in the app, and two boxed inputs either side of the track would read
 * as three controls competing rather than one timeline. The affordance is not lost — it
 * appears on hover, on focus and to a screen reader, which is where §V90 says it belongs.
 */
function RangeEnd({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly onCommit?: ((next: number) => void) | undefined;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const text = draft;
    setDraft(null);
    if (text === null || onCommit === undefined) return;
    const parsed = Number.parseInt(text.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onCommit(parsed);
  };

  return (
    <input
      className={styles.end}
      aria-label={label}
      inputMode="numeric"
      readOnly={onCommit === undefined}
      value={draft ?? String(value)}
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
  );
}
