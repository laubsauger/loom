/**
 * The export interface — the sole readback surface (T68, §V48).
 *
 * Everything in the system is GPU-to-GPU by construction (§V7): previews, the viewer, the
 * frame loop. Readback is the one operation that stalls the pipeline, so it is confined to
 * this module, where the rules about WHEN it may happen and the descriptor it must return
 * (§V60) can be enforced in one place and audited in one place. If readback leaks anywhere
 * else, §V7 stops being enforceable.
 *
 * Deliberately NOT exported here: `./recording/webcodecs.ts`. It is the only browser-only
 * module in the track, and keeping it out of the barrel is what makes this barrel importable
 * in Node, in a worker and in CI. Reach it through `loadVideoEncoder()`.
 */

export {
  DEFAULT_OUTPUT_PORT,
  ExportDiagnosticCode,
  ExportError,
  exportDiagnostic,
  outputRef,
  outputRefKey,
  sameOutputRef,
} from "./types.ts";
export type {
  ExportDiagnosticCodeValue,
  ExportFile,
  ExportInterface,
  ExportInterfaceOptions,
  ExportOutput,
  ExportStats,
  FileSink,
  OutputRef,
  ReadbackImage,
  ReadbackReason,
  ReadbackRegion,
  ReadbackSource,
  ReadOptions,
  ResolvedOutputLike,
} from "./types.ts";

export { MAX_LIVE_INSPECT_PIXELS, createExportInterface, createPixelProbe } from "./export-interface.ts";

export {
  READBACK_ROW_ALIGNMENT,
  alignedRowStride,
  clampRegion,
  cropReadback,
  exportOutputsFrom,
  fullRegion,
  inferRowStride,
  readbackSourceFromBackend,
} from "./outputs.ts";

export { BYTES_PER_PIXEL, clamp01, decodeHalf, linearToSrgb, srgbToLinear } from "./pixel-format.ts";

export {
  autoTransfer,
  boundedSize,
  decodeToLinear,
  encodePlaneToRgba8,
  resizePlane,
  toRgba8,
  toRgba8At,
} from "./image.ts";
export type { Plane, Rgba8Image, ToRgba8Options, TransferMode } from "./image.ts";

export { encodeBase64, encodePng } from "./png.ts";
export type { PngImage } from "./png.ts";

export {
  DEFAULT_PREVIEW_MAX_EDGE,
  capturePng,
  captureFileName,
  captureToFile,
  renderPreviewPng,
  saveCapture,
} from "./screenshot.ts";
export type { CaptureOptions, CapturedImage } from "./screenshot.ts";

export { createFrameRecorder, recordSequence } from "./recording/recorder.ts";
export type { FrameRecorder } from "./recording/recorder.ts";
export type {
  EncodedVideo,
  EncoderConfig,
  EncoderFrame,
  FrameRecorderOptions,
  RecorderState,
  RecordingReport,
  RecordingResult,
  VideoEncoderSink,
} from "./recording/types.ts";

export { avcCodecString, muxMp4, sampleDurationFor, timescaleFor } from "./recording/mp4-muxer.ts";
export type { Mp4MuxInput, Mp4Sample } from "./recording/mp4-muxer.ts";

export { isRecordingAvailable, loadVideoEncoder } from "./recording/encoder-loader.ts";
export type { LoadEncoderOptions } from "./recording/encoder-loader.ts";
export {
  createPointsReadback,
  type PointSetInfo,
  type PointsReadback,
  type PointsWindow,
  type PointsWindowRequest,
} from "./points.ts";
