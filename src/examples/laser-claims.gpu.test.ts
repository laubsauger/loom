import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";

/**
 * E49 LISSAJOUS + E50 GALVO — THE CLAIMS (T947).
 *
 * The row's whole thesis is that the characteristic laser/scope look is PHYSICS the
 * planner computes, not styling: brightness is dwell time, and scan rate bounds how
 * much geometry fits before flicker. Both halves are pinned here in the row's own
 * falsifiable shapes:
 *
 *  - THE DWELL CLAIM, on the plan's buffers AND on pixels: the star's sharp outer
 *    points hold more coincident samples than its gentle inner ones (read from the
 *    emitted dwell attribute, with the slot arithmetic checked against itself), and a
 *    corner's pixels outshine an edge midpoint's — the hot dots real laser art has.
 *    The corner coordinates are taken from the READ-BACK buffers, not recomputed, so
 *    the pixel probe cannot drift from the plan.
 *
 *  - THE FLICKER CLAIM, from rendered pixels: E49's ~1,270-sample plan exceeds the
 *    500-point budget of 30 kpps at 60 fps, so consecutive frames differ massively
 *    (the drawing head sweeps ~40% of the figure per frame); raise pps until the
 *    window covers the whole plan and consecutive frames differ only by the figure's
 *    slow phase creep. If the scan window stopped being honest — a clamp, a full
 *    redraw — the over-budget diff collapses to the in-budget one and this fails.
 */

const SIZE = { width: 320, height: 180 };

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function documentNamed(name: string) {
  const doc = EXAMPLE_DOCUMENTS.find((entry) => entry.name === name);
  if (doc === undefined) throw new Error(`${name} is not shipped`);
  return doc;
}

async function render(
  name: string,
  options: {
    mutate?: (graph: GraphDocument) => void;
    probeBuffers?: readonly string[];
    frames?: number;
    capture?: readonly number[];
  } = {},
) {
  const doc = documentNamed(name);
  const graph = structuredClone(doc.graph) as GraphDocument;
  options.mutate?.(graph);
  return renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...doc.settings, outputResolution: SIZE },
    frames: options.frames ?? 2,
    capture: options.capture ?? [1],
    animate: true,
    ...(options.probeBuffers === undefined ? {} : { probeBuffers: options.probeBuffers }),
  } as never);
}

/** IEEE half → number; the captured working format is rgba16float. */
function f16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * Deposited energy at a pixel, measured on the GREEN + BLUE channels of the f16
 * capture. The output is display-encoded and clamped, and the beam's RED core
 * saturates that transfer at a SINGLE splat (as a real laser core clips any camera),
 * so red carries no ratio — but the beam colour is [1, 0.16, 0.06], and the dim
 * channels have the headroom in which fourteen coincident samples genuinely read as
 * more than one. 3×3 max, so a dot a pixel off its projected centre still reads.
 */
function lumaAt(frame: { bytes: Uint8Array; width: number }, x: number, y: number): number {
  const halves = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength / 2);
  let best = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const at = ((y + dy) * frame.width + (x + dx)) * 4;
      const value = f16(halves[at + 1] ?? 0) + f16(halves[at + 2] ?? 0);
      if (value > best) best = value;
    }
  }
  return best;
}

function toImage(result: Awaited<ReturnType<typeof render>>, frame: number) {
  const captured = result.frames[frame]!;
  return toRgba8(
    {
      width: captured.width,
      height: captured.height,
      format: captured.format,
      bytes: captured.bytes,
      rowStride: captured.width * (BYTES_PER_PIXEL[captured.format as keyof typeof BYTES_PER_PIXEL] ?? 8),
    } as never,
    { space: result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear" } as never,
  );
}

const pixelOf = (clip: number, extent: number): number =>
  Math.max(1, Math.min(extent - 2, Math.round((clip * 0.5 + 0.5) * (extent - 1))));

describe("E50 Galvo — brightness is dwell time (T947)", () => {
  it("sharp outer points dwell hardest, gentle inner points less, and the dots are coincident samples", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    // The dressing is muted for the MEASUREMENT (as the flicker test mutes its
    // phosphor): the 34 px divergence halo spreads a near-uniform baseline over the
    // whole star, which compresses the corner/edge energy ratio the claim is about —
    // the dots stay visibly hotter, but the mechanism is cleanest on the bare beam.
    const result = await render("E50 Galvo", {
      probeBuffers: ["scratch:beam:total", "scratch:beam:meta", "scratch:beam:position"],
      mutate: (graph) => {
        (graph.nodes["echo"]!.parameters as Record<string, unknown>)["persistence"] = 0;
        (graph.nodes["hot"]!.parameters as Record<string, unknown>)["threshold"] = 1000;
      },
    });
    const buffers = (result as { buffers?: Record<string, ArrayBuffer> }).buffers ?? {};
    const total = new Uint32Array(buffers["scratch:beam:total"]!)[0]!;
    const meta = new Float32Array(buffers["scratch:beam:meta"]!);
    const position = new Float32Array(buffers["scratch:beam:position"]!);
    expect(total).toBeGreaterThan(0);

    // Two dwell classes above the travel floor of 1, one per vertex sharpness.
    const dwells = new Set<number>();
    for (let slot = 0; slot < total; slot += 1) dwells.add(meta[slot * 2]!);
    const held = [...dwells].filter((d) => d > 1).sort((a, b) => b - a);
    expect(held.length).toBe(2);
    const [outer, inner] = held as [number, number];
    expect(outer).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(1);

    // The slot arithmetic must agree with itself: a vertex with dwell D holds exactly
    // D coincident samples, and there are five of each kind of vertex.
    const at = (dwell: number): Float32Array[] => {
      const positions: Float32Array[] = [];
      for (let slot = 0; slot < total; slot += 1) {
        if (meta[slot * 2] === dwell) positions.push(position.slice(slot * 4, slot * 4 + 3));
      }
      return positions;
    };
    const outerSamples = at(outer);
    expect(outerSamples.length).toBe(5 * outer);
    expect(at(inner).length).toBe(5 * inner);
    const distinct = new Set(outerSamples.map((p) => `${p[0]},${p[1]}`));
    expect(distinct.size).toBe(5); // coincident: 5 corners, D samples each, no spread

    // And the pixels agree: every outer corner outshines the midpoint of the edge
    // leaving it — the hot dot, deposited rather than drawn. Corner and midpoint
    // coordinates come from the read-back plan itself.
    const frame = result.frames[0]!;
    expect(frame.format).toBe("rgba16float"); // the energy readout below decodes f16
    const corners = [...distinct].map((key) => key.split(",").map(Number) as [number, number]);
    // Edge midpoint: halfway from a corner toward the nearest OTHER lit sample far
    // enough away to be mid-edge — use the planned subdivision samples: pick, for one
    // corner, the sample whose distance to it is closest to half the min corner gap.
    for (const [cx, cy] of corners) {
      let midX = cx;
      let midY = cy;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < total; slot += 1) {
        if (meta[slot * 2] !== 1) continue; // travel samples only
        const dx = position[slot * 4]! - cx;
        const dy = position[slot * 4 + 1]! - cy;
        const score = Math.abs(Math.hypot(dx, dy) - 0.2);
        if (score < bestScore) {
          bestScore = score;
          midX = position[slot * 4]!;
          midY = position[slot * 4 + 1]!;
        }
      }
      const cornerLuma = lumaAt(frame, pixelOf(cx, SIZE.width), pixelOf(-cy, SIZE.height));
      const midLuma = lumaAt(frame, pixelOf(midX, SIZE.width), pixelOf(-midY, SIZE.height));
      expect(cornerLuma, `corner (${cx.toFixed(2)}, ${cy.toFixed(2)})`).toBeGreaterThan(midLuma * 1.5);
    }
  }, 240_000);
});

describe("E49 Lissajous — the scan budget is honest (T947)", () => {
  it("over budget, consecutive frames draw DISJOINT arcs; in budget, the same figure", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    // Phosphor off for the measurement: each captured frame is then the bare beam, so
    // the lit set IS this frame's scan window and nothing else.
    const litOverlap = async (pps?: number): Promise<{ overlap: number; litA: number }> => {
      const result = await render("E49 Lissajous", {
        frames: 3,
        capture: [1, 2],
        mutate: (graph) => {
          (graph.nodes["echo"]!.parameters as Record<string, unknown>)["persistence"] = 0;
          if (pps !== undefined) {
            (graph.nodes["scope"]!.parameters as Record<string, unknown>)["pps"] = pps;
          }
        },
      });
      const a = toImage(result, 0);
      const b = toImage(result, 1);
      let union = 0;
      let intersection = 0;
      let litA = 0;
      for (let at = 0; at < a.data.length; at += 4) {
        const inA = (a.data[at + 1] ?? 0) > 16; // the beam is green
        const inB = (b.data[at + 1] ?? 0) > 16;
        if (inA) litA += 1;
        if (inA || inB) union += 1;
        if (inA && inB) intersection += 1;
      }
      return { overlap: union === 0 ? 0 : intersection / union, litA };
    };

    // Shipped: ~1,270 samples against a 500-sample window. Consecutive frames light
    // CONSECUTIVE slices of the plan — samples [c, c+500) then [c+500, c+1000) — which
    // are disjoint by construction, so their pixels barely overlap: that IS the
    // flicker/drawing-motion artifact, from the cursor arithmetic. At 96,000 pps the
    // window covers the whole plan every frame and consecutive frames are the same
    // figure with a 0.012 rad phase creep — nearly total overlap. A clamp or a
    // silent full redraw would collapse the two cases into one and fail both bounds.
    const over = await litOverlap();
    const within = await litOverlap(96000);
    expect(over.litA).toBeGreaterThan(300); // the partial arc is really there
    expect(over.overlap).toBeLessThan(0.2);
    expect(within.overlap).toBeGreaterThan(0.6);
  }, 240_000);
});
