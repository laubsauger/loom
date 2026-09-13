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
 * EVERY DRIVEN SLOT AT ITS RETAINED VALUE — READ OFF THE DOCUMENT, NEVER COPIED FROM IT.
 *
 * §T1304c's lesson stated as code: a claim that cuts two of ten lanes is asserting §V914
 * about a fifth of the file, and the eight it does not cut could each rest somewhere else
 * entirely and the claim would still pass.
 *
 * ⚑ AND THE LIST IS DERIVED, FOR THE REASON THE FREEZE LIST BELOW IS. The first version of
 * this function was nine numbers transcribed from the document, and a transcription is
 * correct exactly until somebody retunes a lane — at which point it silently asserts §V914
 * about a value the file no longer retains, which is the one failure this claim exists to
 * catch. Every driven parameter in this piece is an `expressionSlot`, and an expression slot
 * CARRIES its own retained value in its `static` binding, so the honest cut is to replace
 * each slot with the number the document itself would fall back to. A lane added tomorrow is
 * cut by landing rather than by somebody remembering this file.
 *
 * It asserts its own size for the same reason `freezeClocks` does: if this ever finds no
 * slots, the shape of the document has changed underneath it and every claim below would
 * quietly become a claim about the live document instead of about its rest state.
 */
function cutEveryDrive(graph: GraphDocument): void {
  const node = graph.nodes["shape"];
  if (node === undefined) throw new Error("E70 has no `shape` node");
  const parameters = node.parameters as Record<string, unknown>;
  let cut = 0;
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== "object" || value === null) continue;
    const slot = value as { mode?: unknown; bindings?: { static?: { value?: unknown } } };
    if (slot.mode !== "expression") continue;
    const retained = slot.bindings?.static?.value;
    if (retained === undefined) {
      throw new Error(`E70's \`${key}\` is driven but carries no retained value`);
    }
    parameters[key] = retained;
    cut += 1;
  }
  if (cut < 10) {
    throw new Error(`cutEveryDrive found ${cut} driven slots; the piece has at least 10`);
  }
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
function clocksOf(parameters: Record<string, unknown>): string[] {
  const clocks = Object.keys(parameters).filter((key) => key.endsWith("Period"));
  /* The two clocks whose names say what they turn rather than that they are periods. */
  for (const named of ["hueTurn", "lightCycle"]) {
    if (!(named in parameters)) {
      throw new Error(`E70 no longer has a ${named} clock — the clock list is stale`);
    }
    clocks.push(named);
  }
  return clocks;
}

function freezeClocks(graph: GraphDocument): void {
  const node = graph.nodes["shape"];
  if (node === undefined) throw new Error("E70 has no `shape` node");
  const parameters = node.parameters as Record<string, unknown>;

  const clocks = clocksOf(parameters);
  if (clocks.length < 10) {
    throw new Error(`freezeClocks found ${clocks.length} clocks; the piece has at least 10`);
  }
  for (const clock of clocks) param(graph, "shape", clock, 1.0e9);

  /* ⚑ AND THE AMPLITUDES GO TO ZERO AS WELL, WHICH IS NOT BELT AND BRACES — IT IS §V976.
   *
   * A period pushed past the horizon makes every clock term CONSTANT, which is all the
   * control arm's assertion literally needs. But constant is not the same as ABSENT, and two
   * of this file's terms prove it: the seed drift reads `sin(jp*TAU*1.31 + 1.7)`, which at
   * jp = 0 is 0.99 and not 0, and the fold limit reads `sin(... + 2.1)`, which is 0.863. So a
   * period-only freeze renders a SLIGHTLY DIFFERENT OBJECT from the one every other arm
   * renders, and the floor it measures is a floor on a picture that does not ship.
   *
   * A zero amplitude provably contributes nothing. The sibling piece found this writing its
   * own version of the coprime claim, and the rule that came out of it is the general one:
   * BUILD A CONTROL BY ZEROING AMPLITUDES, NOT BY SETTING PERIODS TO INFINITY.
   *
   * Derived by name for §V958's reason — a travel added tomorrow is zeroed by landing.
   *
   * ⚠ AND `foldSpin` IS DELIBERATELY NOT IN THIS LIST, which is the half that shows the rule
   * is being applied rather than obeyed. The rotation reads `morph * foldSpin` with
   * `morph = (t/period + morphPhase) * TAU`: at an infinite period that is already exactly
   * `morphPhase * TAU`, a real angle and the one the piece ships at. Zeroing the amplitude
   * instead would send the rotation to the IDENTITY — and an axis-aligned fold chain seen
   * down an axis is the degenerate flat slab this file's `morphPhase` exists to avoid. The
   * control would still collapse to one picture; it would just be a picture of nothing, and
   * the floor it measured would be a floor on the wrong object. Zero the amplitude where the
   * term has a PHASE OFFSET that leaves it non-zero at t=0; freeze the period where the
   * amplitude is what the shipped picture is made of. */
  const travels = Object.keys(parameters).filter(
    (key) => key.endsWith("Travel") || key.endsWith("Drift"),
  );
  if (travels.length < 4) {
    throw new Error(`freezeClocks found ${travels.length} travels; the piece has at least 4`);
  }
  for (const travel of travels) param(graph, "shape", travel, 0);
}

/**
 * THE PERIODS ARE PAIRWISE COPRIME — ENUMERATED AND CHECKED, NOT ASSERTED IN A COMMENT.
 *
 * ⚑ THIS RUNS WITHOUT DAWN ON PURPOSE. It is arithmetic on the document, so it costs nothing
 * and it gates the property every other claim in this file leans on: the piece's answer to
 * *"not just very flat and boring after 15 seconds"* is that its clocks do not line up, so
 * any two moments a viewer compares have a different subset of them moved. If two periods
 * share a factor, the pair realigns on their least common multiple and the piece has a beat
 * frequency nobody designed.
 *
 * ⚠ AND IT IS WRITTEN BECAUSE THE ASSUMPTION FAILED ON THE SIBLING PIECE. The same
 * enumeration, the first time anyone ran it there, found TWO OF NINE PERIODS SHARING A FACTOR
 * OF THREE — realigning every 210 seconds — while two commit messages described the whole set
 * as mutually prime. Nobody had checked; everybody had said it. A property this cheap to test
 * has no business being carried in prose.
 */
describe("E70 Chimera — the clocks", () => {
  it("every period in the document is pairwise coprime with every other", () => {
    const node = e70().document.graph.nodes["shape"];
    if (node === undefined) throw new Error("E70 has no `shape` node");
    const parameters = node.parameters as Record<string, unknown>;

    const periods = new Map<string, number>();
    for (const key of clocksOf(parameters)) {
      const value = parameters[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
        throw new Error(`E70's \`${key}\` is ${String(value)}; a period must be an integer > 1`);
      }
      periods.set(key, value);
    }
    /* If a clock is ever added without a period, the enumeration must fail rather than
       silently check a smaller set — which is exactly how the sibling's two lanes hid. */
    expect(periods.size, "the piece has at least ten independent clocks").toBeGreaterThanOrEqual(10);

    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const entries = [...periods.entries()];
    const shared: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [nameA, a] = entries[i]!;
        const [nameB, b] = entries[j]!;
        const common = gcd(a, b);
        if (common > 1) shared.push(`${nameA} ${a} and ${nameB} ${b} share ${common}`);
      }
    }
    expect(shared, "two clocks that share a factor realign on their LCM").toEqual([]);
  });
});

/* The times the headline claim samples, in seconds. Spaced evenly so "is it still moving"
   is asked at every stage of the run rather than only at moments that flatter it. */
const TIMELINE = [0, 15, 30, 45, 60, 75, 90];

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
  it("keeps changing at every interval out to 90 s — and stops dead with the clocks stopped", async () => {
    const moving = await shootSeries(TIMELINE, 1, (graph) => {
      cutEveryDrive(graph);
      freezeCamera(graph);
    });
    const frozen = await shootSeries(TIMELINE, 1, (graph) => {
      cutEveryDrive(graph);
      freezeCamera(graph);
      freezeClocks(graph);
    });
    if (moving.length !== TIMELINE.length || frozen.length !== TIMELINE.length) {
      throw new Error("an arm captured fewer frames than the timeline asks for");
    }

    /* THE CONTROL FIRST, because a green headline claim means nothing until the instrument
       has shown it can read zero. With every clock stopped, every travel zeroed and the
       camera parked, the shader's uniforms are the same at every one of these times, so the
       frames are the same frame. The worst pair is taken rather than one pair: a control that
       checks three of six gaps is a control over half the run. */
    let control = 0;
    for (let index = 1; index < frozen.length; index += 1) {
      const first = frozen[0];
      const later = frozen[index];
      if (first === undefined || later === undefined) throw new Error("missing control frame");
      control = Math.max(control, meanPixelDelta(first, later));
    }
    expect(control, "clocks stopped: every one of these must be the same picture").toBeLessThan(0.5);

    /* AND THE CLAIM, AND IT IS MEASURED BETWEEN CONSECUTIVE TIMES RATHER THAN AGAINST t=0.
       ⚑ THE FIRST VERSION COMPARED EVERYTHING TO THE FIRST FRAME AND THAT INSTRUMENT BROKE
       THE MOMENT A 43-SECOND CLOCK JOINED THE PIECE. Measured, camera parked and audio cut:
       against t=0 the deltas run 15 s 51.0, 30 s 21.0, 45 s 20.9, 90 s 18.1 — which reads
       exactly like a piece that moved once and settled, and is nothing of the kind. The push
       clock's period is 43 s, so t=0, t=45 and t=90 all catch the object at the SAME
       DISTANCE, and a distance-from-origin instrument reports a phase coincidence as death.
       The consecutive intervals over the same run are 51.0 / 54.2 / 16.0 / 81.2 / 71.0 /
       59.4 against a control floor of 0.0167.
       So the question is asked the way the owner asked it — is it STILL changing — at every
       interval rather than from one privileged moment. A piece that went still anywhere would
       fail here, and no arrangement of periods can fake it. */
    const floor = Math.max(control, 0.05);
    const intervals: number[] = [];
    for (let index = 1; index < moving.length; index += 1) {
      const before = moving[index - 1];
      const after = moving[index];
      if (before === undefined || after === undefined) throw new Error("missing frame");
      intervals.push(meanPixelDelta(before, after));
    }
    for (const [index, delta] of intervals.entries()) {
      expect(
        delta,
        `between ${String(TIMELINE[index])} s and ${String(TIMELINE[index + 1])} s the picture must move`,
      ).toBeGreaterThan(floor * 20);
    }

    /* ⚑ AND THE PART THAT ANSWERS "KEEPS CHANGING" RATHER THAN "CHANGED ONCE": the LAST
       interval is the same order as the FIRST. A piece that moved in its opening seconds and
       then settled — which is exactly what an envelope that settles looks like — passes every
       assertion above and fails this one. Measured 59.4 against 51.0, a ratio of 1.16. */
    const first = intervals[0];
    const last = intervals[intervals.length - 1];
    if (first === undefined || last === undefined) throw new Error("no intervals");
    expect(last, "ninety seconds in it must still be moving as much as it was at the start")
      .toBeGreaterThan(first * 0.4);
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
    /* ⚑ THE RETAINED VALUE IS READ OFF THE DOCUMENT, NOT TYPED IN — and the first version
       typed it in, which is how this claim broke the moment the lane was retuned. A hard
       5.5 against a lane that now retains a different number is not "the drive cut", it is
       "the drive replaced by a wrong constant", and the whole claim silently inverted: every
       frame measured ABOVE the cut arm because the cut arm was simply darker. §V958's shape
       one level down — the freeze was derived and the CUT was not. */
    const retainedVeinEmission = ((): number => {
      const parameters = e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>;
      const slot = parameters["veinEmission"] as { bindings?: { static?: { value?: unknown } } };
      const value = slot?.bindings?.static?.value;
      if (typeof value !== "number") throw new Error("E70's veinEmission is no longer a driven slot");
      return value;
    })();

    const cutVeins = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
      param(graph, "shape", "veinEmission", retainedVeinEmission);
    };
    /* ⚠ AND THE LIVE ARM CUTS EVERY *OTHER* DRIVE, so the only lane still reaching the
       frame is the one under test. Leaving the others live measured the whole audio rig. */
    const live = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
      const parameters = e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>;
      param(graph, "shape", "veinEmission", parameters["veinEmission"]);
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
   * ⚑ THE VEINS LIGHT THE AIR — AND THIS IS THE CLAIM §V973 SAYS COULD NOT HAVE BEEN MADE
   * BEFORE, WHICH IS WHY THE OLD VOLUME SURVIVED THREE PASSES AND A WRITTEN DEFENCE.
   *
   * The owner's complaint was *"these lit up highlights… they also need to ACTUALLY EMIT
   * LIGHT — or at least some fake light, fake volume light, some fake radiance."* The piece
   * already had a volume, so the defect was not that light in the air was missing; it was
   * that the light in the air and the light on the surface were NOT THE SAME LIGHT. The
   * medium accumulated a constant tint shaped by proximity to the object, and knew nothing
   * whatever about which parts of that object were lit. §V973's tell is exactly that such a
   * pairing has no way to DISAGREE visibly: nothing looks broken, the volume simply never
   * confirms what the surface says.
   *
   * So the claim is the disagreement made observable. Cut the vein emission and ask what
   * happened IN THE VOID — the pixels where the primary ray hit nothing at all, which no
   * surface term can reach by construction. If the air carries the object's own light, those
   * pixels move. If the air carries a constant tint, they cannot move, and this test is
   * exactly zero.
   *
   * ⚠ THE VOID MASK IS DERIVED FROM A RENDER RATHER THAN FROM GEOMETRY, and that is the
   * §V964/§V968 discipline: a mask guessed at (say, "the outer margin") would quietly include
   * object pixels at some frames and the claim would be measuring the surface it says it is
   * excluding. Rendering with `haze` at 0 leaves the backdrop and nothing else, so a pixel
   * that is black THERE is a pixel the primary ray missed, measured rather than assumed.
   */
  it("cutting the veins changes the light in the AIR, not only on the shell", async () => {
    /* ⚠ cutEveryDrive FIRST: `freezeClocks` zeroes `foldTravel`, which is itself a driven
       slot, so the other order leaves the cut looking for a slot that is already a number. */
    const held = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
    };

    /* THE MASK: what the camera sees where it sees no object and no medium. */
    const dry = await shoot(40, (graph) => {
      held(graph);
      param(graph, "shape", "haze", 0);
    });
    const lit = await shoot(40, held);
    const dark = await shoot(40, (graph) => {
      held(graph);
      param(graph, "shape", "veinEmission", 0);
      param(graph, "shape", "veinSpill", 0);
      param(graph, "shape", "shellGlow", 0);
      param(graph, "shape", "nodeGlow", 0);
      param(graph, "shape", "nodeSpill", 0);
    });

    /* ⚑ THE MASK IS AN ANNULUS AROUND THE OBJECT, NOT THE WHOLE VOID, AND THE FIRST VERSION
       WAS THE WHOLE VOID — which is §V964's wrong window and reported this claim as dead.
       The void is 81% of the frame and nearly all of it is empty space metres from the
       sculpture, where the medium's own radial falloff has already taken it to nothing.
       Averaging the air over THAT dilutes the thing being measured by a factor of twenty:
       measured at the same frame, the near ring moves 1.78% of its pixels with a mean delta
       of 0.066, and the whole void moves 0.16% with a mean of 0.004. Same render, same
       physics, two different answers, and only one of them is about the air AROUND the
       object.
       The dilation is separable — a horizontal max then a vertical one — so the ring costs
       two linear passes rather than a box search per pixel. */
    const W = lit.w;
    const H = lit.h;
    const RING = 8;
    const solid = new Uint8Array(W * H);
    for (let pixel = 0; pixel < W * H; pixel += 1) if (luma(dry, pixel) > 1) solid[pixel] = 1;
    const spreadX = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let any = 0;
        for (let dx = -RING; dx <= RING && any === 0; dx += 1) {
          const xx = x + dx;
          if (xx >= 0 && xx < W && solid[y * W + xx] === 1) any = 1;
        }
        spreadX[y * W + x] = any;
      }
    }
    const nearObject = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let any = 0;
        for (let dy = -RING; dy <= RING && any === 0; dy += 1) {
          const yy = y + dy;
          if (yy >= 0 && yy < H && spreadX[yy * W + x] === 1) any = 1;
        }
        nearObject[y * W + x] = any;
      }
    }

    let ringPixels = 0;
    let ringMoved = 0;
    let ringDelta = 0;
    let farPixels = 0;
    let farDelta = 0;
    for (let pixel = 0; pixel < W * H; pixel += 1) {
      if (solid[pixel] === 1) continue;
      const delta = Math.abs(luma(lit, pixel) - luma(dark, pixel));
      if (nearObject[pixel] === 1) {
        ringPixels += 1;
        ringDelta += delta;
        if (delta > 0.5) ringMoved += 1;
      } else {
        farPixels += 1;
        farDelta += delta;
      }
    }

    /* The mask has to be a real region, or every number below is an average over nothing. */
    expect(ringPixels / (W * H), "the annulus must be a real part of the frame").toBeGreaterThan(0.005);
    expect(farPixels / (W * H), "and so must the far field it is compared against").toBeGreaterThan(0.2);

    /* THE CLAIM. A volume reading a field unrelated to the surface's returns zero here.
       Measured 1.78% moved at a mean of 0.066; the fences sit at half of each. */
    expect(
      ringMoved / ringPixels,
      "the air beside the object must dim when its light is cut",
    ).toBeGreaterThan(0.008);
    expect(ringDelta / ringPixels, "and by an amount worth seeing").toBeGreaterThan(0.03);

    /* ⚑ AND THE HALF THAT SAYS IT IS THE OBJECT'S LIGHT RATHER THAN A GLOBAL WASH: the
       effect FALLS OFF with distance from the object. A medium that brightened the whole
       frame equally would pass the assertion above and fail this one, and it is exactly what
       a volume that had been given a global gain instead of a field would look like.
       Measured 0.066 beside the object against 0.004 far from it — a factor of sixteen. */
    expect(
      ringDelta / ringPixels,
      "and it must be LOCAL to the object, not a wash over the frame",
    ).toBeGreaterThan((farDelta / Math.max(farPixels, 1)) * 4);
  }, 600_000);

  /**
   * THE PODS LIGHT THE STONE THEY SIT IN — WHICH IS THE DIFFERENCE BETWEEN A LIGHT AND A
   * SPRITE, AND IT IS NOT A THING ANYONE CAN SETTLE BY LOOKING.
   *
   * The owner asked for the highlights to *"ACTUALLY EMIT LIGHT — or at least some fake
   * light, fake volume light, some fake radiance."* A term added to a surface's colour does
   * not emit anything: it brightens the pixels it covers and leaves every neighbouring pixel
   * exactly as it was. Both look like "a bright mark" in a still, and only one of them is a
   * light.
   *
   * ⚑ SO THE MASK IS BUILT FROM THE CORES THEMSELVES RATHER THAN GUESSED AT. An arm with the
   * core term cut says exactly which pixels a pod covers; dilating that gives the stone
   * AROUND the pods; and the pod pixels are then EXCLUDED, because "the mark is bright" is
   * the thing being controlled for, not the thing being claimed.
   *
   * Measured at this frame: cutting the spill moves stone within ten pixels of a pod by 1.708
   * mean luma and stone beyond it by 0.034 — a ratio of fifty. The fences are a fraction of
   * both, and the RATIO is what is asserted rather than the absolute, so a retune of the look
   * cannot quietly weaken the claim into "the pods got brighter".
   */
  it("a pod lights the stone around it, and only around it", async () => {
    const held = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
    };
    const shipped = await shoot(40, held);
    const noCore = await shoot(40, (graph) => {
      held(graph);
      param(graph, "shape", "nodeGlow", 0);
    });
    const noSpill = await shoot(40, (graph) => {
      held(graph);
      param(graph, "shape", "nodeSpill", 0);
    });

    const W = shipped.w;
    const H = shipped.h;
    const RING = 10;
    /* Where a pod's CORE lands: the pixels the core term alone is responsible for. */
    const core = new Uint8Array(W * H);
    for (let pixel = 0; pixel < W * H; pixel += 1) {
      if (Math.abs(luma(shipped, pixel) - luma(noCore, pixel)) > 6) core[pixel] = 1;
    }
    /* Separable dilation: a horizontal pass then a vertical one. */
    const spreadX = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let any = 0;
        for (let d = -RING; d <= RING && any === 0; d += 1) {
          const xx = x + d;
          if (xx >= 0 && xx < W && core[y * W + xx] === 1) any = 1;
        }
        spreadX[y * W + x] = any;
      }
    }
    const nearPod = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let any = 0;
        for (let d = -RING; d <= RING && any === 0; d += 1) {
          const yy = y + d;
          if (yy >= 0 && yy < H && spreadX[yy * W + x] === 1) any = 1;
        }
        nearPod[y * W + x] = any;
      }
    }

    let coreCount = 0;
    let ringCount = 0;
    let ringDelta = 0;
    let farCount = 0;
    let farDelta = 0;
    for (let pixel = 0; pixel < W * H; pixel += 1) {
      /* Stone only. The void is the volume's business and is claimed separately. */
      if (luma(noCore, pixel) <= 4) continue;
      if (core[pixel] === 1) {
        coreCount += 1;
        continue;
      }
      const delta = Math.abs(luma(shipped, pixel) - luma(noSpill, pixel));
      if (nearPod[pixel] === 1) {
        ringCount += 1;
        ringDelta += delta;
      } else {
        farCount += 1;
        farDelta += delta;
      }
    }

    /* The masks must all be real, or the ratio below is an average over nothing (§V964). */
    expect(coreCount, "the pods must actually cover some pixels").toBeGreaterThan(500);
    expect(ringCount, "and there must be stone around them to light").toBeGreaterThan(5000);
    expect(farCount, "and stone away from them to compare against").toBeGreaterThan(200);

    const ring = ringDelta / ringCount;
    const far = farDelta / farCount;
    /* IT REACHES THE STONE AT ALL — this is the assertion a sprite fails outright. */
    expect(ring, "a pod must change the stone it sits in").toBeGreaterThan(0.4);
    /* AND IT IS A LOCAL LIGHT RATHER THAN A GAIN ON THE WHOLE SHELL, which is what a
       mis-scoped shading term looks like and what a mean-only claim would happily pass. */
    expect(ring / Math.max(far, 1.0e-4), "and it must do it LOCALLY").toBeGreaterThan(8);
  }, 600_000);

  /**
   * LOOSENESS IS DRIVEN; IDENTITY IS NOT — AND BOTH HALVES ARE ASSERTED.
   *
   * T1310b ruled that nothing audio-driven may touch the object's identity, because if the
   * music decided what the object IS then silence would be a different object, and silence is
   * what every thumbnail renders. That ruling stands. The owner then asked for *"sometimes
   * more loose, sometimes less"*, which is a third thing: the same object breathing.
   *
   * ⚑ THE INTERESTING HALF IS THE NO-OP ONE. §V914 is satisfied here by ARITHMETIC rather
   * than by a measurement somebody has to redo after a retune: the lane is `0.25 + 0.5 * r`
   * on a rank that rests at its middle, so it retains exactly 0.5, and the shader reads
   * `openness - 0.5`. The rest picture must therefore be BYTE-IDENTICAL to the picture this
   * file would render with the lane deleted — which is what `openSpread` and `openVoid` at 0
   * means. Byte-identity is the only honest way to say "this changes nothing here" (§V147),
   * and T1279's precedent is that a declaration of a no-op is not a proof of one.
   *
   * And the second half proves the lane is not merely dead: at the top of its range the shape
   * is somewhere else, with every other lane cut so the only path to the frame is looseness.
   */
  it("the looseness lane is a no-op at rest and opens the chain when it is driven", async () => {
    const restOnly = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
    };

    const atRest = await shoot(40, restOnly);
    const laneRemoved = await shoot(40, (graph) => {
      restOnly(graph);
      param(graph, "shape", "openSpread", 0);
      param(graph, "shape", "openVoid", 0);
    });

    let differing = 0;
    for (let pixel = 0; pixel < atRest.w * atRest.h; pixel += 1) {
      if (Math.abs(luma(atRest, pixel) - luma(laneRemoved, pixel)) > 0.5) differing += 1;
    }
    expect(differing, "at rest the looseness lane must change NOTHING").toBe(0);

    /* THE REAL HALF. One number, and the chain sits further open. */
    const opened = await shoot(40, (graph) => {
      restOnly(graph);
      param(graph, "shape", "openness", 1);
    });
    expect(
      meanPixelDelta(atRest, opened),
      "driven to the top of its range the shape must be somewhere else",
    ).toBeGreaterThan(1);
  }, 600_000);

  /**
   * THE OBJECT CARRIES THE ANGLES, AND THE CAMERA NEVER MOVES.
   *
   * The owner asked to *"sometimes follow one of the fractal knobs a little closer and see
   * some angles"*, then settled the mechanism: *"it doesn't have to be the camera that moves,
   * it can also be the piece."* Moving the object rather than the eye is what keeps every
   * other claim in this file provable, because §V965's defect — a two-frame comparison that
   * is secretly measuring a dolly — cannot occur against a camera that is parked.
   *
   * So this claim is the pair. The camera is frozen in BOTH arms and every other clock is
   * stopped in both; the only difference is whether the pose clocks are allowed to run. The
   * frames must differ when they do and be one picture when they do not — which is what says
   * the angles come from the object and not from anything else that happens to be moving.
   */
  it("the pose changes the view with the camera parked — and is the only thing that does", async () => {
    const parked = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
    };
    /* `freezeClocks` stops the pose along with everything else, so the moving arm hands the
       three pose clocks back their shipped periods and nothing else. */
    const posed = (graph: GraphDocument): void => {
      parked(graph);
      const shipped = e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>;
      for (const clock of ["posePeriod", "pushPeriod", "aimPeriod"]) {
        param(graph, "shape", clock, shipped[clock]);
      }
    };

    /* Ten and twenty-five seconds: far enough into the push clock's 43 s period to be at a
       different distance as well as a different angle. */
    const [poseA, poseB] = await shootSeries([10, 25], 1, posed);
    const [stillA, stillB] = await shootSeries([10, 25], 1, parked);
    if (poseA === undefined || poseB === undefined || stillA === undefined || stillB === undefined) {
      throw new Error("fewer than two frames captured");
    }

    /* THE CONTROL FIRST. With the pose stopped too, nothing in the piece is moving at all. */
    const floor = meanPixelDelta(stillA, stillB);
    expect(floor, "with the pose stopped these must be one picture").toBeLessThan(0.5);

    /* AND THE CLAIM: the object turned and swam in, and the camera did neither. */
    expect(
      meanPixelDelta(poseA, poseB),
      "the pose must move the view on its own",
    ).toBeGreaterThan(Math.max(floor, 0.05) * 20);
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
