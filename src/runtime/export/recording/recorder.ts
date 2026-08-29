import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { boundedSize, toRgba8At } from "../image.ts";
import type { ExportOutput } from "../types.ts";
import { ExportDiagnosticCode, ExportError, exportDiagnostic, outputRefKey } from "../types.ts";
import type {
  FrameRecorderOptions,
  RecorderState,
  RecordingReport,
  RecordingResult,
} from "./types.ts";

/**
 * Exact-frame recording (T111, §V48).
 *
 * The frame driver already supplies a `FrameEvaluationInput` with a deterministic
 * `frameIndex` (§I.frame, §V44) — that is what makes a recording reproducible, and it is
 * what this recorder keys on. Nothing here reads a clock. Timestamps are computed from
 * `frameIndex / fps`, so frame N lands at exactly N/fps in the file no matter how long the
 * encode took, and a gap in the indices is a gap the recording REPORTS rather than a gap it
 * papers over by sliding the next frame earlier.
 *
 * Two structural details that are not obvious:
 *
 *  - Every capture is deferred by at least one microtask and serialised through a queue. The
 *    backend runs `loop()` callbacks with a GPU frame open, and readback inside an open frame
 *    trips the frame guard (§V8); the hop lets the frame close first. It also keeps encode
 *    order equal to capture order.
 *  - `captureFrame` never rejects. It is designed to be called from a frame-loop hook that
 *    cannot await, where a rejection would become an unhandled rejection and the take would
 *    fail invisibly. Failures land in `state`/`error` and surface from `finish()`.
 */

interface Capture {
  readonly frameIndex: number;
  readonly keyFrame: boolean;
}

export interface FrameRecorder {
  readonly state: RecorderState;
  readonly report: RecordingReport;
  readonly error: ExportError | null;
  /** Everything that went wrong, in order. Empty on a clean take. */
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /** Encode size, fixed at `start()`. Every frame is delivered at exactly this size. */
  readonly size: readonly [number, number] | null;
  start(): Promise<void>;
  /**
   * Offers one rendered frame. Hand this the SAME `FrameEvaluationInput` the frame driver
   * rendered with — not a copy made later, and never a clock reading.
   */
  captureFrame(frame: FrameEvaluationInput): Promise<void>;
  finish(): Promise<RecordingResult>;
  cancel(): void;
}

export function createFrameRecorder(options: FrameRecorderOptions): FrameRecorder {
  const strict = options.strict ?? true;
  const maxInFlight = options.maxInFlight ?? 1;
  const keyFrameInterval = options.keyFrameInterval ?? 60;

  let state: RecorderState = "idle";
  let error: ExportError | null = null;
  let output: ExportOutput | null = null;
  let size: readonly [number, number] | null = null;

  let frames = 0;
  let firstFrameIndex: number | null = null;
  let lastFrameIndex: number | null = null;
  const missing: number[] = [];
  const duplicated: number[] = [];

  let inFlight = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const diagnostics: RuntimeDiagnostic[] = [];

  function fail(diagnostic: RuntimeDiagnostic): void {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
    if (error === null) error = new ExportError(diagnostic);
    if (strict) state = "failed";
  }

  function currentReport(): RecordingReport {
    return {
      frames,
      firstFrameIndex,
      lastFrameIndex,
      missing: [...missing],
      duplicated: [...duplicated],
      contiguous:
        missing.length === 0 &&
        duplicated.length === 0 &&
        (frames === 0 ||
          (firstFrameIndex !== null &&
            lastFrameIndex !== null &&
            lastFrameIndex - firstFrameIndex + 1 === frames)),
    };
  }

  /**
   * Sequencing, decided synchronously at the moment the frame is offered.
   *
   * It has to be synchronous: by the time a deferred read runs, other frames may already have
   * been offered, and the order in which captures were OFFERED is the order the graph
   * rendered them in. Returns null when the frame is not to be encoded.
   */
  function note(frame: FrameEvaluationInput): Capture | null {
    const index = frame.frameIndex;
    if (lastFrameIndex !== null) {
      if (index === lastFrameIndex) {
        duplicated.push(index);
        fail(
          exportDiagnostic(
            "error",
            ExportDiagnosticCode.recordingDuplicateFrame,
            `Frame ${index} was offered twice while recording "${outputRefKey(options.ref)}". ` +
              `A duplicated frame means the loop rendered the same frame input twice, which ` +
              `breaks the one-to-one mapping between frameIndex and encoded frame (§V44).`,
          ),
        );
        return null;
      }
      if (index < lastFrameIndex) {
        fail(
          exportDiagnostic(
            "error",
            ExportDiagnosticCode.recordingOutOfOrder,
            `Frame ${index} arrived after frame ${lastFrameIndex}. Recording captures the ` +
              `render loop in order; a backwards index means the transport was reset or ` +
              `seeked mid-take.`,
          ),
        );
        return null;
      }
      if (index > lastFrameIndex + 1) {
        for (let gap = lastFrameIndex + 1; gap < index; gap += 1) missing.push(gap);
        fail(
          exportDiagnostic(
            "error",
            ExportDiagnosticCode.recordingFrameGap,
            `Frames ${lastFrameIndex + 1}..${index - 1} were never offered to the recorder. ` +
              `The loop dropped them; the file would play them back as if they had never ` +
              `existed, which is exactly the failure exact-frame capture exists to prevent.`,
          ),
        );
        if (strict) return null;
      }
    } else {
      firstFrameIndex = index;
    }
    lastFrameIndex = index;
    const keyFrame = frames === 0 || (keyFrameInterval > 0 && frames % keyFrameInterval === 0);
    return { frameIndex: index, keyFrame };
  }

  async function run(capture: Capture): Promise<void> {
    if (state !== "recording" || size === null) return;
    const [width, height] = size;
    // Reason "recording" is what tells the export interface this read is expected to happen
    // while the loop runs (§V7). It is counted, not waved through.
    const image = await options.api.read(options.ref, { reason: "recording" });
    const rgba = toRgba8At(image, width, height, options.transfer ?? "auto");
    const micros = 1_000_000 / options.fps;
    await options.encoder.encode({
      image: rgba,
      frameIndex: capture.frameIndex,
      // Derived from the frame index, never from elapsed time: this is the whole point.
      timestampMicros: Math.round(capture.frameIndex * micros),
      durationMicros: Math.round(micros),
      keyFrame: capture.keyFrame,
    });
    frames += 1;
  }

  return {
    get state() {
      return state;
    },
    get report() {
      return currentReport();
    },
    get error() {
      return error;
    },
    get diagnostics() {
      return diagnostics;
    },
    get size() {
      return size;
    },

    async start() {
      if (state !== "idle") throw new Error(`Recorder cannot start from state "${state}".`);
      const found = options.api.describe(options.ref);
      if (!found) {
        const diagnostic = exportDiagnostic(
          "error",
          ExportDiagnosticCode.unknownOutput,
          `Cannot record "${outputRefKey(options.ref)}": no such output in the current plan.`,
          { nodeId: options.ref.nodeId, portId: options.ref.portId },
        );
        error = new ExportError(diagnostic);
        state = "failed";
        throw error;
      }
      output = found;
      const [width, height] = boundedSize(
        output.width,
        output.height,
        options.maxWidth ?? output.width,
        options.maxHeight ?? output.height,
      );
      // H.264 macroblocks are 16x16 and chroma is subsampled; odd dimensions are rejected or
      // silently padded depending on the encoder. Rounding down here keeps the size the
      // recorder promises and the size the encoder gets identical.
      size = [Math.max(2, width - (width % 2)), Math.max(2, height - (height % 2))];
      await options.encoder.configure({
        width: size[0],
        height: size[1],
        fps: options.fps,
        ...(options.bitrate === undefined ? {} : { bitrate: options.bitrate }),
      });
      state = "recording";
    },

    captureFrame(frame) {
      if (state !== "recording") return Promise.resolve();
      const capture = note(frame);
      if (!capture) return Promise.resolve();

      inFlight += 1;
      if (inFlight > maxInFlight) {
        fail(
          exportDiagnostic(
            "error",
            ExportDiagnosticCode.recordingBacklog,
            `Recording fell behind at frame ${capture.frameIndex}: ${inFlight} captures in ` +
              `flight with a limit of ${maxInFlight}. A capture that completes after the next ` +
              `frame has rendered encodes the WRONG pixels under the right frame number.`,
          ),
        );
      }

      const task = queue.then(() => run(capture)).then(
        () => {
          inFlight -= 1;
        },
        (cause: unknown) => {
          inFlight -= 1;
          fail(
            cause instanceof ExportError
              ? cause.diagnostic
              : exportDiagnostic(
                  "error",
                  ExportDiagnosticCode.recordingFailed,
                  `Capturing frame ${capture.frameIndex} failed: ${String(cause)}`,
                ),
          );
        },
      );
      queue = task;
      return task;
    },

    async finish() {
      if (state === "idle") throw new Error("Recorder was never started.");
      if (state === "cancelled") throw new Error("Recorder was cancelled.");
      state = state === "failed" ? "failed" : "finishing";
      await queue;
      const video = await options.encoder.finish();
      const result: RecordingResult = { video, report: currentReport() };
      if (state === "failed") {
        // The bytes are still handed back inside the error's context via `report`, but a
        // strict take that lost frames must not be returned as if it were a clean one.
        throw (
          error ??
          new ExportError(
            exportDiagnostic(
              "error",
              ExportDiagnosticCode.recordingFailed,
              "Recording failed; see diagnostics.",
            ),
          )
        );
      }
      state = "done";
      return result;
    },

    cancel() {
      state = "cancelled";
      options.encoder.close?.();
    },
  };
}

/**
 * Deterministic capture: step the driver, capture, repeat (§V47).
 *
 * This is the exact path. `step()` renders exactly one frame synchronously and returns the
 * inputs it rendered with, so awaiting the capture between steps makes it impossible for a
 * read to land on the wrong frame's pixels. Driven by `offlineTransport`, the same graph and
 * seed produce a byte-identical file every run.
 *
 * `step` is typed structurally so `FrameDriver.step` satisfies it without this module
 * importing the execution track.
 */
export async function recordSequence(
  recorder: FrameRecorder,
  step: () => { readonly frame: FrameEvaluationInput } | null,
  frameCount: number,
): Promise<RecordingResult> {
  await recorder.start();
  for (let index = 0; index < frameCount; index += 1) {
    const inputs = step();
    if (!inputs) break;
    await recorder.captureFrame(inputs.frame);
  }
  return recorder.finish();
}
