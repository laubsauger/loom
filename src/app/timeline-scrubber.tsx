import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameRange } from "@domain/types/graph.ts";
import { frameRangeLength } from "@domain/types/graph.ts";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
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
 * Where a frame sits along the track, as 0..1.
 *
 * Pure and exported because it is the part with an off-by-one in it, and a jsdom test
 * cannot measure a box (§V339): the geometry is asserted here on numbers and in
 * `src/tests/e2e` on pixels, and neither pretends to be the other.
 */
export function fractionOfRange(range: FrameRange, frameIndex: number): number {
  const span = frameRangeLength(range) - 1;
  if (span <= 0) return 0;
  return clamp01((frameIndex - range.start) / span);
}

/** The inverse: which frame a fraction of the track points at. Always inside the range. */
export function frameAtFraction(range: FrameRange, fraction: number): number {
  const span = frameRangeLength(range) - 1;
  return range.start + Math.round(clamp01(fraction) * span);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface TimelineScrubberProps {
  /** Reads the last rendered frame. A REF read, never a subscription (§V16). */
  readonly latestFrame: () => FrameInputs | null;
  /** The document's in/out points — the ONE range (§V177). */
  readonly range: FrameRange;
  /** Runs `transport.seek`. Absent = the track is inert, because nothing can seek. */
  readonly onSeek?: ((frameIndex: number) => void) | undefined;
  /** Writes `frameRange` through `project.setSettings`. Absent = the ends are read-only. */
  readonly onChangeRange?: ((range: FrameRange) => void) | undefined;
  readonly intervalMs?: number;
}

export function TimelineScrubber({
  latestFrame,
  range,
  onSeek,
  onChangeRange,
  intervalMs = SCRUBBER_INTERVAL_MS,
}: TimelineScrubberProps) {
  /**
   * The frame the READOUT of this strip reports — `aria-valuenow` and the keyboard
   * handler's starting point. Sampled at 10 Hz (§V16). The PLAYHEAD does not come from
   * here; see `paint` below.
   */
  const [frameIndex, setFrameIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  /** Where the pointer is during a drag, as a fraction. Null when nobody is dragging. */
  const dragRef = useRef<number | null>(null);
  // Read inside the paint loop, which must never be rebuilt to pick up a new range.
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    const tick = () => {
      const frame = latestFrame();
      if (frame !== null) setFrameIndex(frame.frame.frameIndex);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, latestFrame]);

  /**
   * T456 — the playhead moves on the DISPLAY's clock, not on the readout's (§V16).
   *
   * The owner reported forward playback as "steppy" and it was: the playhead was
   * positioned from the 10 Hz sample above, so a marker crossing a 500px track over ten
   * seconds jumped five pixels at a time, ten times a second. Ten discrete positions per
   * second is below anything the eye reads as motion — that is arithmetic, not taste, and
   * no amount of easing fixes a sampling rate.
   *
   * §V16 is not bent to fix it. Its rule is that per-frame data must not enter the
   * document store or re-render the tree, and neither happens here: this writes two CSS
   * properties on two elements it owns, with no React state and no subscription, which is
   * the same escape the viewer's canvas sizing takes. React never writes these two
   * properties, so there is nothing for the two rates to fight over.
   *
   * The frame index still comes from `latestFrame()` — the frame that was actually
   * RENDERED (§V169). This reads it more often; it does not read a different clock, and a
   * stalled loop leaves the playhead exactly where the last real frame put it.
   */
  useEffect(() => {
    let handle = 0;
    const paint = (): void => {
      handle = requestAnimationFrame(paint);
      const dragging = dragRef.current;
      let fraction = dragging;
      if (fraction === null) {
        const frame = latestFrame();
        if (frame === null) return;
        fraction = fractionOfRange(rangeRef.current, frame.frame.frameIndex);
      }
      const percent = `${String(fraction * 100)}%`;
      if (elapsedRef.current !== null) elapsedRef.current.style.width = percent;
      if (playheadRef.current !== null) playheadRef.current.style.left = percent;
    };
    handle = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(handle);
  }, [latestFrame]);

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
    },
    [fractionAt, onSeek],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null) return;
      dragRef.current = fractionAt(event.clientX);
    },
    [fractionAt],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null || onSeek === undefined) return;
      const fraction = fractionAt(event.clientX);
      dragRef.current = null;
      // ONE seek per gesture (§V170) — see the note at the top of the file.
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
          {/* Positioned ONLY by `paint` above — React must not write these, or every
              re-render would snap the playhead back to a 10 Hz sample (T456). */}
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
