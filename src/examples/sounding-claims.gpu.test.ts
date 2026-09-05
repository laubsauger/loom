import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import type { GraphDocument } from "../domain/types/graph.ts";

/**
 * E44 SOUNDING — THE CLAIMS (T755).
 *
 * The picture is a point cloud lifted by a depth map, and a screenshot cannot tell a real
 * relief from a plausible one. So these read the POSITION BUFFER the lattice writes and
 * assert against depth maps whose answer is known analytically — §V681's shape: the claim
 * is about correspondence between an input and a geometry, so it is asserted on the
 * geometry, not on pixels.
 *
 * The feed is a RECORDED result, never a live model: inference is not byte-comparable
 * across machines and a gate that downloaded 94 MB would be neither hermetic nor
 * reproducible. What is under test is the composition, which is ours.
 */

const document = EXAMPLE_DOCUMENTS.find((entry) => entry.name === "E44 Sounding");
const SIZE = 128;
/* T1076: a one-attribute producer's packed buffer IS the position region. */
const POSITION = pointStorageId("cloud");
/* T1205: and the same, for the positions AFTER `xform1` — the ones actually drawn. */
const DRAWN = pointStorageId("xform");

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/* T959: the result texture is r32float — one float per texel, fed as a byte view over
   the float buffer, exactly as the model runner uploads. `level` keeps its 0..255
   spelling so every measured number below keeps meaning (128 is still the mid-grey). */

/** A depth map of one flat level. */
function flat(level: number): Uint8Array {
  const floats = new Float32Array(SIZE * SIZE).fill(level / 255);
  return new Uint8Array(floats.buffer);
}

/** Dark on the left, bright on the right — a known, monotonic ramp across x. */
function rampX(): Uint8Array {
  const floats = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      floats[y * SIZE + x] = x / (SIZE - 1);
    }
  }
  return new Uint8Array(floats.buffer);
}

async function positions(map: Uint8Array): Promise<Float32Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document!.graph as GraphDocument,
    settings: { ...document!.settings, outputResolution: { width: SIZE, height: SIZE } },
    frames: 2,
    capture: [1],
    animate: true,
    inference: () => map,
    probeBuffers: [POSITION, DRAWN],
  } as never);
  const raw = result.buffers?.[POSITION];
  expect(raw, `no position buffer for ${POSITION}`).toBeDefined();
  const drawn = result.buffers?.[DRAWN];
  expect(drawn, `no position buffer for ${DRAWN}`).toBeDefined();
  return new Float32Array(raw!);
}

/** Both halves of the chain at once: what the bridge reads, and what the draw draws. */
async function bothSides(map: Uint8Array): Promise<{ read: Float32Array; drawn: Float32Array }> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document!.graph as GraphDocument,
    settings: { ...document!.settings, outputResolution: { width: SIZE, height: SIZE } },
    frames: 2,
    capture: [1],
    animate: true,
    inference: () => map,
    probeBuffers: [POSITION, DRAWN],
  } as never);
  const read = result.buffers?.[POSITION];
  const drawn = result.buffers?.[DRAWN];
  expect(read, `no position buffer for ${POSITION}`).toBeDefined();
  expect(drawn, `no position buffer for ${DRAWN}`).toBeDefined();
  return { read: new Float32Array(read!), drawn: new Float32Array(drawn!) };
}

/** vec3f in a storage buffer is 16-byte aligned, so z sits at lane 2 of every 4. */
function zOf(data: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 2; i < data.length; i += 4) out.push(data[i]!);
  return out;
}

describe("E44 Sounding — the depth map IS the geometry", () => {
  /**
   * §T385's whole design, exercised for the first time by any example: with no model the
   * node publishes flat mid-grey, and mid-grey is the value that means NO DISPLACEMENT.
   * A document using Depth therefore opens and renders on a machine that cannot run it.
   */
  it("gives NO relief for the mid-grey a missing model publishes", async () => {
    if (dawnError !== undefined) return;
    const z = zOf(await positions(flat(128)));
    expect(z.length).toBeGreaterThan(1000);
    const spread = Math.max(...z) - Math.min(...z);
    expect(spread).toBeLessThan(0.01);
    // And it is flat at the ORIGIN plane, not parked somewhere off-camera: 128/255 is
    // half a hair over 0.5, so the residual is a fraction of a percent of `depth`.
    expect(Math.abs(z[0]!)).toBeLessThan(0.01);
  });

  it("lifts a bright map and drops a dark one, in opposite directions from that plane", async () => {
    if (dawnError !== undefined) return;
    const bright = zOf(await positions(flat(255)));
    const dark = zOf(await positions(flat(0)));
    expect(bright[0]!).toBeGreaterThan(0.9);
    expect(dark[0]!).toBeLessThan(-0.9);
    // Symmetric about the mid-grey plane, because 0 and 255 are equidistant from 128.
    expect(Math.abs(bright[0]! + dark[0]!)).toBeLessThan(0.02);
  });

  /**
   * The strong claim: a KNOWN ramp produces a KNOWN geometry. Left-to-right brightness
   * must become left-to-right height, monotonically, with no reliance on how it looks.
   */
  it("turns a left-to-right ramp into a left-to-right rise, monotonically", async () => {
    if (dawnError !== undefined) return;
    const data = await positions(rampX());
    const cols = 96;
    const row = 30;
    const heights: number[] = [];
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      heights.push(data[index * 4 + 2]!);
    }
    // Every step rises. A single reversal would mean the lattice is not reading the map
    // it was handed — the failure a picture cannot show.
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeGreaterThan(heights[i - 1]! - 1e-4);
    }
    expect(heights.at(-1)! - heights[0]!).toBeGreaterThan(1.5);
  });

  it("places one point per lattice cell, so the count IS cols x rows", async () => {
    if (dawnError !== undefined) return;
    const z = zOf(await positions(flat(128)));
    expect(z.length).toBe(96 * 72);
  });

  /**
   * T830 — the fix the owner's report demanded. The boxes used to carry a CONSTANT colour,
   * so the cloud was a grey lattice that said nothing about the picture. `tint1`
   * (textureToAttribute) now samples the SOURCE at each point, so every box carries the
   * video's own colour and the cloud is the picture standing up in depth. The claim is
   * §V681-shaped: the colour is a per-point CORRESPONDENCE to the source, so it is asserted
   * on the attribute buffer, not on pixels. A depth map alone (a flat mid-grey) would give
   * a constant tint; the real source (the moving orb over the perlin bed) does not.
   */
  /* T1076: `textureToAttribute` owns `sample` alone, so its buffer IS that region. */
  const SAMPLE = pointStorageId("tint");
  async function tintSamples(map: Uint8Array): Promise<Float32Array> {
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: document!.graph as GraphDocument,
      settings: { ...document!.settings, outputResolution: { width: SIZE, height: SIZE } },
      frames: 2,
      capture: [1],
      animate: true,
      inference: () => map,
      probeBuffers: [SAMPLE],
    } as never);
    const raw = result.buffers?.[SAMPLE];
    expect(raw, `no sample buffer for ${SAMPLE}`).toBeDefined();
    return new Float32Array(raw!);
  }

  it("tints every box from the SOURCE, so the cloud carries the picture, not a constant", async () => {
    if (dawnError !== undefined) return;
    // A flat depth map parks nothing (its alpha is opaque), so all 6912 points are present
    // and each one's COLOUR comes from the real source — the orb over the bed, which varies.
    const data = await tintSamples(flat(128));
    const reds: number[] = [];
    for (let i = 0; i < data.length; i += 4) reds.push(data[i]!);
    expect(reds.length).toBe(96 * 72);

    // Valid linear colour, every point (§V313: the attribute is LINEAR by declaration).
    for (const r of reds) expect(r).toBeGreaterThanOrEqual(0);
    // The load-bearing claim: the tint VARIES across the cloud. A constant colour — the old
    // bug, or a bridge sampling nothing — has zero spread; the source's own structure does
    // not. The orb is a bright disc on a dim bed, so the spread is large and real.
    const spread = Math.max(...reds) - Math.min(...reds);
    expect(spread).toBeGreaterThan(0.1);
  });

  /**
   * T1205 — `xform1` SIZES THE CLOUD, AND IT HAS TO DO IT WITHOUT BREAKING §T830.
   *
   * The two are in tension and that tension is the reason the node is in this file.
   * `cloud1.sizeX/sizeY` are pinned at 2.0 because `tint1` reads `position.xy` back as a
   * UV, so the producer's size is a DATA CONTRACT and not a framing choice; the picture
   * still needed to be bigger. So the transform sits downstream of the bridge, and both
   * halves are asserted here at once: the cloud the bridge saw is still on the clip square,
   * and the cloud the draw gets is 1.2× wider about the same middle.
   *
   * The ratio is derived from the read-back extents rather than from the authored 1.2, so
   * a transform that scaled by the wrong amount, about the wrong pivot, or not at all is a
   * different number here. And the centroid claim is the half that separates this from a
   * plain multiply: scaling about the origin would move the cloud's middle by the same 1.2
   * and pass the extent assertion on its own.
   */
  it("grows the DRAWN cloud past the clip square while the bridge still reads it on one", async () => {
    if (dawnError !== undefined) return;
    /* flat(200), NOT flat(128), and the difference is load-bearing — see the pivot claim
       at the bottom. A mid-grey map puts the sheet at z ~ 0, and a cloud whose middle is
       the origin cannot tell a centroid pivot from an origin one. 200 stands it off at
       z ~ 0.54, where the two answers differ. */
    const { read, drawn } = await bothSides(flat(200));

    const spanAndMiddle = (data: Float32Array, axis: number): { span: number; middle: number } => {
      let lo = Infinity;
      let hi = -Infinity;
      let total = 0;
      let seen = 0;
      for (let i = axis; i < data.length; i += 4) {
        const value = data[i] as number;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
        total += value;
        seen += 1;
      }
      return { span: hi - lo, middle: total / seen };
    };

    // THE EXTENT, on the two axes the lattice actually spans.
    for (const axis of [0, 1]) {
      const before = spanAndMiddle(read, axis);
      const after = spanAndMiddle(drawn, axis);

      // §T830 SURVIVES: the bridge's cloud sits inside the clip square, which is the only
      // reason `tint1` can read a position back as a UV at all. If a later hand moved the
      // transform above the bridge, this is what says so.
      expect(before.span, `axis ${axis} is not on the clip square any more`).toBeLessThanOrEqual(2);

      // …and the drawn cloud is 1.2x of it. Derived from the measurement rather than
      // asserted at the authored number, so "it scaled by something" does not pass.
      expect(after.span / before.span, `axis ${axis} scale`).toBeCloseTo(1.2, 4);
    }

    /* ⚑ THE PIVOT, AND IT IS PINNED ON Z FOR A REASON WORTH WRITING DOWN. On x and y this
       lattice is symmetric about the origin, so its middle IS the origin — and a cloud
       centred on the origin cannot distinguish a centroid pivot from an origin one, because
       1.2 x 0 is 0. The claim would read as green while saying nothing. In z the sheet
       stands off at ~0.54, so the two answers are 0.54 and 0.65 and only one of them is
       "it grew where it stood". */
    const beforeZ = spanAndMiddle(read, 2);
    const afterZ = spanAndMiddle(drawn, 2);
    expect(beforeZ.middle, "the fixture must stand the sheet OFF z=0 or the next line is vacuous")
      .toBeGreaterThan(0.1);
    expect(afterZ.middle, "the cloud's middle moved — that is an origin pivot, not a centroid one")
      .toBeCloseTo(beforeZ.middle, 5);
  });
});
