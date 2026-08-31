import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../../runtime/export/image.ts";
import { renderHeadless, syntheticMediaFrame } from "./render-harness.ts";

/**
 * T650 — A MEDIA NODE IN A HEADLESS RENDER DRAWS ATTRIBUTABLE CONTENT, OR REPORTS A
 * NAMED ABSENCE. NEVER SILENT BLACK.
 *
 * Before this gate, `render-harness.ts` never registered a media source, so `webcam`
 * and `movieFileIn` rendered nothing in every Dawn test — and every gate over a
 * document containing media measured a blank and reported green. §V461 applies hard:
 * the broken state PASSED everything, so this fixture must be able to tell "drew the
 * fake" from "drew nothing" — which is why the test card encodes the FRAME INDEX in
 * its first bytes and the assertions read it back, byte-exact, per captured frame.
 *
 * `text` is the stated exception (§V403): its pixels are the browser's font stack
 * rasterizing into a canvas, and headless has no font stack — black is the honest
 * output of a machine that genuinely cannot draw it. Faking glyphs would teach that
 * text works where it does not. The absence is gated by name below.
 */

const SIZE = 64;

function mediaDoc(type: "webcam" | "movieFileIn" | "text"): GraphDocument {
  return {
    revision: 1,
    nodes: {
      feed: { id: "feed", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 240, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float", // linear 8-bit would crush the encoded index bytes (1/255 in display is 0.0003 linear)
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

async function captured(type: "webcam" | "movieFileIn" | "text") {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: mediaDoc(type),
    settings: SETTINGS,
    frames: 4,
    capture: [1, 3],
  });
  const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
  return result.frames.map((frame) => ({
    frameIndex: frame.frameIndex,
    rgba: toRgba8(
      { width: frame.width, height: frame.height, format: frame.format, rowStride: frame.bytes.length / frame.height, bytes: frame.bytes } as never,
      { space } as never,
    ).data,
  }));
}

describe("T650 — headless media draws the fake, attributably", () => {
  it.each(["webcam", "movieFileIn"] as const)(
    "%s shows the test card with the FRAME INDEX readable in its first bytes",
    async (type) => {
      if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
      const frames = await captured(type);

      for (const frame of frames) {
        // ATTRIBUTABLE, not merely non-black (§V461): the first pixel encodes the frame
        // index the harness was stepping when the source was pulled — the playhead is
        // f(frame), off-by-ones included. The external texture is project-sized here, so
        // the blit is 1:1 and the encoding survives to the output byte-exactly.
        expect(frame.rgba[0]).toBe(frame.frameIndex & 255);
        expect(frame.rgba[1]).toBe((frame.frameIndex >> 8) & 255);
        expect(frame.rgba[2]).toBe(170);

        // And the body is the test card, not a lucky corner: a mid-frame pixel matches
        // the generator's own arithmetic for that frame.
        const x = 32;
        const y = 32;
        const expected = syntheticMediaFrame(`media:feed`, [SIZE, SIZE], frame.frameIndex);
        const offset = (y * SIZE + x) * 4;
        expect([frame.rgba[offset], frame.rgba[offset + 1], frame.rgba[offset + 2]]).toEqual([
          expected[offset],
          expected[offset + 1],
          expected[offset + 2],
        ]);
      }

      // Two captures, two different cards: the phase moved, so a frozen upload cannot pass.
      const a = frames[0]?.rgba ?? new Uint8ClampedArray();
      const b = frames[1]?.rgba ?? new Uint8ClampedArray();
      let differing = 0;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differing += 1;
      expect(differing).toBeGreaterThan(100);
    },
    120_000,
  );

  it("text stays black, BY NAME — headless has no font stack, and a fake would lie (§V403)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const frames = await captured("text");
    for (const frame of frames) {
      let lit = 0;
      for (let i = 0; i < frame.rgba.length; i += 4) {
        if ((frame.rgba[i] ?? 0) + (frame.rgba[i + 1] ?? 0) + (frame.rgba[i + 2] ?? 0) > 0) lit += 1;
      }
      // The honest absence: not one texel. The day a headless rasterizer exists, this
      // flips to the test-card contract above — deliberately, not by accident.
      expect(lit).toBe(0);
    }
  }, 120_000);
});
