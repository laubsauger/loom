import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";
import { decodeHalf } from "./pixel-compare.ts";
import { matteReference, MATTE_REFERENCE_ASPECT, MATTE_REFERENCE_SIDE } from "./matte-reference.ts";
import { matteToFloats } from "../../runtime/models/matte-runner.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * A REAL SUBJECT REACHES THE PICTURE, MEASURED PER PIXEL (§V864, T1044)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The matte node produced nothing on a live person three times in one day and produced a
 * clean silhouette once, on the same document, the same weights and the same machine. Six
 * diagnoses were wrong. Every one of them was settled by reading a value, and every one of
 * them could have been settled sooner by a gate that ran REAL CONTENT through the REAL
 * composed path — which, until this file, nothing did: `matte-coverage.gpu.test.ts` feeds a
 * synthetic disc, and the model itself was only ever exercised by out-of-band probes that
 * bypass the node.
 *
 * So this feeds the node a real person's matte — recorded from real MODNet, on the bytes
 * the real GPU preprocess wrote, see `matte-reference.ts` — and requires the SUBJECT to
 * come out the other end of the compiler, the backend, the external-texture upload, the
 * blit and the sink.
 *
 * ## §V864 — AND THIS IS WHY IT IS NOT COVERAGE
 *
 * `<name>:coverage` separates "ran and found nothing" from "did not run" and says NOTHING
 * about whether the matte is any good: measured, a 192-square matte keeps 93% of the
 * 512-square's coverage while visibly losing an arm, and its centroid moves by two texels.
 * An aggregate would pass the exact failure this gate exists to catch. Both assertions
 * below are therefore per pixel, and neither carries a budget of pixels allowed to be
 * wrong — `pixel-compare.ts` states why that knob does not exist here.
 */

/** 16:9, the aspect the reference was recorded at — so the letterbox is the same shape. */
const W = 192;
const H = 108;

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

/** `source -> matte -> output`, the shape a webcam document has once the camera is open. */
function subjectGraph(): GraphDocument {
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

/**
 * The matte's own value, back out of the rendered frame.
 *
 * The sink applies the display transfer on the way out, so a matte of 0.6 lands in these
 * bytes as sRGB(0.6). A measurement taken after a transfer cannot see the value before it
 * (§V838), so the declared space is read from the PLAN and inverted — a sink that stopped
 * encoding makes this stop decoding rather than silently doubling the transform.
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
  for (let i = 0; i < out.length; i += 1) out[i] = decode(decodeHalf(view.getUint16(i * 8, true)));
  return out;
}

function spaceOf(plan: { outputs: ReadonlyArray<{ resourceId: string; space?: string }> }, id: string): string {
  return plan.outputs.find((output) => output.resourceId === id)?.space ?? "encoded";
}

/**
 * Where the reference says the subject is, in PICTURE coordinates — written here, from the
 * letterbox definition, rather than borrowed from `matteToFloats`.
 *
 * Two implementations of one mapping is the point: the fed bytes go through the shipped
 * encoder and the expectation comes through this, so a change to either one separates them
 * instead of moving both together. It is a nearest read, exactly as the encoder and the
 * WGSL blit both are (T959: a matte edge blended bilinearly invents coverage that neither
 * the subject nor the background owns).
 *
 * THE BLIT'S OWN TEXEL READ IS COMPOSED IN HERE, AND SINCE T1051 IT IS THE IDENTITY.
 * The result texture is written at the picture's own size (`matteToFloats` returns
 * `width * height` floats), so output pixel `(x, y)` must read source texel `(x, y)` and
 * nothing else. Until T1051 `MATTE_BLIT_WGSL` read `vec2i(clamp(uv, 0, 1) * (dims - 1))`,
 * the BILINEAR convention floored — `x` at the left edge and `x - 1` from about halfway
 * across, so the picture was squeezed by a texel and the last source column was
 * unreachable. MEASURED both ways, not deduced: against the shipped shader this gate read
 * 0.9368 at (142, 95) where the reference says 0.1294 — the neighbouring texel across a
 * silhouette edge — and reads the reference after the fix. `matte-coverage.gpu.test.ts`
 * holds the mapping on its own, per column and per row, where a one-texel drift is an
 * integer disagreement rather than a soft edge.
 */
function expectedPicture(reference: Float32Array, width: number, height: number): Float32Array {
  const side = MATTE_REFERENCE_SIDE;
  const aspect = width / height;
  const occX = aspect >= 1 ? 1 : aspect;
  const occY = aspect >= 1 ? 1 / aspect : 1;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // The blit's read, first: which texel of the r32float result this output pixel gets.
      const tx = x;
      const ty = y;
      // Then the un-letterbox, from that texel back into the model square.
      const u = ((tx + 0.5) / width - 0.5) * occX + 0.5;
      const v = ((ty + 0.5) / height - 0.5) * occY + 0.5;
      const sx = Math.min(side - 1, Math.max(0, Math.floor(u * side)));
      const sy = Math.min(side - 1, Math.max(0, Math.floor(v * side)));
      out[y * width + x] = reference[sy * side + sx]!;
    }
  }
  return out;
}

/**
 * Pixels that are unambiguously the subject, or unambiguously not — the soft edge removed.
 *
 * A matting model's edge is a genuine gradient several texels wide, and after the
 * reference's own box filter it is wider still. Asserting a hard threshold across it would
 * be asserting the resampler, so a pixel counts as core only when it AND its eight
 * neighbours agree, and as background only under the same rule. What is left is what a
 * person would point at, and it is what a lost arm removes.
 */
function erode(values: Float32Array, width: number, height: number, keep: (v: number) => boolean): boolean[] {
  const out = new Array<boolean>(width * height).fill(false);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy += 1) {
        for (let dx = -1; dx <= 1 && all; dx += 1) {
          all = keep(values[(y + dy) * width + (x + dx)]!);
        }
      }
      out[y * width + x] = all;
    }
  }
  return out;
}

describe("a real subject's matte survives the node's whole path", () => {
  it("renders the recorded silhouette, pixel for pixel", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    expect(
      W / H,
      "the picture must share the reference's aspect, or the letterbox bands do not line up",
    ).toBeCloseTo(MATTE_REFERENCE_ASPECT, 6);

    const reference = matteReference();
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: subjectGraph(),
      settings: settingsAt(W, H),
      frames: 1,
      capture: [0],
      // The SHIPPED encoder, on the real recorded result — the same call the worker makes
      // after `session.run`, so the bytes reaching the external texture are the bytes the
      // app's own worker would have posted.
      inference: () => matteToFloats(reference, MATTE_REFERENCE_SIDE, W, H),
    } as never);

    const frame = result.frames[0]!;
    const actual = matteValues(frame, spaceOf(result.plan, result.outputResourceId));
    const expected = expectedPicture(reference, W, H);

    /*
     * LEG ONE — EVERY PIXEL, against the reference. No budget of pixels allowed to differ:
     * a matte that is wrong in one corner is wrong, and `pixel-compare.ts` says why that
     * knob is deliberately absent.
     *
     * THE TOLERANCE, derived rather than tuned. The value makes two lossy trips this
     * expectation does not: it is stored in a half-float target (2^-10 relative near 1.0)
     * and it is written through the sink's sRGB encode and read back through its inverse.
     * The inverse of sRGB has a slope of about 12.9 near black, so one half-float quantum
     * down there reopens as ~0.004 — MEASURED across this frame, the largest disagreement
     * anywhere is 0.0032. 0.01 sits above that and an order of magnitude below anything
     * that would change what the picture shows.
     */
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < actual.length; i += 1) {
      const delta = Math.abs(actual[i]! - expected[i]!);
      if (delta > worst) {
        worst = delta;
        worstAt = i;
      }
    }
    expect(
      worst,
      `matte differs from the recorded reference at (${worstAt % W}, ${Math.floor(worstAt / W)}): ` +
        `rendered ${actual[worstAt]?.toFixed(4)}, reference ${expected[worstAt]?.toFixed(4)}`,
    ).toBeLessThan(0.01);

    /*
     * LEG TWO — IS THERE A PERSON IN IT? The claim leg one cannot make.
     *
     * Leg one compares two derivations of one recording, so it is satisfied by any
     * transform applied consistently at both ends and it would still pass if the reference
     * itself were replaced with an empty frame. This one asserts the PICTURE: the subject's
     * core is opaque, the background is clear, and both are read off the node's own
     * rendered pixels rather than off the fixture.
     *
     * Stated as "every pixel of the core", not a mean: an arm is a few percent of the frame
     * and a mean cannot see it leave (§V864 — 192-square keeps 93% of the coverage while
     * losing one).
     */
    const core = erode(expected, W, H, (v) => v > 0.9);
    const clear = erode(expected, W, H, (v) => v < 0.02);
    const coreCount = core.filter(Boolean).length;
    const clearCount = clear.filter(Boolean).length;
    // The fixture has to contain a subject at all, or every assertion below is vacuous.
    expect(coreCount, "the reference has no opaque core — it is not a person matte").toBeGreaterThan(
      0.05 * W * H,
    );
    expect(clearCount, "the reference has no clear background").toBeGreaterThan(0.2 * W * H);

    let dimmestCore = 1;
    let brightestClear = 0;
    for (let i = 0; i < actual.length; i += 1) {
      if (core[i] === true) dimmestCore = Math.min(dimmestCore, actual[i]!);
      if (clear[i] === true) brightestClear = Math.max(brightestClear, actual[i]!);
    }
    expect(
      dimmestCore,
      `${coreCount} pixels are the subject's core and the node rendered one of them at ` +
        `${dimmestCore.toFixed(4)} — a hole, or a matte that never reached the picture`,
    ).toBeGreaterThan(0.85);
    expect(
      brightestClear,
      `${clearCount} pixels are background and the node rendered one at ` +
        `${brightestClear.toFixed(4)} — the subject is in the wrong place, or the matte is not one`,
    ).toBeLessThan(0.05);
  }, 240_000);
});
