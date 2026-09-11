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
   * only an event produces is a sharp attack and a slow fall, and that is what is asserted
   * here — not a return to zero, which T1304c deliberately no longer happens (see below).
   *
   * The frames are the fixture's arithmetic rather than eyeballed, and every figure quoted
   * in the comments below was measured on this document rather than estimated.
   */
  it("the conduits FIRE on the kick and gutter down between kicks", async () => {
    /* ⚑ MEASURED AGAINST A CUT ARM AT THE SAME FRAME, NOT AGAINST A LATER FRAME OF ITSELF.
       The first version of this claim compared frame 100 with frames 96 and 150 and asked
       for a rise and a fall. It passed until T1304c, and then it failed for a reason that
       had nothing to do with the beat: THE CAMERA IS MOVING. A dolly down a nave with
       daylight shafts standing in it changes the frame's mean luminance by more, between
       any two frames fifty apart, than one kick does — so the claim had been measuring the
       walk and crediting it to the drum. It only survived as long as it did because the
       hall used to be uniform enough that the walk did not change the average much.
       Cutting ONE lane and holding the frame index fixed removes the camera from the
       measurement entirely, and it is the §V361 shape besides: what differs if the edge
       were cut? */
    const cutKick = (graph: GraphDocument): void => {
      param(graph, "temple", "inlayEmission", 0.85);
    };

    /* At 112 bpm a beat is 60/112 s = 32.14 frames — 536 ms — so beat 3 lands at frame
       96.4. Frame 94 is the last frame before it and frame 98 the first clear one after.
       ⚑ THE LANE NO LONGER RETURNS TO ZERO BETWEEN BEATS, AND THAT IS THE T1304c CHANGE
       ITSELF RATHER THAN A WEAKENED CLAIM. The decay went 250 ms → 420 ms to answer "too
       blinky blinky", and 420 ms against a 536 ms beat means the next kick arrives while
       the last one is still audible in the picture — which is what a light that GUTTERS
       does and what a light that STROBES does not. Measured, live minus cut, in mean luma
       of 255:
           f84 0.226   f88 0.200   f92 0.179   f94 0.168   f96 0.158
           f98 0.426   f100 0.395  f104 0.344  f112 0.273  f120 0.219
       An attack of 2.7× in four frames and a monotone fall over the next twenty-two. The
       claim is that SHAPE, because the shape is what an event makes and a drift cannot. */
    const beforeLive = await shoot(94);
    const beforeCut = await shoot(94, cutKick);
    const afterLive = await shoot(98);
    const afterCut = await shoot(98, cutKick);
    const lateLive = await shoot(120);
    const lateCut = await shoot(120, cutKick);

    const before = meanLuma(beforeLive) - meanLuma(beforeCut);
    const after = meanLuma(afterLive) - meanLuma(afterCut);
    const late = meanLuma(lateLive) - meanLuma(lateCut);

    // The lane exists at all: cutting it changes the picture wherever it is read.
    expect(before, "the conduit lane must reach the frame").toBeGreaterThan(0.05);
    // THE ATTACK. Measured 0.426 against 0.168 — a factor of 2.5 in four frames.
    expect(after, "the kick must put light into the frame it lands on").toBeGreaterThan(before * 2);
    /* THE DECAY, and this is the half a lane that merely RATCHETED would fail: it comes
       back down on its own, without waiting for a quieter passage. Measured 0.219 at f120
       against 0.426 at f98. */
    expect(late, "and it must fall again, or the light came on once").toBeLessThan(after * 0.75);
    expect(late, "but not all the way to nothing inside one beat — it gutters").toBeGreaterThan(before);
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
      /* The slots' own retained values, written as statics: a static replaces the slot.
         ⚑ EVERY DRIVEN SLOT, not a sample of them. T1304c took the piece from two lanes to
         eight, and a claim that cuts two of eight is asserting §V914 about a quarter of the
         file — the four lanes it does not cut could each rest somewhere else entirely and
         this would still pass. The list is the document's, and it is the whole list. */
      param(graph, "temple", "inlayEmission", 0.85);
      param(graph, "temple", "dust", 0.032);
      param(graph, "temple", "inlayRings", 0.34);
      param(graph, "temple", "inlayNode", 0.9);
      param(graph, "temple", "shaft", 0.55);
      param(graph, "temple", "inlaySpill", 4.2);
      param(graph, "temple", "warmIntensity", 0.28);
      param(graph, "temple", "exposure", 1.35);
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
