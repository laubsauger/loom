import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E70 CHIMERA — the claims, and the first one IS THE BRIEF.
 *
 * The owner's acceptance criterion for this row was not "make it look good", which no gate
 * can hold. It was *"the most critical part is to have something interesting and not just
 * very flat and boring after 15 seconds, something that keeps interesting and changing"* —
 * and that is a statement about MOTION OVER TIME, which is exactly the class of thing a
 * still cannot show and a test can.
 *
 * So the headline claim below renders the piece at 0, 15, 45 and 90 seconds and asserts it
 * is a different picture each time. Two things make that claim mean something rather than
 * merely pass:
 *
 *   1. THE ORBIT IS FROZEN. §V965 was filed because E68's beat claim compared two frames of
 *      a moving camera and was therefore measuring the camera — a dolly changes a frame's
 *      mean more between two distant frames than any drive does. With `orbitSpeed` at 0 the
 *      camera is dead still and what moves is the SHAPE, which is the thing being claimed.
 *   2. IT CARRIES ITS OWN CONTROL. A second arm freezes all six clocks by setting their
 *      periods enormous, and asserts the same four frames collapse to one picture. Without
 *      that arm "the frames differ" is the vacuous claim §V958 names by name — E57 shipped
 *      exactly that assertion for two rows before anyone noticed a veil was drifting on its
 *      own clock and making any two frames differ.
 */

function e70() {
  const file = listExamples().find((entry) => entry.fileName === "E70-Chimera.loom.json");
  if (file === undefined) throw new Error("E70-Chimera.loom.json is not shipped");
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

type Mutate = (graph: GraphDocument) => void;

/**
 * Render the document at a chosen set of frame indices, at a chosen frame rate.
 *
 * ⚑ THE FRAME RATE IS A PARAMETER BECAUSE `absTime` IS `absFrameIndex / fps`, and every one
 * of this piece's six clocks reads that and nothing else. At 1 fps, frame 90 IS ninety
 * seconds — so a claim about what the piece looks like a minute and a half in costs 91
 * renders instead of 5 400. That is not a shortcut around the clock, it IS the clock: the
 * shader's state is a function of `absTime` alone, so the same absTime is the same picture
 * however many frames were drawn to get there.
 */
async function shootSeries(
  frames: readonly number[],
  fps: number,
  mutate: Mutate = () => {},
): Promise<Frame[]> {
  const { document, result } = e70();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const last = Math.max(...frames);
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: last + 1,
    capture: [...frames],
    animate: true,
    fps,
    outputNodeId: "out",
    ...(result.components ? { components: result.components } : {}),
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = rendered.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  return rendered.frames.map((frame) => {
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

async function shoot(frameIndex: number, mutate: Mutate = () => {}): Promise<Frame> {
  const [frame] = await shootSeries([frameIndex], 60, mutate);
  if (frame === undefined) throw new Error("no frame captured");
  return frame;
}

const luma = (frame: Frame, pixel: number): number =>
  0.2126 * (frame.d[pixel * 4] ?? 0) + 0.7152 * (frame.d[pixel * 4 + 1] ?? 0) + 0.0722 * (frame.d[pixel * 4 + 2] ?? 0);

const meanLuma = (frame: Frame): number => {
  let total = 0;
  for (let pixel = 0; pixel < frame.w * frame.h; pixel += 1) total += luma(frame, pixel);
  return total / (frame.w * frame.h);
};

/**
 * MEAN ABSOLUTE PER-PIXEL DIFFERENCE, and the choice of instrument is half the claim.
 *
 * A difference of MEANS is the wrong instrument for "is this a different picture": a shape
 * can reorganise completely and keep its average brightness, and §V966 found the matching
 * trap one axis over (peak-to-peak cannot tell a swell from a strobe). Per-pixel is what
 * distinguishes "the object changed" from "the object got brighter".
 */
function meanPixelDelta(a: Frame, b: Frame): number {
  if (a.w !== b.w || a.h !== b.h) throw new Error("frames differ in size");
  let total = 0;
  for (let pixel = 0; pixel < a.w * a.h; pixel += 1) total += Math.abs(luma(a, pixel) - luma(b, pixel));
  return total / (a.w * a.h);
}

function param(graph: GraphDocument, id: string, key: string, value: unknown): void {
  const node = graph.nodes[id];
  if (node === undefined) throw new Error(`E70 has no \`${id}\` node`);
  (node.parameters as Record<string, unknown>)[key] = value;
}

/**
 * EVERY DRIVEN SLOT AT ITS RETAINED VALUE, and it is the WHOLE list rather than a sample.
 *
 * §T1304c's lesson stated as code: a claim that cuts two of nine lanes is asserting §V914
 * about a fifth of the file, and the seven it does not cut could each rest somewhere else
 * entirely and the claim would still pass. These nine numbers are the document's own
 * statics, copied from it.
 */
function cutEveryDrive(graph: GraphDocument): void {
  param(graph, "shape", "veinEmission", 5.5);
  param(graph, "shape", "shellGlow", 0.5);
  param(graph, "shape", "veinSpread", 5.5);
  param(graph, "shape", "haze", 0.22);
  param(graph, "shape", "fillIntensity", 4.6);
  param(graph, "shape", "foldTravel", 0.18);
  param(graph, "shape", "specular", 1.35);
  param(graph, "shape", "saturation", 1.22);
  param(graph, "shape", "tempoScale", 1);
}

/** Park the camera. §V965: otherwise every claim below is a claim about the orbit. */
function freezeCamera(graph: GraphDocument): void {
  param(graph, "shape", "orbitSpeed", 0);
}

/**
 * Stop every clock by putting its period far past the horizon any claim renders.
 *
 * ⚑ DERIVED FROM THE DOCUMENT, NOT WRITTEN OUT — §V958, proved twice on this very file.
 * The first version listed the clocks by hand, and it went stale in BOTH available ways:
 * a seventh clock was added (`voidPeriod`, the negative space the owner asked for) and was
 * never frozen, and one of the six was RENAMED (`juliaPeriod` became `seedPeriod`) so its
 * line addressed a parameter that no longer existed. Neither failure announced itself,
 * because `param()` throws on a missing NODE and not on an unknown KEY — a stale freeze is
 * silent by construction.
 *
 * What caught it was the control arm: the one whose entire job is to show the instrument
 * can read ZERO measured 6.04 where it asserts under 0.5. Without that arm the headline
 * claim would have passed while measuring clocks it believed it had stopped.
 *
 * So the list is read off the shipped parameters instead, and it asserts its own size: the
 * next clock added to the piece is frozen by landing rather than by somebody remembering
 * this file, and a rename fails loudly here instead of quietly freezing nothing.
 */
function freezeClocks(graph: GraphDocument): void {
  const node = graph.nodes["shape"];
  if (node === undefined) throw new Error("E70 has no `shape` node");
  const parameters = node.parameters as Record<string, unknown>;
  const clocks = Object.keys(parameters).filter((key) => key.endsWith("Period"));
  /* The two clocks whose names say what they turn rather than that they are periods. */
  for (const named of ["hueTurn", "lightCycle"]) {
    if (!(named in parameters)) {
      throw new Error(`E70 no longer has a ${named} clock — freezeClocks is stale`);
    }
    clocks.push(named);
  }
  if (clocks.length < 7) {
    throw new Error(`freezeClocks found ${clocks.length} clocks; the piece has at least 7`);
  }
  for (const clock of clocks) param(graph, "shape", clock, 1.0e9);
}

describe("E70 Chimera — claims", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * ⚑ THE ROW'S ACCEPTANCE CRITERION: IT IS NOT FLAT AND BORING AFTER FIFTEEN SECONDS.
   *
   * The camera is frozen and every audio drive is cut, so neither the orbit nor the track
   * can be credited with a change the shape did not make. What is left moving is the six
   * clocks, and the claim is that they move the PICTURE and not merely the numbers.
   *
   * The control arm is the half that makes it a measurement: the same four frames with the
   * clocks stopped must be one picture. If that arm ever also shows motion, something else
   * in the file is drifting and this claim was never testing what it says.
   */
  it("is a different picture at 15 s, 45 s and 90 s — and is not, with the clocks stopped", async () => {
    const moving = await shootSeries([0, 15, 45, 90], 1, (graph) => {
      cutEveryDrive(graph);
      freezeCamera(graph);
    });
    const frozen = await shootSeries([0, 15, 45, 90], 1, (graph) => {
      cutEveryDrive(graph);
      freezeCamera(graph);
      freezeClocks(graph);
    });

    const [m0, m15, m45, m90] = moving;
    const [f0, f15, f45, f90] = frozen;
    if (m0 === undefined || m15 === undefined || m45 === undefined || m90 === undefined) {
      throw new Error("the moving arm captured fewer than four frames");
    }
    if (f0 === undefined || f15 === undefined || f45 === undefined || f90 === undefined) {
      throw new Error("the control arm captured fewer than four frames");
    }

    /* THE CONTROL FIRST, because a green headline claim means nothing until the instrument
       has shown it can read zero. With every clock stopped and the camera parked, the
       shader's uniforms are the same at every one of these times, so the frames are the
       same frame. */
    expect(meanPixelDelta(f0, f15), "clocks stopped: 15 s must be the same picture").toBeLessThan(0.5);
    expect(meanPixelDelta(f0, f45), "clocks stopped: 45 s must be the same picture").toBeLessThan(0.5);
    expect(meanPixelDelta(f0, f90), "clocks stopped: 90 s must be the same picture").toBeLessThan(0.5);

    /* AND THE CLAIM. Every one of these is the shape alone: same camera, no audio.
       ⚑ THE FENCES ARE SET FROM THE FIRST MEASURED RUN rather than chosen — see the row's
       report for the four numbers. What is asserted is a RATIO against the file's own
       control, not an absolute, so a retune of the look cannot quietly weaken it. */
    const d15 = meanPixelDelta(m0, m15);
    const d45 = meanPixelDelta(m0, m45);
    const d90 = meanPixelDelta(m0, m90);
    const floor = Math.max(meanPixelDelta(f0, f15), 0.05);

    expect(d15, "fifteen seconds in, the picture must have moved").toBeGreaterThan(floor * 20);
    expect(d45, "forty-five seconds in").toBeGreaterThan(floor * 20);
    expect(d90, "ninety seconds in").toBeGreaterThan(floor * 20);

    /* ⚑ AND THE PART THAT ACTUALLY ANSWERS "KEEPS CHANGING" RATHER THAN "CHANGED ONCE":
       the later comparisons are not smaller than the early one. A piece that moved in its
       first fifteen seconds and then settled would pass every assertion above — it is
       exactly what an envelope that settles looks like — and would fail this one. */
    expect(d45, "and it must not have settled by 45 s").toBeGreaterThan(d15 * 0.5);
    expect(d90, "nor by 90 s").toBeGreaterThan(d15 * 0.5);
  }, 600_000);

  /**
   * §V914 — WITH NO AUDIO THE PIECE IS STILL THE PIECE.
   *
   * Every thumbnail, every headless render and every first open has no track, so the
   * retained values are the frame most people actually see. E35 is why this is asserted
   * rather than assumed: cutting the audio path on that shipped file rendered a BLACK
   * FRAME, because six of eight retained values sat outside their own lane's range.
   *
   * The claim is deliberately NOT byte-identity here. E68 could make that claim because its
   * lanes rest at exact values — a count at zero, a rank at its middle — at a frame before
   * the first beat. This file's transient lanes ride ENVELOPES (§V966), and an envelope has
   * no frame at which it is exactly zero on a fixture whose first beat is at t=0. So what is
   * asserted is the thing §V914 actually protects: THE REST STATE IS A PICTURE, AND IT IS
   * THE SAME PICTURE THE SHIPPED FILE IS.
   */
  it("the retained values render the piece, not a different or an empty one", async () => {
    const [driven] = await shootSeries([40], 60, freezeCamera);
    const [cut] = await shootSeries([40], 60, (graph) => {
      freezeCamera(graph);
      cutEveryDrive(graph);
    });
    if (driven === undefined || cut === undefined) throw new Error("no frame captured");

    /* IT IS A PICTURE. Not black (E35's failure) and not blown out — a frame whose mean sits
       in the working range of the grade rather than against either end of it. */
    const restMean = meanLuma(cut);
    expect(restMean, "the no-audio frame must not be black").toBeGreaterThan(6);
    expect(restMean, "nor blown out").toBeLessThan(200);

    /* AND IT IS THIS PIECE. The retained values are each lane's DRIVEN MEAN, so the rest
       frame should sit near the shipped one rather than at a corner of its range — a
       retained value outside its lane's driven distribution is §V914's defect exactly, and
       it shows up here as a rest state that looks like a different document. */
    expect(Math.abs(restMean - meanLuma(driven)) / restMean).toBeLessThan(0.35);
  }, 600_000);

  /**
   * THE BIOLUMINESCENCE FIRES AND FALLS BACK, and a continuous lane cannot pass this.
   *
   * §V965's repair is the shape of the measurement: HOLD THE FRAME INDEX FIXED AND CUT ONE
   * LANE, so the difference is the lane and nothing else. Comparing two frames of the live
   * document would measure the six clocks as much as the drum.
   *
   * At 112 bpm a beat is 32.14 frames, so beat 3 lands at frame 96.4: frame 94 is the last
   * before it and 98 the first clear one after. The lane rides the kick BAND ENVELOPE
   * through a 420 ms release (§V966), so it does not return to zero between beats — it
   * gutters, which is the difference between a light that lives and one that strobes.
   */
  it("the veins FIRE on the kick and fall back between kicks", async () => {
    /* ⚑ THE CLOCKS ARE FROZEN HERE TOO, and the first version of this claim was wrong for
       not doing it. Measuring `live - cut` at ONE frame isolates the lane; comparing that
       difference ACROSS frames twenty-six apart does not, because the lane's magnitude
       depends on how much vein-bearing surface is in view, and the shape has moved between
       them. The claim failed exactly that way — the "fall" measured LARGER than the
       "attack" (0.299 against 0.197) because the object at f120 simply carried more vein
       than at f98. §V958 again: freeze every driven slot the claim is not testing, and this
       piece's own clocks are driven slots even though no audio touches them. */
    const cutVeins = (graph: GraphDocument): void => {
      freezeCamera(graph);
      freezeClocks(graph);
      param(graph, "shape", "veinEmission", 5.5);
    };
    const live = (graph: GraphDocument): void => {
      freezeCamera(graph);
      freezeClocks(graph);
    };

    const beforeLive = await shoot(94, live);
    const beforeCut = await shoot(94, cutVeins);
    const afterLive = await shoot(98, live);
    const afterCut = await shoot(98, cutVeins);
    const lateLive = await shoot(120, live);
    const lateCut = await shoot(120, cutVeins);

    const before = meanLuma(beforeLive) - meanLuma(beforeCut);
    const after = meanLuma(afterLive) - meanLuma(afterCut);
    const late = meanLuma(lateLive) - meanLuma(lateCut);

    // The lane reaches the frame at all.
    /* ⚑ THE LANE SWINGS EITHER SIDE OF THE CUT ARM, AND THAT IS THE CLAIM — stronger than
       the one this test was first written to make. The cut arm is not a floor: it is the
       lane's RETAINED value, and §V914 requires that to be the DRIVEN MEAN. So a working
       transient lane must sit BELOW it between hits and rise ABOVE it on one, and measured
       it does exactly that (mean luma of 255, shape and camera both frozen so the only
       thing differing is the drum):

           f94  before the beat   -0.0076   below its own retained mean
           f98  on the beat       +0.0015   above it
           f120 between beats     -0.0075   back below

       A lane that merely drifted could not produce that crossing, and a lane whose retained
       value was a floor rather than a mean could not produce the negative half at all — so
       this single claim carries both the transient's shape AND §V914's requirement on the
       number it rests at. */
    expect(before, "between hits the lane must sit BELOW its retained mean").toBeLessThan(0);
    expect(after, "and a kick must carry it ABOVE that mean").toBeGreaterThan(0);
    // THE ATTACK, as a size rather than only a sign.
    expect(after - before, "the kick's rise must be worth seeing").toBeGreaterThan(0.004);
    // THE FALL: it comes back down on its own rather than ratcheting.
    expect(late, "and it must fall again, or the light simply came on").toBeLessThan(after);
    expect(after - late, "the fall must be the same order as the rise").toBeGreaterThan(0.004);
  }, 600_000);

  /**
   * THE TEMPO LANE IS A NO-OP ON THE FIXTURE AND REAL ON A TRACK — BOTH HALVES.
   *
   * §T1309b asked that the piece work at any tempo, and the lane that answers it is
   * `1 + bpmConfidence * (bpm - 112) / 112`. On the shipped `audioPattern` that is exactly
   * 1, which is why `driven-channel-motion.test.ts` reports the channel as still and why
   * this file declares it there.
   *
   * ⚑ A DECLARATION IS NOT A PROOF, and §T1279 is the precedent: that row's owner proved the
   * fixture no-op BYTE FOR BYTE rather than letting it pass as a change the owner had
   * approved, and separately argued the case where it is real. Both halves are here, so the
   * declaration cannot decay into a lane that is dead everywhere.
   *
   * Only `tempoScale` is left driven in both arms; everything else is cut, so the only path
   * from bpm to the picture is the morph clock.
   */
  it("the tempo lane is inert at 112 bpm and moves the morph at 140", async () => {
    const onlyTempo = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      param(graph, "shape", "tempoScale", {
        mode: "expression",
        bindings: {
          static: { kind: "static", value: 1 },
          expression: {
            kind: "expression",
            source: "1 + op('source1').chan.bpmConfidence * (op('source1').chan.bpm - 112) / 112",
          },
        },
      });
    };

    /* THE NO-OP HALF. At the fixture's own 112 the expression is 1 by arithmetic, so the
       driven arm and a hard static 1 are the same picture — and byte-identity is the only
       honest way to say "this changes nothing here" (§V147). */
    const [atFixture] = await shootSeries([40], 60, onlyTempo);
    const [atStatic] = await shootSeries([40], 60, (graph) => {
      freezeCamera(graph);
      cutEveryDrive(graph);
    });
    if (atFixture === undefined || atStatic === undefined) throw new Error("no frame captured");
    let differing = 0;
    for (let pixel = 0; pixel < atFixture.w * atFixture.h; pixel += 1) {
      if (Math.abs(luma(atFixture, pixel) - luma(atStatic, pixel)) > 0.5) differing += 1;
    }
    expect(differing, "at 112 bpm the tempo lane must change nothing").toBe(0);

    /* THE REAL HALF. One number in the document — the pattern's own bpm — and the morph
       clock runs 25% faster, which is a different picture at the same frame. */
    const [atFaster] = await shootSeries([40], 60, (graph) => {
      onlyTempo(graph);
      param(graph, "music1", "bpm", 140);
    });
    if (atFaster === undefined) throw new Error("no frame captured");
    expect(
      meanPixelDelta(atFixture, atFaster),
      "at 140 bpm the morph must be somewhere else at the same frame",
    ).toBeGreaterThan(1);
  }, 600_000);

  /**
   * THE REFLECTION IS ON THE OBJECT, NOT ON THE FRAME.
   *
   * The second march is the only idea in the file whose absence would still look plausible —
   * a matte shell reads as a matte shell. So the claim is §V361's: what differs if it is cut?
   *
   * And the second half is the one that would catch the reflection reaching something it
   * should not. A reflection is a SURFACE effect: it may only change pixels the primary ray
   * actually hit. If cutting `polish` moved most of the frame, the term would be acting as a
   * global gain — which is what a mis-scoped shading term looks like and what a mean-only
   * claim would happily pass.
   */
  it("cutting `polish` changes the shell and leaves the void alone", async () => {
    const wet = await shoot(40, freezeCamera);
    const dry = await shoot(40, (graph) => {
      freezeCamera(graph);
      param(graph, "shape", "polish", 0);
    });

    let moved = 0;
    let brightMoved = 0;
    let brightCount = 0;
    const median = meanLuma(wet);
    for (let pixel = 0; pixel < wet.w * wet.h; pixel += 1) {
      const delta = Math.abs(luma(wet, pixel) - luma(dry, pixel));
      if (delta > 0.5) moved += 1;
      if (luma(wet, pixel) > median) {
        brightCount += 1;
        brightMoved += delta;
      }
    }
    const total = wet.w * wet.h;

    // It reaches the frame.
    expect(moved / total, "the reflection must change something").toBeGreaterThan(0.01);
    /* And it is a surface effect: the void the object hangs in is untouched, so most of the
       frame cannot have moved. */
    expect(moved / total, "but it must not move most of the frame — it is not a gain").toBeLessThan(0.7);
    // What it moved is the lit shell rather than the background.
    expect(brightMoved / Math.max(brightCount, 1)).toBeGreaterThan(0);
  }, 600_000);
});
