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


/**
 * Several frames of one run, small. This claim asks whether the picture CHANGES, which a
 * 384x216 frame answers as well as a 720p one for a fraction of the render — and it has to
 * reach ninety seconds, which is 5400 frames of stepping whatever the resolution.
 */
async function shootRun(frames: readonly number[], mutate: (graph: GraphDocument) => void = () => {}): Promise<Frame[]> {
  const { document, result } = e68();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { width: 384, height: 216 } },
    frames: Math.max(...frames) + 1,
    capture: [...frames],
    animate: true,
    fps: 60,
    outputNodeId: "out",
    ...(result.components ? { components: result.components } : {}),
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = rendered.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  return [...rendered.frames]
    .sort((a, b) => a.frameIndex - b.frameIndex)
    .map((frame) => {
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
    });
}

/** Mean absolute luma difference between two frames, 0..255. */
function frameDelta(a: Frame, b: Frame): number {
  let total = 0;
  const count = a.w * a.h;
  for (let pixel = 0; pixel < count; pixel += 1) total += Math.abs(luma(a, pixel) - luma(b, pixel));
  return total / count;
}

/**
 * EVERY CLOCK THE PIECE RUNS ON, stopped — amplitudes to zero rather than periods to
 * infinity, because a period of infinity still leaves sin(0) contributing a constant and a
 * zero amplitude provably contributes nothing.
 *
 * ⚑ THIS LIST IS THE POINT OF THE CONTROL ARM. If someone adds a sixth camera lane or a new
 * evolving term and does not add it here, the control stops collapsing and FAILS — which is
 * the only way a freeze list stays honest. A stale freeze list is how "the frames differ"
 * becomes vacuous (§V958), because the thing that moved is not the thing being tested.
 */
function everyClockStopped(): Record<string, number> {
  /* ⚑ RED-VERIFIED, and the margin is the reason this list is trustworthy: removing ONE
     entry (driftX) took the control's frame-0-to-frame-900 delta from under 0.01 to 23.69,
     a factor of 2370 against the fence. The same 'frameDelta' reads both numbers in the same
     run, which is also what validates the "it moves" fences above — an instrument that
     reports 23.69 when something moves and under 0.01 when nothing does can tell the two
     apart. A control arm nobody has broken on purpose is decoration. */
  return {
    dollySpeed: 0,
    speedSwing: 0,
    driftX: 0,
    bobHeight: 0,
    yawAmount: 0,
    rollAmount: 0,
    pitchSwing: 0,
    hueArc: 0,
    warmArc: 0,
    keyBreath: 0,
    doorLife: 0,
  };
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
      param(graph, "temple", "inlayEmission", 3.4);
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
      param(graph, "temple", "inlayEmission", 3.4);
      param(graph, "temple", "dust", 0.032);
      param(graph, "temple", "inlayRings", 0.34);
      param(graph, "temple", "inlayNode", 0.9);
      param(graph, "temple", "shaft", 0.55);
      param(graph, "temple", "inlaySpill", 9.0);
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

  /**
   * IT IS NOT FLAT AFTER FIFTEEN SECONDS (T1309g), and this is the instrument the piece has
   * been missing through six passes of being told it was.
   *
   * "Still flat / still boring / still meh" was reported five times running and there was
   * nothing in the suite that could have caught it, because every existing claim renders one
   * frame or two adjacent ones. A piece that moves for four seconds and then repeats passes
   * all of them.
   *
   * The piece runs on NINE clocks, and after this row every one of their periods is PRIME:
   * the camera's 19, 23, 31, 43; the conduits' hue at 41; the far light at 17; the doorway's
   * 29, 37, 53. Coprimality is the whole design — five sines on one period is one gesture
   * with five faces, while nine on coprime periods do not realign until their product, so any
   * two moments a viewer compares have a different SUBSET displaced. ⚑ Two of them were NOT
   * coprime when this claim was written (42 = 2·3·7 against 15 = 3·5, realigning every 210 s)
   * and writing the claim is what found it.
   *
   * ⚑ AND THE CONTROL ARM IS WHAT MAKES THIS NON-VACUOUS. "Four frames differ" is worth
   * nothing on its own — §V958 — because a drifting noise field or an uncut audio lane would
   * satisfy it. The second arm stops every clock and asserts those same four frames collapse
   * to ONE PICTURE. If they do not, something is moving that the freeze list does not know
   * about, and the first arm was measuring that instead. (Idiom taken from E70, where this
   * control caught a stale freeze list twice.)
   */
  it("the piece is still moving at ninety seconds, and the control proves the clocks are why", async () => {
    const at = [0, 900, 2700, 5400] as const;

    /* THE AUDIO IS CUT IN BOTH ARMS. The question is whether the piece moves on its own
       clocks, and a live drive would answer it for free — which is the §V958 trap in its
       original form. */
    const silent = (graph: GraphDocument): void => {
      param(graph, "temple", "inlayEmission", 3.4);
      param(graph, "temple", "dust", 0.075);
      param(graph, "temple", "inlayRings", 0.34);
      param(graph, "temple", "inlayNode", 0.9);
      param(graph, "temple", "shaft", 0.55);
      param(graph, "temple", "inlaySpill", 9.0);
      param(graph, "temple", "warmIntensity", 0.28);
      param(graph, "temple", "exposure", 1.35);
    };

    const live = await shootRun(at, silent);
    const frozen = await shootRun(at, (graph) => {
      silent(graph);
      for (const [key, value] of Object.entries(everyClockStopped())) param(graph, "temple", key, value);
    });

    const first = frameDelta(live[0]!, live[1]!);
    const mid = frameDelta(live[1]!, live[2]!);
    const late = frameDelta(live[2]!, live[3]!);
    const span = frameDelta(live[0]!, live[3]!);

    // IT MOVES, and by an amount a viewer would call a different picture rather than a drift.
    expect(first, "0 s to 15 s must be a different picture").toBeGreaterThan(4);
    expect(span, "0 s to 90 s must be a different picture").toBeGreaterThan(4);
    /* AND IT IS STILL MOVING LATE. A piece that displaces once and then settles would pass
       the two above and fail this: the interval from 45 s to 90 s has to carry real change,
       not a fraction of the first one. */
    expect(late, "45 s to 90 s must move about as much as the opening did").toBeGreaterThan(first * 0.4);
    expect(mid).toBeGreaterThan(first * 0.4);

    /* THE CONTROL. Every clock stopped, the same four frames, and they must be ONE PICTURE.
       This is what makes the four assertions above mean "the clocks did it" rather than
       "something did it". */
    for (let i = 1; i < at.length; i += 1) {
      expect(
        frameDelta(frozen[0]!, frozen[i]!),
        `with every clock stopped, frame ${at[i]} must be the frame 0 picture — if it is not, the freeze list is stale and the claim above is measuring whatever is missing from it`,
      ).toBeLessThan(0.01);
    }
  }, 900_000);

});
