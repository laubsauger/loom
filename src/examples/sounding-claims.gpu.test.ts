import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { pointPairId } from "../nodes/definitions/points.ts";
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
const POSITION = pointPairId("cloud", "position");

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
    probeBuffers: [POSITION],
  } as never);
  const raw = result.buffers?.[POSITION];
  expect(raw, `no position buffer for ${POSITION}`).toBeDefined();
  return new Float32Array(raw!);
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
  const SAMPLE = pointPairId("tint", "sample");
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
});
