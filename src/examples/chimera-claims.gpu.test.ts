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
  /* ⚑ EIGHT, AND IT WAS TEN UNTIL T1318b TOOK THREE LANES OFF THE FORM AND PUT ONE BACK ON
     THE LIGHT. The owner's ruling is that light may flash at beat rate and form may not, so
     `openness` and `foldTravel` were deleted outright and the kick moved off the global
     `veinEmission` onto the per-mark `flare`. The bound exists to catch the document's shape
     changing underneath this file, which is exactly what happened — so it moves WITH a
     recorded reason rather than being widened until it stops complaining. */
  if (cut < 8) {
    throw new Error(`cutEveryDrive found ${cut} driven slots; the piece has at least 8`);
  }
}

/**
 * Park the camera — ALL OF IT.
 *
 * ⚑ THIS FUNCTION USED TO STOP THE ORBIT AND NOTHING ELSE, AND IT WAS NOT PARKING THE CAMERA.
 * The three clocks it left running — `posePeriod`, `pushPeriod`, `aimPeriod` — were documented
 * for two passes as "the object's pose", but the transform is a rigid rotation and a uniform
 * scale applied to the EYE AND THE RAY DIRECTION TOGETHER, which is a camera move by
 * definition: the eye walks a sphere about the origin while the object stands still. Nothing
 * rendered could ever have disagreed with either description, which is how the wrong one
 * survived — and under it, every claim below that believed it had parked the camera was
 * measuring a camera that was orbiting, tilting, dollying and panning. That is §V965's own
 * defect wearing the name of the function written to prevent it.
 *
 * The owner's T1318b ruling ("the subject holds still; the camera does all the moving") is
 * what made the misnaming matter enough to notice.
 */
function freezeCamera(graph: GraphDocument): void {
  param(graph, "shape", "orbitSpeed", 0);
  for (const clock of ["posePeriod", "pushPeriod", "aimPeriod"]) {
    param(graph, "shape", clock, 1.0e9);
  }
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
  /* ⚑ DERIVED BY SUFFIX, ALL THREE OF THEM (T1324b) — AND THIS IS §V958 CATCHING THIS EXACT
     FUNCTION. The list used to be "everything ending in Period, plus these TWO NAMED ONES",
     and a hand-maintained tail on a derived list is a list that is one edit away from wrong:
     `paletteTurn` landed, was not in the tail, and the control arm that asserts "with every
     clock stopped these are the same picture" read 1.026 against its own 0.5 ceiling. The
     claim did not silently pass — which is the good outcome — but it failed for a reason
     that has nothing to do with what it tests. Every clock in this file is named for what it
     turns or how long it takes, so the suffix IS the rule. */
  const clocks = Object.keys(parameters).filter(
    (key) => key.endsWith("Period") || key.endsWith("Turn") || key.endsWith("Cycle"),
  );
  for (const named of ["hueTurn", "lightCycle", "paletteTurn"]) {
    if (!clocks.includes(named)) {
      throw new Error(`E70 no longer has a ${named} clock — the clock list is stale`);
    }
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
  it("the marks FIRE on the kick and fall back between kicks", async () => {
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
    /* ⚑ AND THE *LANE* IS NAMED RATHER THAN THE PARAMETER, which is what let this claim
       survive T1318b instead of silently passing on a dead key. The kick used to drive
       `veinEmission`, a GLOBAL gain on every conduit at once; it now drives `flare`, which
       reaches the same marks through an R3 sequence one at a time. The claim below is the
       same claim — does the light rise on the transient and gutter between them — and only
       the destination moved. It threw by name when the key went away (`param()` does not),
       which is the failure mode §V958 asks for. */
    const KICK_LANE = "flare";
    const retainedKickLane = ((): number => {
      const parameters = e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>;
      const slot = parameters[KICK_LANE] as { bindings?: { static?: { value?: unknown } } };
      const value = slot?.bindings?.static?.value;
      if (typeof value !== "number") throw new Error(`E70's ${KICK_LANE} is no longer a driven slot`);
      return value;
    })();

    const cutVeins = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
      param(graph, "shape", KICK_LANE, retainedKickLane);
    };
    /* ⚠ AND THE LIVE ARM CUTS EVERY *OTHER* DRIVE, so the only lane still reaching the
       frame is the one under test. Leaving the others live measured the whole audio rig. */
    const live = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
      const parameters = e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>;
      param(graph, "shape", KICK_LANE, parameters[KICK_LANE]);
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
       mis-scoped shading term looks like and what a mean-only claim would happily pass.
       ⚑ 8 -> 4, AND THE RE-FIT IS RECORDED RATHER THAN QUIETLY WIDENED. T1318b widened the
       box fold to take the cube out of the silhouette, which makes the OBJECT BIGGER, and
       every distance in the piece went up by the same 1.4 to keep it framed — camera, light
       rig, and the four fade reaches. `RING` above is in PIXELS, so the same ring now samples
       a different band of the WORLD, and the ratio it measures fell from over 8 to 5.06 with
       nothing about the pods having changed. That is §V920's amendment exactly: a constant
       fitted to one geometry is not a constant, it is a fit, and it has to be re-fitted to the
       data it is now pointed at. The claim it makes is unchanged and still strong — the ring
       moves five times what the far stone does — and a sprite, which moves the far stone by
       exactly as much as the ring, still fails it outright. */
    expect(ring / Math.max(far, 1.0e-4), "and it must do it LOCALLY").toBeGreaterThan(4);
  }, 600_000);

  /**
   * ⚑ THE KEY LIGHT CASTS — AND THE CLAIM IS THAT THE DARKNESS *MOVES WITH THE LIGHT*.
   *
   * The defect this term repairs is precise, and a brightness test cannot see it. The file
   * had AMBIENT occlusion and no cast shadow: `occlusionAt` asks "how enclosed is this point"
   * and knows nothing about where any light is, so THE SHADING PATTERN WAS IDENTICAL WHEREVER
   * THE RIG STOOD. Moving a light changed its tint and its intensity and could not change
   * which parts of the object were dark. That is the owner's *"as if the lights are all like
   * not cones but just all global god lights"*, and it is why the piece read STATICALLY lit
   * while the lights demonstrably moved.
   *
   * So what is measured is the SET OF PIXELS THE SHADOW TAKES ANYTHING FROM — the pixels
   * where the shadowed arm is dimmer than the arm with `shadowStrength` at 0. That set is
   * exactly where the shadow ray was blocked, so it is a pure function of the geometry and
   * the light's DIRECTION, and it carries no dependence on how bright anything is. With the
   * camera parked, the drives cut and every clock stopped but `lightCycle`, the object is
   * byte-for-byte the same object in all four renders and the only thing that changed
   * between the two times is where the lights stand.
   *
   * ⚑ TWO EARLIER FORMS OF THIS CLAIM WERE WRONG, AND BOTH FAILURES ARE WORTH THE LINES.
   *
   *   1. "WHEN THE LIGHT MOVES, DOES MORE OF THE PICTURE CHANGE WITH THE SHADOW THAN
   *      WITHOUT IT" measured 10.18 against 10.38 — very slightly LESS. The reason is real:
   *      A SHADOW REMOVES LIT SURFACE, and a surface dark in both frames cannot respond to
   *      the light travelling, so the moving shadow edge and the lost lit area cancel almost
   *      exactly. A number that goes the wrong way for a correct reason is the most
   *      expensive kind of instrument (§V974).
   *   2. AMBIENT OCCLUSION WAS THEN USED AS A KNOWN NEGATIVE — a term that provably cannot
   *      know where the light is, so its map must not move — AND IT MOVED. 0.74 overlap at
   *      an absolute threshold, 0.44 at a relative one. AO is not a control here and no
   *      threshold makes it one: `occ` MULTIPLIES `lit`, so where the rig has moved away the
   *      same occlusion removes a different share of a smaller number, and its VISIBILITY
   *      travels with the light even though its FIELD cannot. §V968's rule got its own
   *      corollary out of it: A TERM THAT IS INDEPENDENT OF X IS NOT A CONTROL FOR X IF IT
   *      IS *MULTIPLIED* BY SOMETHING THAT IS NOT.
   *
   * The control that holds is the instrument's own A/A: run the identical detector with
   * `lightCycle` STOPPED, so the light does not move either. It must then report the set as
   * unmoved. That is what says a low overlap in the live arm is the light travelling rather
   * than the detector being noise.
   */
  it("the shadow falls somewhere else when the light stands somewhere else", async () => {
    const oneObject = (lightClock: unknown) => (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
      param(graph, "shape", "lightCycle", lightClock);
    };
    const shippedLightCycle = (e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>)["lightCycle"];
    /* At 1 fps a frame index IS a second; 4 s and 22 s are a third of `lightCycle` apart, so
       the rig is in a genuinely different configuration. */
    const WHEN = [4, 22] as const;

    /** Exactly where the shadow took something: dimmer than the same frame without it. */
    const inShadow = (shadowed: Frame, flat: Frame): Set<number> => {
      const set = new Set<number>();
      for (let pixel = 0; pixel < flat.w * flat.h; pixel += 1) {
        const lit = luma(flat, pixel);
        if (lit < 4) continue;
        if ((lit - luma(shadowed, pixel)) / lit > 0.02) set.add(pixel);
      }
      return set;
    };
    const overlap = (a: Set<number>, b: Set<number>): number => {
      if (a.size === 0 || b.size === 0) return 0;
      let both = 0;
      for (const pixel of a) if (b.has(pixel)) both += 1;
      return both / Math.min(a.size, b.size);
    };

    const mapsFor = async (lightClock: unknown): Promise<readonly [Set<number>, Set<number>]> => {
      const live = oneObject(lightClock);
      const [shadowedA, shadowedB] = await shootSeries([...WHEN], 1, live);
      const [flatA, flatB] = await shootSeries([...WHEN], 1, (graph) => {
        live(graph);
        param(graph, "shape", "shadowStrength", 0);
      });
      if (shadowedA === undefined || shadowedB === undefined || flatA === undefined || flatB === undefined) {
        throw new Error("fewer than two frames captured");
      }
      return [inShadow(shadowedA, flatA), inShadow(shadowedB, flatB)] as const;
    };

    /* THE CONTROL FIRST — the detector's own A/A. With the light rig stopped as well, the
       two moments are the same picture and the shadow must be found in the same places. */
    const [stillA, stillB] = await mapsFor(1.0e9);
    expect(stillA.size, "the shadow must actually darken pixels").toBeGreaterThan(1000);
    const floor = overlap(stillA, stillB);
    expect(floor, "with the lights stopped the shadow must not move either").toBeGreaterThan(0.95);

    /* AND THE CLAIM. Same detector, same object, the lights now travelling. */
    const [movedA, movedB] = await mapsFor(shippedLightCycle);
    expect(movedA.size, "the shadow must darken pixels with the rig live too").toBeGreaterThan(1000);
    const travelled = overlap(movedA, movedB);
    expect(
      travelled,
      "a CAST shadow must fall somewhere else when the light stands somewhere else",
    ).toBeLessThan(floor * 0.7);
  }, 900_000);

  /**
   * ⚑ THE BEAT REACHES THE MARKS ONE AT A TIME — AND THE DETECTOR IS VALIDATED AGAINST A
   * KNOWN POSITIVE FOR UNISON BEFORE THE SUCCESSION IS BELIEVED (§V968).
   *
   * The owner asked for *"the brightness of SOME of the glow areas"*. Every audio lane this
   * file had was a GLOBAL multiplier: `veinEmission` lifted every conduit in the frame by the
   * same factor at the same instant, which is the picture inflating rather than anything
   * happening inside it. `flare` reaches the same marks through an R3 sequence over the
   * conduit lattice, reading the envelope twice — once as an amount and once as a POSITION —
   * so the release sweeps through the marks in an order independent of how bright each one
   * already is.
   *
   * The instrument is the SET of pixels a lane brightens, not how much it brightens them. A
   * unison lane brightens the SAME pixels at every value and only changes by how much; a
   * succession lane brightens a DIFFERENT SUBSET at every value. So:
   *
   *   - the KNOWN POSITIVE: the old mechanism, `veinEmission` at two levels. Its two
   *     brightened sets must overlap almost completely. If they do not, the instrument cannot
   *     tell unison from succession and its verdict on `flare` means nothing.
   *   - the CLAIM: `flare` at two levels, whose sets must overlap far less.
   */
  it("the flare fires marks in succession, and the same instrument reads the old lane as unison", async () => {
    const still = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
    };
    const at = async (key: string, value: number): Promise<Frame> =>
      shoot(40, (graph) => {
        still(graph);
        param(graph, "shape", key, value);
      });

    /* Which pixels a lane LIFTS, against its own off state. */
    const lifted = (base: Frame, arm: Frame): Set<number> => {
      const set = new Set<number>();
      for (let pixel = 0; pixel < base.w * base.h; pixel += 1) {
        if (luma(arm, pixel) - luma(base, pixel) > 2) set.add(pixel);
      }
      return set;
    };
    const overlap = (a: Set<number>, b: Set<number>): number => {
      if (a.size === 0 || b.size === 0) return 0;
      let both = 0;
      for (const pixel of a) if (b.has(pixel)) both += 1;
      return both / Math.min(a.size, b.size);
    };

    /* THE KNOWN POSITIVE FOR UNISON: the global vein gain, which is what the kick used to
       drive. Its shipped static is 6.25. */
    const veinOff = await at("veinEmission", 6.25);
    const veinLow = lifted(veinOff, await at("veinEmission", 8));
    const veinHigh = lifted(veinOff, await at("veinEmission", 11));
    expect(veinLow.size, "the known positive must actually lift pixels").toBeGreaterThan(200);
    const unison = overlap(veinLow, veinHigh);
    expect(
      unison,
      "VALIDATION: a global gain must lift the SAME pixels at both levels, or this instrument cannot read succession",
    ).toBeGreaterThan(0.85);

    /* AND THE CLAIM. Same instrument, same frame, same everything but the lane. */
    const flareOff = await at("flare", 0);
    const flareEarly = lifted(flareOff, await at("flare", 0.85));
    const flareLate = lifted(flareOff, await at("flare", 0.45));
    expect(flareEarly.size, "the flare must actually lift pixels").toBeGreaterThan(200);
    const succession = overlap(flareEarly, flareLate);
    expect(
      succession,
      "two points of the sweep must light a DIFFERENT subset of the marks — unison is the defect",
    ).toBeLessThan(unison * 0.8);
  }, 900_000);

  /**
   * THE CAMERA CARRIES THE ANGLES, AND IT IS THE ONLY THING THAT MOVES THE VIEW.
   *
   * ⚑ THIS CLAIM USED TO BE TITLED "the object carries the angles", AND THE THING IT MEASURES
   * NEVER CHANGED — only the name did. `posePeriod`, `pushPeriod` and `aimPeriod` drive a
   * rigid rotation and a uniform scale applied to the eye AND the ray direction together,
   * which is a camera move; calling it an object pose was a description no render could
   * contradict. The owner settled it from the other end (*"we really need to do this with
   * the camera instead"*), and T1318b made the code say what it always did.
   *
   * So this claim is the pair. The camera is frozen in BOTH arms and every other clock is
   * stopped in both; the only difference is whether the pose clocks are allowed to run. The
   * frames must differ when they do and be one picture when they do not — which is what says
   * the angles come from the object and not from anything else that happens to be moving.
   */
  it("the camera rig moves the view with the orbit parked — and is the only thing that does", async () => {
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

    /* AND THE CLAIM: the camera travelled and approached with the object standing still. */
    expect(
      meanPixelDelta(poseA, poseB),
      "the camera rig must move the view on its own",
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
  /**
   * ⚑ THE SPECKLE IS GEOMETRIC, AND THIS CLAIM EXISTS BECAUSE THREE PASSES OF MATERIAL WORK
   * WENT LOOKING FOR IT IN THE SHADING (T1322b).
   *
   * The owner has called this piece *"speckled with noisy stuff… a freckly noisy mess"* and
   * it survived two passes that treated it as a mark problem — under-widened pods (T1318b),
   * then hue-rotated veins (§V988) — because the instrument everyone used was A COUNT OF
   * MAGENTA MARKS, and that count is a BRIGHTNESS THRESHOLD wearing a count's clothes: it
   * reads ZERO with the camera at orbitRadius 34 (§V981's cliff), it fell 75 % when `polish`
   * was cut while the visible speckle did not change at all, and IT CANNOT SEE A WHITE SPECK
   * BY CONSTRUCTION.
   *
   * ⚑ THE INSTRUMENT HERE IS SCALE-FREE AND COLOUR-BLIND ON PURPOSE: a speck is a lit pixel
   * standing more than twice its OWN 3x3 MEDIAN. Nothing about it depends on an absolute
   * brightness or on how many pixels the object covers, which is the whole of what was wrong
   * with the count.
   *
   * ⚑ AND THE CLAIM IS THE ISOLATION, NOT THE VALUE. Measured, every shading term is a no-op
   * against a 0.000 A/A floor — `specular` 0, `polish` 0, pods cut, veins cut, `shellGlow` 0,
   * `haze` 0, `fresnelGain` 0 all land within 0.12 points of the shipped 0.90 — while the
   * march's own `stepScale` moves it by a third. So what is asserted is that THE MARCH OWNS
   * THE SPECKLE AND THE SHADING DOES NOT, which is the sentence two passes of work needed.
   */
  it("the speckle belongs to the MARCH, not to any shading term", async () => {
    const parked = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
    };
    /* A lit pixel more than twice the median of its own eight neighbours. */
    const speckRate = (frame: Frame): number => {
      let hot = 0;
      let lit = 0;
      const around: number[] = [];
      for (let y = 1; y < frame.h - 1; y += 1) {
        for (let x = 1; x < frame.w - 1; x += 1) {
          const pixel = y * frame.w + x;
          const here = luma(frame, pixel);
          if (here < 12) continue;
          lit += 1;
          around.length = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx === 0 && dy === 0) continue;
              around.push(luma(frame, pixel + dy * frame.w + dx));
            }
          }
          around.sort((a, b) => a - b);
          const median = ((around[3] ?? 0) + (around[4] ?? 0)) / 2;
          if ((here - median) / Math.max(median, 4) > 1) hot += 1;
        }
      }
      return hot / Math.max(lit, 1);
    };

    const shipped = await shoot(20, parked);
    /* THE CONTROL FIRST, and it is the one that makes the rest mean anything: the same
       render again must give the same number, because these renders are deterministic. */
    const control = await shoot(20, parked);
    const base = speckRate(shipped);
    expect(speckRate(control) - base, "the A/A floor on this statistic must be zero").toBeCloseTo(0, 10);

    /* AND THE ISOLATION. Cutting the brightest emission in the frame — the pods, which carry
       a gain of 22 and the sixth-power falloff that is the highest-frequency signal the
       shader computes — must NOT take the speckle with it. If it does, the speckle is a mark
       problem after all and this whole diagnosis is wrong. */
    const noPods = await shoot(20, (graph) => {
      parked(graph);
      param(graph, "shape", "nodeGlow", 0);
      param(graph, "shape", "nodeSpill", 0);
    });
    expect(
      speckRate(noPods),
      "cutting the pods must leave most of the speckle standing — it is not a mark problem",
    ).toBeGreaterThan(base * 0.6);

    /* AND THE POSITIVE, AND IT CHANGED HANDS (T1324b). It used to be `stepScale`: stepping
       MORE of the estimate overshoots thin features at grazing angles, which is a land-or-miss
       per pixel, and at the old density it read cleanly (0.5 -> 0.42 -> 0.32 gives
       1.024 -> 0.873 -> 0.767 per cent of lit pixels).
       ⚑ AT THE OPEN DENSITY THIS PASS SHIPS, IT IS NO LONGER A LEVER AT ALL, AND THE ARM WENT
       THE WRONG WAY: `stepScale` 0.78 measured 0.0105 against a shipped 0.0133 — a LOOSER
       march speckling LESS — and swept at the new density it is flat and non-monotone
       (1.035 / 0.957 / 0.984 / 1.018 across 0.50 / 0.42 / 0.36 / 0.30). A more open body is
       more thin structure seen edge-on per pixel, and the step size stops being what decides
       whether a ray finds it.
       ⚑ SO THE CLAIM KEEPS ITS MEANING AND CHANGES ITS INSTRUMENT: the OTHER march term still
       owns it, and far more strongly. `detail` scales the termination threshold against the
       pixel's own footprint, so a smaller value resolves structure the pixel cannot carry —
       which is the mechanism this claim is about, stated directly. A knob that no longer moves
       the number is not a weak positive control, it is the wrong one (§V981). */
    const finerMarch = await shoot(20, (graph) => {
      parked(graph);
      param(graph, "shape", "detail", 1);
    });
    expect(
      speckRate(finerMarch),
      "a march resolving finer than the pixel must speckle MORE — the march is what owns this",
    ).toBeGreaterThan(base * 1.2);
  }, 600_000);

  /**
   * ⚑ THE GAPS BETWEEN THE NODULES OPEN AND CLOSE, AND THE OWNER ASKED FOR IT THREE TIMES
   * BEFORE IT EXISTED (T1322b): *"stuff actually moving away from stuff… opening and closing
   * distances between nodules"*.
   *
   * ⚑ THE CLAIM HAS TO SEPARATE THIS LANE FROM THE ONE IT WOULD BE EASY TO CONFUSE IT WITH.
   * T1318b answered the same request by shortening `voidPeriod`, and that clock moves
   * `minRadius`, which HOLLOWS OUT the shells rather than moving structures apart. So both
   * arms below freeze every other clock and every other travel: what is left moving is the
   * spacing alone, and cutting its travel must collapse the difference to the floor.
   */
  it("the spacing lane moves the gaps, and cutting it stops them", async () => {
    const still = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
    };
    /* `freezeClocks` stops and zeroes everything; this arm hands the spacing lane alone back
       its shipped period and travel, so nothing else in the frame can account for a change. */
    const breathing = (graph: GraphDocument): void => {
      still(graph);
      const shipped = e70().document.graph.nodes["shape"]!.parameters as Record<string, unknown>;
      param(graph, "shape", "spacingPeriod", shipped["spacingPeriod"]);
      param(graph, "shape", "spacingTravel", shipped["spacingTravel"]);
    };

    /* ⚑ THE QUARTER LAPS, NOT THE HALF — AND GETTING THAT WRONG IS HOW THIS CLAIM FIRST READ
       AS A LANE THAT DID NOTHING. The travel is a SINE, so half a period apart is 0 and 0:
       the two sampled frames were both at the lane's neutral value and the arm measured 0.36
       against its own control. A quarter lap either side of the peak is where the extremes
       are. The general shape is §V968's — the instrument was pointed at the two moments the
       term is guaranteed to be absent, and it reported that the term was absent. */
    const [openA, openB] = await shootSeries([26, 77], 1, breathing);
    const [stillA, stillB] = await shootSeries([26, 77], 1, still);
    if (openA === undefined || openB === undefined || stillA === undefined || stillB === undefined) {
      throw new Error("fewer than two frames captured");
    }

    /* THE CONTROL FIRST: with the lane cut, these two times are one picture. */
    const floor = meanPixelDelta(stillA, stillB);
    expect(floor, "with the spacing lane cut these must be the same frame").toBeLessThan(0.5);

    /* AND THE CLAIM: the gaps moved, and they moved GEOMETRY rather than brightness — so the
       count of pixels that changed from lit to unlit (or back) is what is asserted, not a
       mean. A gain would move every lit pixel a little and cross no boundaries. */
    expect(
      meanPixelDelta(openA, openB),
      "the spacing lane must move the picture on its own",
    ).toBeGreaterThan(Math.max(floor, 0.05) * 10);

    /* AND WHAT IT MOVED IS GEOMETRY RATHER THAN BRIGHTNESS. A gain moves every lit pixel a
       little and crosses no boundary; gaps opening take pixels from lit to unlit and back.
       ⚑ AGAINST ITS OWN CONTROL, not against a fitted constant — the frozen arm gives the
       crossing rate two frames of THE SAME OBJECT produce, which is the only honest floor
       for this statistic. */
    const crossings = (a: Frame, b: Frame): number => {
      let crossed = 0;
      for (let pixel = 0; pixel < a.w * a.h; pixel += 1) {
        if (luma(a, pixel) > 12 !== luma(b, pixel) > 12) crossed += 1;
      }
      return crossed / (a.w * a.h);
    };
    const stillCrossings = crossings(stillA, stillB);
    expect(
      crossings(openA, openB),
      "and it must move the SILHOUETTE — gaps opening is geometry, not a gain",
    ).toBeGreaterThan(Math.max(stillCrossings, 0.0002) * 8);
  }, 600_000);

  /**
   * ⚑⚑ THE PODS ARE NOT DICED BY THE CONDUIT LATTICE, AND THAT IS THE OWNER'S CHECKERBOARD
   * (T1324b). *"Still some SQUARE PATTERNS OR ALMOST CHECKERBOARD IN THE MAGENTA LIGHTS."*
   *
   * The cause was a granularity mismatch, not a colour or a hash: a pod is 2 * nodeRadius =
   * 1.24 units across and it was gated, and flared, on `floor(p * veinRate)` — cells 1/3.1 =
   * 0.32 units across. A membership test on cells four times smaller than the object it gates
   * does not gate the object, it MULTIPLIES it by an axis-aligned piecewise constant that
   * steps 0.06 -> 1 across planes crossing its own face.
   *
   * ⚑ THE GUARD IS AGAINST THE CAUSE, NOT THE OBSERVABLE: `veinRate` is the conduit lattice's
   * own knob, so if the pods ever read that lattice again, moving it will move them. And the
   * arm that keeps the guard honest is the legitimate case it could swallow — the VEINS must
   * still respond to `veinRate`, or this would pass just as well with the whole lattice
   * deleted.
   */
  it("the conduit lattice moves the veins and does not touch the pods", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const still = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
      freezeClocks(graph);
    };
    /* Each arm isolates ONE population so neither statistic can be moved by the other. */
    const podsOnly = (graph: GraphDocument): void => {
      still(graph);
      for (const off of ["veinEmission", "veinSpill", "shellGlow"]) param(graph, "shape", off, 0);
    };
    const veinsOnly = (graph: GraphDocument): void => {
      still(graph);
      for (const off of ["nodeGlow", "nodeSpill"]) param(graph, "shape", off, 0);
    };
    const coarser = (inner: Mutate): Mutate => (graph) => {
      inner(graph);
      param(graph, "shape", "veinRate", 0.4);
    };

    const podBase = await shoot(20, podsOnly);
    const podControl = await shoot(20, podsOnly);
    const podCoarse = await shoot(20, coarser(podsOnly));
    const veinBase = await shoot(20, veinsOnly);
    const veinCoarse = await shoot(20, coarser(veinsOnly));

    /* THE A/A FLOOR FIRST — these renders are deterministic, so it is exactly zero, and every
       number below is quoted against it (§V984). */
    const floor = meanPixelDelta(podBase, podControl);
    expect(floor, "the A/A floor on this statistic must be zero").toBeLessThan(0.001);

    /* THE LEGITIMATE CASE THE GUARD COULD SWALLOW: the lattice still owns the veins. Measured
       at 0.094 mean absolute luma against the 0.000 floor — a small number because the veins
       are thin and this arm has the pods switched off, which is the point. */
    const veinMoved = meanPixelDelta(veinBase, veinCoarse);
    expect(
      veinMoved,
      "the conduit lattice must still decide where the veins are — otherwise this guard is vacuous",
    ).toBeGreaterThan(0.05);

    /* AND THE CLAIM: the pods do not read it. Not "less", NOTHING — the pod's gate is taken
       on `trace.nodeCell` now, which no value of `veinRate` can reach. Stated as a ratio to
       the vein arm as well as against the floor, so the two halves cannot both drift. */
    const podMoved = meanPixelDelta(podBase, podCoarse);
    expect(
      podMoved,
      "the pods must not read the conduit lattice — that lattice is what diced them into cubes",
    ).toBeLessThan(Math.max(floor, 0.001));
    expect(
      veinMoved,
      "and the separation must be total rather than merely favourable",
    ).toBeGreaterThan(Math.max(podMoved, 0.0005) * 50);
  }, 600_000);

  /**
   * ⚑⚑ AND THE OWNER'S ACTUAL OBSERVABLE, WITH THE ONLY CONTROL THAT MAKES IT MEAN ANYTHING
   * (T1324b). *"Square patterns or almost checkerboard in the magenta lights."*
   *
   * The claim above guards the CAUSE. This one holds the number, because the number is quoted
   * in the shipped page and nothing else in this file could fail if it drifted.
   *
   * ⚑ THE STATISTIC IS INTERIOR STEP DENSITY: of the pixels strictly inside the pod mask, the
   * share whose luma changes by more than 12/255 across ONE pixel. A shading ramp does not do
   * that; a piecewise-constant lattice does it along every cell plane. It is validated inside
   * the test on a smoothly shaded synthetic disc (0.00 %) and on the same disc multiplied by
   * an axis-aligned piecewise constant (18.67 %) — §V968, because a step detector that fires
   * on nothing would make this claim pass forever.
   *
   * ⚑⚑ AND THE CONTROL IS THE STONE, READ THROUGH THE SAME MASK WITH THE SAME THRESHOLD —
   * WHICH IS WHAT TURNS A NUMBER INTO A CLAIM. A pod is a glow painted on a fractal surface
   * whose own relief steps everywhere, so there is a FLOOR under this statistic that has
   * nothing to do with the defect, and an absolute threshold would have been a number somebody
   * liked. Swept at t = 0 / 5 / 20 / 40 / 60 s:
   *
   *     pods, shipped   27.0  31.4  34.1  33.5  28.0     ratio to the stone 0.76 .. 1.02
   *     the same stone  35.4  36.0  33.4  34.4  32.5
   *     pods, DEFECT    48.3  49.3  49.6  51.1  50.1     ratio to the stone 1.43 .. 1.58
   *
   * ⚠ RED-VERIFIED ON THE DEFECT'S OWN SIGNATURE (§V974): the bottom row is the shipped shader
   * with the conduit gate put back, re-rendered at the same five moments. The defect is not
   * "a bit rougher" — it is HALF AGAIN ROUGHER THAN THE SURFACE ITSELF, at every moment, and
   * the fixed build never exceeds the surface by more than 2 %.
   *
   * ⚑ SO THE CLAIM IS A RATIO AND NOT A NUMBER, and the ceiling sits at 1.05: above the
   * shipped worst case (1.02) and far below the defect's best (1.43). An absolute threshold
   * would have been measuring the fractal, which moves under its own clocks.
   *
   * ⚠ AND ONE HYPOTHESIS DIED HERE. The pod was diagnosed as "a sphere seen through the box
   * fold, whose pre-image has FLAT FACES". It does not: `clamp(p,-L,L)*2 - p` is a REFLECTION
   * per component, an isometry, so the pre-image of a ball is a union of reflected BALLS. A
   * boundary-orientation detector (validated: synthetic disc 59.1 %, synthetic square 99.4 %)
   * puts the pod outline at 60.0 % shipped and 65.1 % with the defect restored — both at the
   * disc end, neither near the square. The pods were never boxes in OUTLINE; the "square
   * patterns" were interior steps, which is what this measures.
   */
  it("the pods are smoother inside than the stone they are painted on", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);

    /* Of the pixels strictly inside `mask`, the share sitting on a one-pixel luma step. */
    const stepShare = (value: Float32Array, mask: Uint8Array, w: number, h: number): { inside: number; share: number } => {
      let inside = 0;
      let steps = 0;
      for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
          const i = y * w + x;
          if (mask[i] !== 1 || mask[i - 1] !== 1 || mask[i + 1] !== 1 || mask[i - w] !== 1 || mask[i + w] !== 1) continue;
          inside += 1;
          const gx = Math.abs((value[i + 1] ?? 0) - (value[i - 1] ?? 0)) / 2;
          const gy = Math.abs((value[i + w] ?? 0) - (value[i - w] ?? 0)) / 2;
          if (Math.max(gx, gy) > 12) steps += 1;
        }
      }
      return { inside, share: steps / Math.max(inside, 1) };
    };

    /* §V968 — the detector against two cases whose answers are known before it is run. */
    const shadedDisc = (diced: boolean): { value: Float32Array; mask: Uint8Array; side: number } => {
      const side = 256;
      const value = new Float32Array(side * side);
      const mask = new Uint8Array(side * side);
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          const r = Math.hypot(x - 128, y - 128);
          if (r >= 90) continue;
          mask[y * side + x] = 1;
          const ramp = 200 * (1 - (r / 90) ** 2);
          const cell = Math.floor(x / 18) + Math.floor(y / 18);
          value[y * side + x] = diced && cell % 2 !== 0 ? ramp * 0.06 : ramp;
        }
      }
      return { value, mask, side };
    };
    const smooth = shadedDisc(false);
    const diced = shadedDisc(true);
    expect(
      stepShare(smooth.value, smooth.mask, smooth.side, smooth.side).share,
      "a smooth shading ramp must read no interior steps",
    ).toBeLessThan(0.005);
    expect(
      stepShare(diced.value, diced.mask, diced.side, diced.side).share,
      "and the detector must FIRE on the defect, synthesised — otherwise its zeros mean nothing",
    ).toBeGreaterThan(0.1);

    const still = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
    };
    /* The pods are isolated by DIFFERENCE rather than by colour: the same frame with the pod
       terms at zero is the stone underneath, so `on - off` is exactly the pod's contribution
       and `off` is exactly the surface it is painted on. Nothing here has to guess a hue. */
    const podsOnly = (graph: GraphDocument): void => {
      still(graph);
      for (const off of ["veinEmission", "veinSpill", "shellGlow"]) param(graph, "shape", off, 0);
    };
    const noPods = (graph: GraphDocument): void => {
      podsOnly(graph);
      for (const off of ["nodeGlow", "nodeSpill"]) param(graph, "shape", off, 0);
    };

    const withPods = await shootSeries([0, 20, 60], 1, podsOnly);
    const without = await shootSeries([0, 20, 60], 1, noPods);

    for (const [index, on] of withPods.entries()) {
      const off = without[index];
      if (off === undefined) throw new Error("missing stone arm");
      const count = on.w * on.h;
      const mask = new Uint8Array(count);
      const glow = new Float32Array(count);
      const stone = new Float32Array(count);
      let lit = 0;
      for (let pixel = 0; pixel < count; pixel += 1) {
        const delta = luma(on, pixel) - luma(off, pixel);
        glow[pixel] = delta;
        stone[pixel] = luma(off, pixel);
        if (delta > 24) { mask[pixel] = 1; lit += 1; }
      }
      /* Without this the claim is satisfied by a frame with no pods in it at all (§V997: an
         absence is satisfied by any other presence, including an empty one). */
      expect(lit, "there must BE pods to measure — measured 3.7k to 12k px").toBeGreaterThan(1500);

      const pod = stepShare(glow, mask, on.w, on.h);
      const surface = stepShare(stone, mask, on.w, on.h);
      expect(pod.inside, "and enough of them to have an interior").toBeGreaterThan(1000);
      expect(
        pod.share / surface.share,
        "the pod glow must be no rougher inside than the stone it sits on — with the conduit gate restored it reads HALF AGAIN rougher",
      ).toBeLessThan(1.05);
    }
  }, 600_000);

  /**
   * ⚑⚑ NEGATIVE SPACE, COUNTED (T1324b). The owner: *"LESS IS MORE sometimes. I think we still
   * need to EMBRACE NEGATIVE SPACE a little bit better."*
   *
   * That reads as taste and it is a connectivity property: a piece with negative space has
   * ENCLOSED BACKGROUND REGIONS inside its own outline; a solid knobbly mass does not. So the
   * statistic is holes — background components not reachable from the frame edge — and the
   * claim is about the FORM, which is why it is asserted against the spacing lane rather than
   * against a number somebody liked.
   *
   * ⚑ THE COUNTER IS VALIDATED AGAINST A KNOWN POSITIVE BEFORE IT IS BELIEVED (§V968), inside
   * the test, on a synthetic disc with a known number of holes punched in it. A hole counter
   * that returns zero on everything would make this claim pass forever in the failing
   * direction if it were only ever asserted downwards.
   *
   * ⚠ AND IT IS ASSERTED AGAINST SHRINKING THE OBJECT, which is the way this ask gets
   * satisfied dishonestly: a smaller body is an emptier FRAME, not negative space. Coverage is
   * checked to have stayed in the band the piece has always occupied.
   */
  it("the body has holes in it, and they come from the form rather than from shrinking", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);

    /* Enclosed background inside the silhouette. Background is flood-filled from the frame
       edge; anything unlit and unreached is a hole. */
    const holesOf = (frame: Frame, threshold: number): { holes: number; share: number; coverage: number } => {
      const { w, h } = frame;
      const lit = new Uint8Array(w * h);
      let area = 0;
      for (let pixel = 0; pixel < w * h; pixel += 1) {
        if (luma(frame, pixel) > threshold) { lit[pixel] = 1; area += 1; }
      }
      const outside = new Uint8Array(w * h);
      const stack: number[] = [];
      const push = (pixel: number): void => {
        if (lit[pixel] === 1 || outside[pixel] === 1) return;
        outside[pixel] = 1; stack.push(pixel);
      };
      for (let x = 0; x < w; x += 1) { push(x); push((h - 1) * w + x); }
      for (let y = 0; y < h; y += 1) { push(y * w); push(y * w + w - 1); }
      while (stack.length > 0) {
        const pixel = stack.pop() ?? 0;
        const x = pixel % w;
        const y = (pixel - x) / w;
        if (x > 0) push(pixel - 1);
        if (x < w - 1) push(pixel + 1);
        if (y > 0) push(pixel - w);
        if (y < h - 1) push(pixel + w);
      }
      const seen = new Uint8Array(w * h);
      let holes = 0;
      let holeArea = 0;
      for (let start = 0; start < w * h; start += 1) {
        if (lit[start] === 1 || outside[start] === 1 || seen[start] === 1) continue;
        let size = 0;
        seen[start] = 1; stack.push(start);
        while (stack.length > 0) {
          const pixel = stack.pop() ?? 0;
          size += 1;
          const x = pixel % w;
          const y = (pixel - x) / w;
          for (const next of [x > 0 ? pixel - 1 : -1, x < w - 1 ? pixel + 1 : -1, y > 0 ? pixel - w : -1, y < h - 1 ? pixel + w : -1]) {
            if (next < 0 || lit[next] === 1 || outside[next] === 1 || seen[next] === 1) continue;
            seen[next] = 1; stack.push(next);
          }
        }
        if (size >= 24) { holes += 1; holeArea += size; }
      }
      return { holes, share: holeArea / Math.max(area + holeArea, 1), coverage: area / (w * h) };
    };

    /* §V968 — the counter against a case whose answer is known before it is run. */
    const punched = (count: number): Frame => {
      const side = 300;
      const d = new Uint8ClampedArray(side * side * 4);
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          let on = Math.hypot(x - 150, y - 150) < 110;
          for (let k = 0; k < count; k += 1) {
            const angle = (k / Math.max(count, 1)) * Math.PI * 2;
            if (Math.hypot(x - (150 + 60 * Math.cos(angle)), y - (150 + 60 * Math.sin(angle))) < 15) on = false;
          }
          const pixel = (y * side + x) * 4;
          const value = on ? 200 : 0;
          d[pixel] = value; d[pixel + 1] = value; d[pixel + 2] = value; d[pixel + 3] = 255;
        }
      }
      return { w: side, h: side, d };
    };
    for (const known of [0, 1, 4]) {
      expect(holesOf(punched(known), 6).holes, `the counter must find ${known} punched holes`).toBe(known);
    }

    const still = (graph: GraphDocument): void => {
      freezeCamera(graph);
      cutEveryDrive(graph);
    };
    const solid = (graph: GraphDocument): void => {
      still(graph);
      /* The spacing lane at the value it shipped before this pass: the operator is the same,
         parked below the threshold where it opens anything. */
      param(graph, "shape", "fixedRadius", 1);
      param(graph, "shape", "spacingOpen", 0.11);
    };

    /* TWO MOMENTS, AT 1 fps, AND BOTH OF THOSE ARE FINDINGS RATHER THAN CONVENIENCE.
       ⚑ ONE MOMENT IS NOT ENOUGH, AND THE RED-VERIFY IS WHAT SHOWED IT: with `fixedRadius`
       parked back at 1 the old body reads 12 holes at t = 20 s and ZERO at t = 40 s. A claim
       that samples 20 s alone would have had to assert "more than 8 holes" to pass, and the
       body this row exists to replace CLEARS THAT BAR at that instant. The defect is a body
       that is solid AT SOME MOMENTS, so the claim has to look at more than one.
       ⚑ AND 1 fps IS THE SAME PICTURE, CHECKED RATHER THAN ASSUMED: every clock reads
       `absTime = frameIndex / fps` and every drive is cut here, so frame 20 at 1 fps and frame
       1200 at 60 fps are the same absTime. Measured BIT-IDENTICAL (mean absolute channel delta
       0.000000 on both moments, and the hole statistics agree to every digit). It costs 41
       renders instead of 2 402. */
    const openFrames = await shootSeries([20, 40], 1, still);
    const closedFrames = await shootSeries([20, 40], 1, solid);
    const openStats = openFrames.map((frame) => holesOf(frame, 6));
    const closedStats = closedFrames.map((frame) => holesOf(frame, 6));

    for (const [index, stats] of openStats.entries()) {
      const parked = closedStats[index];
      if (parked === undefined) throw new Error("missing parked arm");

      /* THE CLAIM, AND IT IS PUT ON THE *AREA* RATHER THAN THE COUNT — because the count is
         what the red-verify slipped through. Measured: shipped 13.61 % / 8.13 % of the body's
         own interior at 20 s / 40 s, against 1.45 % / 0.00 % for the body this replaces. */
      expect(
        stats.share,
        "the shipped body must have real enclosed negative space in it, at every moment",
      ).toBeGreaterThan(0.04);
      expect(
        stats.holes,
        "and that space must be MANY separate gaps rather than one big bite out of it",
      ).toBeGreaterThan(8);

      /* AND THE SPACING OPERATOR IS WHAT BUYS IT. */
      expect(
        stats.share,
        "parked low, the same body is nearly solid — the operator is what holes it",
      ).toBeGreaterThan(Math.max(parked.share, 0.002) * 4);

      /* ⚠ AND NOT BY SHRINKING, WHICH IS THE DISHONEST WAY TO SATISFY THIS ASK: a smaller body
         is an emptier FRAME, not negative space. T1316b measured this piece between 16.7 % and
         39.1 % of the frame.
         ⚑ THE ROUTE WAS TRIED, AND IT DOES NOT EVEN WORK: pulling the camera back on the OLD
         body (`orbitRadius` 26, then 34) reads 2 holes / 1.11 % / 8.2 % coverage and then
         0 holes / 0.00 % / 0.0 % — shrinking LOSES holes, because the gaps stop resolving
         before the silhouette does. The guard is kept anyway; it is cheap, and it is the
         assertion that makes the number above mean what it says. */
      expect(stats.coverage, "the holes must not be bought by shrinking the object").toBeGreaterThan(0.12);
    }
  }, 600_000);

  /**
   * ⚑⚑ THE PALETTE EVOLVES, AND NOTHING EVOLVES *RELATIVE TO* ANYTHING (T1324b). The owner:
   * *"the lights color should probably evolve over time and maybe also slightly change in
   * shade with beat or something."*
   *
   * That ask is in direct tension with §V996, which this file earned the hard way: an
   * UNBOUNDED hue rotation walked the veins into the key light's blue at t = 20 s and
   * cancelled the two-temperature design the piece is built on. The resolution is to rotate
   * the palette as a RIGID BODY — `rotateHue` is a rotation about the grey diagonal, so one
   * turn applied to every colour is an isometry of the wheel and every pairwise arc is
   * preserved exactly. §V996's defect is PER-ELEMENT drift; common-mode drift has none.
   *
   * ⚠ AND §V995 IS WHY THAT PARAGRAPH IS NOT THE TEST. The isometry is exact in the ALGEBRA
   * and the rendered hue of an element is not its tint: it is the tint through a base colour,
   * an exposure, a tone map and a saturation grade, none of which commute with a rotation. So
   * the arcs are read off RENDERED PIXELS, at the palette's two extremes as well as at its
   * two zero crossings, and the parked palette is carried as a control in the same run.
   *
   * ⚑⚑ AND THE FIRST INSTRUMENT FOR THIS WAS WRONG IN THE WAY §V994 NAMES — IT REPORTED THE
   * TURN CLOSING THE TIGHTEST PAIR FROM 0.041 TO 0.023, WHICH WOULD HAVE CONDEMNED THE
   * FEATURE. It isolated an element by rendering the frame with only that element's gains
   * left on, and *"the frame with only the veins on"* IS NOT *"the veins"*: the sky, the
   * environment rim and the stone are still in it, they do not travel with the palette, and
   * on the dim arms they outvoted the thing being measured (vein chroma read 0.036 against
   * 0.153 once isolated properly). The honest isolation is a DIFFERENCE — the same frame with
   * the element's own gains at zero, subtracted — which is the element's contribution and
   * nothing else.
   *
   * ⚠ RED-VERIFIED ON §V996's OWN DEFECT (§V974), and it took two goes to fail for the RIGHT
   * reason. Restoring `hueArc` to 0.5 — the unbounded per-element rotation this file shipped
   * before T1322b — first made the claim red on "the veins arm must actually light something",
   * which is a failure a dim frame would also produce. With a hue-neutral inclusion test and
   * an emptiness floor that is a floor rather than a tolerance, the same arm now fails where
   * it should: *"pods and veins must not arrive at the same colour at 49 s"*, 0.0535 against
   * the 0.06 bound.
   */
  it("the palette travels as a whole, and no colour travels relative to another", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);

    /* Chroma-weighted mean hue, in TURNS, of what `on` has and `off` does not. */
    const hueOfDiff = (on: Frame, off: Frame): { hue: number; px: number } => {
      let x = 0;
      let y = 0;
      let px = 0;
      for (let pixel = 0; pixel < on.w * on.h; pixel += 1) {
        const r = ((on.d[pixel * 4] ?? 0) - (off.d[pixel * 4] ?? 0)) / 255;
        const g = ((on.d[pixel * 4 + 1] ?? 0) - (off.d[pixel * 4 + 1] ?? 0)) / 255;
        const b = ((on.d[pixel * 4 + 2] ?? 0) - (off.d[pixel * 4 + 2] ?? 0)) / 255;
        if (r < 0 || g < 0 || b < 0) continue;
        const max = Math.max(r, g, b);
        /* ⚑ THE INCLUSION TEST IS THE BRIGHTEST CHANNEL, NOT THE LUMA, AND THAT IS §V974
           RATHER THAN pedantry: luma weights green 0.72 against blue 0.07, so a HUE ROTATION
           changes how many pixels clear a luma threshold. Red-verified with `hueArc` at 0.5 —
           the defect §V996 was filed for — this claim went red on "the veins arm must light
           something" (162 px against a 400 floor) instead of on the arc it exists to defend:
           a failure for the WEAK reason, which cannot tell the defect from a dim frame. The
           brightest channel is hue-neutral by construction. */
        if (max < 0.03) continue;
        px += 1;
        const chroma = max - Math.min(r, g, b);
        if (chroma < 0.02) continue;
        let sixth: number;
        if (max === r) sixth = ((g - b) / chroma + 6) % 6;
        else if (max === g) sixth = (b - r) / chroma + 2;
        else sixth = (r - g) / chroma + 4;
        const angle = (sixth / 6) * Math.PI * 2;
        x += Math.cos(angle) * chroma;
        y += Math.sin(angle) * chroma;
      }
      return { hue: (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1, px };
    };
    /* Shortest way round the wheel, in turns: 0 = the same colour, 0.5 = opposite. */
    const arc = (a: number, b: number): number => {
      const delta = Math.abs(a - b) % 1;
      return Math.min(delta, 1 - delta);
    };

    /* `paletteTurn` is 197 s and the swing is a sine, so these four are the palette PARKED,
       at its positive extreme, parked again, and at its negative extreme. A grid that only
       sampled zero crossings would be a control arm pretending to be a claim. */
    const TIMES = [0, 49, 98, 147] as const;
    const ELEMENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["pods", ["nodeGlow", "nodeSpill"]],
      ["veins", ["veinEmission", "veinSpill"]],
      ["key", ["keyIntensity"]],
    ];

    const readHues = async (parked: boolean): Promise<Record<string, number[]>> => {
      const base = (graph: GraphDocument): void => {
        freezeCamera(graph);
        cutEveryDrive(graph);
        if (parked) param(graph, "shape", "paletteTurn", 1.0e9);
      };
      const on = await shootSeries([...TIMES], 1, base);
      const hues: Record<string, number[]> = {};
      for (const [name, gains] of ELEMENTS) {
        const off = await shootSeries([...TIMES], 1, (graph) => {
          base(graph);
          for (const gain of gains) param(graph, "shape", gain, 0);
        });
        hues[name] = on.map((frame, index) => {
          const other = off[index];
          if (other === undefined) throw new Error("missing isolation arm");
          const read = hueOfDiff(frame, other);
          /* §V997 — an empty difference has a hue too, and it means nothing. */
          /* ⚠ AND THE FLOOR IS LOW ON PURPOSE. The veins are filaments and this arm has every
             drive cut, so their own contribution is the smallest population in the frame
             (1355 px shipped, 377 under the `hueArc` defect arm) — a floor set near the
             shipped number would turn every hue move into a failure of this guard instead of
             a failure of the claim. It is here to catch an EMPTY difference (§V997), nothing
             more. */
          expect(read.px, `the ${name} arm must actually light something`).toBeGreaterThan(120);
          return read.hue;
        });
      }
      return hues;
    };

    const turning = await readHues(false);
    const parked = await readHues(true);

    /* THE POSITIVE FIRST: the palette MOVES. Without this everything below is satisfied by
       `paletteArc` 0 — a colour that never travels never collides. At the swing's extreme
       every element has moved, measured pods 0.214, veins 0.145, key 0.123 of a turn. */
    for (const [name] of ELEMENTS) {
      const moved = arc(turning[name]?.[1] ?? 0, parked[name]?.[1] ?? 0);
      expect(moved, `the palette must actually carry ${name} somewhere`).toBeGreaterThan(0.06);
    }

    /* ⚑⚑ AND THE CLAIM, AND IT IS NOT THE ONE THE ALGEBRA PREDICTS — §V995, MEASURED RATHER
       THAN DERIVED. A rigid rotation preserves every arc EXACTLY in tint space, and the
       rendered hues do not: the three elements' own travel under the same turn reads 0.214 /
       0.145 / 0.123, because a bright clipping source and a diffuse lit stone put the same
       rotation through different parts of the tone map. So the pairwise arcs DO move, by up
       to 0.092 of a turn, and the tightest pair in the piece (veins against key) closes from
       0.126 parked to 0.103 turning — an eighteen per cent squeeze, not the zero the isometry
       argument claims.
       ⚑ WHAT THE BOUND ACTUALLY BUYS IS THEREFORE THE THING §V996 IS ABOUT: no pair can be
       WALKED INTO another. Each arc keeps at least four fifths of itself (worst measured
       ratio 0.82) and no arc anywhere over the lap comes near zero (worst 0.103). Both halves
       are asserted, because "the arcs are preserved" is the sentence that would have shipped
       on the strength of the derivation alone. */
    for (let i = 0; i < ELEMENTS.length; i += 1) {
      for (let j = i + 1; j < ELEMENTS.length; j += 1) {
        const a = ELEMENTS[i]?.[0] ?? "";
        const b = ELEMENTS[j]?.[0] ?? "";
        for (let k = 0; k < TIMES.length; k += 1) {
          const moving = arc(turning[a]?.[k] ?? 0, turning[b]?.[k] ?? 0);
          const still = arc(parked[a]?.[k] ?? 0, parked[b]?.[k] ?? 0);
          expect(
            moving,
            `the turn must not spend ${a} against ${b}'s separation — it may carry them, not close them`,
          ).toBeGreaterThan(still * 0.6);
          /* §V996's own assertion, and the bound is set by the TIGHTEST pair rather than by
             the pair anybody was worried about: veins against key, which reads 0.103. */
          expect(
            moving,
            `${a} and ${b} must not arrive at the same colour at ${TIMES[k]} s`,
          ).toBeGreaterThan(0.06);
        }
      }
    }

    /* ⚑ AND THE ONE PER-ELEMENT MOVE IN THE FILE, WHICH IS THE ONE §V996 ACTUALLY GOVERNS:
       the beat's shade nudge on the pods. It must be REAL and it must be SMALL, and both
       halves are asserted because either one alone is satisfied by a value of zero at one end
       and by a disaster at the other. Measured at the palette's extreme: pod hue 0.0639 with
       the lane deleted, 0.0712 at its driven rest, 0.0864 at the peak of a kick — a travel of
       0.0156 of a turn, and the pod/key arc WIDENS across it (0.3655 to 0.3881) rather than
       closing, because the pods and the key sit a third of the wheel apart. ⚑ AND THE PODS
       ARE NOT IN THE TIGHTEST PAIR AT ALL — that is veins against key, which this lane cannot
       reach — so the one per-element move in the file is nowhere near the one gap §V996 has
       to protect. */
    const beat = async (flare: number | undefined): Promise<number> => {
      const base = (graph: GraphDocument): void => {
        freezeCamera(graph);
        cutEveryDrive(graph);
        if (flare !== undefined) param(graph, "shape", "flare", flare);
      };
      const [on] = await shootSeries([49], 1, base);
      const [off] = await shootSeries([49], 1, (graph) => {
        base(graph);
        for (const gain of ["nodeGlow", "nodeSpill"]) param(graph, "shape", gain, 0);
      });
      if (on === undefined || off === undefined) throw new Error("no beat frame");
      return hueOfDiff(on, off).hue;
    };
    const silent = await beat(0);
    const peak = await beat(1);
    expect(
      arc(silent, peak),
      "a transient must MOVE the pod's shade — the owner asked for it and a zero here is the lane missing",
    ).toBeGreaterThan(0.004);
    expect(
      arc(silent, peak),
      "and it must stay a NUDGE — this is the only per-element hue move in the file, so §V996 governs it",
    ).toBeLessThan(0.04);
  }, 600_000);
});
