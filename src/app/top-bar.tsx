import type { ReactNode } from "react";
import type { CapabilityTier } from "@domain/types/backend.ts";
import { Button } from "@ui/primitives/button.tsx";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import styles from "./top-bar.module.css";

export interface TopBarProps {
  projectName?: string;
  /** Transport state. The runtime owns it; the bar only reflects and requests. */
  playing?: boolean;
  onPlayPause?: (() => void) | undefined;
  onStep?: (() => void) | undefined;
  onResetTime?: (() => void) | undefined;
  /**
   * T433: loop the timeline's range. A playback MODE, so it sits with play and step
   * rather than with the range it cycles — the range is the document's and lives on the
   * scrubber.
   */
  onToggleLoop?: (() => void) | undefined;
  looping?: boolean;
  /**
   * T452: audio feature capture. Arming is a deliberate act the user takes, never
   * always-on — so it needs a control, and this is where a user looks for "capture what
   * is playing". Omitted, no button renders: a session with no audio to record must not
   * grow a control that can only refuse.
   */
  onToggleAudioTrack?: (() => void) | undefined;
  onSaveAudioTrack?: (() => void) | undefined;
  recordingAudioTrack?: boolean;
  audioTrackFrames?: number;
  /** Metrics arrive from the telemetry pipe, never from the document store (V16). */
  fps?: number | null;
  gpuMs?: number | null;
  tier?: CapabilityTier | null;
  /**
   * Frame / time / fps (T265). A slot rather than props: the readout samples the frame
   * loop at its own <= 10 Hz tick, so it must own its state and re-render alone (§V16).
   */
  timeline?: ReactNode;
  /**
   * The timeline strip (T433), in the horizontal SLACK between the centred transport and
   * the right-hand readouts — the header's one growable element and the reason this
   * feature costs no height. A slot for the same §V16 reason `timeline` is one: it
   * samples the frame loop on its own tick and must re-render alone.
   */
  scrubber?: ReactNode;
  /**
   * T433: render the timeline's range out. Omitted, no button renders — a session with no
   * device has nothing to render and must not grow a control that can only refuse.
   */
  onRenderRange?: (() => void) | undefined;
  rendering?: boolean;
  /** Frames the current range would produce, for the control's tooltip. */
  renderFrames?: number;
  /** Extra trailing chrome (the shell puts its layout menu here). */
  trailing?: ReactNode;
}

const EM_DASH = "—";

function formatFps(fps: number | null | undefined): string {
  return typeof fps === "number" && Number.isFinite(fps) ? fps.toFixed(1) : EM_DASH;
}

function formatMs(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? `${ms.toFixed(2)} ms` : EM_DASH;
}

/**
 * Top bar: transport, fps, GPU ms, capability tier (§I.ui).
 * Every control is a real button with an accessible name and a tooltip, so the
 * bar is fully operable from the keyboard (V19).
 */
export function TopBar({
  projectName = "untitled",
  playing = false,
  onPlayPause,
  onStep,
  onResetTime,
  onToggleLoop,
  looping = false,
  onRenderRange,
  rendering = false,
  renderFrames = 0,
  scrubber,
  onToggleAudioTrack,
  onSaveAudioTrack,
  recordingAudioTrack = false,
  audioTrackFrames = 0,
  fps = null,
  gpuMs = null,
  tier = null,
  timeline,
  trailing,
}: TopBarProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.mark}>loom</span>
        <span className={styles.project}>{projectName}</span>
      </div>

      <div className={styles.transport} role="group" aria-label="Transport">
        <Tooltip label={playing ? "Pause" : "Play"}>
          <Button
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            onClick={onPlayPause ?? undefined}
            disabled={!onPlayPause}
          >
            <span className={styles.glyph} aria-hidden="true">
              {playing ? "❙❙" : "▶"}
            </span>
          </Button>
        </Tooltip>
        <Tooltip label="Step one frame">
          <Button aria-label="Step one frame" onClick={onStep ?? undefined} disabled={!onStep}>
            <span className={styles.glyph} aria-hidden="true">
              ▶❙
            </span>
          </Button>
        </Tooltip>
        <Tooltip label="Reset time">
          <Button aria-label="Reset time" onClick={onResetTime ?? undefined} disabled={!onResetTime}>
            <span className={styles.glyph} aria-hidden="true">
              ↺
            </span>
          </Button>
        </Tooltip>
        <Tooltip label={looping ? "Stop looping the range" : "Loop the timeline's range"}>
          <Button
            aria-label="Loop the range"
            aria-pressed={looping}
            onClick={onToggleLoop ?? undefined}
            disabled={!onToggleLoop}
          >
            <span className={cx(styles.glyph, looping && styles.glyphLive)} aria-hidden="true">
              ⟳
            </span>
          </Button>
        </Tooltip>
        {onToggleAudioTrack === undefined ? null : (
          <Tooltip
            label={
              recordingAudioTrack
                ? `Stop recording audio features — ${String(audioTrackFrames)} frames`
                : "Record audio features to a track"
            }
          >
            <Button
              aria-label={recordingAudioTrack ? "Stop recording audio features" : "Record audio features"}
              aria-pressed={recordingAudioTrack}
              onClick={onToggleAudioTrack}
            >
              <span className={cx(styles.glyph, recordingAudioTrack && styles.dotLive)} aria-hidden="true">
                ●
              </span>
            </Button>
          </Tooltip>
        )}
        {onSaveAudioTrack === undefined || audioTrackFrames === 0 ? null : (
          <Tooltip label={`Save the recorded track — ${String(audioTrackFrames)} frames`}>
            <Button aria-label="Save audio track" onClick={onSaveAudioTrack}>
              <span className={styles.glyph} aria-hidden="true">
                ⤓
              </span>
            </Button>
          </Tooltip>
        )}
        <span className={styles.state}>
          <span className={cx(styles.dot, playing && styles.dotLive)} aria-hidden="true" />
          {playing ? "live" : "idle"}
        </span>
      </div>

      {scrubber === undefined ? null : (
        <div className={styles.timeline}>
          {scrubber}
          {/* Hidden, not disabled, when there is nothing to render (§V90, and the rule
              T452's audio controls already follow): a graph with no Output cannot produce
              a file, and a permanently greyed word in the densest strip in the app is one
              more thing to read past. It appears the moment an Output node does. */}
          {onRenderRange === undefined || renderFrames === 0 ? null : (
            <Tooltip
              label={
                rendering
                  ? "Rendering the range…"
                  : `Render the range out — ${String(renderFrames)} frames`
              }
            >
              <Button aria-label="Render the range" onClick={onRenderRange} disabled={rendering}>
                <span className={styles.renderLabel}>{rendering ? "…" : "render"}</span>
              </Button>
            </Tooltip>
          )}
        </div>
      )}

      <div className={styles.metrics}>
        {timeline}
        {timeline === undefined ? (
          <div className={styles.metric}>
            <span className={styles.metricLabel}>fps</span>
            <span className={styles.metricValue} aria-label="Frames per second">
              {formatFps(fps)}
            </span>
          </div>
        ) : null}
        <div className={styles.metric}>
          <span className={styles.metricLabel}>gpu</span>
          <span className={styles.metricValue} aria-label="GPU time per frame">
            {formatMs(gpuMs)}
          </span>
        </div>
        <Tooltip label="Detected WebGPU capability tier. Baseline is B.">
          <span className={cx(styles.tier, tier !== null && styles.tierKnown)} tabIndex={0}>
            tier {tier ?? EM_DASH}
          </span>
        </Tooltip>
      </div>

      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}
