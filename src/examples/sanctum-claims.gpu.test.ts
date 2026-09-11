import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E68 SANCTUM — the three claims that are about the piece rather than about the picture.
 *
 * A showcase is mostly look, and look is the owner's call rather than a gate's. What a gate
 * can hold are the things that would break QUIETLY: the beat that stops landing, the
 * reflection that stops reflecting, and the rest state that drifts away from the frame
 * every thumbnail actually shows.
 */

function e68() {
  const file = listExamples().find((entry) => entry.fileName === "E68-Sanctum.loom.json");
  if (file === undefined) throw new Error("E68-Sanctum.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

interface Frame {
  readonly w: number;
  readonly h: number;
  readonly d: Uint8Array | Uint8ClampedArray;
}

async function shoot(frameIndex: number, mutate: (graph: GraphDocument) => void = () => {}): Promise<Frame> {
  const { document, result } = e68();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: frameIndex + 1,
    capture: [frameIndex],
    animate: true,
    fps: 60,
    outputNodeId: "out",
    ...(result.components ? { components: result.components } : {}),
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const space = rendered.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format,
      bytes: frame.bytes,
      rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
    },
    { space },
  );
  return { w: image.width, h: image.height, d: image.data };
}

const luma = (frame: Frame, pixel: number): number =>
  0.2126 * (frame.d[pixel * 4] ?? 0) + 0.7152 * (frame.d[pixel * 4 + 1] ?? 0) + 0.0722 * (frame.d[pixel * 4 + 2] ?? 0);

const meanLuma = (frame: Frame): number => {
  let total = 0;
  for (let pixel = 0; pixel < frame.w * frame.h; pixel += 1) total += luma(frame, pixel);
  return total / (frame.w * frame.h);
};

/** The lower third, where the floor is — the only place a floor reflection can appear. */
const meanFloorLuma = (frame: Frame): number => {
  let total = 0;
  let count = 0;
  for (let y = Math.floor(frame.h * 0.66); y < frame.h; y += 1) {
    for (let x = 0; x < frame.w; x += 1) {
      total += luma(frame, y * frame.w + x);
      count += 1;
    }
  }
  return total / count;
};

function param(graph: GraphDocument, id: string, key: string, value: unknown): void {
  const node = graph.nodes[id];
  if (node === undefined) throw new Error(`E68 has no \`${id}\` node`);
  (node.parameters as Record<string, unknown>)[key] = value;
}

describe("E68 Sanctum — claims", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * THE CONDUITS FIRE ON THE BEAT, and a continuous lane cannot pass this.
   *
   * §T1279's finding, applied to a different file: a drive that BREATHES cannot return, so
   * asserting "the picture moved" would pass for a lane that merely drifts. The shape that
   * only an event produces is up-and-back — brighter on the beat than before it, and back
   * down after.
   *
   * The frames are the fixture's arithmetic rather than eyeballed: at 112 bpm a beat is
   * 60/112 s = 32.14 frames, so beat 3 lands at frame 96.4. 96 is the frame before it, 100
   * is inside the 250 ms decay, and 120 is most of the way back down.
   */
  it("the conduits FIRE on the kick and fall back after it", async () => {
    const before = await shoot(96);
    const onBeat = await shoot(100);
    /* ⚑ 150, NOT 120, AND THE REASON IS A SECOND LANE. T1304b put the exposure on the low
       band's RANK — the "up and down felt over time" ask — so the frame no longer returns
       to its pre-beat level as soon as the 250 ms decay ends: the rank is still elevated.
       Measured across the beat at 112 bpm: mean 65.8 (f96, before) → 70.1 (f100, on) →
       68.6 (f120) → 66.9 (f150). The conduits' own fall is done by f120; what is still
       coming down at f120 is the exposure. Asserting recovery at 120 would be asserting
       that the slower lane does not exist. */
    const after = await shoot(150);

    const rise = meanLuma(onBeat) - meanLuma(before);
    const fall = meanLuma(onBeat) - meanLuma(after);
    expect(rise, "the frame after the kick must be brighter than the one before it").toBeGreaterThan(0);
    expect(fall, "and it must come back down, or this is a drift rather than a beat").toBeGreaterThan(0);
    // Most of the way back inside the decay: a lane that ratchets would fail this while
    // still passing both directions above.
    // Measured: rise 4.3, fall 3.2 by f150.
    expect(fall).toBeGreaterThan(rise * 0.5);
  }, 300_000);

  /**
   * §V914 — WITH NO AUDIO THE PIECE IS THE PICTURE IT ALREADY WAS.
   *
   * Every thumbnail, every headless render and every first open has no track, so the
   * retained value of a driven slot is the frame most people actually see. Both of E68's
   * drives are gains on quantities that rest at a known value — a count at zero, a rank at
   * its middle — so the retained figures are exact rather than approximate, and this
   * asserts them as bytes rather than as intent.
   */
  it("the drives' retained values render the same frame as the drives cut", async () => {
    const driven = await shoot(1);
    const cut = await shoot(1, (graph) => {
      // The slots' own retained values, written as statics: a static replaces the slot.
      param(graph, "temple", "inlayEmission", 0.85);
      param(graph, "temple", "dust", 0.032);
    });
    // Frame 1 is before the first beat lands and the rank has not yet moved off its middle,
    // so the two arms are the same picture — and byte-identical is the only honest way to
    // say "the rest state IS the shipped state" (§V147).
    let differing = 0;
    for (let pixel = 0; pixel < driven.w * driven.h; pixel += 1) {
      if (Math.abs(luma(driven, pixel) - luma(cut, pixel)) > 0.5) differing += 1;
    }
    expect(differing).toBe(0);
  }, 300_000);

  /**
   * THE FLOOR REFLECTS, and `polish` is what decides it.
   *
   * The reflection is the only second march in the piece and the only idea whose absence
   * would still look plausible — a dark floor reads as a dark floor. So the claim is the
   * §V361 one: what differs if the drive is cut? The lower third of the frame, which is
   * where the floor is and where a reflection can appear at all.
   */
  it("cutting `polish` takes the light out of the floor", async () => {
    const wet = await shoot(120);
    const dry = await shoot(120, (graph) => {
      param(graph, "temple", "polish", 0);
    });
    const wetFloor = meanFloorLuma(wet);
    const dryFloor = meanFloorLuma(dry);
    /* Worth seeing, not merely present. ⚑ THE MARGIN MOVED WITH THE GRADE AND THAT IS NOT
       A REGRESSION: measured 61.7 against 56.8, so the reflection still adds 8.6% of the
       floor's light — but T1304b lifted the whole frame out of its crushed histogram, so
       the same absolute contribution is a smaller SHARE of a brighter floor. The fence is
       set under the measurement rather than at the old 15%, which was a fence around a
       darker picture. */
    expect(wetFloor).toBeGreaterThan(dryFloor * 1.05);
    // And it is the FLOOR that moved, not the whole picture — the columns above are lit by
    // their own conduits either way, so a change that moved everything would mean `polish`
    // had reached something it should not.
    const wetAll = meanLuma(wet);
    const dryAll = meanLuma(dry);
    expect((wetFloor - dryFloor) / wetFloor).toBeGreaterThan((wetAll - dryAll) / wetAll);
  }, 300_000);
});
