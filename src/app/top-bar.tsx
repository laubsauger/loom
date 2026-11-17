import type { ReactNode } from "react";
import { Button } from "@ui/primitives/button.tsx";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { formatFps, formatMs } from "./format-metrics.ts";
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
  /** Metrics arrive from the telemetry pipe, never from the document store (V16). */
  fps?: number | null;
  gpuMs?: number | null;
  /**
   * The GPU-ms VALUE, as a slot (B172, §V16). `gpuMs` is a plain prop and no caller ever
   * supplied one, so the header's `gpu` readout rendered an em dash for the life of the
   * app — the first latency number a user looks at, permanently absent. It cannot become
   * a prop of this component either: the number changes at the telemetry hub's <= 10 Hz
   * tick and `app.tsx` must not re-render at that rate, which is the same reason
   * `performance` is a slot. A component that subscribes to the hub itself goes here.
   */
  gpuMetric?: ReactNode;
  cpuMetric?: ReactNode;
  cpuMs?: number | null;
  /** FPS and frame-clock health, sampled independently at <= 10 Hz (§V16). */
  performance?: ReactNode;
  /**
   * The timeline strip (T433), in the horizontal slack between the transport and
   * the right-hand readouts — the header's one growable element and the reason this
   * feature costs no height. A slot for the same §V16 reason `performance` is one: it
   * samples the frame loop on its own tick and must re-render alone.
   */
  scrubber?: ReactNode;
  /**
   * T1785b: the project tempo (beat lamp, BPM, Tap, source), beside the transport. A slot
   * for the same §V16 reason `scrubber` is one: the lamp runs on its own tick.
   */
  tempo?: ReactNode;
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

/**
 * Top bar: transport, timeline, fps and GPU/CPU timing (§I.ui). The capability tier is NOT here (T1256): it
 * is a fact about the device, read once, and it lives on the performance pane's GPU
 * block beside the rows that qualify it.
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
  tempo,
  fps = null,
  gpuMs = null,
  gpuMetric,
  cpuMetric,
  cpuMs = null,
  performance,
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
            className={styles.transportButton}
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
          <Button className={styles.transportButton} aria-label="Step one frame" onClick={onStep ?? undefined} disabled={!onStep}>
            <span className={styles.glyph} aria-hidden="true">
              ▶❙
            </span>
          </Button>
        </Tooltip>
        <Tooltip label="Reset time">
          <Button className={styles.transportButton} aria-label="Reset time" onClick={onResetTime ?? undefined} disabled={!onResetTime}>
            <span className={styles.glyph} aria-hidden="true">
              ↺
            </span>
          </Button>
        </Tooltip>
        <Tooltip label={looping ? "Stop looping the range" : "Loop the timeline's range"}>
          <Button
            className={styles.transportButton}
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
        {onRenderRange === undefined || renderFrames === 0 ? null : (
          <Tooltip label={rendering ? "Rendering the range…" : `Record / render output — ${String(renderFrames)} frames`}>
            <Button className={styles.transportButton} aria-label="Record / render output" aria-pressed={rendering} onClick={onRenderRange} disabled={rendering}>
              <span className={styles.glyph} aria-hidden="true">●</span>
            </Button>
          </Tooltip>
        )}
      </div>

      {tempo}

      {scrubber === undefined ? null : <div className={styles.timeline}>{scrubber}</div>}

      <div className={styles.metrics}>
        {performance}
        {performance === undefined ? (
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
            {gpuMetric ?? formatMs(gpuMs)}
          </span>
        </div>
        <div className={styles.metric} title="CPU pass-encode sum">
          <span className={styles.metricLabel}>cpu</span>
          <span className={styles.metricValue} aria-label="CPU encode time per frame">
            {cpuMetric ?? formatMs(cpuMs)}
          </span>
        </div>
      </div>

      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}
