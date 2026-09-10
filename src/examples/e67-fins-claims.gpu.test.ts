import { beforeAll, describe, expect, it } from "vitest";

import { evaluateExpression } from "../domain/expressions/evaluate.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { ParameterSlot } from "../domain/types/parameters.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { SHOWCASE_BEAT, showcaseBarStart } from "./build-showcase-beat.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import { shippedClipAudio } from "./shipped-clip-audio.ts";

/**
 * E67 FINS — THE CLAIMS (T1265, §V147).
 *
 * The example's sentence has two halves, and each is a claim about rendered pixels:
 *
 *   1. OPTIONAL MEANS THE HAND-BUILT PIECE. With the reactivity knob at 0, or before the
 *      clip has played a hit, the frame is the owner's piece BYTE FOR BYTE, meaning the
 *      frame with every driven light cut to the owner's own value. A lane that leaked a
 *      bias at rest (an expression like `4 + 0.8 * (kick - 0.1)`) would break this.
 *   2. THE LIGHTS ANSWER THE BEAT. On the kick the kick-driven lights (the strip sources and
 *      the three beams) change the frame, and on the snare the inner glow does. Each is
 *      proved by cutting that lane alone and requiring the frame to change, and by
 *      requiring the heard frame to be BRIGHTER, which is what "flare" means.
 *
 * "Only the lights hear the music" is checked on the document rather than on pixels: the
 * set of parameters that read `react1` is exactly the light set. A pixel mask cannot tell
 * a light from a moved slab, and the document can.
 *
 * Every render HEARS the shipped clip through the same seam the example gates use
 * (`shipped-clip-audio.ts`). Moments are derived from the clip's declared grid, as in E66.
 */

const SIZE = { width: 320, height: 180 };
const FPS = 60;
const SECONDS_PER_BEAT = 60 / SHOWCASE_BEAT.bpm;
const frameAt = (bar: number, beat: number, afterMs: number): number =>
  Math.round((showcaseBarStart(bar) + (beat - 1) * SECONDS_PER_BEAT + afterMs / 1000) * FPS);

const MOMENTS = {
  /** 0.25 s in: the silent lead-in beat, before the first hit of the clip. */
  leadIn: 15,
  /** 30 ms after beat 1 of bar 3: a kick (and the downbeat hat), no snare. */
  kick: frameAt(3, 1, 30),
  /** 30 ms after beat 2 of bar 3: the snare. */
  snare: frameAt(3, 2, 30),
} as const;
const LAST_FRAME = Math.max(...Object.values(MOMENTS));

const LIGHTS = ["stripLevel", "laser", "laser2", "laser3", "glow", "gelLevel"] as const;
const KICK_LIGHTS = ["stripLevel", "laser", "laser2", "laser3"] as const;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function e67() {
  const file = listExamples().find((entry) => entry.fileName === "E67-Fins.loom.json");
  if (file === undefined) throw new Error("E67-Fins.loom.json is not shipped");
  return requireExample(file);
}

/** Switch a driven slot to `static`: the parameter reads the owner's retained value. */
function cut(graph: GraphDocument, keys: readonly string[]): void {
  const node = graph.nodes["glass"];
  if (node === undefined) throw new Error('no node "glass"');
  for (const key of keys) {
    const slot = node.parameters[key] as ParameterSlot | undefined;
    if (slot === undefined || typeof slot !== "object" || !("bindings" in slot) || slot.mode !== "expression") {
      throw new Error(`"${key}" on glassRT is not driven by an expression`);
    }
    node.parameters = { ...node.parameters, [key]: { ...slot, mode: "static" } };
  }
}

type Shot = Record<number, Uint8Array>;

async function shoot(mutate?: (graph: GraphDocument) => void): Promise<Shot> {
  const { document, result } = e67();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate?.(graph);
  const audio = shippedClipAudio(graph, FPS);
  if (audio === undefined) throw new Error("E67 binds no shipped clip");
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { ...SIZE } },
    frames: LAST_FRAME + 1,
    capture: Object.values(MOMENTS),
    outputNodeId: "out",
    fps: FPS,
    animate: true,
    components: result.components!,
    audio,
  });
  const errors = rendered.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = rendered.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  const shot: Shot = {};
  for (const frame of rendered.frames) {
    shot[frame.frameIndex] = toRgba8(
      { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
      { space },
    ).data;
  }
  return shot;
}

/** Mean of R+G+B over the frame, 0..765. */
function brightness(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i]! + data[i + 1]! + data[i + 2]!;
  return sum / (data.length / 4);
}

function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count += 1;
  }
  return count;
}

describe("E67 Fins: the lights on the beat", () => {
  let shipped: Shot;
  let handBuilt: Shot;

  beforeAll(async () => {
    if (dawnError !== undefined) return;
    shipped = await shoot();
    handBuilt = await shoot((graph) => cut(graph, LIGHTS));
  }, 300_000);

  it("drives the lights and nothing else from the music", () => {
    const { document } = e67();
    const hearing = Object.entries(document.graph.nodes).flatMap(([id, node]) =>
      Object.entries(node.parameters)
        .filter(([, value]) => JSON.stringify(value).includes("op('react1')"))
        .map(([key]) => `${id}.${key}`),
    );
    expect(hearing.sort()).toEqual(LIGHTS.map((key) => `glass.${key}`).sort());
  });

  it("is the hand-built piece before the first hit", () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    expect(differing(shipped[MOMENTS.leadIn]!, handBuilt[MOMENTS.leadIn]!)).toBe(0);
  });

  it("is the hand-built piece at reactivity 0, on the kick and on the snare", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const off = await shoot((graph) => {
      graph.nodes["react"]!.parameters = { ...graph.nodes["react"]!.parameters, operand: 0 };
    });
    expect(differing(off[MOMENTS.kick]!, handBuilt[MOMENTS.kick]!)).toBe(0);
    expect(differing(off[MOMENTS.snare]!, handBuilt[MOMENTS.snare]!)).toBe(0);
    // Non-vacuity: the same two frames DO differ when the knob is up.
    expect(differing(shipped[MOMENTS.kick]!, handBuilt[MOMENTS.kick]!)).toBeGreaterThan(0);
  }, 300_000);

  it("flares the strips and the beams on the kick", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const noKick = await shoot((graph) => cut(graph, KICK_LIGHTS));
    const frame = MOMENTS.kick;
    expect(differing(shipped[frame]!, noKick[frame]!)).toBeGreaterThan((SIZE.width * SIZE.height) / 10);
    expect(brightness(shipped[frame]!)).toBeGreaterThan(brightness(noKick[frame]!));
  }, 300_000);

  it("blooms the inner glow on the snare", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const noSnare = await shoot((graph) => cut(graph, ["glow"]));
    const frame = MOMENTS.snare;
    expect(differing(shipped[frame]!, noSnare[frame]!)).toBeGreaterThan((SIZE.width * SIZE.height) / 10);
    expect(brightness(shipped[frame]!)).toBeGreaterThan(brightness(noSnare[frame]!));
    /* The glow PEAKS on the snare. The kick frame still carries the tail of the snare a
       beat earlier (483 ms back, decaying over 300 ms), so the glow is not inert there;
       its lift on the snare must be several times its lift on the kick. */
    const lift = (at: number) => brightness(shipped[at]!) - brightness(noSnare[at]!);
    expect(lift(frame)).toBeGreaterThan(3 * lift(MOMENTS.kick));
  }, 300_000);
});

/**
 * T1268 — THE CAMERA CIRCLES THE STACK, and the composition changes because of it.
 *
 * The hand-built orbit swung ±0.30 rad over 503 s and read as a still. The owner picked a
 * full circle every 240 s from stills (the period is theirs; these bounds guard what they
 * chose rather than invent a target):
 *
 *   TRAVEL   the shipped eye expressions, evaluated by the app's own expression engine over
 *            one period, unwrap to a whole turn at the hand-built radius.
 *   REST     at abstime 0 the eye is the T1265 eye, so the approved first frame is unchanged
 *            by construction: nothing else in the file moved.
 *   MOTION   a quarter-turn in (60 s), the frame differs from the same frame with the eye
 *            frozen at its t = 0 position over more than a stated share of the picture. The
 *            frozen arm has the slabs' own spin, the surges and the beams, so what is left is
 *            the camera's alone.
 */
describe("E67 Fins: the camera circles the stack", () => {
  const PERIOD = 240;
  const eyeAt = (t: number): { x: number; z: number } => {
    const glass = e67().document.graph.nodes["glass"]!;
    const read = (key: string): number => {
      const slot = glass.parameters[key] as ParameterSlot;
      const source = (slot as { bindings: { expression: { source: string } } }).bindings.expression.source;
      const result = evaluateExpression(source, { abstime: t });
      if (!result.ok) throw new Error(`${key}: ${result.reason}`);
      return result.value;
    };
    return { x: read("eyeX"), z: read("eyeZ") };
  };

  it("travels a whole turn per period at the hand-built radius, and starts on the approved eye", () => {
    let travel = 0;
    let previous = Math.atan2(eyeAt(0).x, eyeAt(0).z);
    for (let t = 1; t <= PERIOD; t += 1) {
      const eye = eyeAt(t);
      expect(Math.hypot(eye.x, eye.z)).toBeCloseTo(2.78, 6);
      const angle = Math.atan2(eye.x, eye.z);
      travel += Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous));
      previous = angle;
    }
    expect(travel).toBeCloseTo(2 * Math.PI, 3);
    // The T1265 eye at t = 0: 2.78·sin(0.20), 2.78·cos(0.20) — the hand-built orbit's start.
    expect(eyeAt(0).x).toBeCloseTo(2.78 * Math.sin(0.2), 9);
    expect(eyeAt(0).z).toBeCloseTo(2.78 * Math.cos(0.2), 9);
  });

  it("a quarter-turn in, the camera has moved the picture, not only the slabs", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const frame = (PERIOD / 4) * FPS;
    const render = async (frozen: boolean): Promise<Uint8Array> => {
      const { document, result } = e67();
      const graph = structuredClone(document.graph) as GraphDocument;
      if (frozen) {
        const glass = graph.nodes["glass"]!;
        const start = eyeAt(0);
        glass.parameters = { ...glass.parameters, eyeX: start.x, eyeZ: start.z };
      }
      const rendered = await renderHeadless({
        host: nodeGpuHost(),
        graph,
        settings: { ...document.settings, outputResolution: { ...SIZE } },
        frames: frame + 1,
        capture: [frame],
        outputNodeId: "out",
        fps: FPS,
        animate: true,
        components: result.components!,
        audio: shippedClipAudio(graph, FPS)!,
      });
      expect(rendered.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const space = rendered.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
      const f = rendered.frames[0]!;
      return toRgba8(
        { width: f.width, height: f.height, format: f.format, bytes: f.bytes, rowStride: f.width * (BYTES_PER_PIXEL[f.format] ?? 8) },
        { space },
      ).data;
    };
    const moving = await render(false);
    const still = await render(true);
    let moved = 0;
    for (let i = 0; i < moving.length; i += 4) {
      const d = Math.abs(moving[i]! - still[i]!) + Math.abs(moving[i + 1]! - still[i + 1]!) + Math.abs(moving[i + 2]! - still[i + 2]!);
      if (d > 24) moved += 1;
    }
    const share = moved / (SIZE.width * SIZE.height);
    // Measured 57.7% at 320x180; the bound is half of it, far above what a frozen camera
    // (the same frame, exactly: 0%) could reach.
    expect(share, `the orbit moved ${(share * 100).toFixed(1)}% of the picture`).toBeGreaterThan(0.3);
  }, 600_000);
});

/**
 * T1275 — FXAA SMOOTHS EDGES, AND ONLY EDGES.
 *
 * `fxaa1` sits between the grade and the output. Two claims, and the second is the one a
 * plain blur would fail:
 *
 *   OFF      at `amount` 0 the frame is BYTE-IDENTICAL to the chain with no FXAA node at
 *            all, so the knob really switches it off.
 *   EDGES    at `amount` 1, the pixels it changes sit on edges — where the unsmoothed
 *            frame's 3×3 neighbourhood spans a wide range of brightness — and the flat
 *            interior of the glass is left as it was. A blur changes the interior too.
 */
describe("E67 Fins: FXAA smooths edges and nothing else", () => {
  const unwired = (graph: GraphDocument) => {
    delete (graph.nodes as Record<string, unknown>)["fxaa"];
    delete (graph.edges as Record<string, unknown>)["e-grade-fxaa"];
    delete (graph.edges as Record<string, unknown>)["e-fxaa-out"];
    (graph.edges as Record<string, unknown>)["e-grade-out"] = {
      id: "e-grade-out", source: { nodeId: "grade", portId: "out" }, target: { nodeId: "out", portId: "input" },
    };
  };
  const amount = (value: number) => (graph: GraphDocument) => {
    const node = graph.nodes["fxaa"]!;
    node.parameters = { ...node.parameters, amount: value };
  };

  it("at amount 0 is the grade exactly, byte for byte", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const off = await shoot(amount(0));
    const none = await shoot(unwired);
    for (const frame of Object.values(MOMENTS)) expect(differing(off[frame]!, none[frame]!)).toBe(0);
  }, 300_000);

  /* The control a claim like this needs: a plain 3×3 box blur in the same slot. It smooths
     the same edges, so "edges changed" alone cannot tell the two apart; what separates them
     is the flat glass, which a blur moves and FXAA leaves. */
  const BLUR_WGSL = `struct Params { amount: f32, };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(inputTexture));
  var sum = vec3f(0.0);
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      sum = sum + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(f32(i), f32(j)) * px, 0.0).rgb;
    }
  }
  return vec4f(sum / 9.0, 1.0);
}`;
  const blurred = (graph: GraphDocument) => {
    const node = graph.nodes["fxaa"]!;
    node.parameters = { ...node.parameters, source: BLUR_WGSL };
  };

  /** Of the changed pixels, the share on an edge; of the lit flat pixels, the share changed. */
  function stats(a: Uint8Array, b: Uint8Array) {
    const lum = (d: Uint8Array, p: number) => (0.299 * d[p * 4]! + 0.587 * d[p * 4 + 1]! + 0.114 * d[p * 4 + 2]!) / 255;
    let changedOnEdge = 0;
    let changed = 0;
    let flat = 0;
    let flatChanged = 0;
    for (let y = 1; y < SIZE.height - 1; y += 1) {
      for (let x = 1; x < SIZE.width - 1; x += 1) {
        const p = y * SIZE.width + x;
        let lo = 1;
        let hi = 0;
        for (let j = -1; j <= 1; j += 1) for (let i = -1; i <= 1; i += 1) {
          const l = lum(b, p + j * SIZE.width + i);
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
        const edge = hi - lo > 0.05;
        const d = Math.abs(a[p * 4]! - b[p * 4]!) + Math.abs(a[p * 4 + 1]! - b[p * 4 + 1]!) + Math.abs(a[p * 4 + 2]! - b[p * 4 + 2]!);
        if (d > 3) {
          changed += 1;
          if (edge) changedOnEdge += 1;
        }
        if (!edge && lum(b, p) > 0.05) {
          flat += 1;
          if (d > 3) flatChanged += 1;
        }
      }
    }
    return { changed, edgeShare: changedOnEdge / changed, flatShare: flatChanged / flat };
  }

  it("at amount 1 changes the edges and leaves the flat glass alone — which a blur does not", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const on = await shoot();
    const none = await shoot(unwired);
    const blur = await shoot(blurred);
    const frame = MOMENTS.snare;
    const fxaa = stats(on[frame]!, none[frame]!);
    const box = stats(blur[frame]!, none[frame]!);
    const report = `fxaa changed ${fxaa.changed} edge ${(100 * fxaa.edgeShare).toFixed(1)}% flat ${(100 * fxaa.flatShare).toFixed(1)}% | blur changed ${box.changed} edge ${(100 * box.edgeShare).toFixed(1)}% flat ${(100 * box.flatShare).toFixed(1)}%`;
    /* Measured at the snare frame, 320x180: FXAA changed 11065 pixels, 97.0% of them on an
       edge, and 2.6% of the lit flat glass; the box blur changed 14908, 86.2% on an edge,
       and 15.9% of the flat glass. The bounds sit between the two arms, so the blur fails
       both and FXAA passes both. */
    expect(fxaa.changed, report).toBeGreaterThan(2000);
    expect(fxaa.edgeShare, report).toBeGreaterThan(0.93);
    expect(fxaa.flatShare, report).toBeLessThan(0.07);
    expect(box.edgeShare, `the blur control no longer fails the edge bound: ${report}`).toBeLessThan(0.93);
    expect(box.flatShare, `the blur control no longer fails the flat bound: ${report}`).toBeGreaterThan(0.07);
  }, 300_000);
});
