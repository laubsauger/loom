import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import { MATTE_INPUT_SIDE, matteCoverage } from "../../runtime/models/matte-runner.ts";

/**
 * THE MATTE, ON REAL HARDWARE, MEASURED AS THE VALUE A CONSUMER READS (§T957, §V288).
 *
 * The owner reported the matte as "completely broken… it doesn't seem to do the thing",
 * twice, over a node that was working. Every stage was measured on 2026-09-03 and every
 * stage was correct: MODNet on the exact packing this node produces returns a clean person
 * matte (mean 0.281 of the frame claimed, identical on the wasm and webgpu providers), the
 * GPU preprocess writes the letterboxed SOURCE into the model buffer, the un-letterbox is
 * right, and the EMA passes its first result through untouched. What was missing was any
 * way to tell that from a broken one, because a matte publishes the same picture either way.
 *
 * These two gates therefore hold the halves that a black picture cannot report:
 *
 *  - THE INPUT IS THE PICTURE. A preprocess reading the node's own output instead of its
 *    input would be a feedback loop converging to black — a matte that "creeps toward
 *    nothing" and reports no error at all, which is exactly the symptom that was described
 *    and exactly the thing that would never show up in a fed-result test.
 *  - THE RESULT ARRIVES AT ITS OWN STRENGTH. Feed a known matte and require the PIXELS to
 *    carry it: inside a known subject region, outside it, and as the coverage the seam
 *    publishes. A pipeline that crushed the matte on the way to the picture — the failure
 *    "the matte returns to near-zero" names — moves all three.
 *
 * Deliberately NOT here: a run of the real model. It would download 25 MB and give
 * different numbers on different backends, which is neither hermetic nor reproducible
 * (§V742 is the reason this harness replays results rather than computing them). The model
 * itself is exercised out of band; what these gates own is everything between it and the
 * screen.
 */

const SIZE = 64;

/** The side MODNet is fed at, and therefore the stride of the model-input buffer. */
const MODEL_SIDE = MATTE_INPUT_SIDE;

function settingsAt(width: number, height: number) {
  return {
    outputResolution: { width, height },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65_535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
  } as never;
}

const SETTINGS = settingsAt(SIZE, SIZE);

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id } as never;
}

function edge(id: string, from: [string, string], to: [string, string]) {
  return { id, source: { nodeId: from[0], portId: from[1] }, target: { nodeId: to[0], portId: to[1] } };
}

function matteGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: node("src", "noise", { type: "simplex2d", period: 0.2 }),
      cut: node("cut", "matte", {}),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["src", "out"], ["cut", "input"]),
      e2: edge("e2", ["cut", "out"], ["out", "input"]),
    },
    groups: {},
  } as never;
}

const WIDE_SETTINGS = settingsAt(512, 256);

/** A 2:1 vertical ramp into the matte — depth-aspect's own probe picture. */
function rampMatteGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: {
        id: "src",
        type: "ramp",
        definitionVersion: 2,
        position: { x: 0, y: 0 },
        parameters: {
          type: "vertical",
          interp: "linear",
          phase: 0,
          period: 1,
          stops: [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 1, color: [1, 1, 1, 1] },
          ],
        },
        label: "src",
      },
      cut: node("cut", "matte", {}),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["src", "out"], ["cut", "input"]),
      e2: edge("e2", ["cut", "out"], ["out", "input"]),
    },
    groups: {},
  } as never;
}

/** A known matte: 1 inside a centred disc of radius SIZE/4, 0 outside. r32float bytes. */
function disc(width: number, height: number): Uint8Array {
  const floats = new Float32Array(width * height);
  const radius = Math.min(width, height) / 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot(x - width / 2 + 0.5, y - height / 2 + 0.5);
      floats[y * width + x] = d < radius ? 1 : 0;
    }
  }
  return new Uint8Array(floats.buffer);
}

function discMatte(): Uint8Array {
  return disc(SIZE, SIZE);
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * The matte's own value, back out of the rendered frame (§V838, learned the hard way HERE).
 *
 * The output surface is `encoded`: the sink applies the display transfer on the way out, so
 * a matte of 0.6 lands in these bytes as 0.7974 — sRGB(0.6) to four decimals. A first draft of this
 * file read the half floats raw, called the result "linear", and would have reported a
 * matte that was 33% too strong as correct. That is §V838's trap taken from the other side:
 * a measurement AFTER a transfer cannot see the value before it.
 *
 * So the plan is asked which space it declared for the surface, and the declared transfer
 * is inverted. `space` comes from the plan rather than from an assumption, because a sink
 * that stopped encoding would then make this stop decoding rather than silently double.
 */
function matteValues(
  frame: { width: number; height: number; bytes: Uint8Array },
  space: string,
): Float32Array {
  const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
  const out = new Float32Array(frame.width * frame.height);
  const decode = (v: number): number =>
    space === "encoded" || space === "display"
      ? v <= 0.04045
        ? v / 12.92
        : ((v + 0.055) / 1.055) ** 2.4
      : v;
  for (let i = 0; i < out.length; i += 1) out[i] = decode(halfToFloat(view.getUint16(i * 8, true)));
  return out;
}

/** The space the sink declared for the surface these frames were read from. */
function spaceOf(plan: { outputs: ReadonlyArray<{ resourceId: string; space?: string }> }, id: string): string {
  return plan.outputs.find((output) => output.resourceId === id)?.space ?? "encoded";
}

describe("the matte's model input is the picture", () => {
  it("holds the SOURCE, not the node's own previous output", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: rampMatteGraph(),
      settings: WIDE_SETTINGS,
      frames: 3,
      capture: [2],
      /*
       * A DISTINCTIVE fed matte — 1 inside a centred disc, 0 outside — and three frames, so
       * the node's output has been written twice before the buffer is read. If the
       * preprocess ever read the node's own target instead of its input, this buffer would
       * hold the DISC (or, once the loop had converged, nothing at all) rather than the
       * ramp, and the row probes below would not be a ramp in any ordering.
       */
      inference: () => disc(512, 256),
      probeBuffers: ["scratch:cut:modelInput"],
    } as never);
    const buffer = result.buffers?.["scratch:cut:modelInput"];
    expect(buffer).toBeDefined();
    const texels = new Float32Array(buffer!);
    // vec4f per model texel, side x side of them: a short buffer means the readback, not
    // the shader, and would make every probe below index the wrong rows.
    expect(texels.length).toBe(MODEL_SIDE * MODEL_SIDE * 4);

    const rowValue = (row: number) => texels[(row * MODEL_SIDE + MODEL_SIDE / 2) * 4]!;
    /*
     * T974's letterbox, read as depth-aspect reads it: a 2:1 source occupies the centred
     * vertical HALF of the model square with the bars edge-replicated. The squeeze this
     * replaced would read ~0.125 at the top-bar probe instead of ~0.
     */
    expect(rowValue(MODEL_SIDE / 8)).toBeLessThan(0.03);
    expect(rowValue(MODEL_SIDE / 2)).toBeCloseTo(0.5, 1);
    expect(rowValue((MODEL_SIDE * 7) / 8)).toBeGreaterThan(0.97);
    // Uniform scale INSIDE the band, which is what makes it a letterbox rather than a crop.
    expect(rowValue((MODEL_SIDE * 3) / 8)).toBeCloseTo(0.25, 1);
    expect(rowValue((MODEL_SIDE * 5) / 8)).toBeCloseTo(0.75, 1);

    // And the disc that was fed is NOWHERE in it: the fed matte is 0 or 1 everywhere, so a
    // buffer holding it could not produce the graded band above. Asserted directly anyway,
    // because "it happens to look like a ramp" is not the claim — "it is the input" is.
    const distinct = new Set<number>();
    for (let row = 0; row < MODEL_SIDE; row += 1) distinct.add(Math.round(rowValue(row) * 64));
    expect(distinct.size).toBeGreaterThan(8);
  }, 240_000);
});

describe("the matte reaches the picture at full strength", () => {
  /**
   * ⚠ THE GATE THAT FAILS IF THE MATTE GOES BACK TO NEAR-ZERO.
   *
   * It asserts the VALUE a consumer reads, in three ways that a crushed matte moves and a
   * mechanism check would not: the linear level inside a known subject region, the level
   * outside it, and the coverage the seam publishes to the notice strip and to
   * `<name>:coverage`. §V838 — read from the LINEAR target, never a display-encoded frame,
   * so a level that is dimmed on the way to the picture cannot hide under an encode.
   */
  it("publishes a fed matte's own values, inside and outside the subject", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const fed = discMatte();
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: matteGraph(),
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => fed,
    } as never);
    const frame = result.frames[0]!;
    const red = matteValues(frame, spaceOf(result.plan as never, result.outputResourceId as never));

    let inside = 0;
    let insideN = 0;
    let outside = 0;
    let outsideN = 0;
    let claimed = 0;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const d = Math.hypot(x - SIZE / 2 + 0.5, y - SIZE / 2 + 0.5);
        const v = red[y * SIZE + x]!;
        claimed += v;
        // Bands, not the disc edge: an inside/outside split taken AT the boundary would
        // measure the antialiasing rather than the matte.
        if (d < SIZE / 6) {
          inside += v;
          insideN += 1;
        } else if (d > SIZE / 3) {
          outside += v;
          outsideN += 1;
        }
      }
    }

    // A full-alpha subject arrives at full alpha. Anything that halved, gamma-ed or
    // premultiplied the matte on the way here lands below this.
    expect(inside / insideN).toBeGreaterThan(0.99);
    // And nothing leaks into the background — a matte that claimed the whole frame would
    // be as wrong as one that claimed none of it, in the other direction.
    expect(outside / outsideN).toBeLessThan(0.01);

    /*
     * THE SAME FACT, AS THE NUMBER THE APP REPORTS. `matteCoverage` is what the notice
     * strip and the `<name>:coverage` channel read, so the picture and the readout must
     * agree — a readout that stayed healthy while the picture went black would be §V288's
     * own defect one layer up.
     *
     * WITHIN A TEXEL, not exactly, and the slack is named rather than tuned: the result
     * blit resolves its nearest texel as `uv * (dims - 1)`, which dilates a hard edge by
     * about half a texel. On a disc 32 texels across that is a perimeter-over-area effect
     * of roughly 2/r = 6%, and the measured 0.198 -> 0.214 is exactly that. The uniform
     * case below carries the no-crush claim with no edges at all, so this bound is allowed
     * to be loose without the pair of them being loose.
     */
    expect(Math.abs(claimed / (SIZE * SIZE) - matteCoverage(fed))).toBeLessThan(0.03);
    expect(matteCoverage(fed)).toBeGreaterThan(0.001);
  }, 240_000);

  /**
   * The no-crush claim with NO EDGES, so nothing can hide in a resample: a flat matte at a
   * level chosen to be nobody's default arrives at exactly that level.
   *
   * The failure this is aimed at is the one the owner described — the matte "creeping
   * toward nothing" — and any stage that scaled, gamma-ed, premultiplied or averaged the
   * matte on the way to the picture moves this number off 0.6 and cannot move it back.
   */
  it("carries a flat matte through at exactly its own level", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const level = 0.6;
    const flat = new Uint8Array(new Float32Array(SIZE * SIZE).fill(level).buffer);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: matteGraph(),
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => flat,
    } as never);
    const frame = result.frames[0]!;
    const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    let encoded = 0;
    for (let i = 0; i < SIZE * SIZE; i += 1) encoded += halfToFloat(view.getUint16(i * 8, true));
    encoded /= SIZE * SIZE;

    /*
     * ASSERTED IN THE SURFACE'S OWN DOMAIN, so the bound is arithmetic rather than taste
     * (§V147). The sink is `encoded`, so a matte of 0.6 must arrive as sRGB(0.6) = 0.797752,
     * and the only slack allowed is what the FORMAT can hold: rgba16float spaces values in
     * [0.5, 1) exactly 2^-11 apart, so one storable step is the whole budget. The measured
     * 0.797363 is one step low, which is the encode being evaluated in f32 and stored in
     * half — not a scale. Anything that dimmed, gamma-ed or premultiplied the matte moves
     * this by orders of magnitude more.
     */
    const expected = 1.055 * level ** (1 / 2.4) - 0.055;
    expect(Math.abs(encoded - expected)).toBeLessThanOrEqual(2 ** -11);
    // And the number the app reports about the same bytes is the matte's own level, with
    // no transfer applied at all — a coverage that moved with the display encode would be
    // reporting the picture rather than the measurement.
    expect(matteCoverage(flat)).toBeCloseTo(level, 6);
  }, 240_000);

  /**
   * The other end of the same measurement, and the state the owner was actually looking at:
   * the model ran and returned nothing. The picture is black — correctly — and the coverage
   * says so, which is the only thing separating this from every failure mode.
   */
  it("reports zero coverage for an empty result, and renders it as black", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const empty = new Uint8Array(new Float32Array(SIZE * SIZE).buffer);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: matteGraph(),
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => empty,
    } as never);
    const red = matteValues(result.frames[0]!, spaceOf(result.plan as never, result.outputResourceId as never));
    let claimed = 0;
    for (const v of red) claimed += v;
    expect(claimed / (SIZE * SIZE)).toBe(0);
    expect(matteCoverage(empty)).toBe(0);
    // §V839, as the pair: the two renders differ in the direction the metric names.
    expect(matteCoverage(discMatte())).toBeGreaterThan(matteCoverage(empty));
  }, 240_000);
});
