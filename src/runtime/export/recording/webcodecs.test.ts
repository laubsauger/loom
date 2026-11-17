import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebCodecsEncoder, h264CodecFor, probeWebCodecsEncoder } from "./webcodecs.ts";

afterEach(() => vi.unstubAllGlobals());

it("selects an H.264 level that can describe the requested production size class", () => {
  expect(h264CodecFor({ width: 1920, height: 1080, fps: 60 })).toBe("avc1.42002a");
  expect(h264CodecFor({ width: 3840, height: 2160, fps: 60 })).toBe("avc1.640034");
});

it("encodes only explicitly configured captured VideoFrames and always closes them", async () => {
  const encoded: Array<{ readonly frame: FakeVideoFrame; readonly keyFrame: boolean }> = [];
  let failEncode = false;
  class FakeVideoFrame {
    readonly close = vi.fn();
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly timestamp: number;
    readonly duration: number | null;
    constructor(codedWidth: number, codedHeight: number, timestamp: number, duration: number | null) {
      this.codedWidth = codedWidth;
      this.codedHeight = codedHeight;
      this.timestamp = timestamp;
      this.duration = duration;
    }
  }
  class FakeVideoEncoder {
    static isConfigSupported = async (config: VideoEncoderConfig) => ({ supported: true, config });
    readonly encodeQueueSize = 0;
    configure(): void {}
    encode(frame: FakeVideoFrame, options: VideoEncoderEncodeOptions): void {
      if (failEncode) throw new Error("native encode failed");
      encoded.push({ frame, keyFrame: options.keyFrame ?? false });
    }
    flush(): Promise<void> { return Promise.resolve(); }
    close(): void {}
  }
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);

  const timing = { frameIndex: 4, timestampMicros: 66_667, durationMicros: 16_667, keyFrame: true };
  let captured = new FakeVideoFrame(4, 2, timing.timestampMicros, timing.durationMicros);
  const direct = createWebCodecsEncoder({ spool: "memory", captureFrame: () => captured });
  await direct.configure({ width: 4, height: 2, fps: 60 });
  expect(direct.encodeCapturedFrame).toBeTypeOf("function");
  await direct.encodeCapturedFrame?.(timing);
  expect(encoded).toEqual([{ frame: captured, keyFrame: true }]);
  expect(captured.close).toHaveBeenCalledOnce();

  const cpuOnly = createWebCodecsEncoder({ spool: "memory" });
  expect(cpuOnly.encodeCapturedFrame).toBeUndefined();

  const invalid = { codedWidth: 4, codedHeight: 2, timestamp: timing.timestampMicros,
    duration: timing.durationMicros, close: vi.fn() };
  const invalidEncoder = createWebCodecsEncoder({ spool: "memory", captureFrame: () => invalid });
  await invalidEncoder.configure({ width: 4, height: 2, fps: 60 });
  expect(() => invalidEncoder.encodeCapturedFrame?.(timing)).toThrow(/did not return a VideoFrame/);
  expect(invalid.close).toHaveBeenCalledOnce();

  captured = new FakeVideoFrame(8, 2, timing.timestampMicros, timing.durationMicros);
  expect(() => direct.encodeCapturedFrame?.(timing)).toThrow(/encoder requires 4x2/);
  expect(captured.close).toHaveBeenCalledOnce();

  captured = new FakeVideoFrame(4, 2, timing.timestampMicros + 1, timing.durationMicros);
  expect(() => direct.encodeCapturedFrame?.(timing)).toThrow(/does not match 66667 microseconds/);
  expect(captured.close).toHaveBeenCalledOnce();

  captured = new FakeVideoFrame(4, 2, timing.timestampMicros, timing.durationMicros);
  failEncode = true;
  expect(() => direct.encodeCapturedFrame?.(timing)).toThrow("native encode failed");
  expect(captured.close).toHaveBeenCalledOnce();

  await direct.close?.();
  await invalidEncoder.close?.();
});

it("interrupts captured-frame backpressure and closes the acquired frame", async () => {
  let releaseFlush!: () => void;
  const stalledFlush = new Promise<void>(resolve => { releaseFlush = resolve; });
  const closeEncoder = vi.fn();
  class FakeVideoFrame {
    readonly close = vi.fn();
    readonly codedWidth = 3840;
    readonly codedHeight = 2160;
    readonly timestamp = 0;
    readonly duration = 16_667;
  }
  class FakeVideoEncoder {
    static isConfigSupported = async (config: VideoEncoderConfig) => ({ supported: true, config });
    readonly encodeQueueSize = 2;
    configure(): void {}
    encode(): void {}
    flush(): Promise<void> { return stalledFlush; }
    close(): void { closeEncoder(); }
  }
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);

  const controller = new AbortController();
  const captured = new FakeVideoFrame();
  const captureFrame = vi.fn(() => captured);
  const encoder = createWebCodecsEncoder({
    spool: "memory",
    signal: controller.signal,
    captureFrame,
  });
  await encoder.configure({ width: 3840, height: 2160, fps: 60 });

  const encoding = encoder.encodeCapturedFrame?.({
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  expect(captured.close).toHaveBeenCalledOnce();
  controller.abort();
  await expect(encoding).rejects.toMatchObject({ name: "AbortError" });

  expect(() => encoder.encodeCapturedFrame?.({
    frameIndex: 1,
    timestampMicros: 16_667,
    durationMicros: 16_667,
    keyFrame: false,
  })).toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(captureFrame).toHaveBeenCalledOnce();

  await encoder.close?.();
  expect(closeEncoder).toHaveBeenCalledOnce();
  releaseFlush();
});

it("encodes supplied PCM as AAC and returns one MP4 with video and sound tracks", async () => {
  let stalledVideoFlush: Promise<void> | null = null;
  let stalledVideoFlushStarted = false;
  class FakeVideoFrame {
    close(): void {}
  }
  class FakeVideoEncoder {
    static isConfigSupported = async (config: VideoEncoderConfig) => ({ supported: true, config });
    readonly encodeQueueSize = 0;
    private readonly init: VideoEncoderInit;
    constructor(init: VideoEncoderInit) { this.init = init; }
    configure(): void {}
    encode(): void {
      this.init.output({
        byteLength: 3,
        type: "key",
        copyTo: (target: AllowSharedBufferSource) => new Uint8Array(target as ArrayBuffer).set([1, 2, 3]),
      } as EncodedVideoChunk, {
        decoderConfig: { codec: "avc1.42002a", description: Uint8Array.from([1, 0x42, 0, 0x2a]) },
      });
    }
    flush(): Promise<void> {
      if (stalledVideoFlush !== null) stalledVideoFlushStarted = true;
      return stalledVideoFlush ?? Promise.resolve();
    }
    close(): void {}
  }
  class FakeAudioData {
    close(): void {}
  }
  const audioEncoders: FakeAudioEncoder[] = [];
  class FakeAudioEncoder extends EventTarget {
    static isConfigSupported = async (config: AudioEncoderConfig) => ({ supported: true, config });
    private readonly init: AudioEncoderInit;
    encodeQueueSize = 0;
    state = "configured";
    flushes = 0;
    maxQueue = 0;
    constructor(init: AudioEncoderInit) { super(); this.init = init; audioEncoders.push(this); }
    configure(): void {}
    encode(): void {
      this.encodeQueueSize++;
      this.maxQueue = Math.max(this.maxQueue, this.encodeQueueSize);
      queueMicrotask(() => {
        this.encodeQueueSize--;
        this.init.output({
          byteLength: 2,
          duration: 21_333,
          copyTo: (target: AllowSharedBufferSource) => new Uint8Array(target as ArrayBuffer).set([4, 5]),
        } as EncodedAudioChunk, {
          decoderConfig: {
            codec: "mp4a.40.2",
            sampleRate: 48_000,
            numberOfChannels: 1,
            description: Uint8Array.from([0x11, 0x90]),
          },
        });
        this.dispatchEvent(new Event("dequeue"));
      });
    }
    flush(): Promise<void> { this.flushes++; return Promise.resolve(); }
    close(): void { this.state = "closed"; }
  }
  class FakeAudioDecoder {
    private readonly init: AudioDecoderInit;
    constructor(init: AudioDecoderInit) { this.init = init; }
    configure(): void {}
    decode(): void {
      this.init.output({
        numberOfFrames: 1024,
        copyTo: (target: AllowSharedBufferSource) => {
          const samples = target instanceof Float32Array ? target : new Float32Array(target as ArrayBuffer);
          samples[0] = 1;
        },
        close: () => undefined,
      } as unknown as AudioData);
    }
    flush(): Promise<void> { return Promise.resolve(); }
    close(): void {}
  }
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  vi.stubGlobal("AudioDecoder", FakeAudioDecoder);

  const reads: Array<readonly [number, number]> = [];
  const progress: string[] = [];
  const spoolBytes: number[] = [];
  const yieldControl = vi.fn(async () => undefined);
  const encoder = createWebCodecsEncoder({
    spool: "memory",
    onFinishProgress: update => progress.push(update.stage),
    onSpoolProgress: bytes => spoolBytes.push(bytes),
    yieldControl,
    audio: () => ({
      sampleRate: 48_000,
      channelCount: 1,
      totalFrames: 70 * 1024 + 452,
      readFrames(offset, count) {
        reads.push([offset, count]);
        return new Float32Array(count);
      },
    }),
  });
  await encoder.configure({ width: 2, height: 2, fps: 60 });
  await encoder.encode({
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  const video = await encoder.finish();

  expect(video.mimeType).toContain("mp4a.40.2");
  const bytes = video.bytes instanceof Blob
    ? new Uint8Array(await video.bytes.arrayBuffer())
    : video.bytes;
  expect(new TextDecoder("latin1").decode(bytes)).toContain("soun");
  expect(video.frameCount).toBe(1);
  expect(reads).toHaveLength(71);
  expect(reads.at(-1)).toEqual([70 * 1024, 452]);
  expect(audioEncoders.map(instance => instance.flushes)).toEqual([1, 1]);
  expect(audioEncoders[1]!.maxQueue).toBe(32);
  expect(progress[0]).toBe("video");
  expect(progress).toContain("audio");
  expect(progress.at(-1)).toBe("finalizing");
  expect(yieldControl.mock.calls.length).toBeGreaterThan(2);
  expect(spoolBytes.length).toBeGreaterThan(1);
  expect(spoolBytes.every((bytes, index) => index === 0 || bytes > (spoolBytes[index - 1] ?? 0))).toBe(true);

  const controller = new AbortController();
  const cancelledEncoder = createWebCodecsEncoder({
    spool: "memory",
    signal: controller.signal,
    audio: () => ({
      sampleRate: 48_000,
      channelCount: 1,
      totalFrames: 1024,
      readFrames: (_offset, count) => new Float32Array(count),
    }),
    onFinishProgress(update) {
      if (update.stage === "audio") controller.abort();
    },
    yieldControl: async () => undefined,
  });
  await cancelledEncoder.configure({ width: 2, height: 2, fps: 60 });
  await cancelledEncoder.encode({
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  await expect(cancelledEncoder.finish()).rejects.toMatchObject({ name: "AbortError" });
  await cancelledEncoder.close?.();

  let releaseVideoFlush!: () => void;
  stalledVideoFlush = new Promise<void>(resolve => { releaseVideoFlush = resolve; });
  const videoController = new AbortController();
  const stalledEncoder = createWebCodecsEncoder({
    spool: "memory",
    signal: videoController.signal,
  });
  await stalledEncoder.configure({ width: 2, height: 2, fps: 60 });
  await stalledEncoder.encode({
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  const finishing = stalledEncoder.finish();
  await Promise.resolve();
  expect(stalledVideoFlushStarted).toBe(true);
  videoController.abort();
  await expect(finishing).rejects.toMatchObject({ name: "AbortError" });
  await stalledEncoder.close?.();
  releaseVideoFlush();
});

/**
 * T1741b — the format reaches the browser as the codec and bitstream shape it names, and a
 * 10-bit encoder takes only 10-bit planes. The fake below records what it was configured
 * with and what each frame was constructed from, because those are the two things the real
 * VideoEncoder decides the file by.
 */
describe("recording formats (T1741b)", () => {
  /** Chrome 157's hvcC for a 1080p Main 10 take (measured), so finish() muxes a real record. */
  const CHROME_HVCC = Uint8Array.from(
    ("010220000000b000000000007bf000fcfdfafa00000f03a00001001840010c01ffff022000000300b00000030000" +
      "03007b1b0240a10001002a420101022000000300b0000003000003007ba003c0801107cad881bb916452ffcb9fc4" +
      "fea6a020202010a2000100074401c072f05324").match(/../g)!.map((pair) => parseInt(pair, 16)),
  );

  function stubWebCodecs(supported: (config: VideoEncoderConfig) => boolean = () => true) {
    const asked: VideoEncoderConfig[] = [];
    const configured: VideoEncoderConfig[] = [];
    const frames: Array<{ data: unknown; init: VideoFrameBufferInit; closed: boolean }> = [];
    class FakeVideoFrame {
      readonly record: { data: unknown; init: VideoFrameBufferInit; closed: boolean };
      constructor(data: unknown, init: VideoFrameBufferInit) {
        this.record = { data, init, closed: false };
        frames.push(this.record);
      }
      close(): void { this.record.closed = true; }
    }
    class FakeVideoEncoder {
      static isConfigSupported = async (config: VideoEncoderConfig) => {
        asked.push(config);
        return { supported: supported(config), config };
      };
      readonly encodeQueueSize = 0;
      private readonly init: VideoEncoderInit;
      constructor(init: VideoEncoderInit) { this.init = init; }
      configure(config: VideoEncoderConfig): void { configured.push(config); }
      encode(): void {
        this.init.output({
          byteLength: 4,
          type: "key",
          copyTo: (target: AllowSharedBufferSource) => new Uint8Array(target as ArrayBuffer).set([0, 0, 0, 0]),
        } as EncodedVideoChunk, {
          decoderConfig: { codec: configured.at(-1)!.codec, description: configured.at(-1)!.codec.startsWith("hvc1") ? CHROME_HVCC : Uint8Array.from([1, 0x64, 0, 0x2a]) },
        });
      }
      flush(): Promise<void> { return Promise.resolve(); }
      close(): void {}
    }
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
    vi.stubGlobal("navigator", { storage: { getDirectory: () => undefined } });
    return { asked, configured, frames };
  }

  const yuv = (width: number, height: number) => ({
    width,
    height,
    data: Uint16Array.from({ length: width * height * 1.5 }, (_value, index) => 64 + (index % 877)),
    colorSpace: { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false } as const,
  });

  it("configures HEVC Main 10 as length-prefixed HEVC with an hvcC record, never as H.264", async () => {
    const { configured } = stubWebCodecs();
    const encoder = createWebCodecsEncoder({ spool: "memory", format: "hevc-main10" });
    await encoder.configure({ width: 1920, height: 1080, fps: 60 });
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({ codec: "hvc1.2.4.L123.B0", hevc: { format: "hevc" } });
    expect(configured[0]).not.toHaveProperty("avc");
    await encoder.close?.();
  });

  it("configures H.264 High as High profile, still with an avcC record", async () => {
    const { configured } = stubWebCodecs();
    const encoder = createWebCodecsEncoder({ spool: "memory", format: "h264-high" });
    await encoder.configure({ width: 1920, height: 1080, fps: 60 });
    expect(configured[0]).toMatchObject({ codec: "avc1.64002a", avc: { format: "avc" } });
    expect(configured[0]).not.toHaveProperty("hevc");
    await encoder.close?.();
  });

  it("hands HEVC Main 10 the 10-bit planes as I420P10, tagged, and closes every frame", async () => {
    const { frames } = stubWebCodecs();
    const encoder = createWebCodecsEncoder({ spool: "memory", format: "hevc-main10" });
    await encoder.configure({ width: 4, height: 2, fps: 60 });
    const planes = yuv(4, 2);
    await encoder.encodeYuv10?.({ yuv: planes, frameIndex: 0, timestampMicros: 0, durationMicros: 16_667, keyFrame: true });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe(planes.data);
    expect(frames[0]!.init).toMatchObject({
      format: "I420P10", codedWidth: 4, codedHeight: 2, timestamp: 0, duration: 16_667,
      colorSpace: { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false },
    });
    expect(frames[0]!.closed).toBe(true);
    await expect(async () => encoder.encodeYuv10?.({ yuv: yuv(2, 2), frameIndex: 1, timestampMicros: 16_667, durationMicros: 16_667, keyFrame: false }))
      .rejects.toThrow(/encoder requires 4x2/);
    await encoder.close?.();
  });

  it("muxes an HEVC take into an hvc1 MP4 and names the codec the record carries", async () => {
    stubWebCodecs();
    const encoder = createWebCodecsEncoder({ spool: "memory", format: "hevc-main10" });
    await encoder.configure({ width: 4, height: 2, fps: 60 });
    await encoder.encodeYuv10?.({ yuv: yuv(4, 2), frameIndex: 0, timestampMicros: 0, durationMicros: 16_667, keyFrame: true });
    const video = await encoder.finish();
    expect(video.mimeType).toBe('video/mp4; codecs="hvc1.2.4.L123.B0"');
    const bytes = video.bytes instanceof Blob ? new Uint8Array(await video.bytes.arrayBuffer()) : video.bytes;
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("hvc1");
    expect(text).toContain("hvcC");
    expect(text).not.toContain("avcC");
  });

  it("refuses 8-bit input into a 10-bit format, at the cause", async () => {
    stubWebCodecs();
    // The canvas capture is 8-bit: a 10-bit encoder built over it would label 8 bits as 10.
    expect(() => createWebCodecsEncoder({
      spool: "memory", format: "hevc-main10",
      captureFrame: () => ({ codedWidth: 2, codedHeight: 2, timestamp: 0, duration: 0, close() {} }),
    })).toThrow(/canvas holds 8 bits/);
    const encoder = createWebCodecsEncoder({ spool: "memory", format: "hevc-main10" });
    await encoder.configure({ width: 2, height: 2, fps: 60 });
    expect(() => encoder.encode({ image: { width: 2, height: 2, data: new Uint8Array(16) }, frameIndex: 0, timestampMicros: 0, durationMicros: 16_667, keyFrame: true }))
      .toThrow(/takes 10-bit planes/);
    await encoder.close?.();
  });

  it("offers the 10-bit entry point only to a 10-bit format", () => {
    stubWebCodecs();
    expect(createWebCodecsEncoder({ spool: "memory", format: "hevc-main10" }).encodeYuv10).toBeTypeOf("function");
    expect(createWebCodecsEncoder({ spool: "memory", format: "h264-high" }).encodeYuv10).toBeUndefined();
    expect(createWebCodecsEncoder({ spool: "memory" }).encodeYuv10).toBeUndefined();
  });

  it("probes the format's own codec and explains a refusal with the format's own sentence", async () => {
    // Chrome's default answer (measured, 157 and 151): Main 10 unsupported, H.264 supported.
    const { asked } = stubWebCodecs((config) => !config.codec.startsWith("hvc1.2.4"));
    const support = await probeWebCodecsEncoder({ width: 1920, height: 1080, fps: 60 }, { spool: "memory", format: "hevc-main10" });
    expect(asked.at(-1)).toMatchObject({ codec: "hvc1.2.4.L123.B0", hevc: { format: "hevc" } });
    expect(support).toEqual({
      supported: false,
      codec: "hvc1.2.4.L123.B0",
      reason: expect.stringContaining("--enable-features=PlatformHEVCHbdEncoderSupport") as unknown,
    });
    await expect(probeWebCodecsEncoder({ width: 1920, height: 1080, fps: 60 }, { spool: "memory", format: "h264-high" }))
      .resolves.toEqual({ supported: true, codec: "avc1.64002a", reason: null });

    const encoder = createWebCodecsEncoder({ spool: "memory", format: "hevc-main10" });
    await expect(encoder.configure({ width: 1920, height: 1080, fps: 60 })).rejects.toMatchObject({
      diagnostic: { code: "export/encoder-unavailable", message: expect.stringContaining("no HEVC Main 10 encoder") as unknown },
    });
  });
});
