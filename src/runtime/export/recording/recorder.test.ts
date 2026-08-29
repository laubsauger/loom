import { describe, expect, it } from "vitest";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";
import { offlineTransport } from "../../execution/offline-transport.ts";
import { createExportInterface } from "../export-interface.ts";
import type { ExportInterface, ExportOutput } from "../types.ts";
import { outputRef } from "../types.ts";
import { createFrameRecorder, recordSequence } from "./recorder.ts";
import type { EncodedVideo, EncoderConfig, EncoderFrame, VideoEncoderSink } from "./types.ts";

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
