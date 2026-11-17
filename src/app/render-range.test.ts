import { describe, expect, it, vi } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { ExportInterface } from "@runtime/export/index.ts";
import type { EncoderFrame, VideoEncoderSink } from "@runtime/export/index.ts";
import {
  registerRenderRangeCommand,
  renderFrameRange,
  renderRangeHolderFor,
  sourceRangeForOutputRange,
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
    // T467: the take's fresh-performance verb — recorded so a test can pin the ORDER.
    resetAbsoluteClock: () => {
      rendered.push(-1);
    },
    // VN71: the take's clear — recorded so a test can pin that it precedes the first frame.
    resetState: () => {
      rendered.push(-2);
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
  it("maps inclusive output ranges onto the complete project-frame intervals", () => {
    expect(sourceRangeForOutputRange({ start: 0, end: 128 }, 60, 30)).toEqual({ start: 0, end: 257 });
    expect(sourceRangeForOutputRange({ start: 24, end: 47 }, 60, 24)).toEqual({ start: 60, end: 119 });
  });

  it("treats a 30 fps output range as output frames while evaluating every 60 fps project frame", async () => {
    const transport = fakeTransport();
    const encoder = fakeEncoder();
    const settled: number[] = [];
    const capturedSourceFrames: Array<number | undefined> = [];
    const encode = encoder.encode;
    encoder.encode = (frame) => {
      capturedSourceFrames.push(settled.at(-1));
      return encode(frame);
    };
    const result = await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 4 },
      timelineFps: 60,
      outputFps: 30,
      transport,
      encoder,
      onFrameRendered: async (frame) => { settled.push(frame); },
    });

    expect(encoder.encoded).toEqual([0, 1, 2, 3, 4]);
    expect(transport.rendered).toEqual([-1, -2, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(settled).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(capturedSourceFrames).toEqual([0, 2, 4, 6, 8]);
    expect(result.report).toMatchObject({ frames: 5, firstFrameIndex: 0, lastFrameIndex: 4, contiguous: true });
  });

  it("captures the IN POINT itself — the frame the seek rendered — and stops at the out point", async () => {
    const transport = fakeTransport();
    const encoder = fakeEncoder();

    const result = await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 10, end: 14 },
      timelineFps: 60,
      outputFps: 60,
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
      timelineFps: 60,
      outputFps: 60,
      transport,
      encoder,
    });
    expect(encoder.encoded).toEqual([7]);
  });

  it("starts at the in point over cleared state, with no replay from zero (VN71, §V170 as amended)", async () => {
    const transport = fakeTransport();
    const preRoll: Array<readonly [number, number]> = [];
    const yieldControl = vi.fn(async () => undefined);
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 3, end: 5 },
      timelineFps: 60,
      outputFps: 60,
      transport,
      encoder: fakeEncoder(),
      onPreRollProgress: (completed, total) => preRoll.push([completed, total]),
      yieldControl,
    });
    // T467's clock first, then the clear, then the in point itself: frames 0..2 are not
    // played, because a take does not owe the play-through's history unless it asks for a
    // pre-roll — it owes the same file every time, which the clear gives it.
    expect(transport.rendered).toEqual([-1, -2, 3, 4, 5]);
    expect(preRoll).toEqual([]);
    expect(yieldControl).not.toHaveBeenCalled();
  });

  it("VN71: a take clears temporal state and starts AT its in point — no replay from zero — abstime counting from there", async () => {
    const transport = fakeTransport();
    const absoluteAt: Array<number | undefined> = [];
    const preRoll: Array<readonly [number, number]> = [];
    const encoder = fakeEncoder();
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 50_000, end: 50_002 },
      timelineFps: 60,
      outputFps: 60,
      transport: {
        ...transport,
        resetAbsoluteClock: (at) => {
          absoluteAt.push(at);
        },
      },
      encoder,
      onPreRollProgress: (completed, total) => preRoll.push([completed, total]),
    });
    // Cleared (-2), then one seek, to the in point: 50 000 frames from zero are not played.
    expect(transport.rendered).toEqual([-2, 50_000, 50_001, 50_002]);
    expect(encoder.encoded).toEqual([50_000, 50_001, 50_002]);
    expect(preRoll).toEqual([]);
    expect(absoluteAt).toEqual([50_000]);
  });

  it("VN71: a pre-roll plays that many frames before the in point, unrecorded, from cleared state", async () => {
    const transport = fakeTransport();
    const absoluteAt: Array<number | undefined> = [];
    const preRoll: Array<readonly [number, number]> = [];
    const encoder = fakeEncoder();
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 10, end: 11 },
      timelineFps: 60,
      outputFps: 60,
      preRollFrames: 3,
      transport: {
        ...transport,
        resetAbsoluteClock: (at) => {
          absoluteAt.push(at);
        },
      },
      encoder,
      onPreRollProgress: (completed, total) => preRoll.push([completed, total]),
    });
    expect(transport.rendered).toEqual([-2, 7, 8, 9, 10, 11]);
    expect(encoder.encoded).toEqual([10, 11]);
    expect(preRoll).toEqual([[1, 3], [2, 3], [3, 3]]);
    // The count starts at the entry, so the in point carries 10 whatever the pre-roll.
    expect(absoluteAt).toEqual([7]);
  });

  it("VN71: a pre-roll longer than the in point starts at frame 0", async () => {
    const transport = fakeTransport();
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 2, end: 2 },
      timelineFps: 60,
      outputFps: 60,
      preRollFrames: 30,
      transport,
      encoder: fakeEncoder(),
    });
    expect(transport.rendered).toEqual([-1, -2, 0, 1, 2]);
  });

  it("pauses a running loop during capture, then restores playback", async () => {
    const transport = fakeTransport();
    transport.playing = true;
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 2 },
      timelineFps: 60,
      outputFps: 60,
      transport,
      encoder: fakeEncoder(),
    });
    expect(transport.isPlaying()).toBe(true);
  });

  it("cancels without replaying the previous playhead or resuming GPU work", async () => {
    const transport = fakeTransport();
    transport.seek(10_000);
    transport.rendered.length = 0;
    transport.playing = true;
    const controller = new AbortController();
    await expect(renderFrameRange({
      api: fakeExports(), ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 30 }, timelineFps: 60, outputFps: 60,
      transport, encoder: fakeEncoder(), signal: controller.signal,
      onProgress: progress => { if (progress.completedFrames === 1) controller.abort(); },
    })).rejects.toThrow("cancelled");
    expect(transport.rendered).toEqual([-1, -2, 0]);
    expect(transport.isPlaying()).toBe(false);
    expect(transport.latestFrame()?.frame.frameIndex).toBe(0);
  });

  it("reports exact progress and closes the encoder when cancellation reaches a frame boundary", async () => {
    const transport = fakeTransport();
    const controller = new AbortController();
    const encoder = fakeEncoder();
    const close = vi.fn();
    encoder.close = close;
    const progress: Array<[number, number | null]> = [];

    const running = renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 10, end: 14 },
      timelineFps: 60,
      outputFps: 60,
      transport,
      encoder,
      signal: controller.signal,
      onProgress: (update) => {
        progress.push([update.completedFrames, update.frameIndex]);
        if (update.completedFrames === 2) controller.abort();
      },
    });

    await expect(running).rejects.toMatchObject({ name: "RenderRangeCancelledError" });
    expect(encoder.encoded).toEqual([10, 11]);
    expect(progress).toEqual([[0, null], [1, 10], [2, 11]]);
    expect(close).toHaveBeenCalledOnce();
    expect(transport.rendered.at(-1)).toBe(11);
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

/**
 * T1741b — the recording format is set on the bus. What a caller reads back is what the
 * session holds after the command, and the two refusals matter for the same reason the
 * render command's do: no session means nothing to set, and a running take must keep the
 * format it started in (a change mid-take would make the dialog describe a file it is not).
 */
describe("export.setRenderFormat sets the take's format through the bus (T1741b)", () => {
  function session(busy = false) {
    const formats: string[] = [];
    return {
      formats,
      handlers: { busy: () => busy, render: vi.fn(), setFormat: (format: string) => { formats.push(format); } },
    };
  }

  it("hands the session the format the caller chose and reports it back", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    const { formats, handlers } = session();
    renderRangeHolderFor(bus).current = handlers;
    const result = await bus.execute("export.setRenderFormat", { format: "hevc-main10" }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.output).toEqual({ format: "hevc-main10" });
    expect(formats).toEqual(["hevc-main10"]);
  });

  it("refuses a format the app does not offer, at the bus, before the session sees it", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    const { formats, handlers } = session();
    renderRangeHolderFor(bus).current = handlers;
    const result = await bus.execute("export.setRenderFormat", { format: "prores" } as never, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(formats).toEqual([]);
  });

  it("refuses while a take is running, and leaves the running take's format alone", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    const { formats, handlers } = session(true);
    renderRangeHolderFor(bus).current = handlers;
    const result = await bus.execute("export.setRenderFormat", { format: "h264-high" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("export.renderInFlight");
    expect(formats).toEqual([]);
  });

  it("rejects when no session holds the renderer", async () => {
    const { bus } = createHarness();
    registerRenderRangeCommand(bus);
    const result = await bus.execute("export.setRenderFormat", { format: "h264" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("export.noSession");
    expect(result.output).toEqual({ format: null });
  });
});

/**
 * T747 — THE EXPORT WAITS FOR THE FRAME'S INFERENCE.
 *
 * `depth` and `pose` publish "the latest completed result", which is right live (§V144:
 * stale beats stalled) and is a silently wrong FILE in a take: two renders of one project
 * pick up whatever happened to have landed and differ, with nothing in the file saying so.
 * That outranked the worker (§T382) on §V724's logic — a hitch is audible and gets
 * reported; a wrong take ships.
 *
 * ## Why this gate defers on a TIMER and not a microtask
 *
 * §V701: a gate that resolves its async on a microtask never opens the window a real
 * `await` opens, so it cannot see a race living in that window — three mutations walked
 * through §T519's gate for exactly this reason. So the settle here is held open by a
 * deferred that only a `setTimeout` resolves, and the assertion is not "the order came out
 * right" but "the capture was STILL OUTSTANDING while the settle was pending". A loop that
 * dropped the await would capture inside that window and be caught.
 */
function deferred() {
  let release: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

describe("T747 — a take waits for each frame's inference", () => {
  it("does not capture a frame while that frame's settle is still outstanding", async () => {
    const transport = fakeTransport();
    const encoder = fakeEncoder();
    const gates = [deferred(), deferred(), deferred()];
    const settled: number[] = [];

    const running = renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 2 },
      timelineFps: 60,
      outputFps: 60,
      transport,
      encoder,
      onFrameRendered: async (frameIndex) => {
        settled.push(frameIndex);
        await gates[frameIndex]!.promise;
      },
    });

    // Open a REAL window — a macrotask, so every microtask the loop could hide behind has
    // already drained. If the loop were not awaiting, the capture would have happened.
    for (const frameIndex of [0, 1, 2]) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The two operations are genuinely outstanding together: this frame's settle has
      // been entered, and nothing has been encoded for it.
      expect(settled).toEqual([...Array(frameIndex + 1).keys()]);
      expect(encoder.encoded).toEqual([...Array(frameIndex).keys()]);
      gates[frameIndex]!.release();
    }

    await running;
    expect(encoder.encoded).toEqual([0, 1, 2]);
  });

  it("settles a frame BEFORE stepping past it, so the result belongs to that frame", async () => {
    // Ordering, not merely presence: settling after the step would read the NEXT frame's
    // model input and stamp it with this frame's index — an off-by-one that is invisible
    // in the file, which is the whole family this suite exists for.
    const transport = fakeTransport();
    const order: string[] = [];
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 2 },
      timelineFps: 60,
      outputFps: 60,
      transport: {
        ...transport,
        stepOnce: () => {
          order.push("step");
          return transport.stepOnce();
        },
      },
      encoder: fakeEncoder(),
      onFrameRendered: async (frameIndex) => {
        order.push(`settle${frameIndex}`);
      },
    });

    expect(order).toEqual(["settle0", "step", "settle1", "step", "settle2"]);
  });

  it("is optional: a document with no model node renders exactly as before", async () => {
    const transport = fakeTransport();
    const encoder = fakeEncoder();
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      range: { start: 0, end: 2 },
      timelineFps: 60,
      outputFps: 60,
      transport,
      encoder,
    });
    expect(encoder.encoded).toEqual([0, 1, 2]);
  });
});

describe("§T1537b — a take installs each frame's structure before stepping it", () => {
  it("awaits prepareFrame(n) before the step that renders n — the seek's frame 0 included, pre-roll and tail too", async () => {
    // A structural cue reached on frame n has to be the installed plan when n is stepped, or
    // the take renders n in the old structure. Ordering is the claim: prepare n, then step.
    const transport = fakeTransport();
    const order: string[] = [];
    let pending = 0;
    await renderFrameRange({
      api: fakeExports(),
      ref: { nodeId: "out", portId: "out" },
      // A 30 fps take of a 60 fps timeline from output frame 1 (project frame 2), with a
      // two-frame pre-roll (0, 1), and a tail.
      range: { start: 1, end: 2 },
      timelineFps: 60,
      outputFps: 30,
      preRollFrames: 2,
      transport: {
        ...transport,
        seek: (frameIndex) => {
          order.push(`seek${frameIndex}`);
          return transport.seek(frameIndex);
        },
        stepOnce: () => {
          // Never while a prepare is still outstanding.
          expect(pending).toBe(0);
          const inputs = transport.stepOnce();
          order.push(`step${inputs?.frame.frameIndex ?? -1}`);
          return inputs;
        },
        prepareFrame: async (frameIndex) => {
          pending += 1;
          order.push(`prepare${frameIndex}`);
          await new Promise((resolve) => setTimeout(resolve, 1));
          pending -= 1;
        },
      },
      encoder: fakeEncoder(),
    });
    const steps = order.filter((entry) => entry.startsWith("step"));
    expect(steps).toEqual(["step1", "step2", "step3", "step4", "step5"]);
    // Every step is immediately preceded by the prepare for the frame it renders.
    for (const step of steps) {
      const frame = step.slice("step".length);
      expect(order[order.indexOf(step) - 1]).toBe(`prepare${frame}`);
    }
    expect(order.slice(0, 2)).toEqual(["prepare0", "seek0"]);
  });
});
