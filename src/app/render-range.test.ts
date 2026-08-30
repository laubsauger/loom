import { describe, expect, it, vi } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { ExportInterface } from "@runtime/export/index.ts";
import type { EncoderFrame, VideoEncoderSink } from "@runtime/export/index.ts";
import {
  registerRenderRangeCommand,
  renderFrameRange,
  renderRangeHolderFor,
} from "./render-range.ts";
import type { RangeTransport } from "./render-range.ts";

/**
 * RENDERING THE RANGE (T433).
 *
 * ## Why the fake transport, and not a device
 *
 * The claim under test is WHICH FRAMES END UP IN THE FILE, and that is decided entirely
 * by the order of `seek`, `latestFrame` and `stepOnce` — no pixel is involved in getting
 * it wrong. The classic failure is one frame wide: step-then-capture renders
 * `start+1..end+1` while reporting the right count, which is invisible in the file and
 * invisible in the report. A fake transport that records exactly what it was asked to
 * render is the only way to see it.
 *
 * What this does NOT prove: that the encoded bytes are a playable video, that the readback
 * pixels are the graph's, or that a real seek clears temporal state. Those are §V147
 * claims about a picture and belong on a device — `recorder.test.ts` covers the encoder
 * contract, and §V170's replay is `use-frame-loop`'s.
 */

/** A transport that renders nothing and remembers which frames it was asked for. */
function fakeTransport(): RangeTransport & { readonly rendered: number[]; playing: boolean } {
  const state = { playing: true, current: 0 };
  const rendered: number[] = [];
  const inputsFor = (frameIndex: number): FrameInputs =>
    ({
      frame: {
        frameIndex,
        timeSeconds: frameIndex / 60,
        deltaSeconds: 1 / 60,
        wallTimeSeconds: frameIndex / 60,
        wallDeltaSeconds: 1 / 60,
        randomSeed: 1,
      },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [4, 4],
    }) as unknown as FrameInputs;
  return {
    rendered,
    get playing() {
      return state.playing;
    },
    set playing(value: boolean) {
      state.playing = value;
    },
    isPlaying: () => state.playing,
    togglePlay: () => {
      state.playing = !state.playing;
    },
    seek: (frameIndex: number) => {
      state.current = frameIndex;
      rendered.push(frameIndex);
      return frameIndex;
    },
    stepOnce: () => {
      state.current += 1;
      rendered.push(state.current);
      return inputsFor(state.current);
    },
    latestFrame: () => inputsFor(state.current),
  };
}

function fakeEncoder(): VideoEncoderSink & { readonly encoded: number[] } {
  const encoded: number[] = [];
  return {
    encoded,
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

/** An export interface that answers with a 2x2 image and counts nothing else. */
function fakeExports(): ExportInterface {
  const output = {
    ref: { nodeId: "out", portId: "out" },
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

describe("renderFrameRange covers exactly the range (T433)", () => {
  it("captures the IN POINT itself — the frame the seek rendered — and stops at the out point", async () => {
    const transport = fakeTransport();
    const encoder = fakeEncoder();

    const result = await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 10, end: 14 },
      fps: 60,
      transport,
      encoder,
    });

    // Five frames, 10 through 14 — not 11 through 15, which is what stepping before
    // capturing produces while reporting the same count.
    expect(encoder.encoded).toEqual([10, 11, 12, 13, 14]);
    expect(result.report.frames).toBe(5);
    expect(result.report.firstFrameIndex).toBe(10);
    expect(result.report.lastFrameIndex).toBe(14);
    expect(result.report.contiguous).toBe(true);
  });

  it("renders a single-frame range as one frame, not zero and not two", async () => {
    const transport = fakeTransport();
    const encoder = fakeEncoder();
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 7, end: 7 },
      fps: 60,
      transport,
      encoder,
    });
    expect(encoder.encoded).toEqual([7]);
  });

  it("seeks to the in point first, so the take starts from that frame's real state (§V170)", async () => {
    const transport = fakeTransport();
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 3, end: 5 },
      fps: 60,
      transport,
      encoder: fakeEncoder(),
    });
    // The seek is the FIRST thing rendered. Starting from wherever the playhead happened
    // to be would carry a feedback graph's history into the take.
    expect(transport.rendered[0]).toBe(3);
  });

  it("pauses a running loop, so no frame slips between the steps it takes", async () => {
    const transport = fakeTransport();
    transport.playing = true;
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 2 },
      fps: 60,
      transport,
      encoder: fakeEncoder(),
    });
    expect(transport.isPlaying()).toBe(false);
  });
});

describe("export.renderRange refuses by name (§V288)", () => {
  it("rejects when no session holds the renderer", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    const result = await bus.execute("export.renderRange", {}, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("export.noSession");
    expect(result.output).toEqual({ rendered: false, frames: 0, fileName: null });
  });

  it("reports the handler's refusal rather than swallowing it", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    renderRangeHolderFor(bus).current = {
      busy: () => false,
      render: () =>
        Promise.resolve({
          kind: "refused",
          diagnostic: {
            severity: "error",
            code: "export.noOutput",
            message: "This graph declares no Output, so there is nothing to render out.",
          },
        }),
    };
    const result = await bus.execute("export.renderRange", {}, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("export.noOutput");
  });

  it("refuses a second take while one is running rather than interleaving two", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    const render = vi.fn(() =>
      Promise.resolve({ kind: "rendered" as const, frames: 3, fileName: "a.mp4" }),
    );
    renderRangeHolderFor(bus).current = { busy: () => true, render };
    const result = await bus.execute("export.renderRange", {}, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("export.renderInFlight");
    // The point of the guard: the transport is NOT stepped by the second caller.
    expect(render).not.toHaveBeenCalled();
  });

  it("reports the frames rendered even when the save picker was cancelled", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    renderRangeHolderFor(bus).current = {
      busy: () => false,
      render: () => Promise.resolve({ kind: "rendered", frames: 120, fileName: null }),
    };
    const result = await bus.execute("export.renderRange", {}, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.output).toEqual({ rendered: false, frames: 120, fileName: null });
  });
});
