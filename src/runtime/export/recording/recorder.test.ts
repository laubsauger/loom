import { describe, expect, it, vi } from "vitest";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";
import { offlineTransport } from "../../execution/offline-transport.ts";
import { createExportInterface } from "../export-interface.ts";
import type { ExportInterface, ExportOutput } from "../types.ts";
import { outputRef } from "../types.ts";
import { createFrameRecorder, recordSequence } from "./recorder.ts";
import type { EncodedVideo, EncoderConfig, EncoderFrame, EncoderFrameTiming, VideoEncoderSink } from "./types.ts";

/**
 * T111's load-bearing claim is not "it produces an mp4" — it is that the mp4 contains exactly
 * the frames the graph rendered, identified by `frameIndex` (§V44, §I.frame). A recorder that
 * sampled a clock would drop and duplicate frames under load and NOTHING would notice; that
 * is the failure these tests exist to make impossible.
 */

const REF = outputRef("out1");

const OUTPUT: ExportOutput = {
  ref: REF,
  resourceId: "target:out1:out",
  width: 4,
  height: 4,
  format: "rgba8unorm",
      // Frame-identity fixture: the bytes ARE the picture, so they pass through.
      space: "encoded",
};

/** A source whose pixels encode the frame index, so a mislabelled frame is detectable. */
function frameStampedApi(current: () => number, isPlaying = () => true): ExportInterface {
  return createExportInterface({
    source: {
      read: (_target, region) => {
        const bytes = new Uint8Array(region.width * region.height * 4).fill(current() & 0xff);
        return Promise.resolve({
          width: region.width,
          height: region.height,
          format: "rgba8unorm" as const,
          rowStride: region.width * 4,
          bytes,
        });
      },
    },
    outputs: () => [OUTPUT],
    isPlaying,
  });
}

interface RecordingEncoder extends VideoEncoderSink {
  readonly frames: ReadonlyArray<EncoderFrame>;
  readonly config: EncoderConfig | null;
}

function fakeEncoder(): RecordingEncoder {
  const frames: EncoderFrame[] = [];
  let config: EncoderConfig | null = null;
  return {
    get frames() {
      return frames;
    },
    get config() {
      return config;
    },
    configure(next) {
      config = next;
    },
    encode(frame) {
      frames.push(frame);
    },
    finish(): Promise<EncodedVideo> {
      return Promise.resolve({
        mimeType: "video/mp4",
        bytes: new Uint8Array([1, 2, 3]),
        frameCount: frames.length,
        durationSeconds: frames.length / (config?.fps ?? 1),
      });
    },
  };
}

function frame(frameIndex: number, fps = 30): FrameEvaluationInput {
  return {
    timeSeconds: frameIndex / fps,
    deltaSeconds: 1 / fps,
    frameIndex,
    mode: "fixed-step",
    randomSeed: 7,
  };
}

describe("exact-frame capture", () => {
  it("captures by frameIndex, and timestamps from it rather than from elapsed time", async () => {
    let rendered = 0;
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => rendered),
      ref: REF,
      encoder,
      fps: 30,
    });

    await recorder.start();
    for (let index = 0; index < 4; index += 1) {
      rendered = index;
      await recorder.captureFrame(frame(index));
    }
    const result = await recorder.finish();

    expect(result.report.frames).toBe(4);
    expect(result.report.contiguous).toBe(true);
    expect(encoder.frames.map((f) => f.frameIndex)).toEqual([0, 1, 2, 3]);
    // Frame N lands at exactly N/fps, no matter how long the encode took.
    expect(encoder.frames.map((f) => f.timestampMicros)).toEqual([0, 33333, 66667, 100000]);
    // And each frame carries the pixels that were on screen when it was offered.
    expect(encoder.frames.map((f) => f.image.data[0])).toEqual([0, 1, 2, 3]);
  });

  it("keys the first frame and then every keyFrameInterval frames", async () => {
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder,
      fps: 30,
      keyFrameInterval: 2,
    });
    await recorder.start();
    for (let index = 0; index < 5; index += 1) await recorder.captureFrame(frame(index));
    await recorder.finish();
    expect(encoder.frames.map((f) => f.keyFrame)).toEqual([true, false, true, false, true]);
  });

  it("captures a presented frame without reading pixels back", async () => {
    const api = frameStampedApi(() => 0);
    const read = vi.fn(api.read);
    const timings: EncoderFrameTiming[] = [];
    const encoder: VideoEncoderSink = {
      configure: () => undefined,
      encode: () => { throw new Error("CPU image path must not run"); },
      encodeCapturedFrame(timing) { timings.push(timing); },
      finish: async () => ({
        mimeType: "video/mp4",
        bytes: new Uint8Array([1]),
        frameCount: timings.length,
        durationSeconds: timings.length / 30,
      }),
    };
    const recorder = createFrameRecorder({ api: { ...api, read }, ref: REF, encoder, fps: 30 });

    await recorder.start();
    await recorder.captureFrame(frame(0));
    await recorder.captureFrame(frame(1));
    await recorder.finish();

    expect(read).not.toHaveBeenCalled();
    expect(timings).toEqual([
      { frameIndex: 0, timestampMicros: 0, durationMicros: 33_333, keyFrame: true },
      { frameIndex: 1, timestampMicros: 33_333, durationMicros: 33_333, keyFrame: false },
    ]);
  });

  it("publishes a presented-frame capture failure before the caller advances", async () => {
    const encoder: VideoEncoderSink = {
      configure: () => undefined,
      encode: () => undefined,
      encodeCapturedFrame: () => { throw new Error("surface capture failed"); },
      finish: async () => ({
        mimeType: "video/mp4",
        bytes: new Uint8Array(),
        frameCount: 0,
        durationSeconds: 0,
      }),
    };
    const recorder = createFrameRecorder({ api: frameStampedApi(() => 0), ref: REF, encoder, fps: 30 });

    await recorder.start();
    await recorder.captureFrame(frame(0));

    expect(recorder.state).toBe("failed");
    expect(recorder.error?.message).toContain("surface capture failed");
    await expect(recorder.finish()).rejects.toThrow("surface capture failed");
  });

  it("stops presented-frame capture and closes the encoder on cancellation", async () => {
    const timings: EncoderFrameTiming[] = [];
    const close = vi.fn();
    const encoder: VideoEncoderSink = {
      configure: () => undefined,
      encode: () => undefined,
      encodeCapturedFrame: timing => { timings.push(timing); },
      finish: async () => ({
        mimeType: "video/mp4",
        bytes: new Uint8Array(),
        frameCount: timings.length,
        durationSeconds: timings.length / 30,
      }),
      close,
    };
    const recorder = createFrameRecorder({ api: frameStampedApi(() => 0), ref: REF, encoder, fps: 30 });

    await recorder.start();
    await recorder.captureFrame(frame(0));
    await recorder.cancel();
    await recorder.captureFrame(frame(1));

    expect(timings.map(timing => timing.frameIndex)).toEqual([0]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("drives a deterministic take straight off the frame driver's step()", async () => {
    // The offline transport is the exact-frame source (§V47/§V49). recordSequence steps and
    // captures in lockstep, so a read can never land on the next frame's pixels.
    const transport = offlineTransport({ fps: 24, seed: 3, mode: "fixed-step" });
    let rendered = -1;
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => rendered),
      ref: REF,
      encoder,
      fps: 24,
    });

    const result = await recordSequence(
      recorder,
      () => {
        const next = transport.next();
        rendered = next.frameIndex;
        return { frame: next };
      },
      3,
    );

    expect(result.report).toMatchObject({ frames: 3, firstFrameIndex: 0, lastFrameIndex: 2 });
    expect(result.video.frameCount).toBe(3);
    expect(encoder.frames.map((f) => f.image.data[0])).toEqual([0, 1, 2]);
  });

  it("configures the encoder once, at an even size, and delivers every frame at it", async () => {
    // H.264 rejects odd dimensions; a size that drifts per frame fails halfway through a take.
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: createExportInterface({
        source: {
          read: (_target, region) =>
            Promise.resolve({
              width: region.width,
              height: region.height,
              format: "rgba8unorm" as const,
              rowStride: region.width * 4,
              bytes: new Uint8Array(region.width * region.height * 4),
            }),
        },
        outputs: () => [{ ...OUTPUT, width: 101, height: 51 }],
      }),
      ref: REF,
      encoder,
      fps: 30,
      maxWidth: 33,
      maxHeight: 33,
    });
    await recorder.start();
    expect(recorder.size).toEqual([32, 16]);
    await recorder.captureFrame(frame(0));
    await recorder.captureFrame(frame(1));
    await recorder.finish();
    expect(encoder.config).toMatchObject({ width: 32, height: 16, fps: 30 });
    for (const captured of encoder.frames) {
      expect([captured.image.width, captured.image.height]).toEqual([32, 16]);
    }
  });
});

describe("a dropped or duplicated frame is DETECTABLE", () => {
  it("reports the exact indices the loop skipped, and fails the take", async () => {
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder: fakeEncoder(),
      fps: 30,
    });
    await recorder.start();
    await recorder.captureFrame(frame(0));
    await recorder.captureFrame(frame(3));

    expect(recorder.report.missing).toEqual([1, 2]);
    expect(recorder.state).toBe("failed");
    await expect(recorder.finish()).rejects.toThrow(/never offered to the recorder/i);
    expect(recorder.diagnostics[0]?.code).toBe("export/recording-frame-gap");
  });

  it("records the gap but keeps going when the caller opted out of strictness", async () => {
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder,
      fps: 30,
      strict: false,
    });
    await recorder.start();
    await recorder.captureFrame(frame(0));
    await recorder.captureFrame(frame(3));
    const result = await recorder.finish();

    // Two frames encoded, but the report refuses to call the take contiguous.
    expect(result.report.frames).toBe(2);
    expect(result.report.missing).toEqual([1, 2]);
    expect(result.report.contiguous).toBe(false);
  });

  it("encodes a repeated frame index once and reports the repeat", async () => {
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder,
      fps: 30,
      strict: false,
    });
    await recorder.start();
    await recorder.captureFrame(frame(0));
    await recorder.captureFrame(frame(1));
    await recorder.captureFrame(frame(1));
    const result = await recorder.finish();

    expect(encoder.frames.map((f) => f.frameIndex)).toEqual([0, 1]);
    expect(result.report.duplicated).toEqual([1]);
    expect(result.report.contiguous).toBe(false);
  });

  it("refuses a backwards index — a mid-take seek is not a recording", async () => {
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder: fakeEncoder(),
      fps: 30,
      strict: false,
    });
    await recorder.start();
    await recorder.captureFrame(frame(5));
    await recorder.captureFrame(frame(2));
    expect(recorder.diagnostics.map((d) => d.code)).toContain("export/recording-out-of-order");
  });

  it("detects a backlog instead of encoding stale pixels under the wrong frame number", async () => {
    // Fire-and-forget from a live loop: two frames offered before either read completed. The
    // second read would see the NEXT frame's pixels, so the take is flagged rather than
    // silently mislabelled.
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder: fakeEncoder(),
      fps: 30,
      strict: false,
    });
    await recorder.start();
    const first = recorder.captureFrame(frame(0));
    const second = recorder.captureFrame(frame(1));
    await Promise.all([first, second]);
    expect(recorder.diagnostics.map((d) => d.code)).toContain("export/recording-backlog");
  });
});

describe("recording refuses what it cannot do", () => {
  it("fails to start on an output that is not in the plan (§V59)", async () => {
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: outputRef("out1", "mask"),
      encoder: fakeEncoder(),
      fps: 30,
    });
    await expect(recorder.start()).rejects.toThrow(/no such output/i);
    expect(recorder.state).toBe("failed");
  });

  it("ignores frames offered before start or after cancel", async () => {
    const encoder = fakeEncoder();
    const recorder = createFrameRecorder({
      api: frameStampedApi(() => 0),
      ref: REF,
      encoder,
      fps: 30,
    });
    await recorder.captureFrame(frame(0));
    await recorder.start();
    await recorder.captureFrame(frame(0));
    recorder.cancel();
    await recorder.captureFrame(frame(1));
    expect(encoder.frames.map((f) => f.frameIndex)).toEqual([0]);
  });
});

/**
 * T1741b — a 10-bit encoder gets the Output's own float values, not the 8-bit RGBA every
 * other path quantises to. The source below writes a grey level between two bytes; if any
 * step of the recorder went through 8 bits, the 10-bit code would land on a multiple of
 * the 8-bit grid instead of the code the float value derives.
 */
describe("10-bit recording (T1741b)", () => {
  const FLOAT_OUTPUT: ExportOutput = { ...OUTPUT, width: 4, height: 2, format: "rgba16float", space: "encoded" };
  /** 0.25 + 3/1024 in binary16: 8 bits round it to 64/255; BT.709 limited gives Y = 286. */
  const LEVEL_BITS = (13 << 10) | 12;

  function floatApi(output: ExportOutput, reads: { count: number }): ExportInterface {
    return createExportInterface({
      source: {
        read: (_target, region) => {
          reads.count += 1;
          const rowStride = region.width * 8 + 16;
          const bytes = new Uint8Array(rowStride * region.height);
          const view = new DataView(bytes.buffer);
          for (let y = 0; y < region.height; y += 1) {
            for (let x = 0; x < region.width; x += 1) {
              for (let channel = 0; channel < 3; channel += 1) view.setUint16(y * rowStride + x * 8 + channel * 2, LEVEL_BITS, true);
              view.setUint16(y * rowStride + x * 8 + 6, 0x3c00, true);
            }
          }
          return Promise.resolve({ width: region.width, height: region.height, format: output.format, rowStride, bytes });
        },
      },
      outputs: () => [output],
    });
  }

  function tenBitEncoder() {
    const planes: Array<{ frameIndex: number; y: number[]; transfer: string }> = [];
    const encoder: VideoEncoderSink = {
      configure: vi.fn(),
      encode: vi.fn(),
      encodeYuv10(frame) {
        planes.push({
          frameIndex: frame.frameIndex,
          y: Array.from(frame.yuv.data.subarray(0, frame.yuv.width * frame.yuv.height)),
          transfer: frame.yuv.colorSpace.transfer,
        });
      },
      finish: () => Promise.resolve({ mimeType: "video/mp4", bytes: new Uint8Array(1), frameCount: planes.length, durationSeconds: 0 }),
    };
    return { encoder, planes };
  }

  it("reads the float Output and hands the encoder 10-bit planes of it, never 8-bit RGBA", async () => {
    const reads = { count: 0 };
    const { encoder, planes } = tenBitEncoder();
    const recorder = createFrameRecorder({ api: floatApi(FLOAT_OUTPUT, reads), ref: REF, encoder, fps: 30 });
    await recorder.start();
    await recorder.captureFrame(frame(0));
    await recorder.captureFrame(frame(1));
    await recorder.finish();
    expect(reads.count).toBe(2);
    expect(encoder.encode).not.toHaveBeenCalled();
    expect(planes.map((plane) => plane.frameIndex)).toEqual([0, 1]);
    // 64 + 876 × (0.25 + 3/1024) = 285.57 → 286. Through a byte it would be 64 + 876 × 64/255 = 283.9 → 284.
    expect(planes[0]!.y).toEqual(Array.from({ length: 8 }, () => 286));
    expect(planes[0]!.transfer).toBe("iec61966-2-1");
  });

  it("refuses an 8-bit Output before configuring or reading anything", async () => {
    const reads = { count: 0 };
    const { encoder } = tenBitEncoder();
    const output = { ...FLOAT_OUTPUT, format: "rgba8unorm-srgb" as const };
    const recorder = createFrameRecorder({ api: floatApi(output, reads), ref: REF, encoder, fps: 30 });
    await expect(recorder.start()).rejects.toMatchObject({
      diagnostic: { code: "export/unsupported-format", message: expect.stringContaining("rgba8unorm-srgb, which holds 8 bits") as unknown },
    });
    expect(recorder.state).toBe("failed");
    expect(encoder.configure).not.toHaveBeenCalled();
    expect(reads.count).toBe(0);
  });

  it("refuses to resample: the 10-bit path records the Output's own size", async () => {
    const { encoder } = tenBitEncoder();
    const recorder = createFrameRecorder({ api: floatApi(FLOAT_OUTPUT, { count: 0 }), ref: REF, encoder, fps: 30, maxWidth: 2 });
    await expect(recorder.start()).rejects.toThrow(/does not resample/);
    expect(encoder.configure).not.toHaveBeenCalled();
  });
});
