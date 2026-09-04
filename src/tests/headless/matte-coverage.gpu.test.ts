import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import { MATTE_INPUT_SIDE, matteCoverage, matteToFloats } from "../../runtime/models/matte-runner.ts";

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
     * WITHIN ONE STORABLE STEP, and the budget is the FORMAT's rather than the sampler's.
     * This bound was 0.03 until T1051, sized for a dilation that the blit no longer has:
     * `uv * (dims - 1)` read with a floor smeared a hard edge by about half a texel, which
     * on a disc 32 texels across is a perimeter-over-area effect of roughly 2/r = 6% and
     * showed up as 0.198 -> 0.214. The blit is now the identity, so the ONLY thing left
     * between the fed matte and this number is the round trip through the surface: a fed 1
     * comes back as the largest half below one, so the mean can fall short by at most one
     * rgba16float step. Measured after the fix: 0.198022 against 0.198242, a difference of
     * 0.00022 — which is the lit fraction times that one step, exactly.
     */
    expect(Math.abs(claimed / (SIZE * SIZE) - matteCoverage(fed))).toBeLessThan(2 ** -11);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHERE THE MATTE LANDS — the geometry, measured as two centroids (§V842, §T992)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner, once the matte stopped being empty: "we do see something in the matte… but it
 * is not correct." Their screenshot has the subject's head and shoulders in the UPPER
 * centre of the source and the matte's only bright region in the LOWER centre-left. A
 * result that is present but misplaced is a GEOMETRY question, and it is one the gates
 * above cannot see: they feed a synthetic matte and read it back, so any transform applied
 * identically at both ends cancels out. Self-consistency is exactly what a flip preserves.
 *
 * §T992 is the near precedent and the reason this is worth a gate of its own: pose
 * letterboxed its input and read its joints back as though it had not, putting every joint
 * off by the bar width — plausible, never visibly broken, shipped.
 *
 * ## The method, and why it is not "look at it"
 *
 * A flip, a translation and a scale all look alike by eye and are trivially separable from
 * two centroids. So this renders ONE asymmetric source — a small disc parked decisively
 * high and left of centre — and measures where its energy is in three places:
 *
 *   1. the PICTURE, as the sink renders the source itself;
 *   2. the MODEL SQUARE, from the real GPU preprocess buffer;
 *   3. the PICTURE AGAIN, after the real un-letterbox has put a matte back on it.
 *
 * Step 3 uses an IDENTITY MODEL — the model input's own luma, handed back as if it were
 * MODNet's answer — because the question is not what the model says, it is where what it
 * says ends up. With a real model in the loop the two effects could not be separated.
 *
 * §V842: centroids, never an argmax. A matte is a plateau, so an argmax picks an arbitrary
 * point on it and would report a flip and a small translation identically.
 */
describe("the matte lands where the subject is", () => {
  const W = 512;
  const H = 256;
  const GEOMETRY_SETTINGS = settingsAt(W, H);

  /** The subject: high and left, so a vertical flip and a horizontal one are both visible. */
  const DISC = { x: 0.32, y: 0.24 };

  function discGraph(withMatte: boolean): GraphDocument {
    const nodes: Record<string, unknown> = {
      src: {
        id: "src",
        type: "circle",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {
          mode: "fill",
          center: [DISC.x, DISC.y],
          radius: [0.1, 0.1],
          softness: 0.01,
          fillcolor: [1, 1, 1, 1],
          bgcolor: [0, 0, 0, 1],
          // OFF: an aspect-corrected disc on a 2:1 output is an ellipse in uv, and the
          // centroid comparison is cleaner when the shape is the same in both spaces.
          aspectcorrect: false,
        },
        label: "src",
      },
      out: node("out", "output"),
    };
    const edges: Record<string, unknown> = {};
    if (withMatte) {
      nodes["cut"] = node("cut", "matte", {});
      edges["e1"] = edge("e1", ["src", "out"], ["cut", "input"]);
      edges["e2"] = edge("e2", ["cut", "out"], ["out", "input"]);
    } else {
      edges["e1"] = edge("e1", ["src", "out"], ["out", "input"]);
    }
    return { revision: 1, nodes, edges, groups: {} } as never;
  }

  /**
   * The value-weighted centre of a single-channel field, in 0..1 of its own width and
   * height, with the row order the buffer itself has. Both measurements below come through
   * this one function, so a row-order convention cannot enter on one side only.
   */
  function centroid(values: Float32Array, width: number, height: number, stride = 1, offset = 0) {
    let total = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = Math.max(0, values[(y * width + x) * stride + offset]!);
        total += v;
        sx += v * (x + 0.5);
        sy += v * (y + 0.5);
      }
    }
    if (total <= 0) return { x: Number.NaN, y: Number.NaN, total: 0 };
    return { x: sx / total / width, y: sy / total / height, total };
  }

  it("puts the matte's energy where the source's energy is, not mirrored", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const host = nodeGpuHost();

    // 1. THE PICTURE. Where the sink actually renders the disc — no convention assumed,
    //    no parameter trusted; a `center.y` of 0.24 is only a number until this is read.
    const plain = await renderHeadless({
      host,
      graph: discGraph(false),
      settings: GEOMETRY_SETTINGS,
      frames: 1,
      capture: [0],
    } as never);
    const source = matteValues(plain.frames[0]!, "linear");
    const cSource = centroid(source, W, H);

    // 2. THE MODEL SQUARE. The real GPU preprocess, read back as the worker reads it.
    const probed = await renderHeadless({
      host,
      graph: discGraph(true),
      settings: GEOMETRY_SETTINGS,
      frames: 2,
      capture: [1],
      inference: () => null,
      probeBuffers: ["scratch:cut:modelInput"],
    } as never);
    const texels = new Float32Array(probed.buffers!["scratch:cut:modelInput"]!);
    const cModel = centroid(texels, MODEL_SIDE, MODEL_SIDE, 4, 0);

    // 3. THE PICTURE AGAIN, through the real un-letterbox, with an IDENTITY MODEL.
    const identity = new Float32Array(MODEL_SIDE * MODEL_SIDE);
    for (let i = 0; i < identity.length; i += 1) identity[i] = Math.max(0, Math.min(1, texels[i * 4]!));
    const returned = await renderHeadless({
      host,
      graph: discGraph(true),
      settings: GEOMETRY_SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => matteToFloats(identity, MODEL_SIDE, W, H),
    } as never);
    const cMatte = centroid(matteValues(returned.frames[0]!, "linear"), W, H);

    console.log(
      "centroids  source",
      JSON.stringify(cSource),
      "model",
      JSON.stringify(cModel),
      "matte",
      JSON.stringify(cMatte),
    );

    // Each stage has to have found the disc at all; a centroid of an empty field is NaN
    // and every comparison below would pass vacuously.
    expect(cSource.total).toBeGreaterThan(0);
    expect(cModel.total).toBeGreaterThan(0);
    expect(cMatte.total).toBeGreaterThan(0);

    /*
     * LEG A — the letterbox, forwards. On a 2:1 source the picture occupies the centred
     * vertical half of the model square, so the disc's height must map through
     * `(y - 0.5) * occY + 0.5` with occY = 1/aspect = 0.5, and its width must not move at
     * all. Derived from the source's MEASURED position, not from the parameter, so this
     * still holds if the sink's row order is the opposite of what anyone assumed.
     */
    expect(cModel.x).toBeCloseTo(cSource.x, 2);
    expect(cModel.y).toBeCloseTo((cSource.y - 0.5) * (H / W) + 0.5, 2);

    /*
     * LEG B — THE ROUND TRIP, and the one the owner's screenshot is about. The matte must
     * come back on the same spot the subject occupies. A vertical flip lands at 1 - y, a
     * horizontal one at 1 - x, and a letterbox left un-done lands at the model square's own
     * coordinate; all three are far outside this and are reported by the numbers above.
     */
    expect(cMatte.x).toBeCloseTo(cSource.x, 2);
    expect(cMatte.y).toBeCloseTo(cSource.y, 2);
  }, 240_000);
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHICH SOURCE TEXEL AN OUTPUT PIXEL READS — T1051, at the edges where it shows
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The result texture is written at the picture's own size (`matteToFloats` returns
 * `width * height` floats), so the blit's job is the IDENTITY: output pixel (x, y) reads
 * source texel (x, y), and nothing else does.
 *
 * `MATTE_BLIT_WGSL` shipped `vec2i(clamp(uv, 0, 1) * (dims - 1))` — the BILINEAR
 * convention, which maps uv = 1 onto the LAST texel CENTRE — read with a floor. A pixel
 * centre (x+0.5)/w then landed on floor((x+0.5)/w * (w-1)): x at the left edge, x-1 from
 * about halfway across. Two consumer-visible consequences, and this gate names both:
 *
 *   - THE LAST SOURCE COLUMN WAS UNREACHABLE. At 64 wide, output 63 read texel 62, so
 *     nothing a model wrote into column 63 could appear in the picture at all.
 *   - AN INTERIOR COLUMN WAS DUPLICATED. Texel 31 was read by outputs 31 AND 32, which is
 *     the "squeezed by one texel" the picture showed.
 *
 * §V864 is why this is not asked as a coverage or a centroid: both are aggregates, and a
 * one-texel shift moves neither out of any sane tolerance while it visibly moves the
 * subject. Where a texel landed is a WHERE question, so it is asked per pixel.
 *
 * §V147 — the classifier is DERIVED, and the third state is loud. A fed 0 arrives as
 * exactly 0 (sRGB fixes zero, and half-float holds it), and a fed 1 arrives as the largest
 * half below one, because the sink evaluates 1.055·v^(1/2.4) − 0.055 in f32 and stores the
 * result in rgba16float — the same one-step shortfall `carries a flat matte through at
 * exactly its own level` measures above. So the two legal answers are computed from that
 * step rather than guessed at, and a pixel that is NEITHER — a blend of two texels, which
 * is what a filtered read would produce — fails by name instead of being rounded into one
 * of them.
 */
describe("the matte blit reads the texel under the pixel", () => {
  /** Aligned row pitch (8 bytes per texel), non-square so a transposed read is a shape error. */
  const MW = 64;
  const MH = 32;

  /** First, last, and one interior — the edges are where an off-by-one stops being subtle. */
  const LIT_COLUMNS = [0, 31, MW - 1];
  const LIT_ROWS = [0, 15, MH - 1];

  /**
   * What a fed 1.0 reads back as: sRGB-encoded, stored one half-float step low, decoded.
   * Derived from the format's step, never from a measurement pasted back in — and rounded
   * through `fround` because `matteValues` hands back a Float32Array, so the comparison
   * has to happen in the precision the value is actually held at.
   */
  const LIT = Math.fround(((1 - 2 ** -11 + 0.055) / 1.055) ** 2.4);

  /** Lit, dark, or NEITHER — the third answer is the failure this gate is looking for. */
  function classify(value: number): "lit" | "dark" | "between" {
    if (value === 0) return "dark";
    if (value >= LIT && value <= 1) return "lit";
    return "between";
  }

  /** A result texture lit in whole columns (or rows), fed raw — no letterbox in the way. */
  function stripes(axis: "column" | "row", lit: readonly number[]): Uint8Array {
    const floats = new Float32Array(MW * MH);
    for (let y = 0; y < MH; y += 1) {
      for (let x = 0; x < MW; x += 1) {
        floats[y * MW + x] = lit.includes(axis === "column" ? x : y) ? 1 : 0;
      }
    }
    return new Uint8Array(floats.buffer);
  }

  async function renderStripes(fed: Uint8Array): Promise<Float32Array> {
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: matteGraph(),
      settings: settingsAt(MW, MH),
      frames: 1,
      capture: [0],
      inference: () => fed,
    } as never);
    const frame = result.frames[0]!;
    expect(
      [frame.width, frame.height],
      "the picture is not the size this gate fed a result for, so every index below reads the wrong texel",
    ).toEqual([MW, MH]);
    return matteValues(frame, spaceOf(result.plan as never, result.outputResourceId as never));
  }

  it.each([
    { axis: "column" as const, lit: LIT_COLUMNS },
    { axis: "row" as const, lit: LIT_ROWS },
  ])("carries a lit $axis through at its own index, edges included", async ({ axis, lit }) => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const actual = await renderStripes(stripes(axis, lit));

    /*
     * The whole picture at once, so a stripe that MOVED and a stripe that SPREAD are both
     * failures and are told apart in the message. Reported as the set of lit indices rather
     * than as the first bad pixel: "shows [0, 31, 32] where [0, 31, 63] was fed" says what
     * happened; "pixel (32, 0) is 0.9989" does not.
     */
    const litIndices: number[] = [];
    const count = axis === "column" ? MW : MH;
    const span = axis === "column" ? MH : MW;
    for (let index = 0; index < count; index += 1) {
      const seen = new Set<string>();
      for (let along = 0; along < span; along += 1) {
        const value = axis === "column" ? actual[along * MW + index]! : actual[index * MW + along]!;
        seen.add(classify(value));
      }
      expect(
        [...seen].sort(),
        `${axis} ${index} is not one value down its whole length — the blit is reading more than the texel under the pixel`,
      ).toHaveLength(1);
      if (seen.has("lit")) litIndices.push(index);
    }

    expect(
      litIndices,
      `fed ${axis}s ${JSON.stringify(lit)} and the picture shows ${JSON.stringify(litIndices)} — ` +
        `a missing last ${axis} means the final texel is unreachable, a doubled one means the picture is squeezed`,
    ).toEqual([...lit]);
  }, 240_000);

  /**
   * The gate above compares two SETS, and a set comparison over an empty render is exactly
   * §V883's vacuous shape — a node that drew nothing would report [] and only fail because
   * the fixture is non-empty. So the same frame is asserted the other way round, by count:
   * as many pixels came out lit as texels were fed lit, and that number is not zero.
   */
  it("lights exactly as many pixels as it was fed, and not zero of them", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const fed = stripes("column", LIT_COLUMNS);
    const actual = await renderStripes(fed);
    const fedFloats = new Float32Array(fed.buffer, fed.byteOffset, MW * MH);

    let fedLit = 0;
    for (const value of fedFloats) if (value === 1) fedLit += 1;
    let renderedLit = 0;
    for (const value of actual) if (classify(value) === "lit") renderedLit += 1;

    expect(fedLit, "the fixture lit nothing — every claim in this describe would be vacuous").toBe(
      LIT_COLUMNS.length * MH,
    );
    expect(
      renderedLit,
      `${fedLit} texels were fed at full matte and ${renderedLit} pixels came out lit`,
    ).toBe(fedLit);
  }, 240_000);
});
