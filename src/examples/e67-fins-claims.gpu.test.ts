import { beforeAll, describe, expect, it } from "vitest";

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
