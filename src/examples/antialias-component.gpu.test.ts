import { beforeAll, describe, expect, it } from "vitest";

import { createComponentSystem, parseComponentDefinition } from "../domain/components/index.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listStarterComponentFiles } from "./catalogue.ts";

/**
 * THE SHIPPED ANTIALIAS COMPONENT (T1276) — FXAA, EXTRACTED FROM E67.
 *
 * The component is the FXAA pass E67 Fins ships after its grade (T1275), saved as a starter
 * component so any piece can drop it in. Its claims are its own, read off the shipped file:
 *
 *   OFF         at `amount` 0 it returns its input BYTE FOR BYTE, alpha included — the same
 *               frame as the plate wired straight to the output.
 *   STAIRCASES  at `amount` 1 it smooths the pixel staircases of a hard threshold, and only
 *               at the contours.
 *   DIRECTION   and it does it ALONG each edge, which is what FXAA is and a blur is not. A
 *               straight, axis-aligned edge is already smooth along its own direction, so
 *               FXAA leaves it (bar the rectangle's four corners), while a 3×3 box blur in
 *               the same slot softens every pixel of it. The test asserts the blur fails.
 *
 * Why two plates: on a picture of flat regions a blur also changes only the edges, so
 * "changes the edges" cannot separate FXAA from a blur. The straight edge can.
 */

const SIZE = { width: 320, height: 180 };
const SETTINGS: ProjectSettings = {
  outputResolution: SIZE,
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const nodes = createNodeRegistry(allNodeDefinitions).view();

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function shippedAntialias(): GraphComponentDefinition {
  const file = listStarterComponentFiles().find((entry) => entry.fileName === "Antialias.loom.json");
  if (file === undefined) throw new Error("Antialias.loom.json is not shipped");
  const library = (JSON.parse(file.text) as { componentLibrary?: { components?: unknown[] } }).componentLibrary;
  const parsed = parseComponentDefinition(library?.components?.[0]);
  if (!parsed.ok) throw new Error(`Antialias.loom.json did not parse: ${parsed.issues.join(", ")}`);
  return parsed.definition;
}

/** The same definition with its FXAA pass swapped for a 3×3 box blur — the control arm. */
function asABlur(definition: GraphComponentDefinition): GraphComponentDefinition {
  const blur = `struct Params { amount: f32, };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(inputTexture));
  var sum = vec4f(0.0);
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      sum = sum + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(f32(i), f32(j)) * px, 0.0);
    }
  }
  return sum / 9.0;
}`;
  const inner = Object.fromEntries(
    Object.entries(definition.graph.nodes).map(([id, n]) =>
      n.type === "customWgsl" ? [id, { ...n, parameters: { ...n.parameters, source: blur } }] : [id, n],
    ),
  );
  return { ...definition, graph: { ...definition.graph, nodes: inner } };
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}) =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as never;
const wire = (id: string, from: string, to: string, toPort = "input") => ({
  id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: toPort },
});

interface Plate {
  readonly nodes: Record<string, never>;
  readonly edges: Record<string, ReturnType<typeof wire>>;
  /** The node whose output is the picture. */
  readonly tip: string;
}

/** Hard staircases: noise cut at a threshold with no softness. */
const staircases = (): Plate => ({
  nodes: {
    grain: node("grain", "noise", {
      type: "perlin4d", seed: 11, period: 0.25, harmon: 1, spread: 2, gain: 0.5, rough: 0.5,
      exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true, t4d: 0.37, s4d: 1, speed: 0,
    }),
    cut: node("cut", "threshold", { threshold: 0.5, softness: 0, channel: "luminance", compare: "greater" }),
  },
  edges: { p1: wire("p1", "grain", "cut") },
  tip: "cut",
});

/** Straight edges only: an axis-aligned white rectangle on black, square corners. */
const straight = (): Plate => ({
  nodes: {
    box: node("box", "rectangle", {
      // `size` is a half-extent: this covers the middle half of the frame each way.
      mode: "fill", center: [0.5, 0.5], size: [0.25, 0.25], roundness: 0, softness: 0,
      fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: false,
    }),
  },
  edges: {},
  tip: "box",
});

function plateOnly(plate: Plate): GraphDocument {
  return {
    revision: 1,
    nodes: { ...plate.nodes, out: node("out", "output") },
    edges: { ...plate.edges, t1: wire("t1", plate.tip, "out") },
    groups: {},
  } as GraphDocument;
}

function throughAntialias(plate: Plate, parameters: Record<string, unknown> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: { ...plate.nodes, aa1: node("aa1", "component:antialias@1", parameters), out: node("out", "output") },
    edges: { ...plate.edges, t1: wire("t1", plate.tip, "aa1", "picture"), t2: wire("t2", "aa1", "out") },
    groups: {},
  } as GraphDocument;
}

async function render(graph: GraphDocument, definition?: GraphComponentDefinition): Promise<Uint8Array> {
  const system = definition === undefined ? undefined : createComponentSystem(nodes, [definition]);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: SETTINGS,
    frames: 1,
    capture: [0],
    ...(system === undefined ? {} : { components: system.components.view() }),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const frame = result.frames[0]!;
  const space = result.plan.outputs[0]?.space ?? "linear";
  return toRgba8(
    { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
    { space },
  ).data;
}

/** Pixels whose RGB moved by more than 3 (of 765), and how many of them sit on a contour. */
function changes(after: Uint8Array, before: Uint8Array) {
  const lum = (d: Uint8Array, p: number) => (0.299 * d[p * 4]! + 0.587 * d[p * 4 + 1]! + 0.114 * d[p * 4 + 2]!) / 255;
  let changed = 0;
  let onContour = 0;
  for (let y = 1; y < SIZE.height - 1; y += 1) {
    for (let x = 1; x < SIZE.width - 1; x += 1) {
      const p = y * SIZE.width + x;
      const d = Math.abs(after[p * 4]! - before[p * 4]!) + Math.abs(after[p * 4 + 1]! - before[p * 4 + 1]!) + Math.abs(after[p * 4 + 2]! - before[p * 4 + 2]!);
      if (d <= 3) continue;
      changed += 1;
      let lo = 1;
      let hi = 0;
      for (let j = -1; j <= 1; j += 1) for (let i = -1; i <= 1; i += 1) {
        const l = lum(before, p + j * SIZE.width + i);
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
      if (hi - lo > 0.3) onContour += 1;
    }
  }
  return { changed, onContour };
}

describe("T1276 — the Antialias starter component", () => {
  it("at amount 0 returns its input byte for byte, alpha included", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const plate = await render(plateOnly(staircases()));
    const off = await render(throughAntialias(staircases(), { amount: 0 }), shippedAntialias());
    let differing = 0;
    for (let i = 0; i < plate.length; i += 1) if (plate[i] !== off[i]) differing += 1;
    expect(differing).toBe(0);
  }, 120_000);

  it("at amount 1 smooths the staircases, only at the contours", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const plate = await render(plateOnly(staircases()));
    const fxaa = changes(await render(throughAntialias(staircases()), shippedAntialias()), plate);
    // Measured: 2712 pixels changed, 2705 of them within the 3×3 of a contour (99.7%); the
    // other seven sit one pixel further out, where FXAA's along-edge taps reach.
    expect(fxaa.changed, `fxaa changed ${fxaa.changed} pixels`).toBeGreaterThan(500);
    expect(fxaa.onContour / fxaa.changed).toBeGreaterThan(0.99);
  }, 120_000);

  it("smooths along the edge, so a straight edge is left alone — which a blur does not", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const definition = shippedAntialias();
    const plate = await render(plateOnly(straight()));
    const fxaa = changes(await render(throughAntialias(straight()), definition), plate);
    const box = changes(await render(throughAntialias(straight()), asABlur(definition)), plate);
    /* Measured on a 160×90 rectangle at 320×180 (a 500-pixel perimeter): FXAA changed 36
       pixels, all at the four corners, where an edge stops being straight; the box blur
       changed 1000, both sides of every edge. The bound sits between the two and the blur
       must break it, or the control has stopped controlling. */
    const report = `on the straight edge: fxaa changed ${fxaa.changed}, blur changed ${box.changed}`;
    expect(fxaa.changed, report).toBeLessThanOrEqual(100);
    expect(box.changed, `the blur control no longer breaks the bound: ${report}`).toBeGreaterThan(500);
  }, 120_000);
});
