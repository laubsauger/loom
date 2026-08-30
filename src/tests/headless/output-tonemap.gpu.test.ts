import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { nodeGpuHost as dawnGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { paritySettings } from "../fixtures/parity-graphs.ts";
import { renderOnce } from "./render-harness.ts";
import type { RenderedFrame } from "./render-harness.ts";

/**
 * T474 — THE TONE MAP, IN BYTES, ON DAWN (§V56, §V186b, §V383).
 *
 * ## What was wrong
 *
 * §V56 has said "encode + tonemap ONLY @ output|display node" since the colour policy was
 * written. The encode half shipped in T375. The tone map was named by the invariant and
 * did not exist — `outputNode.parameters` was literally `{}` — while the default working
 * format is `rgba16float`. `encodeDisplay` clamps, so a final value above 1 was flattened
 * to 255 with no roll-off available anywhere. That is the FIRST assertion below, kept
 * rather than fixed: `none` still clips, because `none` is the default and changing what
 * today's projects render is not on offer.
 *
 * The fixture is SYNTHETIC and that is a finding, not a shortcut. E4 Bloom was the obvious
 * candidate and it does not qualify: measured on Dawn, its composite reaches the Output
 * node at 0.9692 linear with zero of 262144 pixels over 1.0. Its over-range values live
 * between `level` and `add`, which is what its `rgba16float` overrides are for. A gate
 * built on E4 would have asserted a roll-off on a picture with nothing to roll off.
 *
 * ## The fixture, and why every number in it is exact
 *
 * ```
 *   solid(display 1.0) ──► level(whitelevel 0.5, rgba16float) ──► output(rgba8unorm)
 * ```
 *
 * Nothing here is measured-and-recorded; each step is arithmetic that can be checked by
 * reading it:
 *
 *  - `solid` takes its colour in DISPLAY space and decodes it, and `srgbToLinear(1) = 1`
 *    exactly. Its target is the project's `rgba8unorm`, and 1.0 stores as 255 and samples
 *    back as exactly 1.0 — no quantisation error to carry.
 *  - `level` with black 0 / white W / invert 0 / gamma 1 / contrast 1 / brightness 1
 *    reduces to `c / W` (see `LEVEL_FRAGMENT_WGSL`), so W = 0.5 gives **2.0**. Its target
 *    carries a `rgba16float` override, exactly as E4's four middle nodes do, so the value
 *    survives instead of clipping at the first 8-bit target. 2.0 is exact in binary16.
 *  - `output` renders to the project's `rgba8unorm`, so the readback is BYTES, with no
 *    half-float decode standing between Dawn and the assertion.
 *
 * So the Output node is handed exactly 2.0 and the three expected bytes below are the
 * three curves evaluated at 2.0, encoded, and quantised. They are written as literals
 * because a tolerance would let a wrong curve through: Reinhard and Filmic differ by 32
 * counts here, and the gap between "rolls off" and "clips" is 42.
 *
 * ## Sensitivity, proved rather than asserted
 *
 * In a worktree (§V364), with `tonemapReinhard` changed from `x / (x + 1)` to `x / (x + 2)`:
 * ONE test went red — `expected [188,188,188,255] to deeply equal [213,213,213,255]` — and
 * the other five stayed green, including Filmic, so the two operators are independently
 * pinned. With the curve and the encode swapped in `outputDisplayShader`
 * (`tonemapFilmic(encodeDisplay(…))` instead of the reverse), THREE went red: Reinhard
 * 213→127, Filmic 245→205, and the shader-text case in `output.test.ts`. `none` and the
 * grey stayed green in both breaks, which is what a byte-identity anchor is for.
 */

const SIZE = 8;

/** The linear value the Output node is handed. See the fixture note above. */
const HDR_INPUT = 2.0;

/**
 * `none` — `encodeDisplay` clamps to 1 and 1 encodes to 1. This is TODAY'S BEHAVIOUR and
 * the bug T474 describes, pinned so that "the default moves nobody's pixels" is a measured
 * claim and not a hopeful one.
 */
const EXPECTED_NONE = 255;

/**
 * `reinhard` — 2 / (1 + 2) = 0.666667; sRGB encode gives 1.055·0.666667^(1/2.4) − 0.055 =
 * 0.836005; ×255 = 213.18.
 */
const EXPECTED_REINHARD = 213;

/**
 * `filmic` — Narkowicz: (2·(2·2.51 + 0.03)) / (2·(2·2.43 + 0.59) + 0.14) = 10.10 / 11.04 =
 * 0.914855; encoded 0.961599; ×255 = 245.21.
 */
const EXPECTED_FILMIC = 245;

/**
 * A display-0.5 grey through an Output node at working format `rgba8unorm`, which is the
 * exact case `present-parity.gpu.test.ts` measured for B47 and got 128 (linear 0.214041
 * quantises to 55/255 = 0.215686 in the solid's 8-bit target, which encodes to 0.501783).
 * It is here as the ANCHOR for "byte-identical to today" on a value that is not clipped:
 * 255 could hide a broken curve behind a clamp, and this cannot.
 */
const EXPECTED_GREY = 128;

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(`Dawn (vgpu/node) could not start, so the tone map is unverified: ${dawnError}`);
  }
}

function settings(displayTransform: "srgb" | "none" = "srgb"): ProjectSettings {
  return {
    ...paritySettings({ size: SIZE, workingFormat: "rgba8unorm" }),
    colorPolicy: { workingSpace: "linear", displayTransform },
  };
}

/** solid → level → output, with the tone map the Output node is asked for. */
function hdrGraph(toneMap?: string): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: {
        id: "solid",
        type: "solid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { color: [1, 1, 1, 1] },
      },
      hot: {
        id: "hot",
        type: "level",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: { whitelevel: 0.5 },
        format: { mode: "fixed", format: "rgba16float" },
      },
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 400, y: 0 },
        // Absent, not `{ toneMap: "none" }`, when nothing is asked for: that is what every
        // shipped `.loom.json` carries, and it is the case the default has to cover.
        parameters: toneMap === undefined ? {} : { toneMap },
      },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "hot", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "hot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

/** A display-0.5 grey straight into the Output node — no over-range value anywhere. */
function greyGraph(toneMap?: string): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: {
        id: "solid",
        type: "solid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { color: [0.5, 0.5, 0.5, 1] },
      },
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: toneMap === undefined ? {} : { toneMap },
      },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

/** The centre texel, so a failure names a pixel rather than a mean. */
function centre(frame: RenderedFrame): readonly number[] {
  const index = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return [...frame.bytes.subarray(index, index + 4)];
}

async function render(graph: GraphDocument, displayTransform: "srgb" | "none" = "srgb") {
  const frame = await renderOnce({ host: dawnGpuHost(), graph, settings: settings(displayTransform) });
  expect(frame.format).toBe("rgba8unorm");
  return frame;
}

describe("T474 — the Output node's tone map, in exact bytes on Dawn", () => {
  it("is measuring a real over-range value, or it is measuring nothing", async () => {
    requireDawn();
    // The fixture's whole claim is that the Output node is handed 2.0. Read it directly,
    // with the display transform off so nothing sits between the level node and the bytes,
    // and with the output target overridden to the same float format the level writes.
    const graph = hdrGraph();
    const nodes = graph.nodes as Record<string, { format?: unknown }>;
    nodes["out"] = { ...nodes["out"], format: { mode: "fixed", format: "rgba16float" } };

    const frame = await renderOnce({
      host: dawnGpuHost(),
      graph,
      settings: settings("none"),
    });

    expect(frame.format).toBe("rgba16float");
    const index = ((SIZE / 2) * SIZE + SIZE / 2) * 8;
    const bits = new DataView(frame.bytes.buffer, frame.bytes.byteOffset).getUint16(index, true);
    // binary16 → f32 for a positive normal value; 2.0 is exact, so no tolerance is needed.
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    const value = (exponent === 0 ? mantissa / 1024 : 1 + mantissa / 1024) * 2 ** (exponent - 15);
    expect(value).toBe(HDR_INPUT);
  }, 60_000);

  it("CLIPS at 255 with no tone map, which is what every project renders today", async () => {
    requireDawn();
    const absent = await render(hdrGraph());
    const explicit = await render(hdrGraph("none"));

    expect(centre(absent)).toEqual([EXPECTED_NONE, EXPECTED_NONE, EXPECTED_NONE, 255]);
    // A missing parameter and an explicit `none` are the same picture, byte for byte.
    expect(centre(explicit)).toEqual(centre(absent));
  }, 60_000);

  it("rolls 2.0 off to 213 with Reinhard", async () => {
    requireDawn();
    const frame = await render(hdrGraph("reinhard"));
    expect(centre(frame)).toEqual([EXPECTED_REINHARD, EXPECTED_REINHARD, EXPECTED_REINHARD, 255]);
    // Non-vacuity in the direction that matters: it is a ROLL-OFF, not a clip.
    expect(EXPECTED_REINHARD).toBeLessThan(EXPECTED_NONE);
  }, 60_000);

  it("rolls 2.0 off to 245 with the filmic curve, which is NOT Reinhard", async () => {
    requireDawn();
    const frame = await render(hdrGraph("filmic"));
    expect(centre(frame)).toEqual([EXPECTED_FILMIC, EXPECTED_FILMIC, EXPECTED_FILMIC, 255]);
    // Two operators that agreed would mean one of them is not wired up.
    expect(EXPECTED_FILMIC).not.toBe(EXPECTED_REINHARD);
  }, 60_000);

  it("leaves an in-range picture byte-identical to what it rendered before T474", async () => {
    requireDawn();
    // 128 is the number `present-parity.gpu.test.ts` measured for this exact case, and it
    // is not near a clamp, so a curve that leaked into the `none` path would move it.
    const frame = await render(greyGraph());
    expect(centre(frame)).toEqual([EXPECTED_GREY, EXPECTED_GREY, EXPECTED_GREY, 255]);
    expect(centre(await render(greyGraph("none")))).toEqual(centre(frame));
  }, 60_000);

  it("changes an in-range picture too — a tone map is not a highlight-only fix", async () => {
    requireDawn();
    // Stated because it is the honest limitation of any global operator and the thing a
    // user will notice first: Reinhard at 0.215686 linear returns 0.177305, which is a
    // visibly darker mid-grey. It is not "only affects highlights", and pretending it were
    // would be the promise §V328 forbids.
    const toned = centre(await render(greyGraph("reinhard")));
    expect(toned[0]).toBeLessThan(EXPECTED_GREY);
  }, 60_000);
});
