import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeComponents } from "../tests/headless/pixel-compare.ts";
import { renderHeadless, type RenderedFrame } from "../tests/headless/render-harness.ts";
import { SHARED_UNIFORMS_WGSL } from "../runtime/backend/shared-uniforms.ts";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { starterComponentsView } from "./component-files.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * TimeGrid's claims — the video wall, asserted from pixels.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The component is Tile → SlitScan → a duotone, all stock. Nothing about that composition
 * is obvious enough to be left unasserted: the order is load-bearing (scan before tile and
 * every cell shows the SAME warp, which looks like it works), the per-cell delay is a
 * shader nobody else calls, and the property a performer relies on — turning the grid
 * mid-show — is invisible in every picture it produces.
 *
 * ## THE INSTRUMENT, and why it makes every number here exact rather than tolerated
 *
 * The probe source is a FRAME STAMP: `vec4f(uv.x, uv.y, frameIndex / 240, 1)`. The red and
 * green channels give each cell spatial structure (so "the cells are identical" is a real
 * claim and not a statement about a flat colour); the BLUE channel names the frame. Then a
 * cell's whole 128x72 block can be compared BYTE FOR BYTE against a render of the same
 * graph in Uniform mode at the frame that cell is supposed to be showing. No tolerance
 * appears anywhere below (§V147): the assertions are identity, strict ordering, or an
 * integer derived from the ring's own arithmetic.
 *
 * ## THE GEOMETRY IS CHOSEN SO THE SAMPLING CANNOT LIE
 *
 * 512 x 288 everywhere — the project resolution matches the resolution TimeGrid pins
 * internally, so every pass is 1:1 and no resample sits between the claim and the pixels.
 * The grid is 4x4 because 512/4 and 288/4 are both integers: a cell is exactly 128x72
 * texels and cell c samples its source at exactly the sub-uv cell 0 does, which is what
 * makes "identical" mean identical. At 3 columns of 512 it would not, and the byte
 * comparison would fail on arithmetic rather than on the effect (the near-miss this file
 * was written around).
 *
 * 16 cells over a 61-frame ring is also the one grid where the ladder lands on integers:
 * SlitScan spends `frames - 1 = 60` steps on a displacement of 1, Ordered gives cell k a
 * displacement of k/15, so cell k reads exactly 4k frames back. Every expected value below
 * is that arithmetic and nothing else.
 */

const STAMP_SCALE = 240;

/** `uv` in red/green so a cell has structure; the frame index in blue so a cell has a NAME. */
const STAMP_WGSL = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.x, uv.y, frameU.frameIndex / ${STAMP_SCALE}.0, 1.0);
}`;

const WIDTH = 512;
const HEIGHT = 288;
const COLS = 4;
const ROWS = 4;
const CELLS = COLS * ROWS;
const CELL_W = WIDTH / COLS;
const CELL_H = HEIGHT / ROWS;
/** SlitScan's usable depth: `frames - 1`. 61 frames, so 60 steps. */
const RING_STEPS = 60;
/** Ordered mode: cell k displaces k/(CELLS-1), which is 4k frames back on a 60-step ring. */
const BACK_OF = (cell: number): number => Math.round((cell / (CELLS - 1)) * RING_STEPS);
/** Late enough that the ring has archived every one of its 61 layers. */
const LAST = 140;

const SETTINGS: ProjectSettings = {
  outputResolution: { width: WIDTH, height: HEIGHT },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

interface WallParameters {
  readonly grid?: readonly [number, number];
  readonly spread?: number;
  readonly mode?: number;
  readonly rate?: number;
  readonly seed?: number;
  readonly colour?: readonly [number, number, number, number];
  readonly blend?: number;
}

function probeGraph(wall: WallParameters): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
    id,
    { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, label: id, parameters, ...extra },
  ] as const;
  const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => [
    id,
    { id, source: { nodeId: from[0], portId: from[1] }, target: { nodeId: to[0], portId: to[1] } },
  ] as const;
  return {
    revision: 1,
    groups: {},
    nodes: Object.fromEntries([
      // customWgsl inherits its size from an input, so the stamp needs something to stand on.
      node("bed", "ramp", { type: "vertical" }, { definitionVersion: 2 }),
      node("src", "customWgsl", { source: STAMP_WGSL }),
      node("wall", "component:timeGrid@1", {
        grid: [COLS, ROWS],
        spread: 1,
        mode: 1,
        rate: 1,
        seed: 7,
        colour: [1, 0.68, 0.36, 1],
        blend: 0,
        ...wall,
      }),
      node("out", "output", { toneMap: "none" }),
    ]) as GraphDocument["nodes"],
    edges: Object.fromEntries([
      edge("e-bed-src", ["bed", "out"], ["src", "input"]),
      edge("e-src-wall", ["src", "out"], ["wall", "input"]),
      edge("e-wall-out", ["wall", "out"], ["out", "input"]),
    ]) as GraphDocument["edges"],
  };
}

async function shoot(
  wall: WallParameters,
  capture: readonly number[] = [LAST],
): Promise<{ frames: readonly RenderedFrame[]; plan: Awaited<ReturnType<typeof renderHeadless>>["plan"] }> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: probeGraph(wall),
    settings: SETTINGS,
    components: await starterComponentsView(),
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  return { frames: result.frames, plan: result.plan };
}

/** One cell's rectangle, as the raw component values the target holds. */
function cellBlock(frame: RenderedFrame, cell: number): Float64Array {
  const values = decodeComponents(frame.bytes, frame.format);
  const col = cell % COLS;
  const row = Math.floor(cell / COLS);
  const block = new Float64Array(CELL_W * CELL_H * 4);
  let at = 0;
  for (let y = row * CELL_H; y < (row + 1) * CELL_H; y += 1) {
    for (let x = col * CELL_W; x < (col + 1) * CELL_W; x += 1) {
      const base = (y * frame.width + x) * 4;
      block[at] = values[base] ?? 0;
      block[at + 1] = values[base + 1] ?? 0;
      block[at + 2] = values[base + 2] ?? 0;
      block[at + 3] = values[base + 3] ?? 0;
      at += 4;
    }
  }
  return block;
}

function identical(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at += 1) if (a[at] !== b[at]) return false;
  return true;
}

/** The blue channel at a cell's centre — the frame stamp, after the sink's transfer curve. */
function stampAt(frame: RenderedFrame, cell: number): number {
  const values = decodeComponents(frame.bytes, frame.format);
  const x = (cell % COLS) * CELL_W + CELL_W / 2;
  const y = Math.floor(cell / COLS) * CELL_H + CELL_H / 2;
  return values[(y * frame.width + x) * 4 + 2] ?? 0;
}

function differingPixels(a: RenderedFrame, b: RenderedFrame): number {
  const left = decodeComponents(a.bytes, a.format);
  const right = decodeComponents(b.bytes, b.format);
  let count = 0;
  for (let at = 0; at < left.length; at += 4) {
    if (left[at] !== right[at] || left[at + 1] !== right[at + 1] || left[at + 2] !== right[at + 2]) count += 1;
  }
  return count;
}

/** The scan's history ring, off the plan the backend was actually handed. */
function ringOf(plan: Awaited<ReturnType<typeof renderHeadless>>["plan"]): unknown {
  const rings = (plan.resources as unknown as ReadonlyArray<Record<string, unknown>>).filter(
    (resource) => resource["kind"] === "ring",
  );
  expect(rings, "TimeGrid must own exactly one history ring").toHaveLength(1);
  return rings[0];
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("TimeGrid — one stream, many moments", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * NON-VACUITY FIRST. Every claim below compares cells to each other, so a wall whose
   * cells were identical for a boring reason — a flat source, a Tile that never tiled —
   * would satisfy several of them by accident. This is the floor: with the wall doing its
   * job, cells are NOT all the same.
   */
  it("is looking at a real 4x4 wall of differing cells, or it is looking at nothing", async () => {
    const { frames } = await shoot({ mode: 1 });
    const frame = frames[0] as RenderedFrame;
    expect({ width: frame.width, height: frame.height }).toEqual({ width: WIDTH, height: HEIGHT });
    const blocks = Array.from({ length: CELLS }, (_, cell) => cellBlock(frame, cell));
    const distinct = blocks.filter((block, index) => index === 0 || !identical(block, blocks[0] as Float64Array));
    expect(distinct.length).toBe(CELLS);
  }, 120_000);

  /**
   * MODE 0 — UNIFORM: one moment everywhere.
   *
   * Byte-identical CELL BLOCKS, not "similar": the delay map is flat at 0 for every cell,
   * so all sixteen read the same ring layer, and 512/4 and 288/4 being whole means cell c
   * samples the source at exactly the sub-uv cell 0 does. Anything that leaked a per-cell
   * offset in — a map that was not flat within a cell, a Tile partition disagreeing with
   * the map's — shows up here as an inequality, not as a small number.
   */
  it("Uniform: every cell is the SAME moment, byte for byte", async () => {
    const { frames } = await shoot({ mode: 0 });
    const frame = frames[0] as RenderedFrame;
    const first = cellBlock(frame, 0);
    const wrong: number[] = [];
    for (let cell = 1; cell < CELLS; cell += 1) {
      if (!identical(cellBlock(frame, cell), first)) wrong.push(cell);
    }
    expect(wrong, "cells that do not match cell 0").toEqual([]);
  }, 120_000);

  /**
   * MODE 1 — ORDERED: the cascade, and WHICH moment each cell holds.
   *
   * The strong form. Cell k is claimed to show the frame 4k older than the one cell 0
   * shows, and the way that is checked is to render the SAME graph in Uniform mode — where
   * every cell provably holds the newest layer — at frame LAST − 4k, and compare cell k's
   * block against it byte for byte. A weaker test ("the cells differ") passes on a wall
   * whose delays are shuffled, doubled, or off by a frame; this one names the layer.
   */
  it("Ordered: cell k shows exactly the frame 4k back — asserted against Uniform at that frame", async () => {
    const wanted = Array.from({ length: CELLS }, (_, cell) => LAST - BACK_OF(cell));
    expect(wanted[0]).toBe(LAST);
    expect(wanted[CELLS - 1]).toBe(LAST - RING_STEPS);

    const ordered = (await shoot({ mode: 1 })).frames[0] as RenderedFrame;
    const uniform = await shoot({ mode: 0 }, [...wanted].sort((a, b) => a - b));
    const byFrame = new Map(uniform.frames.map((frame) => [frame.frameIndex, frame]));

    const mismatched: string[] = [];
    for (let cell = 0; cell < CELLS; cell += 1) {
      const at = LAST - BACK_OF(cell);
      const reference = byFrame.get(at);
      if (reference === undefined) throw new Error(`no Uniform capture at frame ${at}`);
      // Any cell of the Uniform frame will do — the claim above proved they are all equal.
      if (!identical(cellBlock(ordered, cell), cellBlock(reference, cell))) {
        mismatched.push(`cell ${cell} is not frame ${at} (${BACK_OF(cell)} back)`);
      }
    }
    expect(mismatched).toEqual([]);
  }, 240_000);

  /**
   * ORDERED, the ORDER — stated separately because it fails separately.
   *
   * The stamp rises with the frame index and every stage between it and the sink is
   * monotone, so "older" is "darker in blue" whatever the transfer curve does. STRICTLY
   * decreasing in reading order, with no epsilon: two cells landing on the same value
   * would mean two cells sharing a moment, which at 16 cells on a 61-frame ring is a bug
   * and not a rounding.
   */
  it("Ordered: the cascade runs in reading order, strictly", async () => {
    const frame = (await shoot({ mode: 1 })).frames[0] as RenderedFrame;
    const stamps = Array.from({ length: CELLS }, (_, cell) => stampAt(frame, cell));
    const notDescending = stamps.filter((value, index) => index > 0 && value >= (stamps[index - 1] as number));
    expect(notDescending, `stamps in reading order: ${stamps.map((v) => v.toFixed(5)).join(", ")}`).toEqual([]);
  }, 120_000);

  /**
   * THE LIVE-ON-THE-FLY CLAIM, and the one most likely to regress in silence.
   *
   * Rows and columns are UNIFORM values on both consumers (Tile's `repeat`, the map's
   * `grid`), so re-partitioning the wall must not touch a single resource — above all not
   * the 69.75 MiB history ring, which a reallocation would empty. Nothing a viewer sees
   * would reveal that: the wall would simply be black for a second and then look right.
   *
   * So the assertion is on the PLAN the backend is handed: same resources, same passes,
   * same shader text, across a 4x4 and a 2x8. The picture is asserted to change in the
   * same breath, because "nothing changed" would satisfy the first half perfectly.
   */
  it("changing the grid re-partitions the wall and reallocates NOTHING", async () => {
    const square = await shoot({ grid: [COLS, ROWS] });
    const wide = await shoot({ grid: [2, 8] });

    expect(ringOf(wide.plan)).toEqual(ringOf(square.plan));
    expect(wide.plan.resources).toEqual(square.plan.resources);

    const signature = (plan: typeof square.plan) =>
      (plan.passes as unknown as ReadonlyArray<Record<string, unknown>>).map((pass) => ({
        id: pass["id"],
        kind: pass["kind"],
        target: pass["target"],
        shader: pass["shader"],
      }));
    expect(signature(wide.plan)).toEqual(signature(square.plan));

    // And the wall really did re-partition: a 2x8 is not a 4x4.
    const changed = differingPixels(square.frames[0] as RenderedFrame, wide.frames[0] as RenderedFrame);
    expect(changed).toBeGreaterThan(WIDTH * HEIGHT * 0.5);
  }, 180_000);

  /**
   * THE COLOURIZER'S NO-OP END (§V147, and the reason Blend is a Cross rather than an
   * opacity). At 0 the dissolve is `mix(wall, duotone, 0)`, so the Colour knob is not
   * merely weak, it is INERT: two renders that differ only in Colour must be the same
   * bytes. At 1 the same pair must differ across most of the frame — which is what stops
   * this being a test that a disconnected colourizer would also pass.
   */
  it("Blend 0 makes Colour inert, byte for byte; Blend 1 makes it the picture", async () => {
    const amber = [1, 0.68, 0.36, 1] as const;
    const green = [0.2, 1, 0.45, 1] as const;

    const offA = (await shoot({ blend: 0, colour: amber })).frames[0] as RenderedFrame;
    const offB = (await shoot({ blend: 0, colour: green })).frames[0] as RenderedFrame;
    expect(differingPixels(offA, offB)).toBe(0);

    const onA = (await shoot({ blend: 1, colour: amber })).frames[0] as RenderedFrame;
    const onB = (await shoot({ blend: 1, colour: green })).frames[0] as RenderedFrame;
    // Everything the duotone touches is everything that is not black.
    expect(differingPixels(onA, onB)).toBeGreaterThan(WIDTH * HEIGHT * 0.9);
    // And Blend itself moved the picture, not only the Colour knob's authority over it.
    expect(differingPixels(offA, onA)).toBeGreaterThan(WIDTH * HEIGHT * 0.9);
  }, 180_000);

  /**
   * MODE 2 — RANDOM is a LOOK, not noise: the same seed is the same wall, and a different
   * seed is a different one. A hash built on `fract(sin(x))` would satisfy the first half
   * on one machine and nothing else, which is why the map's hash is integer arithmetic.
   */
  it("Random: the seed deals the wall, and the same seed deals it again", async () => {
    const seven = (await shoot({ mode: 2, seed: 7 })).frames[0] as RenderedFrame;
    const sevenAgain = (await shoot({ mode: 2, seed: 7 })).frames[0] as RenderedFrame;
    const eleven = (await shoot({ mode: 2, seed: 11 })).frames[0] as RenderedFrame;
    expect(differingPixels(seven, sevenAgain)).toBe(0);
    expect(differingPixels(seven, eleven)).toBeGreaterThan(WIDTH * HEIGHT * 0.2);
  }, 180_000);

  /**
   * E51 itself, on the shipped bytes: the wall in the file is a wall, not nine copies of
   * one frame. The claims above run on a probe source built for measurement; this is the
   * cheap check that the DOCUMENT everyone opens is wired the same way.
   */
  it("E51 Chorus ships a wall whose cells hold different moments", async () => {
    const file = listExamples().find((entry) => entry.fileName === "E51-Chorus.loom.json");
    if (file === undefined) throw new Error("E51-Chorus.loom.json is not shipped");
    const { document } = requireExample(file);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: { ...document.settings, outputResolution: { width: 384, height: 216 } },
      components: await starterComponentsView(),
      frames: 121,
      capture: [120],
      animate: true,
      outputNodeId: "out",
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const frame = result.frames[0] as RenderedFrame;
    const values = decodeComponents(frame.bytes, frame.format);
    /*
     * WHOLE BLOCKS, not centre pixels. The first draft sampled one texel at each cell's
     * centre and read 2 distinct values out of 9 — E51's bed is deliberately dark, so most
     * centres sit on near-black and a point probe cannot tell nine moments apart. That is
     * the sampling landing outside the thing being measured, not the wall failing.
     * 384/3 and 216/3 are whole, so a cell here is exactly 128x72 texels.
     */
    const block = (cell: number): string => {
      const col = cell % 3;
      const row = Math.floor(cell / 3);
      const out: number[] = [];
      for (let y = row * 72; y < (row + 1) * 72; y += 1) {
        for (let x = col * 128; x < (col + 1) * 128; x += 1) {
          const base = (y * frame.width + x) * 4;
          out.push(values[base] ?? 0, values[base + 1] ?? 0, values[base + 2] ?? 0);
        }
      }
      return out.join(",");
    };
    const blocks = Array.from({ length: 9 }, (_, cell) => block(cell));
    const twins: string[] = [];
    for (let a = 0; a < 9; a += 1) {
      for (let b = a + 1; b < 9; b += 1) if (blocks[a] === blocks[b]) twins.push(`${a}=${b}`);
    }
    expect(twins, "cells holding the same moment").toEqual([]);
  }, 180_000);
});
