import type { VideoEncoderSink } from "./types.ts";

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
  readonly codec?: string;
  readonly bitrate?: number;
  readonly latencyMode?: "quality" | "realtime";
}

export async function loadVideoEncoder(
  options: LoadEncoderOptions = {},
): Promise<VideoEncoderSink | null> {
  if (!isRecordingAvailable()) return null;
  const module = await import("./webcodecs.ts");
  return module.createWebCodecsEncoder(options);
}
