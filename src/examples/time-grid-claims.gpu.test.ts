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

/**
 * The same card with the clock taken out of it. Every claim about something the component
 * animates BY ITSELF — the palette walking, the tear re-dealing — needs a source that is
 * not moving, or "the frame changed" says nothing about which thing changed it.
 */
const STILL_WGSL = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.x, uv.y, 0.5, 1.0);
}`;

/**
 * A TRUE CIRCLE, measured in the frame's own pixel geometry rather than in uv — so it is
 * round on screen, and any departure from round downstream is the wall's doing. Hard-edged
 * on purpose: a soft disc has no bounding box to measure.
 */
const DISC_WGSL = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = frameU.resolution.x / frameU.resolution.y;
  let d = length((uv - vec2f(0.5)) * vec2f(aspect, 1.0));
  let v = select(0.0, 1.0, d < 0.2);
  return vec4f(v, v, v, 1.0);
}`;

const WIDTH = 512;
const HEIGHT = 288;
const COLS = 4;
const ROWS = 4;
const CELLS = COLS * ROWS;
const CELL_W = WIDTH / COLS;
const CELL_H = HEIGHT / ROWS;
/** The shipped history depth, and the one every expected value below is derived from. */
const SPAN = 61;
/** SlitScan's usable depth: `frames - 1`. 61 frames, so 60 steps. */
const RING_STEPS = SPAN - 1;
/**
 * T1019a: the ring runs at HALF the component's internal resolution. Asserted as a
 * RESOURCE below and separately from any value, because a ring that silently stayed at
 * full resolution passes every pixel assertion in this file while costing four times what
 * the parameter's description promises.
 */
const RING_SIZE = [WIDTH / 2, HEIGHT / 2] as const;
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
  readonly columns?: number;
  readonly rows?: number;
  readonly churn?: number;
  readonly span?: number;
  readonly spread?: number;
  readonly mode?: number;
  readonly rate?: number;
  readonly seed?: number;
  readonly glitch?: number;
  readonly chroma?: number;
  readonly crush?: number;
  readonly colour?: readonly [number, number, number, number];
  readonly blend?: number;
}

type Card = "stamp" | "still" | "disc";

function probeGraph(wall: WallParameters, card: Card = "stamp"): GraphDocument {
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
      node("src", "customWgsl", { source: card === "disc" ? DISC_WGSL : card === "still" ? STILL_WGSL : STAMP_WGSL }),
      node("wall", "component:timeGrid@1", {
        columns: COLS,
        rows: ROWS,
        // Churn 0 pins the wall: every claim below is about a FIXED grid, and a
        // sample-and-hold re-cutting underneath one would make it about two things.
        churn: 0,
        span: SPAN,
        spread: 1,
        mode: 1,
        rate: 1,
        seed: 7,
        colour: [1, 1, 1, 1],
        glitch: 0,
        chroma: 0,
        crush: 1,
        blend: 0,
        ...wall,
      }),
      /* The MATTE input, deterministic: a luma key on the same card. Two of the claims
         below (the dropout, and the matte travelling through the ring) are about what
         arrives on `in2`, so the probe has to supply it rather than leave it dark. */
      node("key", "threshold", { threshold: 0.5, softness: 0.05, channel: "luminance", compare: "greater" }),
      node("out", "output", { toneMap: "none" }),
    ]) as GraphDocument["nodes"],
    edges: Object.fromEntries([
      edge("e-bed-src", ["bed", "out"], ["src", "input"]),
      edge("e-src-key", ["src", "out"], ["key", "input"]),
      edge("e-src-wall", ["src", "out"], ["wall", "in1"]),
      edge("e-key-wall", ["key", "out"], ["wall", "in2"]),
      edge("e-wall-out", ["wall", "out"], ["out", "input"]),
    ]) as GraphDocument["edges"],
  };
}

async function shoot(
  wall: WallParameters,
  capture: readonly number[] = [LAST],
  card: Card = "stamp",
): Promise<{ frames: readonly RenderedFrame[]; plan: Awaited<ReturnType<typeof renderHeadless>>["plan"] }> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: probeGraph(wall, card),
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

/**
 * THE SEAM MARGIN, and it is analytically derived rather than a fudge.
 *
 * The ring runs at half the internal resolution (T1019a), so the record pass averages
 * 1/scale = 2 source texels into each ring texel — and at a cell BOUNDARY those two texels
 * belong to different cells, because Tile's `fract` wraps there. So exactly ceil(1/scale)
 * = 2 output pixels at each edge of every cell carry a trace of the neighbouring moment.
 * It is a real, stated consequence of paying a quarter of the memory, and it is 2 px of a
 * 128 px cell.
 *
 * Every block comparison below therefore reads cell INTERIORS. The claims are still byte
 * identity — nothing is tolerated, the region is just the part of the cell the seam does
 * not reach.
 */
const SEAM = 2;

/** One cell's interior, as the raw component values the target holds. */
function cellBlock(frame: RenderedFrame, cell: number): Float64Array {
  const values = decodeComponents(frame.bytes, frame.format);
  const col = cell % COLS;
  const row = Math.floor(cell / COLS);
  const block = new Float64Array((CELL_W - 2 * SEAM) * (CELL_H - 2 * SEAM) * 4);
  let at = 0;
  for (let y = row * CELL_H + SEAM; y < (row + 1) * CELL_H - SEAM; y += 1) {
    for (let x = col * CELL_W + SEAM; x < (col + 1) * CELL_W - SEAM; x += 1) {
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
    const square = await shoot({ columns: COLS, rows: ROWS });
    const wide = await shoot({ columns: 2, rows: 8 });

    expect(ringOf(wide.plan)).toEqual(ringOf(square.plan));
    expect(wide.plan.resources).toEqual(square.plan.resources);
    /* And the ring is what the Span knob's description PROMISES it is (§V228). A value
       assertion cannot see this: a full-resolution ring renders the same pixels and costs
       four times the memory the parameter says it does. */
    const ring = ringOf(square.plan) as { size: readonly number[]; frames: number };
    expect({ size: [...ring.size], frames: ring.frames }).toEqual({ size: [...RING_SIZE], frames: SPAN });

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
   * ═══════════════════════════════════════════════════════════════════════════════
   * THE DAMAGE — per cell, brief, overlapping, and reproducible from a seed.
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * THE PER-CELL CLAIM, and the reason it is run in UNIFORM mode. With every cell holding
   * the same moment, the wall's sixteen blocks are byte-identical (asserted above), so the
   * ONLY thing that can make them differ is a degradation reading its own cell index.
   * A test run in Ordered mode would show cells differing whatever the glitch did.
   *
   * A PROPER SUBSET, not all of them, and that is the design rather than a weak assertion.
   * Damage is dealt by short bursts on co-prime frame periods, so on any given frame some
   * cells are firing and most are not — at 6x6 the owner should see one or two things
   * happening, not thirty-six. "All cells break at Glitch 1" would be a different and
   * worse instrument, and the sparsity claim below pins that from the other side.
   */
  it("damage breaks cells INDIVIDUALLY: identical moments, no longer identical cells", async () => {
    const clean = (await shoot({ mode: 0, glitch: 0 })).frames[0] as RenderedFrame;
    const torn = (await shoot({ mode: 0, glitch: 1 })).frames[0] as RenderedFrame;

    const cleanBlocks = Array.from({ length: CELLS }, (_, cell) => cellBlock(clean, cell));
    // The floor: without damage the sixteen are one block repeated.
    expect(cleanBlocks.filter((block) => !identical(block, cleanBlocks[0] as Float64Array))).toHaveLength(0);

    // With it, a NON-EMPTY PROPER SUBSET is broken — the cell index reached the shader.
    const broken: number[] = [];
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (!identical(cellBlock(torn, cell), cellBlock(clean, cell))) broken.push(cell);
    }
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.length).toBeLessThan(CELLS);

    /*
     * And WHICH cells break is dealt from the cell index and the seed, not from the
     * picture: a different seed breaks a different set.
     *
     * This replaced a stricter assertion that was WRONG about the design — that every
     * broken cell must differ from every other. Two cells taking a DROPOUT in the same
     * frame are legitimately identical, because a dropout multiplies by the matte and in
     * Uniform mode both cells hold the same picture. The gate said '0=9' and the gate was
     * right; the claim was over-specified. Variety across cells is a property of the
     * VOCABULARY over time, and the burst claim below is where it belongs.
     */
    const dealt = (frame: RenderedFrame, reference: RenderedFrame): string => {
      let mask = "";
      for (let cell = 0; cell < CELLS; cell += 1) {
        mask += identical(cellBlock(frame, cell), cellBlock(reference, cell)) ? "." : "#";
      }
      return mask;
    };
    const elsewhere = (await shoot({ mode: 0, glitch: 1, seed: 23 })).frames[0] as RenderedFrame;
    expect(dealt(elsewhere, clean)).not.toBe(dealt(torn, clean));
  }, 240_000);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * THE ENVELOPE — and this is the claim pass 3 exists for.
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * Pass 2 held one event per cell for a whole tick. It was sparse, deterministic, and the
   * owner's verdict was that the glitch "feels like it has very few frames… we are a
   * little bit too simplified" — one clean state sitting there for half a second reads as
   * slow, not as broken. Pass 3 made every event a BURST: two or three frames long, six
   * independent trains on co-prime periods, re-dealt every frame inside the burst.
   *
   * That is a property of TIME, so it is asserted across CONSECUTIVE FRAMES: over twelve
   * of them the set of broken cells must take at least six distinct values. On the pass-2
   * design the same measurement returns ONE — the set could not change until the tick did
   * — so this assertion is exactly the difference between the two builds, and it is what a
   * future "simplification" would have to trip over.
   *
   * The one-sided bounds are deliberate. WHICH cells break is the hash's business and
   * pinning the exact set would be asserting the hash; that damage is brief, overlapping
   * and never total is the instrument's business, and that is what is pinned.
   */
  it("damage comes in BURSTS: the broken set changes from frame to frame, and is never the whole wall", async () => {
    const window = [140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151];
    const clean = await shoot({ mode: 0, glitch: 0 }, window);
    const torn = await shoot({ mode: 0, glitch: 1 }, window);
    const cleanAt = new Map(clean.frames.map((frame) => [frame.frameIndex, frame]));

    const signatures: string[] = [];
    let mostBroken = 0;
    let everBroken = 0;
    for (const frame of torn.frames) {
      const reference = cleanAt.get(frame.frameIndex);
      if (reference === undefined) throw new Error(`no clean capture at ${frame.frameIndex}`);
      let mask = "";
      let count = 0;
      for (let cell = 0; cell < CELLS; cell += 1) {
        const same = identical(cellBlock(frame, cell), cellBlock(reference, cell));
        mask += same ? "." : "#";
        if (!same) count += 1;
      }
      signatures.push(mask);
      mostBroken = Math.max(mostBroken, count);
      everBroken += count;
    }

    // Non-vacuity: something actually broke over the window.
    expect(everBroken).toBeGreaterThan(0);
    // BRIEF: the pattern is not one state held across the window.
    expect(new Set(signatures).size, `broken sets over 12 frames:\n${signatures.join("\n")}`).toBeGreaterThanOrEqual(6);
    // NEVER TOTAL: the wall is damaged, not replaced.
    expect(mostBroken).toBeLessThan(CELLS);
  }, 300_000);

  /**
   * SNOW MUST NOT CLIP (§V833/§V838), and it must actually be THERE while that is checked.
   *
   * The owner photographed a block of full-intensity confetti and said it "oversteers,
   * overflows". It did: the grain was mixed toward 1.0 and the transfer clamped, so a lit
   * cell went to flat white and every bit of structure under it was gone. The repair was
   * structural — the grain MODULATES luminance multiplicatively and its weight falls to
   * zero in the highlights — so the honest gate is "nothing reaches the clamp at all",
   * not "some number is small".
   *
   * ## THE FIRST VERSION OF THIS TEST COULD NOT FAIL, and that is why it reads like this
   *
   * It sampled ONE frame and counted clipped pixels. Red-verified by raising SNOW_DEPTH
   * from 0.45 to 6.0 — a thirteen-fold overdrive that must clip — and it stayed GREEN,
   * because damage is sparse and bursty and no snow happened to be firing on that frame.
   * A clipping test that renders no snow is a test of an empty picture.
   *
   * So it sweeps a window, and it PROVES THE SUBJECT IS PRESENT before judging it: a
   * snowing cell is identified exactly — its interior is monochrome (r == g == b
   * everywhere) while the probe card underneath it never is (red is uv.x, green is uv.y)
   * — and the claim is that snow occurred AND that nothing anywhere in the window sits on
   * the clamp.
   */
  it("snow rides the picture and never reaches the clip, at full Glitch", async () => {
    const window = [140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151];
    const clean = await shoot({ mode: 0, glitch: 0 }, window);
    const torn = await shoot({ mode: 0, glitch: 1 }, window);
    const cleanAt = new Map(clean.frames.map((frame) => [frame.frameIndex, frame]));

    /*
     * IDENTIFYING SNOW, and the discriminator had to be rebuilt when the grain stopped
     * desaturating. It used to be "the cell is monochrome", which was true only while snow
     * REPLACED the picture — the thing that made it look out of place.
     *
     * The three kinds separate cleanly on ONE measured statistic — the largest ratio any
     * pixel's channel takes against the clean frame:
     *
     *   DROPOUT never exceeds 1.000. It multiplies by the matte and does nothing else.
     *   SNOW    1.65 to 1.87, measured. It modulates, so it can lift a pixel as well as
     *           drop one, but it is bounded by SNOW_DEPTH and the highlight weighting.
     *   TEAR    past 15. A displaced band puts a bright pixel where a dark one was, so the
     *           ratio is unbounded by anything but the picture's own contrast.
     *
     * So "something got brighter, but nothing got more than three times brighter" is snow
     * and cannot be either of the others — five times clear of a tear, and strictly above
     * a dropout's ceiling.
     */
    const looksLikeSnow = (torn: Float64Array, clean: Float64Array): boolean => {
      let peakRatio = 0;
      for (let at = 0; at < torn.length; at += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
          const before = clean[at + channel] ?? 0;
          if (before <= 0.05) continue;
          peakRatio = Math.max(peakRatio, (torn[at + channel] ?? 0) / before);
        }
      }
      return peakRatio > 1 && peakRatio < 3;
    };

    let snowing = 0;
    for (const frame of torn.frames) {
      const reference = cleanAt.get(frame.frameIndex);
      if (reference === undefined) throw new Error(`no clean capture at ${frame.frameIndex}`);
      for (let cell = 0; cell < CELLS; cell += 1) {
        const block = cellBlock(frame, cell);
        const before = cellBlock(reference, cell);
        if (identical(block, before)) continue;
        if (looksLikeSnow(block, before)) snowing += 1;
      }
    }

    /*
     * THE CEILING TEST. `>= 1.0` was the obvious predicate and it is the wrong one: the
     * sink's own ceiling measures 0.99609 (255/256) rather than 1.0, so nothing ever
     * satisfied it and the assertion could not fail — red-verified by overdriving
     * SNOW_DEPTH 13x and watching it stay green.
     *
     * What IS exact and falsifiable: snow must not ADD pixels at the ceiling. A
     * multiplicative, highlight-protected grain leaves the brightest pixels alone and
     * scales everything else from a lower base, so the count of pixels sitting on the top
     * cannot rise. An additive or over-driven one pushes whole regions onto the clamp and
     * the count jumps. Integers, compared exactly.
     */
    const ceilingCount = (frames: readonly RenderedFrame[], ceiling: number): number => {
      let n = 0;
      for (const frame of frames) {
        const values = decodeComponents(frame.bytes, frame.format);
        for (let at = 0; at < values.length; at += 4) {
          if ((values[at] ?? 0) >= ceiling || (values[at + 1] ?? 0) >= ceiling || (values[at + 2] ?? 0) >= ceiling) n += 1;
        }
      }
      return n;
    };
    /* RGB ONLY. The first version walked every component including ALPHA, which is 1.0
       everywhere — so the ceiling came out at 1.0, nothing could reach it, both counts were
       zero and the assertion was vacuous. Measured, the sink's real RGB ceiling is 0.99609
       (255/256) and a 13x overdrive pushes 4672 pixels to 9706. */
    let ceiling = 0;
    for (const frame of clean.frames) {
      const values = decodeComponents(frame.bytes, frame.format);
      for (let at = 0; at < values.length; at += 4) {
        ceiling = Math.max(ceiling, values[at] ?? 0, values[at + 1] ?? 0, values[at + 2] ?? 0);
      }
    }

    // NON-VACUITY, and it is the whole reason this test is shaped this way.
    expect(snowing, "snowing cells found in the window").toBeGreaterThan(0);
    expect(ceiling).toBeGreaterThan(0.9);
    expect(
      ceilingCount(torn.frames, ceiling),
      "pixels pushed onto the sink's ceiling by the damage",
    ).toBeLessThanOrEqual(ceilingCount(clean.frames, ceiling));
  }, 300_000);

  /**
   * DETERMINISM (§V44's sibling promise). The tear is an integer hash of (cell, seed,
   * tick) and nothing else, so the same seed is the same wall — twice, and on any device
   * — and a different seed is a different wall. `Math.random` or a `fract(sin(x))` hash
   * would pass neither half reliably.
   *
   * The third assertion is the knob's identity end: at Glitch 0 the shader returns a
   * `textureLoad` at the fragment's own coordinate before it has looked at the seed, so
   * Seed is INERT byte-for-byte rather than nearly so.
   */
  it("Glitch replays from its seed, and Glitch 0 makes the seed inert", async () => {
    const seven = (await shoot({ mode: 0, glitch: 0.9, seed: 7 })).frames[0] as RenderedFrame;
    const sevenAgain = (await shoot({ mode: 0, glitch: 0.9, seed: 7 })).frames[0] as RenderedFrame;
    const eleven = (await shoot({ mode: 0, glitch: 0.9, seed: 11 })).frames[0] as RenderedFrame;
    expect(differingPixels(seven, sevenAgain)).toBe(0);
    expect(differingPixels(seven, eleven)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);

    const offSeven = (await shoot({ mode: 0, glitch: 0, seed: 7 })).frames[0] as RenderedFrame;
    const offEleven = (await shoot({ mode: 0, glitch: 0, seed: 11 })).frames[0] as RenderedFrame;
    expect(differingPixels(offSeven, offEleven)).toBe(0);
  }, 240_000);

  /**
   * THE RECOLORIZER EVOLVES ON ITS OWN — the Ramp's phase is an expression on the
   * free-running clock, INSIDE the component.
   *
   * Rendered against a STILL card with the glitch off and the wall in Uniform mode, so
   * after the ring has filled the only thing left in the graph that can change is the
   * palette. Two frames five seconds apart therefore differ if and only if the phase moved
   * — and at Blend 0 the same pair must be identical, because the dissolve's dry side is
   * the ungraded wall and the whole recolorizer is bypassed.
   *
   * This is also the standing evidence for the one thing that DOES animate inside a
   * component: an internal node is flattened into the parent graph and resolved with the
   * frame like any other node. Only the instance's published page is frozen.
   */
  it("the palette walks by itself, and Blend 0 bypasses it entirely", async () => {
    const graded = await shoot({ mode: 0, glitch: 0, blend: 1 }, [120, 420], "still");
    const [early, late] = graded.frames;
    expect(differingPixels(early as RenderedFrame, late as RenderedFrame)).toBeGreaterThan(
      WIDTH * HEIGHT * 0.5,
    );

    const raw = await shoot({ mode: 0, glitch: 0, blend: 0 }, [120, 420], "still");
    expect(differingPixels(raw.frames[0] as RenderedFrame, raw.frames[1] as RenderedFrame)).toBe(0);
  }, 300_000);

  /**
   * NO DEGRADATION BRIGHTENS A CELL — the owner's "too bright", as a property.
   *
   * "The static looks too bright" survived one repair, so this is the gate that repair
   * should have shipped with. It is stated over ALL damage rather than over snow alone,
   * because it needs no fragile discrimination between the three kinds and because a tear
   * that started lifting would be the same defect wearing a different hat.
   *
   * ONE-SIDED, and the asymmetry is the mechanism: a tear MOVES pixels inside a cell and a
   * snow burst MODULATES them symmetrically, so neither has any business raising the mean.
   * A DROPOUT multiplies by the matte and legitimately drops it — hence a ceiling and no
   * floor.
   *
   * MEASURED IN LINEAR LIGHT, and that is not a detail. Measured on ENCODED values the
   * same snow read +0.019 and looked like a fault; the sink's transfer is concave, so
   * luma-of-encoded is not encode-of-luma and any change in SATURATION moves the encoded
   * luma on its own. That artifact is what sent the last repair after the wrong number —
   * and it is also a real thing the owner sees, which is why the fix was to stop
   * desaturating rather than to dim anything.
   *
   * The bound is 0.01 and it is derived from both ends: the worst honest excursion
   * measured across a 24-frame window is +0.00254 (a tear), and the silhouette lift this
   * gate exists to catch was +0.03 in linear. Four times clear of the signal, three times
   * below the fault.
   */
  it("no damage brightens a cell — measured in linear light", async () => {
    const window = [130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141];
    const clean = await shoot({ mode: 0, spread: 0, glitch: 0, crush: 1 }, window);
    const torn = await shoot({ mode: 0, spread: 0, glitch: 1, crush: 1 }, window);
    const cleanAt = new Map(clean.frames.map((frame) => [frame.frameIndex, frame]));

    /* The sink publishes ENCODED pixels; luminance only means anything in linear. */
    const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const meanLuma = (frame: RenderedFrame, cell: number): number => {
      const block = cellBlock(frame, cell);
      let sum = 0;
      for (let at = 0; at < block.length; at += 4) {
        sum += 0.2126 * linear(block[at] ?? 0) + 0.7152 * linear(block[at + 1] ?? 0) + 0.0722 * linear(block[at + 2] ?? 0);
      }
      return sum / (block.length / 4);
    };

    const brightened: string[] = [];
    let broken = 0;
    for (const frame of torn.frames) {
      const reference = cleanAt.get(frame.frameIndex);
      if (reference === undefined) throw new Error(`no clean capture at ${frame.frameIndex}`);
      for (let cell = 0; cell < CELLS; cell += 1) {
        if (identical(cellBlock(frame, cell), cellBlock(reference, cell))) continue;
        broken += 1;
        const lift = meanLuma(frame, cell) - meanLuma(reference, cell);
        if (lift > 0.01) brightened.push(`f${frame.frameIndex} c${cell} lifted ${lift.toFixed(5)}`);
      }
    }
    // NON-VACUITY: damage has to have happened before "it did not brighten" means anything.
    expect(broken, "broken cells over the window").toBeGreaterThan(10);
    expect(brightened, "cells the damage made brighter").toEqual([]);
  }, 300_000);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * ASPECT — and a square-grid-only test could not have caught this (§V854).
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * Tile repeats the source into the SAME frame, so a cell is W/cols by H/rows and its
   * aspect is (W/H) x (rows/cols) — equal to the source's if and ONLY IF rows equals cols.
   * Every non-square grid was therefore stretching the picture to fill a slot of the wrong
   * shape, and the rendered aspect WAS rows/cols exactly. Measured before the fix, on this
   * card, through this component:
   *
   *     3x3 -> 1.000 | 4x2 -> 0.500 | 2x4 -> 2.000 | 8x12 -> 1.333 | 4x5 -> 1.200
   *
   * The wall shipped 4x5. It went unseen because the grid was square for the whole of the
   * component's first life, and every claim in this file above was written at 4x4 — the one
   * shape where the fault is invisible. That is §V854's shape exactly, so this test is
   * NON-SQUARE ONLY: 4x4 is deliberately absent, because including it would let a
   * regression pass on one of the cases.
   *
   * The bound is one pixel and it is derived, not chosen: the measurement is a hard-edged
   * disc's bounding box in whole texels, so where the boundary falls relative to a texel
   * centre can move an edge by one. The fault it detects is 30 pixels wide at 4x2 (a 30x60
   * blob where a 60x60 belongs), so the bound is thirty times clear of it.
   */
  it("preserves the source's aspect at every grid, square or not", async () => {
    /* The extremes of Churn's own range, plus what the example ships. */
    const grids = [
      [4, 2],
      [2, 4],
      [8, 12],
      [12, 8],
      [4, 5],
      [3, 7],
    ] as const;

    const wrong: string[] = [];
    for (const [columns, rows] of grids) {
      const frame = (
        await shoot({ columns, rows, mode: 0, spread: 0, glitch: 0, chroma: 0, crush: 1 }, [79], "disc")
      ).frames[0] as RenderedFrame;
      const values = decodeComponents(frame.bytes, frame.format);
      const cellW = Math.floor(WIDTH / columns);
      const cellH = Math.floor(HEIGHT / rows);
      let minX = Infinity;
      let maxX = -1;
      let minY = Infinity;
      let maxY = -1;
      for (let y = 0; y < cellH; y += 1) {
        for (let x = 0; x < cellW; x += 1) {
          if ((values[(y * frame.width + x) * 4] ?? 0) > 0.5) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      // NON-VACUITY: the disc has to be IN the cell before its shape means anything.
      if (maxX < 0 || width < 4 || height < 4) {
        wrong.push(`${columns}x${rows}: no disc found in the cell (${width}x${height})`);
        continue;
      }
      if (Math.abs(width - height) > 1) {
        wrong.push(`${columns}x${rows}: disc rendered ${width}x${height}, aspect ${(width / height).toFixed(3)}`);
      }
    }
    expect(wrong, "grids that stretched the picture").toEqual([]);
  }, 300_000);

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

  /**
   * ─────────────────────────────────────────────────────────────────────────────────
   * T1042 — E51's MATTE, on the shipped bytes, in two halves.
   * ─────────────────────────────────────────────────────────────────────────────────
   *
   * The bug: `mpick1` shipped at index 0, so the MATTE NODE's output reached no pixel of
   * the wall. The owner changed its model, its backend and its resolution and the picture
   * never moved, because the thing he was tuning was not on the path the output takes. The
   * claim above — nine cells holding nine moments — could not have caught it: it says
   * nothing about `in2`, and it is green either way.
   *
   * ## Why this is two assertions and not one
   *
   * THE ROUTE is structural and must be asserted structurally, because the pixel half is
   * nearly blind. TimeGrid consumes its matte in exactly ONE place — the per-cell dropout —
   * and a dropout is rare on purpose (period 47, life 12, share 0.30, odds scaling with
   * cell brightness). MEASURED over frames 60-479 of this document: driving `wall1.in2`
   * from all-white to all-black moves SIX frames out of 420 and not one component
   * elsewhere. A pixel gate alone would therefore pass on 414 of every 420 frames with the
   * matte severed — which is exactly the state that shipped.
   *
   * So: the branch assertion is the one that would have failed on the bug, and the pixel
   * assertion is the one that proves the branch reaches the glass rather than merely being
   * wired. Neither is sufficient; both are cheap.
   */
  it("E51 Chorus ships the matte node on the wall's matte input, and cutting it changes the frame", async () => {
    const file = listExamples().find((entry) => entry.fileName === "E51-Chorus.loom.json");
    if (file === undefined) throw new Error("E51-Chorus.loom.json is not shipped");
    const { document } = requireExample(file);
    const graph = document.graph;

    /*
     * HALF ONE — the selected branch is the MATTE NODE, derived rather than spelled.
     * Read the switch's index, find the edge that arrives at that order, and name the TYPE
     * of the node it comes from. Asserting `index === 1` alone would go quietly wrong the
     * day someone reorders the branches.
     */
    const chosen = graph.nodes["mpick"]?.parameters?.["index"];
    expect(typeof chosen, "mpick1 must carry a plain numeric index").toBe("number");
    const feeding = Object.values(graph.edges).filter(
      (edge) => edge.target.nodeId === "mpick" && edge.target.portId === "inputs",
    );
    const selected = feeding.find((edge) => (edge.order ?? 0) === chosen);
    expect(selected, `no edge arrives at mpick1 order ${String(chosen)}`).toBeDefined();
    const source = graph.nodes[selected!.source.nodeId];
    expect(
      source?.type,
      "the branch mpick1 selects must be the matte node — the one whose Inspector page a " +
        "user tunes. At index 0 it was `threshold` and the matte node reached no pixel.",
    ).toBe("matte");
    expect(
      Object.values(graph.edges).some(
        (edge) => edge.source.nodeId === "mpick" && edge.target.nodeId === "wall" && edge.target.portId === "in2",
      ),
      "mpick1 must reach the wall's matte input",
    ).toBe(true);

    /*
     * HALF TWO — the same bytes, rendered with and without `e-mpick-wall`, over the window
     * where the dropout is known to fire. 192x108 because the dropout's schedule is
     * resolution-independent (the component pins its own internal size) and the readback
     * is not.
     */
    const WINDOW = Array.from({ length: 21 }, (_, at) => 280 + at);
    const shootShipped = async (mutate: (graph: GraphDocument) => void): Promise<Map<number, Float64Array>> => {
      const copy = JSON.parse(JSON.stringify(graph)) as GraphDocument;
      mutate(copy);
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: copy,
        settings: { ...document.settings, outputResolution: { width: 192, height: 108 } },
        components: await starterComponentsView(),
        frames: Math.max(...WINDOW) + 1,
        capture: WINDOW,
        animate: true,
        outputNodeId: "out",
      });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      return new Map(result.frames.map((frame) => [frame.frameIndex, decodeComponents(frame.bytes, frame.format)]));
    };

    const wired = await shootShipped(() => {});
    const severed = await shootShipped((copy) => {
      delete (copy.edges as Record<string, unknown>)["e-mpick-wall"];
    });

    const moved: number[] = [];
    for (const at of WINDOW) {
      const a = wired.get(at);
      const b = severed.get(at);
      if (a === undefined || b === undefined) throw new Error(`no capture at frame ${at}`);
      let differing = 0;
      for (let component = 0; component < a.length; component += 1) {
        if ((a[component] ?? 0) !== (b[component] ?? 0)) differing += 1;
      }
      if (differing > 0) moved.push(at);
    }

    /*
     * THE CLAIM. Cutting the matte must change the frame — measured at 288-293 on
     * 2026-09-04. If this window ever comes back empty, the first thing to check is not
     * this wire but whether the source got darker: the dropout's odds scale with cell
     * brightness, so retuning `bed1` or `flare1` moves the burst.
     */
    expect(moved, "cutting the matte changed no frame in the window where the dropout fires").not.toEqual([]);

    /*
     * AND ITS SHAPE, derived rather than measured: a dropout lives DROP_LIFE = 12 shader
     * frames, and E51 runs the wall at Rate 2, so one burst is 12 / 2 = 6 RENDERED frames,
     * contiguous. A wire that leaked the matte outside the dropout — an alpha the ring or
     * the recolorizer was reading on its own account — would move frames continuously and
     * fail here while passing the assertion above.
     */
    const contiguous = moved.every((at, index) => index === 0 || at === (moved[index - 1] ?? 0) + 1);
    expect(contiguous, `the frames the matte moved are not one burst: ${moved.join(",")}`).toBe(true);
    expect(moved.length, `a burst at Rate 2 is DROP_LIFE / 2 = 6 rendered frames; got ${moved.join(",")}`).toBe(6);
  }, 300_000);
});
