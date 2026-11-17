import type { CapturedVideoFrame, EncoderFrameTiming, VideoEncoderSink } from "./types.ts";
import type { AudioPcmProvider, EncoderConfig, EncoderFinishProgress } from "./types.ts";
import type { MediaSpoolMode } from "./media-spool.ts";
import type { VideoFormatId } from "./video-format.ts";

/**
 * The WebCodecs/headless boundary, in one file.
 *
 * `./webcodecs.ts` is the only module in the export track that names a browser-only API, and
 * nothing imports it statically — not the barrel, not the recorder, not this file. The import
 * below is dynamic and guarded, so:
 *
 *  - a headless run (Node, CI, the parity harness) resolves the export interface, the PNG
 *    path and the recorder with the encoder module never loaded at all;
 *  - a bundler splits it into its own chunk, downloaded only when a recording starts;
 *  - a worker without WebCodecs gets `null` instead of a throw at import time.
 *
 * `null` means "recording is not available here", which is the honest answer. It is NOT a cue
 * to fall back to `MediaRecorder`: that samples a stream on a clock and cannot capture exact
 * frames, and the locked decision (§C recording) rules it out explicitly.
 */
export function isRecordingAvailable(): boolean {
  const scope = globalThis as { VideoEncoder?: unknown; VideoFrame?: unknown };
  return typeof scope.VideoEncoder === "function" && typeof scope.VideoFrame === "function";
}

export interface LoadEncoderOptions {
  /** T1741b: the recording format; absent is H.264 (`DEFAULT_VIDEO_FORMAT`). */
  readonly format?: VideoFormatId;
  readonly codec?: string;
  readonly bitrate?: number;
  readonly latencyMode?: "quality" | "realtime";
  /** Captures the already-presented output without a GPU-to-CPU readback. */
  readonly captureFrame?: ((timing: EncoderFrameTiming) => CapturedVideoFrame) | undefined;
  /** When present, the flushed H.264 take is muxed with this deterministic PCM source. */
  readonly audio?: AudioPcmProvider;
  readonly audioBitrate?: number;
  /** Explicit test seam. Production uses disk-backed OPFS and never falls back silently. */
  readonly spool?: MediaSpoolMode;
  /** Reports work performed after all video frames have been collected. */
  readonly onFinishProgress?: ((progress: EncoderFinishProgress) => void) | undefined;
  /** Encoded media bytes durably appended to temporary disk storage. */
  readonly onSpoolProgress?: ((writtenBytes: number) => void) | undefined;
  /** Lets the app yield a browser task while CPU-heavy finishing work continues. */
  readonly yieldControl?: (() => Promise<void>) | undefined;
  /** Cancels queued video flush, soundtrack encoding, or MP4 finalization. */
  readonly signal?: AbortSignal | undefined;
}

export interface VideoEncoderSupport {
  readonly supported: boolean;
  readonly codec: string;
  readonly reason: string | null;
}

export type AudioEncoderSupport = VideoEncoderSupport;

export async function probeVideoEncoderSupport(
  config: EncoderConfig,
  options: LoadEncoderOptions = {},
): Promise<VideoEncoderSupport> {
  const module = await import("./webcodecs.ts");
  return module.probeWebCodecsEncoder(config, options);
}

export async function probeAudioEncoderSupport(): Promise<AudioEncoderSupport> {
  const module = await import("./webcodecs.ts");
  return module.probeWebCodecsAudioEncoder();
}

export async function loadVideoEncoder(
  options: LoadEncoderOptions = {},
): Promise<VideoEncoderSink | null> {
  if (!isRecordingAvailable()) return null;
  const module = await import("./webcodecs.ts");
  return module.createWebCodecsEncoder(options);
}
