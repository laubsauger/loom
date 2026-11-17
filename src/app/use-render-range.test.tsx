// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "@domain/types/graph.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { EncoderFrame, ExportInterface, LoadEncoderOptions, VideoEncoderSink } from "@runtime/export/index.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { transportHolderFor } from "./transport-commands.ts";
import { useRenderRange } from "./use-render-range.ts";
import { renderRangeHolderFor } from "./render-range.ts";
import { drainNativeViewerOutputs, registerNativeViewerOutput, trackNativeViewerDrain } from "./native-viewer-outputs.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

/**
 * T586 — THE WIRING GUARD for the render-time honest edge.
 *
 * T645 WIDENED IT: the same seam now carries §V329's whole property, so the guard below
 * covers a WEBCAM document too — the case T644 found, where the warning was a correct
 * decision that structurally could not reach a live camera.
 *
 * `nonReproducibleRenderWarning` is proven at exact text in
 * `domain/render/reproducibility.test.ts`. That
 * is the DECISION, and a correct decision with no construction site is the failure this
 * repo keeps catching (§V220): `renderFrameRange` has accepted an `onDiagnostic` callback
 * since T433 and NOTHING has ever passed one, so a warning built perfectly and never
 * emitted would have looked exactly like this feature working.
 *
 * So this file asserts the seam and only the seam: a take over a document holding a
 * free-run media node comes back with the warning ON THE SESSION, where `app.tsx` folds it
 * into the problems pane — and a take over a locked one comes back with nothing. The
 * second half is what makes the first mean something (§V461).
 *
 * It also pins the two properties that decide whether this is a warning or a refusal: the
 * take still RENDERS (the owner approved free run; forcing the lock would hand back a
 * different take), and the diagnostic is `severity: "warning"`, not `"error"`.
 */

function unusedCapture() {
  return { captureFrame: () => { throw new Error("This test injects a CPU encoder"); }, dispose() {} };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["success", "failure", "cancel", "unavailable"] as const)("owns canvas capture through %s without reading pixels", async outcome => {
  const { bus } = createHarness();
  let current = 0;
  transportHolderFor(bus).current = {
    isPlaying: () => false, togglePlay() {}, resetAbsoluteClock() {}, resetState() {},
    seek: (frame: number) => { current = frame; return frame; },
    stepOnce: () => frameInputs(++current),
  } as never;
  const api = fakeExports();
  const read = vi.fn(api.read);
  const dispose = vi.fn();
  const captureFrame = vi.fn((timing: { timestampMicros: number; durationMicros: number }) => ({
    codedWidth: 2, codedHeight: 2, timestamp: timing.timestampMicros, duration: timing.durationMicros, close() {},
  }));
  const write = vi.fn(async () => ({ kind: "cancelled" as const }));
  const releasePreparation = vi.fn();
  const view = renderHook(() => useRenderRange({
    createCapture: () => ({ captureFrame, dispose }),
    beforeRender: async () => releasePreparation,
    bus, exports: { ...api, read }, compiled: COMPILED, graph: graphWith("timeline"),
    registry: REGISTRY, settings: SETTINGS, latestFrame: () => frameInputs(current), name: () => "test", write,
    loadEncoder: async options => outcome === "unavailable" ? null : ({
      ...fakeEncoder(),
      encodeCapturedFrame(timing) {
        options!.captureFrame!(timing).close();
        if (outcome === "failure") throw new Error("Capture failed");
        if (outcome === "cancel") renderRangeHolderFor(bus).current?.cancel?.();
      },
    }),
  }));
  let result: unknown;
  await act(async () => { result = await bus.execute("export.renderRange", {}, contextFor(alice)); });
  expect(read).not.toHaveBeenCalled();
  expect(captureFrame).toHaveBeenCalledTimes(outcome === "success" ? 3 : outcome === "unavailable" ? 0 : 1);
  expect(dispose).toHaveBeenCalledOnce();
  expect(releasePreparation).toHaveBeenCalledOnce();
  expect(view.result.current.rendering).toBe(false);
  expect(write).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
  if (outcome === "failure") expect(view.result.current.diagnostics.some(d => d.message.includes("Capture failed"))).toBe(true);
  if (outcome === "unavailable") expect(result).toMatchObject({
    status: "rejected", diagnostics: [{ code: "export.encoderUnavailable" }],
  });
});

it("VN71: renders a range past 10 000 frames (the old timeline limit), and refuses only past one day at the project rate", async () => {
  const { bus } = createHarness();
  let current = 0;
  const seeks: number[] = [];
  transportHolderFor(bus).current = {
    isPlaying: () => false, togglePlay() {}, resetAbsoluteClock() {}, resetState() {},
    seek: (frame: number) => { seeks.push(frame); current = frame; return frame; },
    stepOnce: () => frameInputs(++current),
  } as never;
  const take = (frameRange: { start: number; end: number }) => {
    const view = renderHook(() => useRenderRange({
      createCapture: unusedCapture, bus, exports: fakeExports(), compiled: COMPILED, graph: graphWith("timeline"),
      registry: REGISTRY, settings: { ...SETTINGS, fps: 60, frameRange }, latestFrame: () => frameInputs(current),
      name: () => "test", write: async () => ({ kind: "cancelled" }), loadEncoder: async () => fakeEncoder(),
    }));
    return view;
  };
  // Three minutes and a bit at 60 fps: the piece T1687b could not hold.
  const long = take({ start: 10_998, end: 11_000 });
  let result: unknown;
  await act(async () => { result = await renderRangeHolderFor(bus).current!.render(); });
  expect(result).toMatchObject({ kind: "rendered", frames: 3 });
  expect(seeks).toEqual([10_998]);
  long.unmount();

  const day = 86_400 * 60;
  take({ start: 0, end: day });
  await act(async () => { result = await renderRangeHolderFor(bus).current!.render(); });
  expect(result).toMatchObject({
    kind: "refused",
    diagnostic: { code: "export.renderRangeOutsideTimeline", message: expect.stringContaining("one day at 60 fps") as unknown },
  });
});

it("refuses odd render dimensions before audio preparation or capture allocation", async () => {
  const { bus } = createHarness();
  const createCapture = vi.fn(unusedCapture);
  const prepareAudio = vi.fn(async () => null);
  const view = renderHook(() => useRenderRange({
    createCapture, prepareAudio, bus, exports: fakeExports(), compiled: COMPILED,
    graph: graphWith("timeline"), registry: REGISTRY,
    settings: { ...SETTINGS, outputResolution: { width: 641, height: 480 } },
    latestFrame: () => frameInputs(0), name: () => "test", write: async () => ({ kind: "cancelled" }),
  }));
  let result: unknown;
  await act(async () => { result = await renderRangeHolderFor(bus).current!.render(); });
  expect(result).toMatchObject({ kind: "refused", diagnostic: { code: "export.invalidVideoSize" } });
  expect(createCapture).not.toHaveBeenCalled();
  expect(prepareAudio).not.toHaveBeenCalled();
  expect(view.result.current.rendering).toBe(false);
});

it("uses output-frame units after an FPS change while preserving time during the change itself", () => {
  const { bus } = createHarness();
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: { ...SETTINGS, fps: 60, frameRange: { start: 0, end: 128 } },
    latestFrame: () => frameInputs(0),
    name: () => "test",
    write: async () => ({ kind: "cancelled" }),
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
  }));

  expect(view.result.current.frames).toBe(129);
  act(() => view.result.current.setRenderSettings({ outputFps: 30 }));
  expect(view.result.current.renderSettings.range).toEqual({ start: 0, end: 64 });
  expect(view.result.current.frames).toBe(65);
  act(() => view.result.current.setRenderSettings({ range: { start: 0, end: 128 } }));
  expect(view.result.current.frames).toBe(129);
});

it("offers the selected render dimensions in the destination filename", async () => {
  let suggestedName: string | undefined;
  vi.stubGlobal("showSaveFilePicker", async (options: { suggestedName?: string }) => {
    suggestedName = options.suggestedName;
    return {
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
  });
  const { bus } = createHarness();
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: SETTINGS,
    latestFrame: () => frameInputs(0),
    name: () => "take.loom.json",
  }));
  await act(async () => {
    await view.result.current.prepareDestination();
  });
  expect(suggestedName).toBe("take.2x2.0-2.mp4");
});

it("reports throughput from only the latest 32 completed output frames", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { bus } = createHarness();
  let current = 0;
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek: (frame: number) => { current = frame; return frame; },
    stepOnce: () => frameInputs(++current),
  } as never;
  let finishEntered!: () => void;
  let releaseFinish!: () => void;
  const entered = new Promise<void>(resolve => { finishEntered = resolve; });
  const heldFinish = new Promise<Awaited<ReturnType<VideoEncoderSink["finish"]>>>(resolve => {
    releaseFinish = () => resolve({
      mimeType: "video/mp4",
      bytes: new Uint8Array([1]),
      frameCount: 68,
      durationSeconds: 68 / 60,
    });
  });
  const encoder = fakeEncoder();
  encoder.finish = () => {
    finishEntered();
    return heldFinish;
  };
  const exports = fakeExports();
  let reads = 0;
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: {
      ...exports,
      read: async () => {
        reads += 1;
        now += reads <= 36 ? 10 : 500;
        return {
          width: 2,
          height: 2,
          format: "rgba8unorm" as const,
          rowStride: 8,
          bytes: new Uint8Array(16),
        };
      },
    },
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: { ...SETTINGS, frameRange: { start: 0, end: 67 } },
    latestFrame: () => frameInputs(current),
    name: () => "test",
    loadEncoder: async () => encoder,
    write: async () => ({ kind: "cancelled" }),
  }));

  let pending!: Promise<unknown>;
  await act(async () => { pending = bus.execute("export.renderRange", {}, contextFor(alice)); });
  await act(async () => { await entered; });

  expect(view.result.current.progress).toMatchObject({ stage: "frames", completedFrames: 68 });
  expect(view.result.current.recentFramesPerSecond).toBeCloseTo(2);
  expect(view.result.current.elapsedMilliseconds).toBe(16_360);

  await act(async () => { releaseFinish(); await pending; });
});

it("blocks the take and awaits output shutdown before evaluating its first frame", async () => {
  const { bus } = createHarness();
  const seek = vi.fn((frame: number) => frame);
  transportHolderFor(bus).current = { isPlaying: () => false, togglePlay() {}, resetAbsoluteClock() {}, resetState() {}, seek,
    stepOnce: () => frameInputs(1) } as never;
  let release!: () => void;
  const beforeRender = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  let releaseViewer!: () => void;
  const backend = {} as LoomBackend;
  const viewerDrain = new Promise<void>(resolve => { releaseViewer = resolve; });
  const stopViewer = vi.fn(() => trackNativeViewerDrain(backend, viewerDrain));
  registerNativeViewerOutput(backend, stopViewer);
  renderHook(() => useRenderRange({
    createCapture: unusedCapture, bus, exports: fakeExports(), compiled: COMPILED, graph: graphWith("timeline"),
    registry: REGISTRY, settings: { ...SETTINGS, frameRange: { start: 0, end: 0 } }, latestFrame: () => frameInputs(0),
    name: () => "test", beforeRender: async () => { await Promise.all([beforeRender(), drainNativeViewerOutputs(backend)]); }, loadEncoder: async () => fakeEncoder(),
    write: async () => ({ kind: "cancelled" }) }));
  let pending!: Promise<unknown>;
  await act(async () => { pending = bus.execute("export.renderRange", {}, contextFor(alice)); });
  expect(beforeRender).toHaveBeenCalledOnce();
  expect(stopViewer).toHaveBeenCalledOnce();
  expect(renderRangeHolderFor(bus).current!.busy()).toBe(true);
  expect(seek).not.toHaveBeenCalled();
  await act(async () => { release(); });
  expect(seek).not.toHaveBeenCalled();
  await act(async () => { releaseViewer(); await pending; });
  expect(seek).toHaveBeenCalledTimes(1); // Seek to the render in point; cleanup must not replay the timeline.
  expect(renderRangeHolderFor(bus).current!.busy()).toBe(false);
  beforeRender.mockRejectedValueOnce(new Error("GPU shutdown failed"));
  await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });
  expect(seek).toHaveBeenCalledTimes(1);
  expect(renderRangeHolderFor(bus).current!.busy()).toBe(false);
});

it("cancels an active take and restores hook state without saving a partial file", async () => {
  const { bus } = createHarness();
  const seek = vi.fn((frame: number) => frame);
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek,
    stepOnce: () => frameInputs(1),
  } as never;
  let release!: () => void;
  let entered!: () => void;
  const beforeRenderEntered = new Promise<void>((resolve) => { entered = resolve; });
  const beforeRender = () => new Promise<void>((resolve) => {
    release = resolve;
    entered();
  });
  const write = vi.fn(async () => ({
    kind: "saved" as const,
    fileName: "partial.mp4",
    method: "download" as const,
  }));
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: SETTINGS,
    latestFrame: () => frameInputs(0),
    name: () => "test",
    beforeRender,
    loadEncoder: async () => fakeEncoder(),
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
    write,
  }));

  let pending!: Promise<unknown>;
  await act(async () => {
    pending = bus.execute("export.renderRange", {}, contextFor(alice));
  });
  await act(async () => { await beforeRenderEntered; });
  expect(view.result.current.rendering).toBe(true);

  await act(async () => {
    view.result.current.cancel();
    release();
    await pending;
  });

  expect(view.result.current.rendering).toBe(false);
  expect(renderRangeHolderFor(bus).current?.busy()).toBe(false);
  expect(seek).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("passes deterministic range audio to the MP4 encoder", async () => {
  const { bus } = createHarness();
  let current = 0;
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek: (frame: number) => { current = frame; return frame; },
    stepOnce: () => frameInputs(++current),
  } as never;
  const pcm = vi.fn(() => ({
    sampleRate: 48_000,
    channelCount: 1,
    samples: new Float32Array(800),
  }));
  const close = vi.fn();
  const loadEncoder = vi.fn(async (options: LoadEncoderOptions = {}) => {
    const encoder = fakeEncoder();
    const finish = encoder.finish;
    encoder.finish = async () => {
      await options.audio?.();
      return finish();
    };
    return encoder;
  });
  renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: { ...SETTINGS, frameRange: { start: 0, end: 0 } },
    latestFrame: () => frameInputs(0),
    name: () => "test",
    audioRequirement: () => ({ kind: "required" }),
    prepareAudio: async () => ({ pcm, close }),
    loadEncoder,
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
    probeAudioEncoder: async () => ({ supported: true, codec: "mp4a.40.2", reason: null }),
    write: async () => ({ kind: "cancelled" }),
  }));

  await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });
  expect(loadEncoder).toHaveBeenCalledWith(expect.objectContaining({
    audio: pcm,
    onFinishProgress: expect.any(Function),
    yieldControl: expect.any(Function),
    signal: expect.any(AbortSignal),
  }));
  expect(pcm).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("renders video-only when audio is excluded, even if the source is not reproducible", async () => {
  const { bus } = createHarness();
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek: (frame: number) => frame,
    stepOnce: () => frameInputs(1),
  } as never;
  const prepareAudio = vi.fn();
  const probeAudioEncoder = vi.fn();
  const loadEncoder = vi.fn(async () => fakeEncoder());
  const restoreAudioMonitor = vi.fn();
  const muteAudioMonitor = vi.fn(() => restoreAudioMonitor);
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith(),
    registry: REGISTRY,
    settings: { ...SETTINGS, frameRange: { start: 0, end: 0 } },
    latestFrame: () => frameInputs(0),
    name: () => "test",
    audioRequirement: () => ({ kind: "invalid", reason: "Audio File In must be Locked to Timeline." }),
    prepareAudio,
    muteAudioMonitor,
    loadEncoder,
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
    probeAudioEncoder,
    write: async () => ({ kind: "cancelled" }),
  }));

  expect(view.result.current.includeAudio).toBe(true);
  act(() => view.result.current.setIncludeAudio(false));
  expect(view.result.current.includeAudio).toBe(false);
  await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });

  expect(prepareAudio).not.toHaveBeenCalled();
  expect(probeAudioEncoder).not.toHaveBeenCalled();
  expect(loadEncoder).toHaveBeenCalledWith(expect.objectContaining({
    onFinishProgress: expect.any(Function),
    yieldControl: expect.any(Function),
    signal: expect.any(AbortSignal),
  }));
  expect(muteAudioMonitor).toHaveBeenCalledOnce();
  expect(restoreAudioMonitor).toHaveBeenCalledOnce();
});

it("awaits timeline-file analysis for video-only reactivity without encoding its PCM", async () => {
  const { bus } = createHarness();
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek: (frame: number) => frame,
    stepOnce: () => frameInputs(1),
  } as never;
  const pcm = vi.fn(() => ({
    sampleRate: 48_000,
    channelCount: 1,
    samples: new Float32Array(800),
  }));
  const close = vi.fn();
  const prepareAudio = vi.fn(async () => ({ pcm, close }));
  const loadEncoder = vi.fn(async () => fakeEncoder());
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: { ...SETTINGS, frameRange: { start: 0, end: 0 } },
    latestFrame: () => frameInputs(0),
    name: () => "test",
    audioRequirement: () => ({ kind: "required" }),
    prepareAudio,
    loadEncoder,
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
    probeAudioEncoder: async () => ({ supported: true, codec: "mp4a.40.2", reason: null }),
    write: async () => ({ kind: "cancelled" }),
  }));

  act(() => view.result.current.setIncludeAudio(false));
  await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });

  expect(prepareAudio).toHaveBeenCalledOnce();
  expect(loadEncoder).toHaveBeenCalledWith(expect.objectContaining({
    onFinishProgress: expect.any(Function),
    yieldControl: expect.any(Function),
    signal: expect.any(AbortSignal),
  }));
  expect(pcm).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("releases prepared audio after an encoder failure so monitoring can be restored", async () => {
  const { bus } = createHarness();
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek: (frame: number) => frame,
    stepOnce: () => frameInputs(1),
  } as never;
  const close = vi.fn();
  const restoreAudioMonitor = vi.fn();
  renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: fakeExports(),
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: { ...SETTINGS, frameRange: { start: 0, end: 0 } },
    latestFrame: () => frameInputs(0),
    name: () => "test",
    audioRequirement: () => ({ kind: "required" }),
    prepareAudio: async () => ({ pcm: () => ({
      sampleRate: 48_000,
      channelCount: 1,
      samples: new Float32Array(800),
    }), close }),
    muteAudioMonitor: () => restoreAudioMonitor,
    loadEncoder: async () => { throw new Error("encoder failed"); },
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
    probeAudioEncoder: async () => ({ supported: true, codec: "mp4a.40.2", reason: null }),
    write: async () => ({ kind: "cancelled" }),
  }));

  await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });
  expect(close).toHaveBeenCalledOnce();
  expect(restoreAudioMonitor).toHaveBeenCalledOnce();
});

it("releases prepared audio after cancellation so monitoring can be restored", async () => {
  const { bus } = createHarness();
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay() {},
    resetAbsoluteClock() {},
    resetState() {},
    seek: (frame: number) => frame,
    stepOnce: () => frameInputs(1),
  } as never;
  let enterRead!: () => void;
  let releaseRead!: () => void;
  const readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
  const heldRead = new Promise<Awaited<ReturnType<ExportInterface["read"]>>>((resolve) => {
    releaseRead = () => resolve({
      width: 2,
      height: 2,
      format: "rgba8unorm",
      rowStride: 8,
      bytes: new Uint8Array(16),
    });
  });
  const exports = fakeExports();
  const close = vi.fn();
  const restoreAudioMonitor = vi.fn();
  const view = renderHook(() => useRenderRange({
    createCapture: unusedCapture,
    bus,
    exports: { ...exports, read: () => { enterRead(); return heldRead; } },
    compiled: COMPILED,
    graph: graphWith("timeline"),
    registry: REGISTRY,
    settings: { ...SETTINGS, frameRange: { start: 0, end: 0 } },
    latestFrame: () => frameInputs(0),
    name: () => "test",
    audioRequirement: () => ({ kind: "required" }),
    prepareAudio: async () => ({ pcm: () => ({
      sampleRate: 48_000,
      channelCount: 1,
      samples: new Float32Array(800),
    }), close }),
    muteAudioMonitor: () => restoreAudioMonitor,
    loadEncoder: async () => fakeEncoder(),
    probeEncoder: async () => ({ supported: true, codec: "avc1.42002a", reason: null }),
    probeAudioEncoder: async () => ({ supported: true, codec: "mp4a.40.2", reason: null }),
    write: async () => ({ kind: "cancelled" }),
  }));

  let pending!: Promise<unknown>;
  await act(async () => { pending = bus.execute("export.renderRange", {}, contextFor(alice)); });
  await act(async () => { await readEntered; });
  act(() => view.result.current.cancel());
  await act(async () => { releaseRead(); await pending; });

  expect(close).toHaveBeenCalledOnce();
  expect(restoreAudioMonitor).toHaveBeenCalledOnce();
});

const REGISTRY = createNodeRegistry(allNodeDefinitions);

const SETTINGS = {
  outputResolution: { width: 2, height: 2 },
  frameRange: { start: 0, end: 2 },
  fps: 60,
  limits: { maxResolution: 4096 },
} as unknown as ProjectSettings;

function graphWith(playMode?: string): GraphDocument {
  return {
    revision: 1,
    nodes: {
      track1: {
        id: "track1",
        type: "audioFileIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "track1",
        parameters: playMode === undefined ? {} : { playMode },
      },
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
    },
    edges: {},
  } as unknown as GraphDocument;
}

/** T644's document: a live camera and an Output, and nothing with a media transport. */
function webcamGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      cam1: {
        id: "cam1",
        type: "webcam",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "cam1",
        parameters: {},
      },
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
    },
    edges: {},
  } as unknown as GraphDocument;
}

/** Enough of a compile for `declaredSink` to find the Output node. */
const COMPILED = {
  ok: true,
  outputs: [{ nodeId: "out", portId: "in" }],
  diagnostics: [],
} as unknown as CompiledGraph;

function frameInputs(frameIndex: number): FrameInputs {
  return {
    frame: {
      frameIndex,
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      wallTimeSeconds: frameIndex / 60,
      wallDeltaSeconds: 1 / 60,
      randomSeed: 1,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [2, 2],
  } as unknown as FrameInputs;
}

function fakeExports(): ExportInterface {
  const output = {
    ref: { nodeId: "out", portId: "in" },
    resourceId: "r0",
    width: 2,
    height: 2,
    format: "rgba8unorm" as const,
    space: "linear" as const,
  };
  return {
    listOutputs: () => [output],
    describe: () => output,
    read: () =>
      Promise.resolve({
        width: 2,
        height: 2,
        format: "rgba8unorm" as const,
        rowStride: 8,
        bytes: new Uint8Array(2 * 2 * 4),
      }),
    stats: { readbacks: 0, duringPlayback: 0, refused: 0, bytesRead: 0 },
  } as unknown as ExportInterface;
}

function fakeEncoder(): VideoEncoderSink {
  const encoded: number[] = [];
  return {
    configure: () => undefined,
    encode: (frame: EncoderFrame) => {
      encoded.push(frame.frameIndex);
    },
    finish: () =>
      Promise.resolve({
        mimeType: "video/mp4",
        bytes: new Uint8Array([1, 2, 3]),
        frameCount: encoded.length,
        durationSeconds: encoded.length / 60,
      }),
  };
}

/**
 * Runs one whole take through the hook and returns the session it settled on.
 *
 * `stall` makes the transport hand the recorder the SAME frame index twice, which is the
 * recorder's own `recordingDuplicateFrame` condition — the cheapest way to get a
 * diagnostic that originates BELOW this hook, so the `onDiagnostic` pass-through into
 * `renderFrameRange` is falsifiable rather than merely present (§V500).
 */
async function takeOver(graph: GraphDocument, stall = false) {
  const { bus } = createHarness();
  let current = 0;
  transportHolderFor(bus).current = {
    isPlaying: () => false,
    togglePlay: () => undefined,
    resetAbsoluteClock: () => undefined,
    resetState: () => undefined,
    seek: (frameIndex: number) => {
      current = frameIndex;
      return frameIndex;
    },
    stepOnce: () => {
      if (!stall) current += 1;
      return frameInputs(current);
    },
  } as unknown as NonNullable<ReturnType<typeof transportHolderFor>["current"]>;

  const saved: { fileName: string | null } = { fileName: null };
  const view = renderHook(() =>
    useRenderRange({
    createCapture: unusedCapture,
      bus,
      exports: fakeExports(),
      compiled: COMPILED,
      graph,
      registry: REGISTRY,
      settings: SETTINGS,
      latestFrame: () => frameInputs(current),
      name: () => "take.loom.json",
      loadEncoder: () => Promise.resolve(fakeEncoder()),
      write: ({ fileName }: { fileName: string }) => {
        saved.fileName = fileName;
        return Promise.resolve({ kind: "saved" as const, fileName });
      },
    } as unknown as Parameters<typeof useRenderRange>[0]),
  );

  let result: { status: string } | null = null;
  await act(async () => {
    result = (await bus.execute("export.renderRange", {}, contextFor(alice))) as { status: string };
  });
  return { session: view.result.current, result, saved };
}

describe("T586 — a take over free-run media reports itself, and a locked one does not", () => {
  it("a free-run media node puts a WARNING on the session, and the take still renders", async () => {
    const { session, result, saved } = await takeOver(graphWith());

    const warning = session.diagnostics.find((d) => d.code === "export.nonReproducible");
    expect(warning, "the warning never reached the session — onDiagnostic is unwired").toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('Audio File In "track1"');
    expect(warning?.suggestion).toContain("Locked to Timeline");

    // NOT a refusal: the owner approved free run, and forcing the lock or cancelling the
    // take would both hand back something other than what they asked for.
    expect((result as unknown as { status: string }).status).toBe("applied");
    expect(saved.fileName).toBe("take.2x2.0-2.mp4");
  });

  it("the SAME document with the lock opted in renders silently", async () => {
    const { session, result } = await takeOver(graphWith("timeline"));
    expect(session.diagnostics.map((d) => d.code)).not.toContain("export.nonReproducible");
    expect((result as unknown as { status: string }).status).toBe("applied");
  });

  /**
   * T644 — THE CASE THAT COULD NOT REACH THIS SEAM, and the reason T645 is a property
   * rather than a patch.
   *
   * A webcam declares no transport parameters, so it was invisible to every derivation the
   * warning was built on. This take renders a live camera, produces a different file every
   * time it runs, and before T645 came back with an empty diagnostics list. Classifying
   * `webcam` in `NODE_REPRODUCIBILITY` does not make this pass on its own — the hook has to
   * call the function that reads the classification, which is the half §V220 keeps catching.
   */
  it("T644 — a take over a WEBCAM warns too, and the take still renders", async () => {
    const { session, result, saved } = await takeOver(webcamGraph());

    const warning = session.diagnostics.find((d) => d.code === "export.nonReproducible");
    expect(
      warning,
      "a take over a live camera reported nothing — §V329 has no site on this path",
    ).toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('Webcam "cam1"');
    expect(warning?.suggestion).toContain("Record the input to a file");

    // Same ruling as T586's: the take PROCEEDS. Refusing would hand back nothing at all for
    // a document whose only content is the camera the user pointed at something.
    expect((result as unknown as { status: string }).status).toBe("applied");
    expect(saved.fileName).toBe("take.2x2.0-2.mp4");
  });

  /**
   * The OTHER half of the channel, and the reason it is worth wiring at all.
   *
   * `renderFrameRange` has accepted `onDiagnostic` since T433 and this hook never passed
   * one, so everything the RECORDER had to say about a take — a duplicated frame, a gap,
   * an encoder refusal — was computed, put in a report, and discarded before any surface
   * could show it. Passing the callback fixes that for free, and this pins it: without the
   * argument the assertion below goes quiet, so the wiring is falsifiable rather than
   * decorative (§V500).
   *
   * It also pins the `finally`: this take REFUSES (the range is not contiguous) and the
   * diagnostics still reach the session, which is what a user needs when the take they got
   * is both broken and non-reproducible.
   */
  it("the recorder's OWN diagnostics reach the session too — the channel, not just T586", async () => {
    const { session } = await takeOver(graphWith("timeline"), true);
    const codes = session.diagnostics.map((d) => d.code);
    expect(codes.length, "nothing from below this hook reached the session").toBeGreaterThan(0);
    expect(codes.some((code) => code.includes("uplicate") || code.includes("ecording"))).toBe(true);
  });
});

/**
 * T1741b — THE FORMAT GOES THROUGH THE BUS AND DECIDES THE PATH.
 *
 * Set with `export.setRenderFormat` exactly as the dialog's picker sets it, then rendered
 * with `export.renderRange`. What is asserted is what decides the file: which format the
 * encoder was loaded for, whether the 8-bit canvas was captured or the float Output read,
 * and that an 8-bit Output is refused for a 10-bit format instead of rendered.
 */
describe("recording format (T1741b)", () => {
  function floatExports(format: "rgba16float" | "rgba8unorm-srgb", reads: { count: number }): ExportInterface {
    const output = { ref: { nodeId: "out", portId: "in" }, resourceId: "r0", width: 2, height: 2, format, space: "encoded" as const };
    return {
      listOutputs: () => [output],
      describe: () => output,
      read: () => {
        reads.count += 1;
        return Promise.resolve({ width: 2, height: 2, format, rowStride: 16, bytes: new Uint8Array(32) });
      },
      stats: { readbacks: 0, duringPlayback: 0, refused: 0, bytesRead: 0 },
    } as unknown as ExportInterface;
  }

  function attachTransport(bus: ReturnType<typeof createHarness>["bus"]) {
    let current = 0;
    transportHolderFor(bus).current = {
      isPlaying: () => false, togglePlay() {}, resetAbsoluteClock() {}, resetState() {},
      seek: (frame: number) => { current = frame; return frame; },
      stepOnce: () => frameInputs(++current),
    } as never;
    return () => current;
  }

  it("renders HEVC Main 10 from the float Output, with no canvas capture, after the format is set on the bus", async () => {
    const { bus } = createHarness();
    const current = attachTransport(bus);
    const reads = { count: 0 };
    const createCapture = vi.fn(unusedCapture);
    const loaded: LoadEncoderOptions[] = [];
    const probed: Array<string | undefined> = [];
    const planes: number[] = [];
    const view = renderHook(() => useRenderRange({
      createCapture, bus, exports: floatExports("rgba16float", reads), compiled: COMPILED, graph: graphWith("timeline"),
      registry: REGISTRY, settings: SETTINGS, latestFrame: () => frameInputs(current()), name: () => "test",
      write: async () => ({ kind: "cancelled" }),
      probeEncoder: async (_config, options) => {
        probed.push(options?.format);
        return { supported: true, codec: "hvc1.2.4.L93.B0", reason: null };
      },
      loadEncoder: async (options) => {
        loaded.push(options!);
        return { ...fakeEncoder(), encodeYuv10: (frame) => { planes.push(frame.frameIndex); } };
      },
    }));
    let set: unknown;
    await act(async () => { set = await bus.execute("export.setRenderFormat", { format: "hevc-main10" }, contextFor(alice)); });
    expect(set).toMatchObject({ status: "applied", output: { format: "hevc-main10" } });
    expect(view.result.current.renderSettings.format).toBe("hevc-main10");
    expect(probed.at(-1)).toBe("hevc-main10");

    let result: unknown;
    await act(async () => { result = await bus.execute("export.renderRange", {}, contextFor(alice)); });
    expect(result).toMatchObject({ status: "applied", output: { frames: 3 } });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.format).toBe("hevc-main10");
    expect(loaded[0]!.captureFrame).toBeUndefined();
    expect(createCapture).not.toHaveBeenCalled();
    expect(reads.count).toBe(3);
    expect(planes).toEqual([0, 1, 2]);
  });

  it("refuses HEVC Main 10 of an 8-bit Output by name, before any encoder or capture exists", async () => {
    const { bus } = createHarness();
    attachTransport(bus);
    const createCapture = vi.fn(unusedCapture);
    const loadEncoder = vi.fn(async () => fakeEncoder());
    const view = renderHook(() => useRenderRange({
      createCapture, bus, exports: floatExports("rgba8unorm-srgb", { count: 0 }), compiled: COMPILED, graph: graphWith("timeline"),
      registry: REGISTRY, settings: SETTINGS, latestFrame: () => frameInputs(0), name: () => "test",
      write: async () => ({ kind: "cancelled" }), loadEncoder,
      probeEncoder: async () => ({ supported: true, codec: "hvc1.2.4.L93.B0", reason: null }),
    }));
    await act(async () => { await bus.execute("export.setRenderFormat", { format: "hevc-main10" }, contextFor(alice)); });
    // The dialog reads this: the browser could encode it, the Output cannot feed it.
    expect(view.result.current.encoderSupport).toMatchObject({
      supported: false,
      reason: expect.stringContaining("this Output is rgba8unorm-srgb") as unknown,
    });
    let result: unknown;
    await act(async () => { result = await bus.execute("export.renderRange", {}, contextFor(alice)); });
    expect(result).toMatchObject({ status: "rejected", diagnostics: [{ code: "export.formatNeedsFloatOutput" }] });
    expect(loadEncoder).not.toHaveBeenCalled();
    expect(createCapture).not.toHaveBeenCalled();
  });

  it("names both blockers when the browser has no encoder AND the Output is 8-bit", async () => {
    const { bus } = createHarness();
    attachTransport(bus);
    const browserReason = "This browser has no HEVC Main 10 encoder for 2x2 at 60 fps.";
    const view = renderHook(() => useRenderRange({
      createCapture: unusedCapture, bus, exports: floatExports("rgba8unorm-srgb", { count: 0 }), compiled: COMPILED,
      graph: graphWith("timeline"), registry: REGISTRY, settings: SETTINGS, latestFrame: () => frameInputs(0), name: () => "test",
      write: async () => ({ kind: "cancelled" }),
      probeEncoder: async () => ({ supported: false, codec: "hvc1.2.4.L93.B0", reason: browserReason }),
    }));
    await act(async () => { await bus.execute("export.setRenderFormat", { format: "hevc-main10" }, contextFor(alice)); });
    const reason = view.result.current.encoderSupport?.reason ?? "";
    expect(view.result.current.encoderSupport?.supported).toBe(false);
    expect(reason.startsWith(browserReason)).toBe(true);
    expect(reason).toContain("this Output is rgba8unorm-srgb");
  });

  it("keeps the 8-bit formats on the canvas capture, and the default on H.264", async () => {
    const { bus } = createHarness();
    const current = attachTransport(bus);
    const reads = { count: 0 };
    const createCapture = vi.fn(() => ({
      captureFrame: (timing: { timestampMicros: number; durationMicros: number }) => ({
        codedWidth: 2, codedHeight: 2, timestamp: timing.timestampMicros, duration: timing.durationMicros, close() {},
      }),
      dispose() {},
    }));
    const loaded: LoadEncoderOptions[] = [];
    renderHook(() => useRenderRange({
      createCapture, bus, exports: floatExports("rgba16float", reads), compiled: COMPILED, graph: graphWith("timeline"),
      registry: REGISTRY, settings: SETTINGS, latestFrame: () => frameInputs(current()), name: () => "test",
      write: async () => ({ kind: "cancelled" }),
      loadEncoder: async (options) => {
        loaded.push(options!);
        return { ...fakeEncoder(), encodeCapturedFrame(timing) { options!.captureFrame!(timing).close(); } };
      },
    }));
    await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });
    await act(async () => { await bus.execute("export.setRenderFormat", { format: "h264-high" }, contextFor(alice)); });
    await act(async () => { await bus.execute("export.renderRange", {}, contextFor(alice)); });
    expect(loaded.map((options) => options.format)).toEqual(["h264", "h264-high"]);
    expect(loaded.every((options) => typeof options.captureFrame === "function")).toBe(true);
    expect(createCapture).toHaveBeenCalledTimes(2);
    expect(reads.count).toBe(0);
  });
});
