import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import type { Rgba8Image, TransferMode } from "../image.ts";
import type { ExportInterface, OutputRef } from "../types.ts";

/**
 * The encoder seam for realtime recording (T111).
 *
 * `VideoEncoder` is browser-only, so it is NOT named here and no module on this path imports
 * it. The recorder — the part that has to be right, because it is the part that decides which
 * frame is which — talks to this interface and is fully testable in Node with a fake sink.
 * `./webcodecs.ts` provides the real implementation and is imported by nothing in this
 * directory's barrel, so a headless build never pulls it in.
 */

export interface EncoderConfig {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate?: number;
}

export interface EncoderFrameTiming {
  /**
   * The DETERMINISTIC frame index from `FrameEvaluationInput` (§I.frame, §V44).
   *
   * This, not a clock reading, is what makes a recording reproducible: the same graph, seed
   * and frame range produce the same file. A recorder that sampled `performance.now()` would
   * drop and duplicate frames under load and there would be no way to notice.
   */
  readonly frameIndex: number;
  readonly timestampMicros: number;
  readonly durationMicros: number;
  readonly keyFrame: boolean;
}

export interface EncoderFrame extends EncoderFrameTiming {
  readonly image: Rgba8Image;
}

/** What 10-bit codes mean: written into the stream so a player decodes them as intended. */
export interface Yuv10ColorSpace {
  readonly primaries: "bt709";
  readonly transfer: "iec61966-2-1";
  readonly matrix: "bt709";
  readonly fullRange: false;
}

/**
 * One 4:2:0 frame of 10-bit codes in 16-bit samples, the layout WebCodecs calls `I420P10`
 * (T1741b). Built from a full-precision Output readback (`./yuv10.ts`), never from 8-bit
 * bytes: that is what makes a 10-bit file of it honest.
 */
export interface I420P10Image {
  readonly width: number;
  readonly height: number;
  /** Y (`width * height`), then Cb, then Cr (`width/2 * height/2` each), tightly packed. */
  readonly data: Uint16Array;
  readonly colorSpace: Yuv10ColorSpace;
}

export interface Yuv10EncoderFrame extends EncoderFrameTiming {
  readonly yuv: I420P10Image;
}

/** Browser-neutral shape of a frame captured from a GPU presentation surface. */
export interface CapturedVideoFrame {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;
  close(): void;
}

export interface EncodedVideo {
  /** e.g. `video/mp4; codecs="avc1.42001f"`. */
  readonly mimeType: string;
  readonly bytes: Uint8Array | Blob;
  /** Removes temporary disk-backed storage after the artifact has been saved. */
  readonly dispose?: (() => Promise<void>) | undefined;
  readonly frameCount: number;
  readonly durationSeconds: number;
}

/** Interleaved float PCM. Offline export currently supplies one fixed-rate mono channel. */
export interface AudioPcmTrack {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly samples: Float32Array;
}

/** A finite PCM track sampled in bounded batches instead of allocated for the whole take. */
export interface AudioPcmSource {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly totalFrames: number;
  /** Returns exactly count interleaved frames; invalid ranges throw. */
  readFrames(offset: number, count: number): Float32Array;
}

export type AudioPcmProvider = () => AudioPcmTrack | AudioPcmSource | Promise<AudioPcmTrack | AudioPcmSource>;

/** Work performed by `finish()` after the exact video frames have been collected. */
export type EncoderFinishProgress =
  | { readonly stage: "video" }
  | { readonly stage: "audio"; readonly completedFrames: number; readonly totalFrames: number }
  | { readonly stage: "finalizing" };

export interface VideoEncoderSink {
  configure(config: EncoderConfig): Promise<void> | void;
  encode(frame: EncoderFrame): Promise<void> | void;
  /** Present only when the encoder was explicitly configured with a surface capture. */
  encodeCapturedFrame?(timing: EncoderFrameTiming): Promise<void> | void;
  /**
   * Present only when the encoder writes a 10-bit format (T1741b). The recorder then reads
   * the Output at full precision and hands it 10-bit planes; `encode` and a canvas capture,
   * both 8-bit, are refused by such an encoder.
   */
  encodeYuv10?(frame: Yuv10EncoderFrame): Promise<void> | void;
  /** Flushes and muxes. Called once. */
  finish(): Promise<EncodedVideo>;
  /** Releases resources after a cancelled take. */
  close?(): Promise<void> | void;
}

export type RecorderState = "idle" | "recording" | "finishing" | "done" | "failed" | "cancelled";

/**
 * What actually got captured, frame by frame.
 *
 * Reported rather than assumed: "the encoder produced 600 frames" says nothing about whether
 * they are frames 0..599 of the graph's timeline. `missing` and `duplicated` are what make a
 * broken take detectable instead of merely wrong.
 */
export interface RecordingReport {
  readonly frames: number;
  readonly firstFrameIndex: number | null;
  readonly lastFrameIndex: number | null;
  /** Frame indices the loop skipped between the first and last captured frame. */
  readonly missing: ReadonlyArray<number>;
  /** Frame indices offered more than once. Encoded once; the repeat is recorded here. */
  readonly duplicated: ReadonlyArray<number>;
  /** True when the take is exactly `first..last` with nothing missing and nothing repeated. */
  readonly contiguous: boolean;
}

export interface RecordingResult {
  readonly video: EncodedVideo;
  readonly report: RecordingReport;
}

export interface FrameRecorderOptions {
  /** Output discovery and the sole CPU readback surface (§V48); explicit surface capture bypasses reads. */
  readonly api: ExportInterface;
  readonly ref: OutputRef;
  readonly encoder: VideoEncoderSink;
  readonly fps: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly transfer?: TransferMode;
  readonly bitrate?: number;
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  /** Key frame every N frames. 0 keys only the first. */
  readonly keyFrameInterval?: number;
  /**
   * Default true: a gap, a repeat or a backlog fails the take. A recording that silently
   * dropped frames is not a shorter recording, it is a wrong one — the whole reason capture
   * is driven by `frameIndex` is to make that distinction exist.
   */
  readonly strict?: boolean;
  /**
   * How many captures may be in flight. Default 1: with more, a slow encoder means the read
   * for frame N lands after frame N+1 has already rendered, and the file gets N+1's pixels
   * labelled as N. Detecting the backlog is the only honest option.
   */
  readonly maxInFlight?: number;
}
