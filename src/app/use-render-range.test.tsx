// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "@domain/types/graph.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { EncoderFrame, ExportInterface, VideoEncoderSink } from "@runtime/export/index.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { transportHolderFor } from "./transport-commands.ts";
import { useRenderRange } from "./use-render-range.ts";

/**
 * T586 — THE WIRING GUARD for the render-time honest edge.
 *
 * `freeRunRenderWarning` is proven at exact text in `domain/media/transport.test.ts`. That
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

afterEach(cleanup);

const REGISTRY = createNodeRegistry(allNodeDefinitions);

const SETTINGS = { frameRange: { start: 0, end: 2 }, fps: 60 } as unknown as ProjectSettings;

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

    const warning = session.diagnostics.find((d) => d.code === "export.freeRunMedia");
    expect(warning, "the warning never reached the session — onDiagnostic is unwired").toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('Audio File In "track1"');
    expect(warning?.suggestion).toContain("Locked to Timeline");

    // NOT a refusal: the owner approved free run, and forcing the lock or cancelling the
    // take would both hand back something other than what they asked for.
    expect((result as unknown as { status: string }).status).toBe("applied");
    expect(saved.fileName).toBe("take.0-2.mp4");
  });

  it("the SAME document with the lock opted in renders silently", async () => {
    const { session, result } = await takeOver(graphWith("timeline"));
    expect(session.diagnostics.map((d) => d.code)).not.toContain("export.freeRunMedia");
    expect((result as unknown as { status: string }).status).toBe("applied");
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
