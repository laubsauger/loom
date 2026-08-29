import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../../domain/types/graph.ts";
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { OUTPUT_NODE_ID, paritySettings } from "../fixtures/parity-graphs.ts";
import { renderHeadless } from "./render-harness.ts";
import type { RenderedFrame } from "./render-harness.ts";

/**
 * Does the product animate AT ALL, and does its motion come from the frame clock?
 *
 * This file exists because nothing else asserted it. The compiler suite proves plans are
 * built, the backend suite proves passes are submitted, and the parity suite proves two
 * paths agree — and every one of them would stay green in a build where the picture never
 * moved. That gap was not theoretical: the owner reported "no way to actually play and
 * animate anything", and the pieces underneath all tested fine individually. It is the same
 * shape as B9 and B10 in §B, where each layer was green and the seam belonged to nobody.
 *
 * The three claims below are deliberately a set. "Pixels changed" on its own is a weak test:
 * it passes just as happily if a shader is reading a wall clock, which would make offline
 * renders unreproducible (§V44) without ever going red. So motion is asserted together with
 * its absence and with reproducibility:
 *
 *   1. speed=1 -> consecutive frames DIFFER. Something moves.
 *   2. speed=0 -> consecutive frames are IDENTICAL. Nothing moves on its own, so whatever
 *      moved in (1) was the parameter and not an ambient clock.
 *   3. the same graph rendered twice produces the same bytes. Motion is a function of frame
 *      index, which is what makes an offline render match the live preview frame for frame.
 *
 * Together those say motion comes from `FrameEvaluationInput` and nowhere else. Any one of
 * them alone can be satisfied by a broken build.
 */

const SIZE = 32;

/** Noise -> output. `speed` and the noise type are what vary between the cases below. */
function animatedNoiseGraph(speed: number, type = "perlin4d"): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      noise: {
        id: "noise",
        type: "noise",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        // Only the parameters this claim depends on are pinned. A default moving elsewhere
        // in the node should not fail an animation test — but `period` is pinned because a
        // noise field coarse enough to be flat across 32 texels would make frame-to-frame
        // difference undetectable for reasons that have nothing to do with animation.
        parameters: { type, speed, period: 4, t4d: 0 },
      },
      [OUTPUT_NODE_ID]: {
        id: OUTPUT_NODE_ID,
        type: "output",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: {},
      },
    },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "noise", portId: "out" },
        target: { nodeId: OUTPUT_NODE_ID, portId: "input" },
      },
    },
  };
}

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(`Dawn (vgpu/node) could not start, so animation is unverified: ${dawnError}`);
  }
}

/**
 * Frames one second apart, not one frame apart, and that distance is the point.
 *
 * `speed` is capped at 10, so at 60fps a single frame advances the noise field by at most
 * 0.16 units — below one 8-bit quantum for a field this smooth. A per-frame assertion
 * therefore fails on a build that animates perfectly well, which is how the first draft of
 * this file went red. Whether a single 60fps frame is visibly different is not the claim
 * anyone cares about; whether a second of playback moves the picture is.
 */
async function renderFrames(speed: number, type?: string): Promise<ReadonlyArray<RenderedFrame>> {
  const result = await renderHeadless({
    host: dawnGpuHost(),
    graph: type === undefined ? animatedNoiseGraph(speed) : animatedNoiseGraph(speed, type),
    settings: paritySettings({ size: SIZE }),
    fps: 1,
    frames: 3,
    capture: [0, 1, 2],
  });
  // Info-level notes are expected here (headless Dawn reports timestamp-query as
  // unavailable); anything above info would mean the frames below are not trustworthy.
  expect(result.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  return result.frames;
}

/** How many bytes differ. Reported as a count so a failure says HOW different, not just that. */
function differingBytes(a: RenderedFrame, b: RenderedFrame): number {
  expect(a.bytes.length).toBe(b.bytes.length);
  let differing = 0;
  for (let i = 0; i < a.bytes.length; i += 1) {
    if (a.bytes[i] !== b.bytes[i]) differing += 1;
  }
  return differing;
}

describe("animation reaches the picture", () => {
  it("moves when a time-driven parameter is non-zero", async () => {
    requireDawn();
    const frames = await renderFrames(1);
    const [first, second, third] = frames;
    expect(first && second && third).toBeTruthy();
    if (!first || !second || !third) return;

    // Not "some byte changed": a second of a moving noise field should redraw most of the
    // image. A handful of differing bytes would mean something is nearly static, and would
    // let a barely-advancing clock pass as animation.
    const perFrame = differingBytes(first, second);
    expect(perFrame).toBeGreaterThan(first.bytes.length / 4);
    expect(differingBytes(first, third)).toBeGreaterThan(perFrame / 2);
  }, 60_000);

  it("ignores time on a 2D noise type, which is why `speed` alone is not enough (B14)", async () => {
    requireDawn();
    // Not a defect in the shader: a 2D field has no fourth dimension for time to move
    // along, and TD behaves the same way. The defect is that `speed` is offered anyway on
    // the DEFAULT type and silently does nothing, which is how "nothing animates" happens
    // to someone who did everything right. Pinned here so the UI fix (V146 — a parameter
    // that cannot affect output must READ inactive) has something to fail against if the
    // shader is ever "fixed" instead of the presentation.
    const frames = await renderFrames(1, "perlin2d");
    const [first, , third] = frames;
    expect(first && third).toBeTruthy();
    if (first && third) expect(differingBytes(first, third)).toBe(0);
  }, 60_000);

  it("holds still when it is not driven, so motion is the parameter and not a clock", async () => {
    requireDawn();
    const frames = await renderFrames(0);
    const [first, second, third] = frames;
    expect(first && second && third).toBeTruthy();
    if (!first || !second || !third) return;

    expect(differingBytes(first, second)).toBe(0);
    expect(differingBytes(first, third)).toBe(0);
  }, 60_000);

  it("replays identically, so an offline render matches the live preview (§V44)", async () => {
    requireDawn();
    const [once, twice] = await Promise.all([renderFrames(1), renderFrames(1)]);
    for (let index = 0; index < 3; index += 1) {
      const a = once[index];
      const b = twice[index];
      expect(a && b).toBeTruthy();
      if (a && b) expect(differingBytes(a, b)).toBe(0);
    }
  }, 90_000);
});
