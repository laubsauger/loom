import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * ═════════════════════════════════════════════════════════════════════════════════════
 * T1169 — E63's claims. THE SUBJECT IS THE CONNECTIVITY CLAIM, SO THE TESTS ARE ABOUT IT.
 * ═════════════════════════════════════════════════════════════════════════════════════
 *
 * §T1167 found that the "skin" the owner asked for already ships: `pointTopology` authors
 * the connectivity claim on a pointset edge and `geometry` in surface mode spans whatever
 * grid the edge claims. E63 puts the claim on screen three times — the same pointset drawn
 * as points, spanned with the seam open, and spanned with the seam closed — so the tests
 * that matter are the ones that would go red if the CLAIM stopped doing anything.
 *
 * The load-bearing one writes itself and it is the first below: CUT THE TOPOLOGY
 * DECLARATION AND THE FRAME MUST CHANGE. That is this project's "assert what differs if
 * the wire were cut", and it is the whole thesis of the file.
 *
 * ## Every measurement is against THE PLATE, and that is what makes it exact
 *
 * The document composites the render OVER a backdrop, and the render's background is fully
 * transparent — so `over` with a transparent front is the identity on its back layer, and a
 * pixel where nothing was drawn is BYTE-IDENTICAL to the backdrop rendered on its own. That
 * turns "you can see through it" into an exact equality rather than a threshold on
 * darkness (§V147): a see-through pixel is one whose three bytes equal the plate's.
 *
 * The panels are found the same way instead of being hard-coded thirds: a column in which
 * every row is the plate is a GUTTER, and the runs between gutters are the panels. So the
 * test locates the three tubes from the picture, and a file that lost one fails on the
 * count rather than silently measuring the wrong rectangle.
 */

/** One second and a half in: past any warm-up, and cheap. The seam is a geometric fact at
 *  every frame, so the frame index is not load-bearing for claims 1–4. */
const FRAME = 90;

/** Lattice columns — E63's `SKIN_COLS`. Claim 4 derives its texel indices from this. */
const SKIN_COLS = 96;

function e63() {
  const file = listExamples().find((entry) => entry.fileName === "E63-Skin.loom.json");
  if (file === undefined) throw new Error("E63-Skin.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

type Mutate = (graph: GraphDocument) => void;

/**
 * THE CUT. `closed1` takes `standC`'s pointset directly and the `pointTopology` node is out
 * of the path — the graph a reader would have built before they knew the node existed.
 */
const cutTopology: Mutate = (graph) => {
  const wire = graph.edges["e-seam-closed"];
  if (wire === undefined) throw new Error("E63 lost `e-seam-closed`");
  (wire as { source: { nodeId: string; portId: string } }).source = { nodeId: "standC", portId: "out" };
};

/** THE FLAG, alone: the node still in the path, claiming the lattice it was already given. */
const openTheSeam: Mutate = (graph) => {
  const seam = graph.nodes["seam"];
  if (seam === undefined) throw new Error("E63 lost `seam`");
  (seam.parameters as Record<string, unknown>)["wrapU"] = false;
};

/** Take the output from some other node — used for the plate and for the two field arms. */
const outputFrom =
  (nodeId: string): Mutate =>
  (graph) => {
    const wire = graph.edges["e-plate-out"];
    if (wire === undefined) throw new Error("E63 lost `e-plate-out`");
    (wire as { source: { nodeId: string; portId: string } }).source = { nodeId, portId: "out" };
  };

/** The field's own clock stopped. The rim light keeps turning — see the §V923 claim. */
const stillField: Mutate = (graph) => {
  const field = graph.nodes["field"];
  if (field === undefined) throw new Error("E63 lost `field`");
  (field.parameters as Record<string, unknown>)["speed"] = 0;
};

interface Shot {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

async function shoot(mutate?: Mutate, options: { frame?: number; animate?: boolean } = {}): Promise<Shot> {
  const { document } = e63();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate?.(graph);
  const frame = options.frame ?? FRAME;
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: frame + 1,
    capture: [frame],
    // The value graph OFF pins every driven slot at its retained value: the rim stops turning.
    animate: options.animate ?? true,
    outputNodeId: "out",
    fps: 60,
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const captured = result.frames[0];
  if (captured === undefined) throw new Error("no frame");
  const space = result.plan.outputs.find((entry) => entry.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    {
      width: captured.width,
      height: captured.height,
      format: captured.format,
      bytes: captured.bytes,
      rowStride: captured.width * (BYTES_PER_PIXEL[captured.format] ?? 8),
    },
    { space },
  );
  return { width: captured.width, height: captured.height, rgba: image.data };
}

const sameAt = (a: Shot, b: Shot, pixel: number): boolean =>
  a.rgba[pixel * 4] === b.rgba[pixel * 4] &&
  a.rgba[pixel * 4 + 1] === b.rgba[pixel * 4 + 1] &&
  a.rgba[pixel * 4 + 2] === b.rgba[pixel * 4 + 2];

interface Difference {
  readonly total: number;
  readonly minX: number;
  readonly maxX: number;
}

function differing(a: Shot, b: Shot): Difference {
  let total = 0;
  let minX = a.width;
  let maxX = -1;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (sameAt(a, b, y * a.width + x)) continue;
      total += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return { total, minX, maxX };
}

/** Runs of columns that draw SOMETHING, separated by columns that are plate top to bottom. */
function panelsOf(shot: Shot, plate: Shot): ReadonlyArray<readonly [number, number]> {
  const drawn = new Uint8Array(shot.width);
  for (let x = 0; x < shot.width; x += 1) {
    for (let y = 0; y < shot.height; y += 1) {
      if (!sameAt(shot, plate, y * shot.width + x)) {
        drawn[x] = 1;
        break;
      }
    }
  }
  const found: Array<readonly [number, number]> = [];
  let start = -1;
  for (let x = 0; x <= shot.width; x += 1) {
    if (x < shot.width && drawn[x] === 1) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      found.push([start, x - 1] as const);
      start = -1;
    }
  }
  return found;
}

/**
 * Pixels inside a panel's own silhouette on their row that are EXACTLY the plate — the
 * places you can see straight through whatever is drawn there. Strictly interior: the
 * margin either side of the tube is not a hole in it.
 */
function seeThrough(shot: Shot, plate: Shot, from: number, to: number): { count: number; minX: number; maxX: number } {
  let count = 0;
  let minX = shot.width;
  let maxX = -1;
  for (let y = 0; y < shot.height; y += 1) {
    let lo = -1;
    let hi = -1;
    for (let x = from; x <= to; x += 1) {
      if (sameAt(shot, plate, y * shot.width + x)) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo < 0) continue;
    for (let x = lo + 1; x < hi; x += 1) {
      if (!sameAt(shot, plate, y * shot.width + x)) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return { count, minX, maxX };
}

describe("E63 — the connectivity claim is what turns dots into a surface (T1169)", () => {
  /**
   * ⚑ THE LOAD-BEARING CLAIM. Cut `seam1` out of the graph and the frame changes.
   *
   * And it changes ONLY in the panel that node feeds, which is the second half of the same
   * statement: `pointTopology` emits no pass and owns no buffer (§V197), so it can reach
   * nothing except the consumer it republishes to. A version of this node that quietly
   * moved a point — or that recompiled a neighbour — fails on the containment, not on the
   * count.
   *
   * Measured on Dawn while writing this: 12,984 pixels differ, all of them between x = 951
   * and x = 992, inside the right panel's [807, 1069].
   */
  it("changes the frame when the topology declaration is cut, and changes nothing else", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const plate = await shoot(outputFrom("bed"));
    const shipped = await shoot();
    const cut = await shoot(cutTopology);

    const panels = panelsOf(shipped, plate);
    expect(panels, "three tubes, gutter-separated").toHaveLength(3);
    const right = panels[2] as readonly [number, number];

    const delta = differing(shipped, cut);
    // Measured 13,052. A floor two orders below it: what is asserted is "not nothing".
    expect(delta.total).toBeGreaterThan(100);
    // And the exact half: nothing outside the panel the node feeds moved AT ALL.
    expect(delta.minX).toBeGreaterThanOrEqual(right[0]);
    expect(delta.maxX).toBeLessThanOrEqual(right[1]);
  }, 240_000);

  /**
   * THE NODE'S WHOLE EFFECT IS THE FLAG — and this is the claim that says the points never
   * move. `pointTopology` with `wrapU: false` republishes exactly the lattice the edge
   * already carried, so it must be indistinguishable from not being there: not "close", not
   * "within a tolerance" — the SAME BYTES.
   *
   * Measured: 0 pixels differ between the two.
   */
  it("is byte-identical to no topology node at all once the seam flag is off", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const cut = await shoot(cutTopology);
    const flat = await shoot(openTheSeam);

    expect(differing(cut, flat).total).toBe(0);
  }, 240_000);

  /**
   * THE THREE PANELS, AS ONE MEASUREMENT. The same pointset, three claims, and the picture
   * says which is which without reading a word:
   *
   *   dots    the claim is ignored — 35,187 interior pixels show the plate through the
   *           cloud, spread across 244 columns of the tube. Nothing spans anything.
   *   open    the grid the GENERATOR published, seam open — 997 interior pixels, confined
   *           to an eight-pixel-wide band: the missing seam cell, and nothing else.
   *   closed  the same points through `seam1` — EXACTLY ZERO. The skin is closed.
   *
   * The zero is the assertion that carries this; the other two are what stop it being
   * satisfied by an empty frame.
   */
  it("draws a cloud you see through, a skin with one slit, and a skin with none", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const plate = await shoot(outputFrom("bed"));
    const shipped = await shoot();
    const panels = panelsOf(shipped, plate);
    expect(panels).toHaveLength(3);

    const [dots, open, closed] = panels as ReadonlyArray<readonly [number, number]>;
    const cloud = seeThrough(shipped, plate, dots![0], dots![1]);
    const slit = seeThrough(shipped, plate, open![0], open![1]);
    const skin = seeThrough(shipped, plate, closed![0], closed![1]);

    // Measured 35,187 over 244 columns: a lattice of billboards is mostly gaps.
    expect(cloud.count).toBeGreaterThan(10_000);
    expect(cloud.maxX - cloud.minX).toBeGreaterThan(100);
    // Measured 997 in an 8-column band (x 632..639): ONE seam, not a general leakiness.
    expect(slit.count).toBeGreaterThan(100);
    expect(slit.maxX - slit.minX).toBeLessThan(40);
    // The claim, exactly: no pixel of the closed tube shows what is behind it.
    expect(skin.count).toBe(0);
  }, 240_000);

  /**
   * ⚑ THE TRAP THIS FILE PAID FOR, AND IT IS A PROPERTY OF THE DATA.
   *
   * `wrapU` asserts that the last column is adjacent to the first. It does NOT make the
   * field periodic. `pointsFromTexture` reads a flat lattice, so without help, column 0 and
   * column 95 sample two unrelated parts of the noise and the seam cell bridges a cliff —
   * which renders as a dark crevice that looks exactly like the hole it was meant to close.
   * `fold1` (a Mirror about the field's own centre) is what makes the two edges agree.
   *
   * Asserted where the mechanism is, on the two texels the lattice's first and last columns
   * actually read — `floor(((col + 0.5) / cols) * width)`, the shader's own arithmetic, so
   * texels 6 and 1273 of a 1280-wide field. Folded they are EQUAL, byte for byte, on every
   * row. Raw they differ by up to 16/255.
   */
  it("folds the field so the two columns the seam joins actually agree", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const raw = await shoot(outputFrom("field"));
    const folded = await shoot(outputFrom("fold"));

    const firstTexel = Math.floor((0.5 / SKIN_COLS) * raw.width);
    const lastTexel = Math.floor(((SKIN_COLS - 0.5) / SKIN_COLS) * raw.width);
    expect([firstTexel, lastTexel]).toEqual([6, 1273]);

    const worst = (shot: Shot): number => {
      let most = 0;
      for (let y = 0; y < shot.height; y += 1) {
        const a = shot.rgba[(y * shot.width + firstTexel) * 4] ?? 0;
        const b = shot.rgba[(y * shot.width + lastTexel) * 4] ?? 0;
        most = Math.max(most, Math.abs(a - b));
      }
      return most;
    };

    // The trap, reproduced: the raw field disagrees across the seam by up to 16/255.
    expect(worst(raw)).toBeGreaterThan(4);
    // And closed: the folded field agrees EXACTLY, which is why the seam is invisible.
    expect(worst(folded)).toBe(0);
  }, 240_000);

  /**
   * §V923 — TWO CLOCKS, CUT ONE AT A TIME.
   *
   * E57 shipped a "frames differ" claim that passed over a FROZEN camera, because a second,
   * slower clock kept changing pixels. This file has exactly two: the 4D noise under the
   * skin, and the rim light's turning direction. So each is cut ALONE and must still leave
   * the other visible — and cutting BOTH must leave a frame that does not change by one
   * byte, which is the only thing that proves the pair is the whole of the motion.
   *
   * Measured as mean |Δ| linear luma over the instrument's own 120-frame gap, across the
   * whole minute: shipped 2.73e-2, field cut 8.33e-3, light cut 2.48e-2, both cut 0.0000
   * exactly (29 windows each). Here, cheaply, as differing pixels between two frames.
   */
  it("keeps moving with either clock cut, and stops dead with both", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const pair = async (mutate: Mutate | undefined, animate: boolean): Promise<number> => {
      const early = await shoot(mutate, { frame: 120, animate });
      const late = await shoot(mutate, { frame: 240, animate });
      return differing(early, late).total;
    };

    expect(await pair(undefined, true)).toBeGreaterThan(10_000);
    // The field frozen: the light alone still moves the frame.
    expect(await pair(stillField, true)).toBeGreaterThan(10_000);
    // The light frozen (the value graph off, every slot at its retained value): the field alone does.
    expect(await pair(undefined, false)).toBeGreaterThan(10_000);
    // Both frozen: not "small". Nothing.
    expect(await pair(stillField, false)).toBe(0);
  }, 600_000);
});
