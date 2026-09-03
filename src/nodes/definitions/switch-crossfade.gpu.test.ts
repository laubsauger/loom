import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import { nodeGpuHost as dawnGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { paritySettings } from "../../tests/fixtures/parity-graphs.ts";
import { renderOnce } from "../../tests/headless/render-harness.ts";
import type { RenderedFrame } from "../../tests/headless/render-harness.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1054 — CROSSFADE, MEASURED ON THE PICTURE (§V147)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `switch.test.ts` pins the arithmetic and the uniforms. Neither can see whether a blend
 * reaches a PIXEL: the shader could sample the wrong texture, mix in the wrong direction,
 * or ignore the uniform entirely and every plan-level assertion would stay green. So the
 * claim is made here, in bytes, on Dawn.
 *
 * ## The fixture, and why each choice is forced
 *
 * ```
 *   solid(red) ──┐
 *   solid(green) ├──► switch(index, crossfade) ──► output
 *   solid(blue) ─┘
 * ```
 *
 * THREE inputs, not two. §V854's precondition, and it has bitten this project repeatedly:
 * with two inputs "blends with the NEXT input" and "blends with the LAST input" are the
 * same statement, so a fixture built on two proves neither. With three they disagree on
 * every channel.
 *
 * A FRACTION OF 0.2, not 0.5 and never an integer. At 0.5 a blend is symmetric, so an
 * inverted `mix` reads identically; at an integer a crossfade and a hard select are the
 * same picture by construction, which is the degenerate point where the whole feature is
 * invisible. 0.2 makes all four hypotheses — hard select, correct blend, inverted blend,
 * blend with the wrong neighbour — land on four different byte triples.
 *
 * ONE COLOUR PER INPUT rather than three greys. A grey ramp measures the weight but not
 * WHICH texture was sampled; primaries put the identity of the source in a different
 * channel from its weight, so a mis-bound texture cannot hide behind a plausible number.
 *
 * ## Why every expectation is exact, with no tolerance (§V147)
 *
 * Nothing here is measured-and-recorded — each number is arithmetic that can be checked by
 * reading it:
 *
 *  - `solid` takes its colour in DISPLAY space and decodes it, and `srgbToLinear` is the
 *    identity at exactly 0 and 1. Every component of every input is 0 or 1, so no decode
 *    error enters the fixture. The parity settings put the working space in linear with
 *    the display transform OFF, so nothing sits between the blend and the bytes.
 *  - the working format is `rgba8unorm`, so a readback IS the target's bytes — no
 *    half-float decoder standing between Dawn and the assertion.
 *  - the readback is the SWITCH's own target, not the Output node's, so the measurement
 *    is of this node and not of the display path downstream of it.
 *  - 0.2 and 0.8 land on 51 and 204 exactly (0.2 × 255 = 51), and the seam case uses
 *    2^-8, which is exact in binary. So `toEqual` is used at full strength.
 */

const SIZE = 8;

/** Display-space primaries: every component is 0 or 1, where the sRGB decode is identity. */
const RED = [1, 0, 0, 1];
const GREEN = [0, 1, 0, 1];
const BLUE = [0, 0, 1, 1];

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    // Never skipped (§C): the only test that can see this failure mode must not turn into
    // a green tick on a machine without a GPU.
    throw new Error(`Dawn (vgpu/node) could not start, so the crossfade is unverified: ${dawnError}`);
  }
}

function solid(id: string, color: readonly number[]) {
  return { id, type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color } };
}

/**
 * Three solids into one Switch. The edge `order` is EXPLICIT (§V131, T225): the index
 * counts through the order the document declares, so a fixture that let the id tiebreak
 * decide would be asserting against an ordering it did not choose.
 */
function crossfadeGraph(
  index: number,
  crossfade: boolean,
  colors: readonly (readonly number[])[] = [RED, GREEN, BLUE],
): GraphDocument {
  const nodes: Record<string, unknown> = {
    pick: {
      id: "pick",
      type: "switch",
      definitionVersion: 1,
      position: { x: 200, y: 0 },
      parameters: { index, crossfade },
    },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
  };
  const edges: Record<string, unknown> = {
    eOut: { id: "eOut", source: { nodeId: "pick", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  colors.forEach((color, slot) => {
    const id = `src${slot}`;
    nodes[id] = solid(id, color);
    edges[`e${slot}`] = {
      id: `e${slot}`,
      source: { nodeId: id, portId: "out" },
      target: { nodeId: "pick", portId: "inputs" },
      order: slot,
    };
  });
  return { revision: 1, nodes, edges, groups: {} } as unknown as GraphDocument;
}

/** The centre texel, so a failure names a pixel rather than a mean. */
function centre(frame: RenderedFrame): readonly number[] {
  const at = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return [...frame.bytes.subarray(at, at + 4)];
}

/** Renders one frame and reads the SWITCH's own target, in its own bytes. */
async function switchPixel(
  index: number,
  crossfade: boolean,
  colors?: readonly (readonly number[])[],
): Promise<readonly number[]> {
  const frame = await renderOnce({
    host: dawnGpuHost(),
    graph: crossfadeGraph(index, crossfade, colors),
    settings: paritySettings({ size: SIZE }),
    outputNodeId: "pick",
  });
  expect(frame.format).toBe("rgba8unorm");
  return centre(frame);
}

describe("T1054 — Switch crossfade, in bytes on Dawn", () => {
  it("has three DISTINCT inputs in the order the document declares", async () => {
    requireDawn();
    // Non-vacuity, and the fixture's own premise (§V854): if the three sources did not
    // differ on the measured channels, or arrived in another order, every blend below
    // would be asserting about a picture other than the one it names.
    expect(await switchPixel(0, false)).toEqual([255, 0, 0, 255]);
    expect(await switchPixel(1, false)).toEqual([0, 255, 0, 255]);
    expect(await switchPixel(2, false)).toEqual([0, 0, 255, 255]);
  }, 120_000);

  it("CUTS at a fractional index while the toggle is off — today's picture, unchanged", async () => {
    requireDawn();
    // §V831's promise on the picture. 0.2 of the way toward green still renders pure red,
    // because the index floors. This is the anchor the blend below is a departure from:
    // without it, a green here could be read as "crossfade works" rather than "the default
    // moved", and every shipped document would have moved with it.
    expect(await switchPixel(0.2, false)).toEqual([255, 0, 0, 255]);
  }, 120_000);

  it("BLENDS the two neighbours once the toggle is on", async () => {
    requireDawn();
    // THE claim. mix(red, green, 0.2) = (0.8, 0.2, 0) = (204, 51, 0).
    //   a hard select would read       [255,   0, 0]
    //   an INVERTED mix would read     [ 51, 204, 0]
    //   a blend with the LAST input    [204,   0, 51]
    // so this single triple separates the correct implementation from all three defects.
    expect(await switchPixel(0.2, true)).toEqual([204, 51, 0, 255]);
  }, 120_000);

  it("fades the LAST input into the FIRST across the seam", async () => {
    requireDawn();
    // mix(blue, red, 0.2) = (0.2, 0, 0.8) = (51, 0, 204). A blend that clamped at the last
    // input would render pure blue, which is the behaviour T235's wrap exists to refuse:
    // everything that drives an index ramps off the end on purpose.
    expect(await switchPixel(2.2, true)).toEqual([51, 0, 204, 255]);
  }, 120_000);

  it("is CONTINUOUS across the seam, to within one 8-bit count", async () => {
    requireDawn();
    // The property a wrap-around blend can most easily get wrong: a sign flip or a `%` on
    // the fraction leaves a full-swing jump exactly at the wrap, which no single-index
    // assertion can see. Approaching index 3 from below with a fraction of 1 − 2^-8:
    // red = 0.99609375 → 253.996 → 254, blue = 0.00390625 → 0.996 → 1.
    expect(await switchPixel(2.99609375, true)).toEqual([254, 0, 1, 255]);
    // ...and AT the seam it is input 0 exactly. One count apart on two channels: continuous.
    // A discontinuity here would be 254 counts, not one.
    expect(await switchPixel(3, true)).toEqual([255, 0, 0, 255]);
  }, 120_000);

  it("blends ALPHA with the same weight, and does not clamp it to opaque", async () => {
    requireDawn();
    // Alpha is straight (non-premultiplied) throughout, matching TD and `composite.ts`, so
    // all four channels take the same weight. mix(a=1, a=0, 0.2) = 0.8 → 204.
    //
    // This is also where the §V833/§V838 question is settled by measurement rather than by
    // reflex. `mix` is a CONVEX combination, so it cannot manufacture an alpha above the
    // larger of its two inputs — there is no overflow for a clamp to fix. Adding one would
    // INTRODUCE a difference instead, making crossfade quietly clip an over-range alpha
    // that the hard select passes through untouched. A 255 here would mean alpha had been
    // forced opaque and the blend was not carrying coverage at all.
    expect(await switchPixel(0.2, true, [RED, [0, 1, 0, 0], BLUE])).toEqual([204, 51, 0, 204]);
  }, 120_000);
});
