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

/** A depth map of one flat level. */
function flat(level: number): Uint8Array {
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    bytes[i * 4] = level;
    bytes[i * 4 + 1] = level;
    bytes[i * 4 + 2] = level;
    bytes[i * 4 + 3] = 255;
  }
  return bytes;
}

/** Dark on the left, bright on the right — a known, monotonic ramp across x. */
function rampX(): Uint8Array {
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const level = Math.round((x / (SIZE - 1)) * 255);
      const at = (y * SIZE + x) * 4;
      bytes[at] = level;
      bytes[at + 1] = level;
      bytes[at + 2] = level;
      bytes[at + 3] = 255;
    }
  }
  return bytes;
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
});
