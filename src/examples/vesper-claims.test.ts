import { describe, expect, it } from "vitest";

import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { mediaPlayhead, mediaTransportFrom } from "../domain/media/transport.ts";
import { createParameterReadOptions, resolveParameters } from "../domain/parameters/index.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * ⚑ E56 VESPER'S CLAIM: THE AUDIO MOVES THE PICTURE, AND THE PICTURE NEVER STOPS MOVING.
 *
 * ## Why the claim lands here and not on Dawn
 *
 * `cuePoint` is a TRANSPORT parameter. The compiler never reads it — `compileMedia` reads
 * zero parameters and declares one external texture — so nothing about which video frame is
 * showing exists anywhere in the render plan. The path that decides it is
 *
 *   value graph → `resolveParameters` → `mediaTransportFrom` → `mediaPlayhead` → `<video>`
 *
 * and every link but the last is pure, headless, and exercised below on THE SHIPPED BYTES.
 * A Dawn gate over this document renders `registerSyntheticMediaSources`' test card at
 * whatever the harness feels like, which would be green with the drive severed — the exact
 * §V918 shape, an instrument reporting from a path adjacent to the one under test.
 *
 * ## ⚑⚑ WHAT THIS FILE MEASURES CHANGED TWICE, AND THE SECOND TIME IS THE POINT
 *
 * Round one asserted DUTY — what fraction of the run is not pinned against a wall. Round
 * two replaced it with a HISTOGRAM of visited clip positions, because duty cannot see a
 * lane that covers its range unevenly.
 *
 * ⚠ BOTH WERE STILL THE WRONG INSTRUMENT, and the owner found out by using the file:
 * *"we're seeing the image freezing a lot."* A lane can be 100% interior AND evenly covered
 * AND still spend a quarter of its run on one video frame, because those metrics describe
 * WHERE the playhead goes and the complaint is about WHETHER IT MOVES. So the load-bearing
 * instrument here is now the LONGEST RUN OF FRAMES SHOWING THE SAME SOURCE FRAME — the
 * literal reading of "it freezes", and the one no amount of coverage implies.
 *
 * That is why claim 2 is paired with THE OWNER'S OWN SETTINGS as the failing arm (§V461):
 * `From Low 0.20, From High 0.99 → 0..16, Clamp` on this same chain, which pins for 20.3%
 * of the run with a longest still run of 109 frames. The instrument is shown able to see a
 * freeze, on the exact configuration that was reported, before its "no freeze" is believed.
 *
 * ## What each claim would catch
 *
 *   1. THE MECHANISM. `cue` on, or `cuePoint` is inert and everything below measures a
 *      free-running clock instead of a drive.
 *   2. ⚑ IT NEVER FREEZES, with the owner's settings as the arm that does.
 *   3. IT NEVER LEAVES THE LANE, and never touches the file's own ends — the bounce, not a
 *      clamp, and the difference is that a clamp would show up as claim 2 failing.
 *   4. ⚑ IT RUNS BACKWARDS about half the time. Reverse, on screen, from a strictly
 *      POSITIVE rate — which is the thing the owner asked for twice and could not find.
 *   5. THE LANE IS EVENLY COVERED, with an auto-calibrated linear arm as the failing pair.
 *   6. §V914 — the retained value is the driven mean and lies inside the drive's range.
 *   7. ⚑ THE LOAD-BEARING ONE, AND IT IS LAST (§V910): the SPEED follows the ENVELOPE, and
 *      cutting the drive stops the picture dead. Everything above is a statement about
 *      numbers this file computes; this is the one that says they came from the AUDIO.
 */

const registry = createNodeRegistry(allNodeDefinitions);
const view = registry.view();

/** The clip's real length: 496 frames at 24 fps. */
const SOURCE_FRAMES = 496;
const SOURCE_FPS = 24;
const DURATION = SOURCE_FRAMES / SOURCE_FPS;
/** The lane `travel1` bounces between — short of both ends of the file (T1190). */
const LANE_LOW = 0.4;
const LANE_HIGH = 14.6;
const HORIZON = 3600;
/** One `norm1` window (17 s) plus the follower's own settle. Before that, warm-up. */
const SETTLED = 1200;

function vesper(): GraphDocument {
  const file = listExamples().find((entry) => entry.fileName === "E56-Vesper.loom.json");
  if (file === undefined) throw new Error("E56-Vesper.loom.json is not in examples/");
  const { document } = requireExample(file);
  /* Read UNFLATTENED, and guarded rather than assumed: this file has no component
     instances, so flattening is a no-op — but a future edit that added one would make
     every label below resolve against the wrong graph, silently. */
  const component = Object.values(document.graph.nodes).find((entry) =>
    entry.type.startsWith("component:"),
  );
  if (component !== undefined) {
    throw new Error(`E56 gained a component instance (${component.type}) — flatten before reading labels`);
  }
  return structuredClone(document.graph) as GraphDocument;
}

function nodeNamed(graph: GraphDocument, label: string): GraphNode {
  const found = Object.values(graph.nodes).find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`no node labelled ${label}`);
  return found;
}

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 56,
});

/**
 * The playhead, frame by frame, through the app's own two functions.
 *
 * Deliberately NOT a re-implementation: `mediaTransportFrom` and `mediaPlayhead` are the
 * exact pair `use-media-sources` hands to `applyMediaPlayhead`, so a change to how a cue is
 * interpreted reddens this file rather than sliding past it.
 */
function playheads(graph: GraphDocument, frames = HORIZON): number[] {
  const clip = nodeNamed(graph, "clip1");
  const definition = view.get(clip.type);
  const session = createValueGraphSession(registry);
  const out: number[] = [];
  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frame = frameAt(frameIndex);
    const evaluated = session.evaluate(graph, frame, {});
    /* §V837's ONE factory. `op('travel1').chan.high` is read inside the NODE REFERENCE
       READER, not off `channels` — a resolve handed only `channels` answers every chan read
       with "no resolver", falls back to §V108's retained static, and reports a lane that
       never moves while the app animates (§B181). */
    const resolved = resolveParameters(clip, definition, createParameterReadOptions({
      graph,
      registry: view,
      frame,
      channels: evaluated.resolver,
    }));
    /* `.get(key)?.value`, exactly as `createMediaTransportRunner` reads it. */
    const read = (key: string): ParameterValue | undefined => resolved.get(key)?.value;
    out.push(mediaPlayhead(mediaTransportFrom(read), frameIndex / 60, DURATION).position);
  }
  return out;
}

/** One published channel over the same horizon. */
function channel(graph: GraphDocument, name: string): number[] {
  const session = createValueGraphSession(registry);
  const out: number[] = [];
  for (let frameIndex = 0; frameIndex < HORIZON; frameIndex += 1) {
    const value = session.evaluate(graph, frameAt(frameIndex), {}).resolver(name, undefined as never);
    out.push(typeof value === "number" ? value : Number.NaN);
  }
  return out;
}

/**
 * THE FAILING ARM (§V461): the same shipped document driven as a POSITION.
 *
 * `travel1` is cut out of the chain — `clip1.cuePoint` is re-pointed at `rate1`, which is
 * the node it integrates — and `rate1`'s output bounds are rewritten as CLIP POSITIONS
 * rather than rates. That is round two's mechanism exactly, and with the owner's own
 * calibration it is the configuration he reported freezing.
 */
function positionArm(fromLow: number, fromHigh: number, toLow: number, toHigh: number): GraphDocument {
  const graph = vesper();
  const rate = nodeNamed(graph, "rate1");
  for (const [key, value] of Object.entries({ fromLow, fromHigh, toLow, toHigh })) {
    (rate.parameters as Record<string, ParameterValue>)[key] = value;
  }
  const clip = nodeNamed(graph, "clip1");
  const slot = clip.parameters["cuePoint"] as {
    bindings: { expression: { kind: string; source: string }; static: { kind: string; value: number } };
  };
  slot.bindings.expression.source = "op('rate1').chan.high";
  return graph;
}

/**
 * THE OTHER FAILING ARM: `norm1` cut out, so `rate1` reads the RAW envelope.
 *
 * Under a rate drive the position histogram is no longer evidence for the normaliser — a
 * bounced integral of almost any positive rate covers its lane evenly, which is exactly
 * what the first version of this file measured and mistook for a result. What `norm1`
 * actually shapes now is HOW THE SPEED IS DISTRIBUTED, so that is what the pair below
 * compares, with the linear arm auto-calibrated to the envelope's own measured span.
 */
function rawEnvelopeArm(low: number, high: number): GraphDocument {
  const graph = vesper();
  const envId = nodeNamed(graph, "env1").id;
  const rateId = nodeNamed(graph, "rate1").id;
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (edge.target.nodeId === rateId) {
      (graph.edges as Record<string, typeof edge>)[edgeId] = {
        ...edge,
        source: { nodeId: envId, portId: "out" },
      };
    }
  }
  const rate = nodeNamed(graph, "rate1");
  (rate.parameters as Record<string, ParameterValue>)["fromLow"] = low;
  (rate.parameters as Record<string, ParameterValue>)["fromHigh"] = high;
  return graph;
}

/** Which of the clip's 496 stored frames a position lands on. */
const sourceFrameAt = (seconds: number): number =>
  Math.min(SOURCE_FRAMES - 1, Math.max(0, Math.floor((seconds / DURATION) * SOURCE_FRAMES)));

/** ⚑ The instrument: the longest run of frames showing the SAME source frame, and the share. */
function stillness(positions: readonly number[]): { readonly longest: number; readonly share: number } {
  let longest = 0;
  let run = 0;
  let same = 0;
  for (let index = 1; index < positions.length; index += 1) {
    if (sourceFrameAt(positions[index]!) === sourceFrameAt(positions[index - 1]!)) {
      same += 1;
      run += 1;
      if (run > longest) longest = run;
    } else run = 0;
  }
  return { longest, share: same / (positions.length - 1) };
}

/** Share of the run in each of 20 equal slices of `[low, high]`, as percentages. */
function rangeHistogram(values: readonly number[], low: number, high: number): number[] {
  const counts = new Array(20).fill(0) as number[];
  for (const value of values) {
    counts[Math.min(19, Math.max(0, Math.floor(((value - low) / (high - low)) * 20)))]! += 1;
  }
  return counts.map((count) => (count / values.length) * 100);
}

const laneHistogram = (positions: readonly number[]): number[] =>
  rangeHistogram(positions, LANE_LOW, LANE_HIGH);

/** Total-variation distance from a perfectly even lane, in percent. 0 = flat. */
const unevenness = (share: readonly number[]): number =>
  share.reduce((total, value) => total + Math.abs(value - 5), 0) / 2;

describe("E56 Vesper — the envelope drives the playhead", () => {
  it("holds the element at the cue point rather than playing it", () => {
    /* The mechanism in one assertion: without `cue`, `cuePoint` is inert and everything
       below would be measuring a free-running clock instead of the drive. */
    const clip = nodeNamed(vesper(), "clip1");
    expect(clip.parameters["cue"]).toBe(true);
    expect(clip.type).toBe("movieFileIn");
  });

  it("drives a RATE through an integrator, not a position — the shape, pinned", () => {
    /* The structural fact the rest of this file rests on. A future edit that re-pointed
       `cuePoint` at `rate1` would restore round two's freeze and pass nothing below, but it
       would pass more of them if this were not stated as its own claim. */
    const graph = vesper();
    const travel = nodeNamed(graph, "travel1");
    expect(travel.type).toBe("valueSpeed");
    expect(travel.parameters["limit"]).toBe("mirror");
    expect(travel.parameters["minimum"]).toBe(LANE_LOW);
    expect(travel.parameters["maximum"]).toBe(LANE_HIGH);
    const rate = nodeNamed(graph, "rate1");
    /* ⚑ THE FLOOR. `toLow` above zero is what makes "it never freezes" a property of the
       document rather than a hope about the signal. */
    expect(rate.parameters["toLow"]).toBeGreaterThan(0);
  });

  it("⚑ NEVER FREEZES — and the owner's own settings, on this chain, do (§V461)", () => {
    const shipped = stillness(playheads(vesper()).slice(SETTLED));
    /* Measured: 5 frames, 0.08 s. The ceiling is a quarter of a second, which is the point
       at which a moving picture reads as a still one. */
    expect(shipped.longest, "the longest run of one source frame").toBeLessThan(15);

    /* §V461, and it comes with a name on it: `From Low 0.20, From High 0.99 -> 0..16,
       Clamp` is what the owner set, and on a PERCENTILE input a clamped From Low of 0.20 is
       not a rare excursion — it is exactly 20% of the time, by construction. Measured: 109
       frames of one frame, 1.82 s. The instrument sees a freeze; the shipped drive has none
       to see. */
    const ownerPositions = playheads(positionArm(0.2, 0.99, 0, 16)).slice(SETTLED);
    const owner = stillness(ownerPositions);
    expect(owner.longest, "the reported configuration must actually freeze").toBeGreaterThan(60);
    /* And name the MECHANISM rather than only the symptom: it is the clamp, and on a
       percentile input a clamped `From Low` of 0.20 pins for very close to 20% of the run
       because 20% of the time is what "below the 20th percentile" MEANS. Measured 20.3%. */
    const pinned = ownerPositions.filter((value) => value <= 1e-9).length / ownerPositions.length;
    expect(pinned).toBeGreaterThan(0.15);
    expect(pinned).toBeLessThan(0.25);
  });

  it("stays inside the lane and never reaches either end of the FILE", () => {
    /* The bounce, and the owner's "range it so we don't hit the actual end of frame range".
       A clamp would satisfy the bounds too — which is why claim 2 above is what tells the
       two apart, and why this one is not asserted alone. */
    const positions = playheads(vesper());
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(LANE_LOW);
    expect(Math.max(...positions)).toBeLessThanOrEqual(LANE_HIGH);
    // And it uses the lane rather than sitting in the middle of it.
    expect(Math.min(...positions)).toBeLessThan(LANE_LOW + 0.5);
    expect(Math.max(...positions)).toBeGreaterThan(LANE_HIGH - 0.5);
    expect(LANE_HIGH).toBeLessThan(DURATION - 1);
  });

  it("⚑ RUNS BACKWARDS about half the time, from a strictly POSITIVE rate", () => {
    /* The owner asked for reverse twice and could not find it, because with `cue` on the
       transport's own `speed` is not read at all. Here the reverse is the BOUNCE: the rate
       never goes negative and the picture still plays backwards on every other leg. */
    const rate = channel(vesper(), "rate1:high").slice(SETTLED);
    expect(Math.min(...rate), "the rate is a speed, never a direction").toBeGreaterThan(0);

    const positions = playheads(vesper()).slice(SETTLED);
    let backwards = 0;
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index]! < positions[index - 1]!) backwards += 1;
    }
    const share = backwards / (positions.length - 1);
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.65);
  });

  it("⚑ `norm1` spreads the SPEED evenly — and the raw envelope, best-calibrated, does not", () => {
    /* ⚠ WHAT THIS MEASURES CHANGED WITH THE DRIVE, and the first version of this claim was
       wrong in a way worth recording: it measured the POSITION histogram, which under a
       bounced integral is even for almost any positive rate signal and therefore says
       nothing about the normaliser at all. Under a rate drive `norm1` shapes the SPEED, so
       the speed is what the pair below compares. */
    const shipped = rangeHistogram(channel(vesper(), "rate1:high").slice(SETTLED), 0.4, 5);
    expect(unevenness(shipped), `shipped: ${shipped.map((s) => s.toFixed(1)).join(" ")}`).toBeLessThan(15);
    expect(Math.max(...shipped)).toBeLessThan(9);

    /* §V461: the RAW envelope onto the same rate range, auto-calibrated to its own measured
       span over this exact run — a calibration no human could beat, because it is measured
       from the answer. It still crams most of the run into a few tenths of the range, which
       is the owner's "wasting most of the resolution on the first 20 decibels". */
    const envelope = channel(vesper(), "env1:high").slice(SETTLED);
    const raw = rangeHistogram(
      channel(rawEnvelopeArm(Math.min(...envelope), Math.max(...envelope)), "rate1:high").slice(SETTLED),
      0.4,
      5,
    );
    expect(unevenness(raw), `raw: ${raw.map((s) => s.toFixed(1)).join(" ")}`).toBeGreaterThan(20);

    /* And the picture still reaches essentially every frame the lane covers: 14.2 s of a
       24 fps clip is 341. */
    expect(new Set(playheads(vesper()).map(sourceFrameAt)).size).toBeGreaterThan(320);
    const lane = laneHistogram(playheads(vesper()).slice(SETTLED));
    expect(unevenness(lane), `lane: ${lane.map((s) => s.toFixed(1)).join(" ")}`).toBeLessThan(15);
  });

  it("§V914 — the retained cue point is the driven mean, and inside what the drive produces", () => {
    const positions = playheads(vesper());
    const retained = nodeNamed(vesper(), "clip1").parameters["cuePoint"] as {
      bindings?: { static?: { value?: number } };
    };
    const stood = retained.bindings?.static?.value;
    expect(typeof stood).toBe("number");

    /* Strictly inside, not merely within the parameter's declared range: a fallback at an
       end would open every no-audio host on a frame the music never chooses. */
    expect(stood!).toBeGreaterThan(Math.min(...positions));
    expect(stood!).toBeLessThan(Math.max(...positions));

    const mean = positions.reduce((total, value) => total + value, 0) / positions.length;
    expect(stood!).toBeCloseTo(mean, 1);
  });

  /**
   * ⚑ LAST, AND THE ONLY ONE THAT NAMES THE BEHAVIOUR (§V910).
   *
   * Everything above says the picture moves. This says it moves BECAUSE OF THE AUDIO, in
   * both directions at once:
   *
   *  - the SPEED of the playhead tracks the envelope. Under a rate drive that is the whole
   *    relationship, and a correlation is the only honest way to state it — "it moved" is
   *    true of a constant rate too;
   *  - and severing the drive at the cue point exactly as §V108 severs it leaves the
   *    playhead on ONE FRAME FOREVER. If a future edit made the motion come from the clock,
   *    or from a node's defaults, or from anything but the envelope, this reddens and
   *    nothing else here would.
   *
   * Nothing follows it.
   */
  it("THE SPEED IS THE MUSIC, AND CUTTING THE DRIVE STOPS THE PICTURE DEAD", () => {
    const graph = vesper();
    const positions = playheads(graph).slice(SETTLED);
    const envelope = channel(graph, "env1:high").slice(SETTLED);

    const speed: number[] = [];
    for (let index = 1; index < positions.length; index += 1) {
      speed.push(Math.abs(positions[index]! - positions[index - 1]!) * 60);
    }
    const level = envelope.slice(1);
    const meanLevel = level.reduce((t, v) => t + v, 0) / level.length;
    const meanSpeed = speed.reduce((t, v) => t + v, 0) / speed.length;
    let covariance = 0;
    let varianceLevel = 0;
    let varianceSpeed = 0;
    for (let index = 0; index < speed.length; index += 1) {
      const a = level[index]! - meanLevel;
      const b = speed[index]! - meanSpeed;
      covariance += a * b;
      varianceLevel += a * a;
      varianceSpeed += b * b;
    }
    const correlation = covariance / Math.sqrt(varianceLevel * varianceSpeed);
    /* Measured 0.837. A floor rather than the figure: the exact number moves with the
       follower's tuning, and what must not move is that the LOUDER it is, the FASTER the
       day turns. A severed or inverted drive lands near zero or negative. */
    expect(correlation, "louder must mean faster").toBeGreaterThan(0.6);
    /* And the speed really does vary — a constant rate would correlate with nothing but
       would also make the claim above meaningless if it slipped through. */
    expect(Math.max(...speed) / Math.min(...speed)).toBeGreaterThan(5);

    const cut = vesper();
    const clip = nodeNamed(cut, "clip1");
    const slot = clip.parameters["cuePoint"] as { bindings: { static: { value: number } } };
    /* §V108's own fallback path: drop the expression and the retained static stands. This
       is severance rather than deletion on purpose — a document with no `cuePoint` at all
       would fall to the SCHEMA default (0) and pass for the wrong reason. */
    (clip.parameters as Record<string, ParameterValue>)["cuePoint"] =
      slot.bindings.static.value as ParameterValue;

    const still = playheads(cut);
    expect(new Set(still).size).toBe(1);
    expect(still[0]).toBeCloseTo(slot.bindings.static.value, 6);
    /* Same document, same clock, same 3600 frames: 1 frame against more than 320. */
    expect(new Set(still.map(sourceFrameAt)).size).toBe(1);
  });
});
