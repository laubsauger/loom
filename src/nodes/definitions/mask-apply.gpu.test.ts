import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * B189 — MASK'S `apply` MODE, ON PIXELS A CONSUMER READS BACK.
 *
 * The node tests next door assert the shader TEXT, which is necessary and nowhere near
 * sufficient: the entire defect this mode exists for was an operator whose arithmetic was
 * right and whose result nothing could see. So this asserts the picture.
 *
 * THE FIXTURE IS THE DEFECT IN MINIATURE. A flat colour is the source and a gradient the
 * mask. Under `alpha` the output's rgb is the source's rgb at EVERY column — correct
 * straight-alpha behaviour, and exactly what made a shipped DepthCut look like a
 * pass-through in every RGB view for two task rows while the owner reported it three
 * times. Under `colour` the rgb carries the coverage.
 *
 * ALPHA MUST BE BIT-IDENTICAL BETWEEN THE MODES, and that is the load-bearing half rather
 * than a nicety: §B189's point cohorts (23092 motes at coverage exactly 0, 1509 at exactly
 * 1, asserted in `hologram-claims.gpu.test.ts`) are read off ALPHA, so a mode that
 * re-derived coverage while carving colour would move numbers a long way from this file.
 *
 * EXACTNESS (§V147), and why the fixtures are two. Colour is carved by a MULTIPLY, and
 * f16 storage rounds `rgb * coverage` once on the GPU — so `readback(rgb) * readback(a)`
 * recomputed in JS is a different rounding, and pinning it would need a tolerance band.
 * Instead the STEP fixture pins the two ends, where the product is exact for any precision
 * (x*0 is 0, x*1 is x), and the GRADIENT fixture pins the soft middle with strict
 * inequalities, which need no epsilon either. No band appears anywhere below.
 *
 * The project turns the DISPLAY TRANSFORM OFF for the same reason: the sRGB encode is
 * non-linear, so `encode(rgb * coverage)` is not `encode(rgb) * coverage`, and asserting
 * through it would put a curve between the claim and the arithmetic it is about.
 */

const SIZE = { width: 64, height: 4 };

const settings: ProjectSettings = {
  outputResolution: { ...SIZE },
  workingFormat: "rgba16float",
  // Raw linear values out (§V56's measurement path) — see the docblock.
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

/**
 * solid -> mask.input, gradient -> mask.mask, mask -> output.
 *
 * `step` puts a Threshold between the ramp and the mask, whose softness of 0 makes the
 * coverage literally 0 on one side and literally 1 on the other — the fully-cut and
 * fully-kept cohorts, which is what a background removal is made of.
 */
function graph(apply: string, step: boolean): GraphDocument {
  const nodes: GraphDocument["nodes"] = {
    src: {
      id: "src", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 },
      parameters: { color: [0.8, 0.4, 0.2, 1] },
    },
    ramp: {
      id: "ramp", type: "ramp", definitionVersion: 1, position: { x: 0, y: 200 },
      parameters: { type: "horizontal" },
    },
    cut: {
      id: "cut", type: "mask", definitionVersion: 1, position: { x: 400, y: 0 },
      parameters: { channel: "red", invert: 0, apply },
    },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 600, y: 0 }, parameters: {} },
  };
  const edges: GraphDocument["edges"] = {
    e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "cut", portId: "input" } },
    e3: { id: "e3", source: { nodeId: "cut", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  if (step) {
    nodes["hard"] = {
      id: "hard", type: "threshold", definitionVersion: 1, position: { x: 200, y: 200 },
      parameters: { threshold: 0.5, softness: 0, channel: "red", compare: "greater" },
    };
    edges["e2a"] = { id: "e2a", source: { nodeId: "ramp", portId: "out" }, target: { nodeId: "hard", portId: "input" } };
    edges["e2b"] = { id: "e2b", source: { nodeId: "hard", portId: "out" }, target: { nodeId: "cut", portId: "mask" } };
  } else {
    edges["e2"] = { id: "e2", source: { nodeId: "ramp", portId: "out" }, target: { nodeId: "cut", portId: "mask" } };
  }
  return { revision: 1, nodes, edges, groups: {} };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

async function render(apply: string, step = false) {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(apply, step),
    settings,
    frames: 1,
    capture: [0],
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  return decodeComponents(frame.bytes, frame.format);
}

/** The mask runs along x, so row 0 is the whole picture. */
const columns = Array.from({ length: SIZE.width }, (_, x) => x);

describe("Mask — the apply mode, on pixels (B189)", () => {
  it("carves alpha only by default, so a colour view sees an untouched picture", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const pixels = await render("alpha");
    // ONE distinct rgb value across the whole gradient: the pass-through the owner saw.
    for (const channel of [0, 1, 2]) {
      expect(new Set(columns.map((x) => pixels[x * 4 + channel]!)).size, `channel ${channel}`).toBe(1);
    }
    // ...while alpha carries the coverage the whole time, unseen by any colour view.
    expect(new Set(columns.map((x) => pixels[x * 4 + 3]!)).size).toBeGreaterThan(SIZE.width / 2);
  }, 120_000);

  it("carves colour in the colour mode without touching alpha — the soft middle", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const straight = await render("alpha");
    const carved = await render("colour");

    for (const x of columns) {
      const coverage = straight[x * 4 + 3]!;
      // The mode adds a factor to rgb and re-derives NOTHING: alpha is bit-identical.
      expect(carved[x * 4 + 3], `x ${x} alpha`).toBe(coverage);
      // Coverage is strictly inside (0, 1) everywhere on the gradient — this fixture's
      // texel centres never reach either end — so the carve is a strict darkening.
      expect(coverage, `x ${x} coverage is interior`).toBeGreaterThan(0);
      expect(coverage, `x ${x} coverage is interior`).toBeLessThan(1);
      for (const channel of [0, 1, 2]) {
        expect(carved[x * 4 + channel], `x ${x} channel ${channel}`).toBeLessThan(
          straight[x * 4 + channel]!,
        );
      }
    }
    // And it tracks the coverage rather than merely being darker: brighter mask, brighter
    // pixel, at every step along the gradient.
    for (let x = 1; x < SIZE.width; x += 1) {
      expect(carved[x * 4], `x ${x} rises with coverage`).toBeGreaterThan(carved[(x - 1) * 4]!);
    }
  }, 120_000);

  /**
   * The two cohorts, exactly — and this is the claim the owner was making: with the
   * background fully cut, the picture there must be BLACK, not merely transparent.
   */
  it("takes the cut side to exactly black and leaves the kept side exactly the source", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const straight = await render("alpha", true);
    const carved = await render("colour", true);

    let cut = 0;
    let kept = 0;
    for (const x of columns) {
      const coverage = straight[x * 4 + 3]!;
      expect(carved[x * 4 + 3], `x ${x} alpha`).toBe(coverage);
      if (coverage === 0) {
        cut += 1;
        // Fully cut: no light at all, in the channel every RGB view reads.
        for (const channel of [0, 1, 2]) expect(carved[x * 4 + channel], `x ${x} cut`).toBe(0);
        // ...and the defect, pinned: the default mode leaves this column fully lit.
        expect(straight[x * 4], `x ${x} straight is untouched`).toBeGreaterThan(0);
      } else if (coverage === 1) {
        kept += 1;
        // Fully kept: bit-identical to the unmasked picture, no rounding introduced.
        for (const channel of [0, 1, 2]) {
          expect(carved[x * 4 + channel], `x ${x} kept`).toBe(straight[x * 4 + channel]!);
        }
      }
    }
    // Both cohorts must actually be present, or the loop above asserted nothing.
    expect(cut, "columns fully cut").toBeGreaterThan(8);
    expect(kept, "columns fully kept").toBeGreaterThan(8);
  }, 120_000);
});
