import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T661 — THE POINTER SEAM, GATED ON ITS SHIPPED VICTIM.
 *
 * The fifth reader-that-cannot-see (T630 compiler warnings, T633 the oracle's channels,
 * T650 media sources, T655 analyze channels): `render-harness.ts` created a pointer
 * source and never fed it, and the value-graph evaluate never received `inputs.pointer`
 * at all — so every mouse channel read {0,0,0} and every `frameU.pointer` read a frozen
 * origin, in every offline gate, since the beginning.
 *
 * E12-Fluid is the victim and therefore the fixture (§V461): EVERY force in it is the
 * pointer, so a dead seam renders a still fluid with a blob parked in a corner — static,
 * plausible, green under every check this repo ran before this file. A fixture on a
 * document that ignores the pointer would prove nothing; this one cannot pass by luck,
 * because the assertions pin the ink to WHERE THE SCRIPT PUT THE CURSOR, per §V618 on
 * the display-encoded tile.
 */

function e12() {
  const file = listExamples().find((entry) => entry.fileName === "E12-Fluid.loom.json");
  if (file === undefined) throw new Error("E12-Fluid.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** Display-encoded rgba at a normalised position — the tile a human judges (§V618). */
function rgbaAt(
  frame: { width: number; height: number; format: string; bytes: Uint8Array },
  space: string,
  u: number,
  v: number,
): [number, number, number] {
  const rgba = toRgba8(
    { width: frame.width, height: frame.height, format: frame.format, rowStride: frame.bytes.length / frame.height, bytes: frame.bytes } as never,
    { space } as never,
  ).data;
  const x = Math.round(u * (frame.width - 1));
  const y = Math.round(v * (frame.height - 1));
  const offset = (y * frame.width + x) * 4;
  return [rgba[offset] ?? 0, rgba[offset + 1] ?? 0, rgba[offset + 2] ?? 0];
}

describe("T661 — the pointer reaches an offline render (E12-Fluid)", () => {
  it("the ink follows the scripted cursor: left, then right, attributably", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { document } = e12();

    // A performance in two positions: park left of centre, then jump right. `null`
    // holds (§V236) — the seam's contract, exercised on purpose between the two.
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: document.settings,
      frames: 30,
      capture: [13, 28],
      animate: true,
      outputNodeId: "out",
      pointer: (frameIndex) => {
        if (frameIndex === 0) return { x: 0.25, y: 0.5, buttons: 1 };
        if (frameIndex === 15) return { x: 0.75, y: 0.5, buttons: 1 };
        return null;
      },
    });
    const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
    const left = result.frames[0];
    const right = result.frames[1];
    if (left === undefined || right === undefined) throw new Error("expected two captured frames");

    // Frame 13: the blob sits where the cursor is — 1:1, drivenSlot("mouse1:x"/"y") —
    // and its colour is the ink's amber (r > g > b), not a lucky bright pixel. The
    // mirror position is fluid-empty.
    const inkAt13 = rgbaAt(left, space, 0.25, 0.5);
    const farAt13 = rgbaAt(left, space, 0.75, 0.5);
    expect(inkAt13[0]).toBeGreaterThan(150);
    expect(inkAt13[0]).toBeGreaterThan(inkAt13[1]);
    expect(inkAt13[1]).toBeGreaterThan(inkAt13[2]);
    expect(farAt13[0]).toBeLessThan(60);

    // Frame 28: the cursor jumped, the blob went with it. The old position may keep a
    // decaying dye trail (persistence 0.985 — that is the fluid working, not a bug),
    // so the claim there is DIMMER THAN THE BLOB WAS, not black.
    const inkAt28 = rgbaAt(right, space, 0.75, 0.5);
    expect(inkAt28[0]).toBeGreaterThan(150);
    expect(inkAt28[0]).toBeGreaterThan(inkAt28[1]);
    expect(rgbaAt(right, space, 0.25, 0.5)[0]).toBeLessThan(inkAt13[0]);
  }, 240_000);

  it("records what the engine read, frame by frame — the replay half's other side", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { document } = e12();
    const read: Array<{ frameIndex: number; x: number }> = [];
    await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: document.settings,
      frames: 4,
      capture: [3],
      animate: true,
      outputNodeId: "out",
      pointer: (frameIndex) => (frameIndex === 2 ? { x: 0.9, y: 0.1, buttons: 0 } : null),
      recordPointer: (frameIndex, state) => read.push({ frameIndex, x: state.x }),
    });
    // What replays is what was READ (T431's contract, pointer edition): the hold
    // frames record the held value, the jump records on its own frame, never earlier.
    expect(read).toEqual([
      { frameIndex: 0, x: 0 },
      { frameIndex: 1, x: 0 },
      { frameIndex: 2, x: 0.9 },
      { frameIndex: 3, x: 0.9 },
    ]);
  }, 240_000);
});
