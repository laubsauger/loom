import { ExportDiagnosticCode, ExportError, exportDiagnostic } from "../types.ts";
import { avcCodecString, muxMp4, sampleDurationFor, timescaleFor } from "./mp4-muxer.ts";
import type { Mp4Sample } from "./mp4-muxer.ts";
import type { EncodedVideo, EncoderConfig, EncoderFrame, VideoEncoderSink } from "./types.ts";

/**
 * The WebCodecs encoder — the ONLY browser-only module in `src/runtime/export/**` (T111).
 *
 * It is deliberately not re-exported from `../index.ts`. A headless build, a Node test or a
 * worker without WebCodecs imports the export interface, the PNG path and the recorder
 * without this file ever being resolved; a consumer that wants realtime recording imports it
 * explicitly, or reaches it through `loadWebCodecsEncoder()`, which resolves it dynamically so
 * even a bundler-level reference is optional.
 *
 * `VideoEncoder` and `VideoFrame` are read off `globalThis`, not off `window`: the runtime is
 * lint-banned from `window`/`document` (§V63 / T92) precisely so it can move into a worker,
 * and WebCodecs is available there. Nothing in this file touches the DOM.
 *
 * Chrome ≥128 is the baseline (§C decided), which guarantees WebCodecs — so the availability
 * check exists for headless and for worker contexts, not as a fallback ladder to
 * MediaRecorder. There is no MediaRecorder stopgap, by decision.
 */

export function isWebCodecsAvailable(): boolean {
  const scope = globalThis as { VideoEncoder?: unknown; VideoFrame?: unknown };
  return typeof scope.VideoEncoder === "function" && typeof scope.VideoFrame === "function";
}

export interface WebCodecsEncoderOptions {
  /** Default: H.264 baseline, level 4.0 — the most broadly decodable choice. */
  readonly codec?: string;
  readonly bitrate?: number;
  readonly latencyMode?: "quality" | "realtime";
}

function unavailable(detail: string): ExportError {
  return new ExportError(
    exportDiagnostic(
      "error",
      ExportDiagnosticCode.encoderUnavailable,
      `WebCodecs video encoding is unavailable: ${detail}`,
      {
        suggestion:
          "Recording requires WebCodecs (Chrome/Edge ≥128, the §C baseline). There is no " +
          "MediaRecorder fallback by decision — it cannot capture exact frames.",
      },
    ),
  );
}

export function createWebCodecsEncoder(options: WebCodecsEncoderOptions = {}): VideoEncoderSink {
  const codec = options.codec ?? "avc1.42002a";

  let encoder: VideoEncoder | null = null;
  let config: EncoderConfig | null = null;
  let description: Uint8Array | null = null;
  let failure: unknown = null;
  const samples: Mp4Sample[] = [];
  let sampleDuration = 0;

  return {
    async configure(next) {
      if (!isWebCodecsAvailable()) throw unavailable("VideoEncoder is not defined in this context.");
      config = next;
      sampleDuration = sampleDurationFor(next.fps);
      const encoderConfig: VideoEncoderConfig = {
        codec,
        width: next.width,
        height: next.height,
        framerate: next.fps,
        // "avc" (length-prefixed) rather than annex-B: an avcC record is what an MP4 sample
        // entry needs, and annex-B output simply does not report one.
        avc: { format: "avc" },
        latencyMode: options.latencyMode ?? "quality",
        ...(next.bitrate === undefined
          ? { bitrate: options.bitrate ?? estimateBitrate(next) }
          : { bitrate: next.bitrate }),
      };

      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (support.supported !== true) {
        throw unavailable(
          `no encoder for ${codec} at ${next.width}x${next.height}. Try a lower resolution or a baseline profile.`,
        );
      }

      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const described = metadata?.decoderConfig?.description;
          if (described && description === null) description = toBytes(described);
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          samples.push({
            bytes,
            keyFrame: chunk.type === "key",
            duration: sampleDuration,
          });
        },
        error: (cause) => {
          failure = cause;
        },
      });
      encoder.configure(encoderConfig);
    },

    encode(frame: EncoderFrame) {
      if (!encoder) throw new Error("Encoder used before configure().");
      if (failure) throw failure;
      const video = new VideoFrame(frame.image.data, {
        format: "RGBA",
        codedWidth: frame.image.width,
        codedHeight: frame.image.height,
        timestamp: frame.timestampMicros,
        duration: frame.durationMicros,
      });
      try {
        encoder.encode(video, { keyFrame: frame.keyFrame });
      } finally {
        // A VideoFrame holds a GPU/media resource until closed. Leaking them stalls the
        // encoder within a few dozen frames.
        video.close();
      }
      // Backpressure: the recorder's in-flight limit governs readback, but the encoder has
      // its own queue, and letting it grow unbounded is how a long take runs out of memory.
      return encoder.encodeQueueSize > 8 ? drain(encoder) : undefined;
    },

    async finish(): Promise<EncodedVideo> {
      if (!encoder || !config) throw new Error("Encoder finished before configure().");
      await encoder.flush();
      encoder.close();
      encoder = null;
      if (failure) throw failure;
      if (description === null) {
        throw unavailable("the encoder never reported an avcC decoder description.");
      }
      const bytes = muxMp4({
        width: config.width,
        height: config.height,
        timescale: timescaleFor(config.fps),
        samples,
        codecDescription: description,
      });
      return {
        mimeType: `video/mp4; codecs="${avcCodecString(description)}"`,
        bytes,
        frameCount: samples.length,
        durationSeconds: samples.length / config.fps,
      };
    },

    close() {
      try {
        encoder?.close();
      } catch {
        // Closing an already-errored encoder throws; the take is being abandoned anyway.
      }
      encoder = null;
    },
  };
}

function toBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  const view = source as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function drain(encoder: VideoEncoder): Promise<void> {
  return encoder.flush();
}

/** ~0.12 bits per pixel per frame — a defensible default for screen-captured graphics. */
function estimateBitrate(config: EncoderConfig): number {
  return Math.round(config.width * config.height * config.fps * 0.12);
}
