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
  /** Metrics arrive from the telemetry pipe, never from the document store (V16). */
  fps?: number | null;
  gpuMs?: number | null;
  tier?: CapabilityTier | null;
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
  fps = null,
  gpuMs = null,
  tier = null,
  trailing,
}: TopBarProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.mark}>shaderloom</span>
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
        <span className={styles.state}>
          <span className={cx(styles.dot, playing && styles.dotLive)} aria-hidden="true" />
          {playing ? "live" : "idle"}
        </span>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>fps</span>
          <span className={styles.metricValue} aria-label="Frames per second">
            {formatFps(fps)}
          </span>
        </div>
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
