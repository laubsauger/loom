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

export interface EncoderFrame {
  readonly image: Rgba8Image;
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

export interface EncodedVideo {
  /** e.g. `video/mp4; codecs="avc1.42001f"`. */
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly frameCount: number;
  readonly durationSeconds: number;
}

export interface VideoEncoderSink {
  configure(config: EncoderConfig): Promise<void> | void;
  encode(frame: EncoderFrame): Promise<void> | void;
  /** Flushes and muxes. Called once. */
  finish(): Promise<EncodedVideo>;
  /** Releases resources after a cancelled take. */
  close?(): void;
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
  /** The sole readback surface (§V48). The recorder has no other way to see a pixel. */
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
