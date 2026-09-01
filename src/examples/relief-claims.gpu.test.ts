import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T797 — E27's claims, and every one of them is measured on a DARK SOURCE.
 *
 * The owner's report was "relief when driving with camera and a rather dark image is kind
 * a boring". Nothing in the catalogue could have caught it: every gate, every look pass
 * and the whole look baseline render this file's understudy, and **the understudy is
 * LIT**. That is why the behaviour shipped, and it is why this file exists — a fixture
 * that cannot tell apart the thing its test asserts is not a fixture (§V461).
 *
 * THE DARK FIXTURE. The same understudy, one fourteenth of the light: `bed1.brightness`
 * and `swell1.fillcolor` both scaled by 0.14. Deliberately a SCALE and nothing else — the
 * picture, its shape, its motion and its timing are untouched, so any difference these
 * tests measure is the graph's response to LEVEL and cannot be a response to content.
 *
 * Read display-encoded off the Output's own space (§V618), at the project resolution,
 * because additive point density is resolution-dependent (§V627).
 */

const DIM = 0.14;

/** The mechanism under test: relief ∝ luminance, so a dark room has no relief. */
const FLAT_CEILING = 0.03;
/** What the rebuilt file must clear on the same dark input. */
const LIVELY_FLOOR = 0.12;

function e27() {
  const file = listExamples().find((entry) => entry.fileName === "E27-Relief.loom.json");
  if (file === undefined) throw new Error("E27-Relief.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** THE DARK ROOM. One scale on the understudy's two halves; nothing else moves. */
function dimmed(graph: GraphDocument): void {
  const bed = graph.nodes["bed"];
  const swell = graph.nodes["swell"];
  if (bed === undefined || swell === undefined) throw new Error("E27 lost `bed`/`swell`");
  const brightness = (bed.parameters as Record<string, unknown>)["brightness"];
  if (typeof brightness !== "number") throw new Error("`bed1.brightness` is not a number");
  (bed.parameters as Record<string, unknown>)["brightness"] = brightness * DIM;
  const fill = (swell.parameters as Record<string, unknown>)["fillcolor"];
  if (!Array.isArray(fill)) throw new Error("`swell1.fillcolor` is not a colour");
  (swell.parameters as Record<string, unknown>)["fillcolor"] = [
    (fill[0] as number) * DIM,
    (fill[1] as number) * DIM,
    (fill[2] as number) * DIM,
    1,
  ];
}

/**
 * OPEN THE EXPOSURE LOOP — the control that makes this a crossing rather than a picture.
 * `norm1.whitelevel` goes back to a static 1.0, which is exactly what the file did before
 * T797 (and exactly what it silently falls back to if `roofsafe1` is ever renamed, since
 * a measured channel IS its node's name, §V129).
 */
function unmetered(graph: GraphDocument): void {
  const norm = graph.nodes["norm"];
  if (norm === undefined) throw new Error("E27 lost `norm`");
  (norm.parameters as Record<string, unknown>)["whitelevel"] = 1;
}

/** Cut the motion out of the height, leaving luminance alone in alpha. */
function stillHeight(graph: GraphDocument): void {
  const edge = (graph.edges as Record<string, { source: { nodeId: string; portId: string } }>)[
    "e-stir-heat"
  ];
  if (edge === undefined) throw new Error("E27 lost `e-stir-heat`");
  edge.source = { nodeId: "norm", portId: "out" };
}

interface Reading {
  /** Mean display-encoded luma, 0..1. The "is there a picture" number. */
  readonly mean: number;
  /** Fraction of pixels above half. The "does it reach the palette's top" number. */
  readonly bright: number;
  /** Per-pixel mean |Δ| against another frame, filled by `compare`. */
  readonly luma: Float64Array;
}

async function shoot(
  mutate: (graph: GraphDocument) => void,
  frame: number,
): Promise<Reading> {
  const { document } = e27();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: frame + 1,
    capture: [frame],
    animate: true,
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
  const luma = new Float64Array(image.data.length / 4);
  let sum = 0;
  let bright = 0;
  for (let at = 0, pixel = 0; at < image.data.length; at += 4, pixel += 1) {
    const value =
      (0.2126 * (image.data[at] ?? 0) +
        0.7152 * (image.data[at + 1] ?? 0) +
        0.0722 * (image.data[at + 2] ?? 0)) /
      255;
    luma[pixel] = value;
    sum += value;
    if (value > 0.5) bright += 1;
  }
  return { mean: sum / luma.length, bright: bright / luma.length, luma };
}

/** Mean per-pixel |Δ| between two readings of the same size. */
function compare(a: Reading, b: Reading): number {
  let total = 0;
  for (let at = 0; at < a.luma.length; at += 1) total += Math.abs((a.luma[at] ?? 0) - (b.luma[at] ?? 0));
  return total / a.luma.length;
}

describe("E27 sets its own exposure, and a dark room still gets a relief (T797)", () => {
  /**
   * THE LEAD CLAIM, and it is a PAIR because a single number cannot say "rescued".
   *
   * The unmetered arm is the shipped file before T797: `norm1` at a static white point,
   * the source arriving one fourteenth as bright, and every point in the sheet compressed
   * into a band near zero — a flat navy rectangle. The metered arm is the same graph with
   * `roof1` allowed to say how bright the frame actually is.
   *
   * Measured on Dawn while writing this: 0.0163 unmetered against 0.1977 metered, and
   * bright pixels 0.00% against 9.5%. The thresholds sit far from both.
   */
  it("recovers a dark source that the open loop leaves flat", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const open = await shoot((graph) => {
      dimmed(graph);
      unmetered(graph);
    }, 90);
    const closed = await shoot(dimmed, 90);

    // Measured 0.0163: the report, reproduced. A flat, near-black plate.
    expect(open.mean).toBeLessThan(FLAT_CEILING);
    expect(open.bright).toBeLessThan(0.001);
    // Measured 0.1977 and 9.5% — past what the LIT understudy reads (0.1713 before T797).
    expect(closed.mean).toBeGreaterThan(LIVELY_FLOOR);
    expect(closed.bright).toBeGreaterThan(0.02);
  }, 240_000);

  /**
   * THE READING THAT WAS WRONG, ASSERTED SO IT STAYS CORRECTED.
   *
   * The natural intuition — the owner's, and it was mine until the frame said otherwise —
   * is that a dark scene has little luminance but plenty of motion, so the motion term
   * carries the frame exactly where the luminance term is starved. It does not: a frame
   * difference of a dark picture is dark by the same factor. Motion is not an alternative
   * to the exposure, it is DOWNSTREAM of it.
   *
   * Measured: 0.0163 with the motion rig and the loop open, against 0.0159 with neither —
   * a 2% difference on a number that has to move by an order of magnitude to matter. This
   * is the assertion that stops someone "simplifying" `norm1` away on the grounds that
   * E41 proved motion is enough.
   */
  it("is NOT rescued by the motion term alone — a dark difference is still dark", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const motionOnly = await shoot((graph) => {
      dimmed(graph);
      unmetered(graph);
    }, 90);
    const neither = await shoot((graph) => {
      dimmed(graph);
      unmetered(graph);
      stillHeight(graph);
    }, 90);

    expect(motionOnly.mean).toBeLessThan(FLAT_CEILING);
    expect(neither.mean).toBeLessThan(FLAT_CEILING);
    // Both flat, and indistinguishably so: under a tenth of the gap the metering opens.
    expect(Math.abs(motionOnly.mean - neither.mean)).toBeLessThan(0.01);
  }, 240_000);

  /**
   * AND THE MOTION TERM IS NOT DECORATION EITHER, once the exposure is closed.
   *
   * The same frame with `stir1` bypassed differs by a mean 0.073 per pixel over more than
   * a third of the frame (measured 0.0734 / 55.5% above 5/255 at 1280x720). Asserted as a
   * COMPARISON rather than a level, because §V712's lesson is that a still frame's summary
   * statistics read identically with the wiring mis-owned.
   */
  it("adds real height where the picture moves, on top of the exposure", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const withMotion = await shoot(dimmed, 90);
    const without = await shoot((graph) => {
      dimmed(graph);
      stillHeight(graph);
    }, 90);

    expect(withMotion.mean).toBeGreaterThan(LIVELY_FLOOR);
    expect(without.mean).toBeGreaterThan(LIVELY_FLOOR);
    // The height changed, not just the exposure.
    expect(compare(withMotion, without)).toBeGreaterThan(0.02);
  }, 240_000);

  /**
   * FRAME 0 HAS NO FLASH, and this is the gate for §V769's thumbnail against §V732's
   * transient.
   *
   * A Cache tap reads the oldest slice WRITTEN (§V229) — and on frame 0 nothing has been
   * written, so it reads black and a difference taken against the live source is the whole
   * picture. Before `now1` was put on the near side, frame 0 measured 0.256 against a
   * steady 0.178: the sheet opened over-lifted and blown, which is exactly the transient
   * §V732 records being baked into a baseline and passing.
   *
   * Asserted as frame 0 AGAINST frame 2, because the absolute level is what the look
   * baseline already guards; what this test is for is that the two agree.
   */
  it("opens on its subject rather than on the cache's empty first difference", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const first = await shoot(() => {}, 0);
    const settled = await shoot(() => {}, 2);

    // Measured 0.1752 against 0.1738 — under 2%. The pre-`now1` file ran +44%.
    expect(first.mean / settled.mean).toBeGreaterThan(0.85);
    expect(first.mean / settled.mean).toBeLessThan(1.15);
  }, 240_000);
});
