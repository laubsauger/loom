import { describe, expect, it } from "vitest";

import { SILENCE } from "../../domain/audio/feature-track.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import type { AudioFeatures, FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "./audio.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T414: Audio In — sound as channels, and the determinism seam that makes an
 * audio-reactive project renderable.
 *
 * The node is a pure projection of `FrameInputs.audio`; these tests are therefore the
 * REPLAY claim itself: feed the same feature track twice, get the same numbers twice,
 * by construction (§V45, §V329). No analyser, no browser, no wall clock anywhere.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const frame = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

/** Every field of the v2 record (T1227), each a different non-zero number (§V461): a dropped or crossed field cannot pass. */
const FEATURES: AudioFeatures = {
  level: 0.5,
  low: 0.9,
  lowMid: 0.4,
  highMid: 0.2,
  high: 0.05,
  onset: 0.75,
  onsetCount: 1,
  onsetMax: 0.8,
  kick: 0.31,
  kickCount: 2,
  snare: 0.22,
  snareCount: 3,
  hat: 0.13,
  hatCount: 4,
  centroid: 0.37,
  bpm: 124,
  bpmConfidence: 0.6,
  beatPhase: 0.45,
  beat: 17,
  beatCount: 5,
};

function audioGraph(extra: GraphDocument["nodes"] = {}, edges: GraphDocument["edges"] = {}): GraphDocument {
  return {
    revision: 1,
    nodes: {
      sound: {
        id: "sound",
        type: "audioIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        label: "audio1",
      },
      ...extra,
    },
    edges,
    groups: {},
  } as never;
}

describe("audioIn (T414)", () => {
  it("projects the frame's features as channels, verbatim", () => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(audioGraph(), frame(0), { audio: FEATURES });
    expect(result.byName.get("audio1")).toEqual(FEATURES);
  });

  it("is SILENT — all zeros, not absent — when the session has no audio (§V329)", () => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(audioGraph(), frame(0));
    // Zeros, so every downstream stage keeps evaluating deterministically; a missing
    // bag would make `driven` parameters dangle instead.
    expect(result.byName.get("audio1")).toEqual(SILENCE);
  });

  it("REPLAY: the same feature track produces the same numbers — determinism by construction (§V45)", () => {
    const track: ReadonlyArray<AudioFeatures> = [
      FEATURES,
      { ...FEATURES, low: 0.1, onset: 0 },
      { ...FEATURES, level: 0.9, high: 0.6 },
    ];
    // A lagged channel makes this a real claim: valueLag is STATEFUL, so identical
    // outputs require identical inputs at every step, not just the last one.
    const graph = audioGraph(
      {
        smooth: {
          id: "smooth",
          type: "valueLag",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { lag: 0.2 },
          label: "smooth1",
        },
      } as never,
      {
        e1: { id: "e1", source: { nodeId: "sound", portId: "out" }, target: { nodeId: "smooth", portId: "in" } },
      } as never,
    );
    const run = (): Array<number | undefined> => {
      const session = createValueGraphSession(registry);
      const out: Array<number | undefined> = [];
      track.forEach((features, index) => {
        const result = session.evaluate(graph, frame(index), { audio: features });
        out.push(result.byName.get("smooth1")?.["low"]);
      });
      return out;
    };
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // And the lag really lagged: the smoothed value sits between the raw endpoints.
    expect(first[1]).toBeGreaterThan(0.1);
    expect(first[1]).toBeLessThan(0.9);
  });

  it("drives a parameter through the existing driven machinery — no new binding kind", () => {
    // The resolver answers `audio1:low` exactly the way it answers `lfo1:value` —
    // V143's model verbatim, which is the whole point of publishing features as
    // channels rather than inventing an audio binding.
    const session = createValueGraphSession(registry);
    const result = session.evaluate(audioGraph(), frame(0), { audio: FEATURES });
    expect(result.resolver("audio1:low", { frame: frame(0) } as never)).toBe(0.9);
    expect(result.resolver("audio1:onset", { frame: frame(0) } as never)).toBe(0.75);
  });

  it("says what onset IS in the one place users read, names the drums as heuristics, and never claims 'bar'", () => {
    for (const type of ["audioIn", "audioFileIn"] as const) {
      const definition = registry.get(type);
      expect(definition?.description).toContain("onset");
      expect(definition?.description).toContain("not a beat detector");
      // T1227: the detectors are named for what they are FOR and described as what they ARE.
      expect(definition?.description).toContain("kick / snare / hat");
      expect(definition?.description?.toLowerCase()).toContain("heuristic");
      // The tempo fields are a claim the live doors do not make, and the description says which field says so.
      expect(definition?.description).toContain("bpmConfidence");
      expect(definition?.description).toContain("NO bar channels");
      const channels = definition?.valueEvaluate?.({
        inputs: {},
        values: {},
        frame: frame(0),
        audio: FEATURES,
        state: {},
      });
      expect(Object.keys(channels ?? {})).not.toContain("bar");
      expect(Object.keys(channels ?? {})).not.toContain("barPhase");
    }
  });

  it("T1227 — with no tempo claim, bpmConfidence is 0 and so is every other tempo channel", () => {
    // What a live door reads until T1228: the reducer writes NO_TEMPO_CLAIM. The node is a
    // projection, so this is pinned at the seam it crosses — a claim with confidence 0 and
    // a non-zero bpm would be the record contradicting itself.
    const session = createValueGraphSession(registry);
    const live = { ...FEATURES, bpm: 0, bpmConfidence: 0, beatPhase: 0, beat: 0, beatCount: 0 };
    const bag = session.evaluate(audioGraph(), frame(0), { audio: live }).byName.get("audio1") ?? {};
    expect([bag["bpm"], bag["bpmConfidence"], bag["beatPhase"], bag["beat"], bag["beatCount"]]).toEqual([0, 0, 0, 0, 0]);
    // While the detectors, which are measurements of the interval, still come through.
    expect(bag["kickCount"]).toBe(2);
    expect(bag["centroid"]).toBe(0.37);
  });
});

/**
 * T1228 — A DECLARED TEMPO on the two live doors: §T825's cheap half, and every claim here
 * is the one that separates DECLARED from ESTIMATED — timeline-anchored (§V436), so the
 * beat is a function of the frame and of nothing else. The numbers are exact by
 * construction (120 bpm is a beat every half second) and each is checked against a
 * neighbour that would differ if the arithmetic were off by a beat, a phase, or a clock.
 */
describe("declared tempo on audioIn / audioFileIn (T1228)", () => {
  const evaluate = (
    type: "audioIn" | "audioFileIn",
    timeSeconds: number,
    values: Record<string, number | string | boolean>,
    deltaSeconds = 1 / 60,
    audio: AudioFeatures = FEATURES,
  ): Record<string, number> =>
    registry.get(type)?.valueEvaluate?.({
      inputs: {},
      values,
      frame: { timeSeconds, deltaSeconds, frameIndex: Math.round(timeSeconds * 60), mode: "offline", randomSeed: 7 },
      audio,
      state: {},
    }) as Record<string, number>;

  it("on Auto passes the RECORD's claim through untouched — the estimator's field, not the node's", () => {
    // The fixture's claim is at confidence 0.6 with bpm 124; Auto is a projection and must
    // not overwrite it with either a declaration or a zero. (`tempoMode` absent is Auto: a
    // document that never touched the group reads as it did before T1228.)
    for (const values of [{}, { tempoMode: "auto", bpm: 128 }]) {
      const bag = evaluate("audioIn", 1.5, values);
      expect([bag["bpm"], bag["bpmConfidence"], bag["beat"], bag["beatPhase"], bag["beatCount"]]).toEqual([124, 0.6, 17, 0.45, 5]);
      expect(Object.keys(bag)).not.toContain("bar");
    }
  });

  it("audioIn Declared counts beats from Beat Offset along the TIMELINE, at confidence 1, and the bar is then a fact", () => {
    // 120 bpm, beat one at 0.25 s: t = 1.5 s is 1.25 s in, 2.5 beats — beat 2, half way,
    // 0.625 of a four-beat bar. §V461: none of these is 0 or a default.
    const bag = evaluate("audioIn", 1.5, { tempoMode: "declared", bpm: 120, beatOffset: 0.25, beatsPerBar: 4 });
    expect(bag["bpm"]).toBe(120);
    expect(bag["bpmConfidence"]).toBe(1);
    expect(bag["beat"]).toBe(2);
    expect(bag["beatPhase"]).toBeCloseTo(0.5, 12);
    expect(bag["bar"]).toBe(0);
    expect(bag["barPhase"]).toBeCloseTo(0.625, 12);
    // The record's own claim (124 at 0.6) is overridden, and only the tempo fields are:
    // the analysis channels are still the record's.
    expect(bag["kickCount"]).toBe(2);
    expect(bag["centroid"]).toBe(0.37);
    // A different signature regroups the same beats: 3/4 puts beat 2.5 in bar 0 at 5/6.
    const waltz = evaluate("audioIn", 1.5, { tempoMode: "declared", bpm: 120, beatOffset: 0.25, beatsPerBar: 3 });
    expect(waltz["beat"]).toBe(2);
    expect(waltz["barPhase"]).toBeCloseTo(2.5 / 3, 12);
    // And the offset is where beat one FALLS, not a delay on the phase: a quarter second
    // later than the offset is exactly half a beat in, whatever the offset was.
    const shifted = evaluate("audioIn", 1.75, { tempoMode: "declared", bpm: 120, beatOffset: 0.5 });
    expect(shifted["beat"]).toBe(2);
    expect(shifted["beatPhase"]).toBeCloseTo(0.5, 12);
  });

  it("beatCount is the beats that fell in the frame INTERVAL — a pulse, T437-shaped", () => {
    // t = 1.75 s at 120 bpm from 0.25 s is exactly beat 3; the frame before it was not.
    const onBeat = evaluate("audioIn", 1.75, { tempoMode: "declared", bpm: 120, beatOffset: 0.25 });
    expect(onBeat["beat"]).toBe(3);
    expect(onBeat["beatCount"]).toBe(1);
    // A sixtieth later the beat has passed: same beat, no pulse.
    const after = evaluate("audioIn", 1.75 + 1 / 60, { tempoMode: "declared", bpm: 120, beatOffset: 0.25 });
    expect(after["beat"]).toBe(3);
    expect(after["beatCount"]).toBe(0);
    // A slow frame under a fast tempo reports every beat it crossed, not the last one.
    const slow = evaluate("audioIn", 2.0, { tempoMode: "declared", bpm: 180, beatOffset: 0 }, 1.0);
    expect(slow["beatCount"]).toBe(3);
  });

  it("before Beat Offset nothing has happened: the claim stands, the count has not begun", () => {
    const early = evaluate("audioIn", 0.1, { tempoMode: "declared", bpm: 120, beatOffset: 0.25 });
    expect(early["bpm"]).toBe(120);
    expect(early["bpmConfidence"]).toBe(1);
    expect([early["beat"], early["beatPhase"], early["beatCount"], early["bar"], early["barPhase"]]).toEqual([0, 0, 0, 0, 0]);
  });

  it("is TIMELINE-ANCHORED (§V436): the same frame gives the same beat whatever was evaluated before it", () => {
    // A scrub is an out-of-order sequence of frames. The claim is that order cannot matter,
    // which an accumulator anywhere in the path would break.
    const values = { tempoMode: "declared", bpm: 113, beatOffset: 0.37, beatsPerBar: 5 };
    const straight = [2.0, 7.5, 3.25].map((t) => evaluate("audioIn", t, values));
    const scrubbed = [7.5, 3.25, 2.0].map((t) => evaluate("audioIn", t, values));
    expect(scrubbed[2]).toEqual(straight[0]);
    expect(scrubbed[0]).toEqual(straight[1]);
    expect(scrubbed[1]).toEqual(straight[2]);
    // And it is the timeline, not the record: with the record silent the beat is unchanged.
    expect(evaluate("audioIn", 7.5, values, 1 / 60, SILENCE)["beat"]).toBe(straight[1]?.["beat"]);
  });

  it("audioFileIn Declared counts along the FILE: Beat Offset is a second into the file, and trim, speed and cue move the beats with the sound", () => {
    // In point 10 s, beat one at 10.5 s in the file, 120 bpm. One timeline second in at
    // speed 1 the playhead is at 11.0 s: exactly beat 1, which the interval also crosses.
    const base = { tempoMode: "declared", bpm: 120, beatOffset: 10.5, beatsPerBar: 4, playMode: "timeline", trimStart: 10 };
    const unity = evaluate("audioFileIn", 1.0, { ...base, speed: 1 });
    expect(unity["beat"]).toBe(1);
    expect(unity["beatPhase"]).toBeCloseTo(0, 12);
    expect(unity["beatCount"]).toBe(1);
    // Double speed: the same timeline second is 12.0 s into the file — beat 3.
    const double = evaluate("audioFileIn", 1.0, { ...base, speed: 2 });
    expect(double["beat"]).toBe(3);
    expect(double["bpm"]).toBe(120);
    // Half speed: 10.5 s, beat one has just fallen.
    const half = evaluate("audioFileIn", 1.0, { ...base, speed: 0.5 });
    expect(half["beat"]).toBe(0);
    expect(half["beatPhase"]).toBeCloseTo(0, 12);
    // A held cue at 13.0 s is beat 5, and HELD: the interval crosses nothing.
    const cued = evaluate("audioFileIn", 1.0, { ...base, speed: 1, cue: true, cuePoint: 13.0 });
    expect(cued["beat"]).toBe(5);
    expect(cued["beatCount"]).toBe(0);
    // Without the in point the same timeline second is only 1.0 s into the file, before
    // beat one — which is what makes the offset a FILE second and not a timeline one.
    const untrimmed = evaluate("audioFileIn", 1.0, { ...base, speed: 1, trimStart: 0 });
    expect([untrimmed["beat"], untrimmed["beatPhase"]]).toEqual([0, 0]);
  });

  it("Declared adds EXACTLY the bar channels, so a declared source and Audio Pattern are the same channel set", () => {
    // The swap promise, with structure now included: nothing an Audio Pattern publishes is
    // missing from a declared live source, and nothing extra appears.
    const pattern = Object.keys(
      registry.get("audioPattern")?.valueEvaluate?.({ inputs: {}, values: { bpm: 120 }, frame: frame(0), state: {} }) ?? {},
    ).sort();
    for (const type of ["audioIn", "audioFileIn"] as const) {
      const declared = Object.keys(evaluate(type, 0, { tempoMode: "declared" })).sort();
      expect(declared).toEqual(pattern);
      const auto = Object.keys(evaluate(type, 0, {}));
      expect(pattern.filter((name) => !auto.includes(name))).toEqual(["bar", "barPhase"]);
    }
  });

  it("the Tempo controls say they are unread on Auto and name the mode that reads them (§V146)", () => {
    for (const type of ["audioIn", "audioFileIn"] as const) {
      const definition = registry.get(type);
      const parameters = definition?.parameters ?? {};
      expect(parameters["tempoMode"]?.type).toBe("enum");
      for (const key of ["bpm", "beatOffset", "beatsPerBar"]) {
        const reason = parameters[key]?.inactiveWhen?.({ tempoMode: "auto" });
        expect(reason, `${type}.${key}`).toContain("Declared");
        expect(parameters[key]?.inactiveWhen?.({ tempoMode: "declared" })).toBeNull();
      }
      // The description says what the confidence's THREE values mean, in the one place users read.
      expect(definition?.description).toContain("1 is a DECLARED tempo");
    }
  });
});

/**
 * T1230 — the detector knobs sit on BOTH doors, in the Analysis group, and their defaults
 * are the constants the capture hook falls back to — so a node that never stored them and
 * a node that stored the defaults build the same engine. What the knobs DO is pinned where
 * they are read (`use-audio-input.test.ts`); here only that the schema and the fallback
 * cannot drift apart, and that the one place users read names the group.
 */
describe("detector knobs on audioIn / audioFileIn (T1230)", () => {
  it("both doors carry Hit Threshold and Retrigger, in Analysis, at the shipped defaults", () => {
    for (const type of ["audioIn", "audioFileIn"] as const) {
      const schema = effectiveParameterSchema(registry.get(type), {});
      for (const key of ["threshold", "retrigger"] as const) {
        expect(schema[key]?.group, `${type}.${key}`).toBe("Analysis");
        expect(schema[key]?.type, `${type}.${key}`).toBe("number");
        expect((schema[key] as { default?: unknown }).default, `${type}.${key}`).toBe(AUDIO_DETECTOR_DEFAULTS[key]);
      }
      expect(registry.get(type)?.description).toContain("Hit Threshold and Retrigger");
    }
  });

  it("evaluation never reads them: the counts arrive already counted (§V352)", () => {
    const channels = registry.get("audioIn")?.valueEvaluate?.({
      inputs: {},
      values: { threshold: 0.3, retrigger: 0.2 },
      frame: frame(0),
      audio: FEATURES,
      state: {},
    });
    expect(channels).toEqual(FEATURES);
  });
});

describe("audioFileIn (T434)", () => {
  it("projects the same channel set as audioIn — one feature record, two doors", () => {
    const definition = registry.get("audioFileIn");
    const channels = definition?.valueEvaluate?.({
      inputs: {},
      values: {},
      frame: frame(0),
      audio: FEATURES,
      state: {},
    });
    expect(channels).toEqual(FEATURES);
    // The movieFileIn analogy is the CONTRACT: one asset parameter, kind "audio".
    const file = definition?.parameters["file"];
    expect(file?.type).toBe("asset");
    expect((file as { kind?: string }).kind).toBe("audio");
  });
});

describe("audioPattern (T442)", () => {
  const channelsAt = (timeSeconds: number, deltaSeconds = 1 / 60, parameters: Record<string, number> = {}) =>
    registry.get("audioPattern")?.valueEvaluate?.({
      inputs: {},
      values: { bpm: 120, amount: 1, ...parameters },
      frame: { timeSeconds, deltaSeconds, frameIndex: Math.round(timeSeconds * 60), mode: "offline", randomSeed: 7 },
      state: {},
    }) as Record<string, number>;

  /**
   * T701 moved these two values, and the move is the point rather than a re-baseline.
   *
   * The kick envelope is unchanged — it is still `0.12 + 0.88 * exp(-phase * 7)` — but
   * it is an AMPLITUDE, and the channel this node publishes is what an `AnalyserNode`
   * would report for that amplitude: `(dB + 100) / 70`, because `getByteFrequencyData`
   * maps [-100, -30] dB onto 0..255. Pinning the linear envelope by exact value here
   * was what let §V647 stand for as long as it did: the gate agreed with the node and
   * neither of them agreed with a real track.
   */
  const analyserDomain = (amplitude: number, referenceDb: number) => (20 * Math.log10(amplitude) + referenceDb) / 70;
  const LOW_REFERENCE_DB = 68.25;

  it("strikes the kick EXACTLY on the beat, in the ANALYSER'S dB domain (T701)", () => {
    // 120 bpm: a beat every 0.5s. On the boundary the kick envelope is exp(0) = 1, and a
    // full-scale strike sits where real music's low band peaks — 68.25/70 = 0.975.
    const onBeat = channelsAt(1.0);
    expect(onBeat.low).toBeCloseTo(0.975, 10);
    expect(onBeat.onsetCount).toBe(1);
    // T707: onset is an envelope in the ANALYSER'S calibration — a full strike lands on
    // real music's measured max (0.28), not at 1.0, which was ~3.5× any real track.
    expect(onBeat.onset).toBeCloseTo(0.28, 10);
    expect(onBeat.onsetMax).toBeCloseTo(0.28, 10);
    // Just before the next beat the amplitude has decayed to 0.12 + 0.88*exp(-phase*7),
    // which is 18.35 dB down from the strike and therefore 18.35/70 down the channel.
    const late = channelsAt(1.49);
    const phase = (1.49 * 2) % 1;
    expect(late.low).toBeCloseTo(analyserDomain(0.12 + 0.88 * Math.exp(-phase * 7), LOW_REFERENCE_DB), 10);
    expect(late.onsetCount).toBe(0);
  });

  /**
   * The property the domain fix EXISTS for, and the one a revert to linear cannot fake:
   * `amount` is a master GAIN, so halving it is -6.0206 dB and must cost every band the
   * same 6.0206/70 = 0.086 of channel — never a halving of the channel value. That is
   * what makes this node substitutable for a live source rather than merely
   * same-shaped: turning a real track down 6 dB moves its analyser bands by exactly
   * this much (measured live in `src/tests/e2e/audio-analyser-domain.spec.ts`, where a
   * real Chromium AnalyserNode moves 0.142-0.144 per 10 dB against 20/70 = 0.1429).
   */
  it("answers a gain change the way a real analyser does — a FIXED offset per dB (T701, T702)", () => {
    const full = channelsAt(1.17);
    const halved = channelsAt(1.17, 1 / 60, { amount: 0.5 });
    const costOfSixDb = (20 * Math.log10(2)) / 70;
    for (const band of ["low", "lowMid", "highMid", "high"] as const) {
      expect((full[band] ?? 0) - (halved[band] ?? 0)).toBeCloseTo(costOfSixDb, 10);
      // And emphatically NOT the linear answer, which would halve the channel.
      expect(halved[band] ?? 0).toBeGreaterThan(0.75 * (full[band] ?? 0));
    }
    // `level` is the amplitude-domain control (§V648) and DOES halve — it is an RMS on
    // both paths, and leaving it linear is what made T700's diagnosis a measurement.
    expect(halved["level"] ?? 0).toBeCloseTo((full["level"] ?? 0) / 2, 10);
  });

  /**
   * The calibration claim itself, stated as a range check rather than trusted: the four
   * bands must rest and peak inside the envelope three recorded tracks actually measure
   * (§V647's table). Before T701 `low` rested at 0.12 and peaked at 1.0 against music's
   * p01 0.69-0.83 — the rest state was above music's ceiling nowhere and below its floor
   * everywhere, which is why every gain+bias pair fitted here pinned under a real track.
   */
  it("rests and peaks where real music does, band by band (T701, §V647)", () => {
    const musicEnvelope = {
      low: { restAtLeast: 0.65, peakAtMost: 0.99 },
      lowMid: { restAtLeast: 0.38, peakAtMost: 0.79 },
      highMid: { restAtLeast: 0.34, peakAtMost: 0.74 },
      high: { restAtLeast: 0.24, peakAtMost: 0.62 },
    } as const;
    // A whole bar at 120bpm, sampled per frame: the rest is the minimum, the strike the max.
    const frames = Array.from({ length: 120 }, (_, index) => channelsAt(4 + index / 60));
    for (const band of ["low", "lowMid", "highMid", "high"] as const) {
      const values = frames.map((channels) => channels[band] as number);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(musicEnvelope[band].restAtLeast);
      expect(Math.max(...values)).toBeLessThanOrEqual(musicEnvelope[band].peakAtMost);
    }
  });

  it("reports MULTI-EVENT frames honestly — T437's interval semantics beyond 0|1", () => {
    // A whole second at 120 bpm inside one delta: two beats crossed, count says 2.
    const slow = channelsAt(2.0, 1.0);
    expect(slow.onsetCount).toBe(2);
    // T707: the interval peak wears the envelope's calibration — a full strike's 0.28.
    expect(slow.onsetMax).toBeCloseTo(0.28, 10);
  });

  it("is pure: the same clock gives the same channels — replayable by construction", () => {
    expect(channelsAt(3.21)).toEqual(channelsAt(3.21));
  });

  /**
   * T548 changed this from an equality to a SUPERSET, and the change is the design.
   *
   * The swap promise — replace this node with a live source and every wire survives — is
   * about the channels a live source CAN publish, and it still holds exactly: every
   * audioIn channel is here, under the same name. What is extra is the musical structure,
   * and it is extra because only a node that knows its own tempo can publish it honestly.
   * An `audioIn` cannot; §V403 says so out loud in its description rather than shipping a
   * guessed bar count that would be confidently wrong.
   *
   * So the assertion is two-sided and neither side is slack: the shared set is EQUAL to
   * audioIn's, and the extra set is EXACTLY the bar channels. A channel added to either
   * node lands in one of those two lists and has to be argued for. T1227 moved `beat`
   * and `beatPhase` from the extra list into the shared one: the record now carries a
   * tempo claim with its confidence, so a live source publishes them too (at 0, honestly).
   */
  it("publishes every audioIn channel under the same name, so a live source still swaps in", () => {
    const pattern = Object.keys(channelsAt(0));
    const live = Object.keys(
      registry.get("audioIn")?.valueEvaluate?.({ inputs: {}, values: {}, frame: frame(0), state: {} }) ?? {},
    ).sort();
    expect(pattern.filter((name) => live.includes(name)).sort()).toEqual(live);
  });

  it("adds EXACTLY the bar channels a live source cannot know (T548, §V403, T1227)", () => {
    const pattern = Object.keys(channelsAt(0));
    const live = Object.keys(
      registry.get("audioIn")?.valueEvaluate?.({ inputs: {}, values: {}, frame: frame(0), state: {} }) ?? {},
    );
    expect(pattern.filter((name) => !live.includes(name)).sort()).toEqual(["bar", "barPhase"]);
  });

  /**
   * T1227 — the detectors and the tempo claim, by exact value. The pattern knows which
   * drum struck, so each detector is that drum's strike (at `onset`'s calibration: a
   * full strike is 0.28, the snare's 0.8 of it, the hat's 0.5) and each count is that
   * drum's events over the frame interval. At 120 bpm t = 1.5 s is beat 3: an ODD beat,
   * so kick AND snare strike, and a hat with them (eighths land on every beat).
   */
  it("strikes kick, snare and hat as their own detectors, and claims its tempo at confidence 1", () => {
    const onThree = channelsAt(1.5);
    expect(onThree.kick).toBeCloseTo(0.28, 12);
    expect(onThree.kickCount).toBe(1);
    expect(onThree.snare).toBeCloseTo(0.8 * 0.28, 12);
    expect(onThree.snareCount).toBe(1);
    expect(onThree.hat).toBeCloseTo(0.5 * 0.28, 12);
    expect(onThree.hatCount).toBe(1);
    expect(onThree.bpm).toBe(120);
    expect(onThree.bpmConfidence).toBe(1);
    expect(onThree.beat).toBe(3);
    expect(onThree.beatCount).toBe(1);

    // Beat 2 is EVEN: the kick and a hat strike, the snare does not — and its envelope is
    // 0 rather than a decaying tail from beat 1, because the snare only sounds on odd beats.
    const onTwo = channelsAt(1.0);
    expect(onTwo.kickCount).toBe(1);
    expect(onTwo.snareCount).toBe(0);
    expect(onTwo.snare).toBe(0);
    expect(onTwo.hatCount).toBe(1);

    // The off-beat eighth (beat 2.5): ONLY the hat strikes; the kick is decaying from beat 2.
    const offBeat = channelsAt(1.25);
    expect(offBeat.hatCount).toBe(1);
    expect(offBeat.hat).toBeCloseTo(0.5 * 0.28, 12);
    expect(offBeat.kickCount).toBe(0);
    expect(offBeat.kick).toBeCloseTo(Math.exp(-0.5 * 7) * 0.28, 12);
    expect(offBeat.beatCount).toBe(0);

    // Between events every envelope is its strike's decay, at the frame's phase.
    const between = channelsAt(1.6);
    expect(between.kick).toBeCloseTo(Math.exp(-0.2 * 7) * 0.28, 12);
    expect(between.snare).toBeCloseTo(Math.exp(-0.2 * 9) * 0.8 * 0.28, 12);
    expect(between.hat).toBeCloseTo(Math.exp(-0.4 * 14) * 0.5 * 0.28, 12);
    expect([between.kickCount, between.snareCount, between.hatCount, between.beatCount]).toEqual([0, 0, 0, 0]);
  });

  it("counts every drum's events over the INTERVAL, like onsetCount (T437, T1227)", () => {
    // One whole second at 120 bpm in a single frame, ending on beat 4: beats 3 and 4
    // crossed (two kicks, two beats), one of them odd (one snare), four eighths (four hats).
    const slow = channelsAt(2.0, 1.0);
    expect(slow.kickCount).toBe(2);
    expect(slow.snareCount).toBe(1);
    expect(slow.hatCount).toBe(4);
    expect(slow.beatCount).toBe(2);
    // And the interval's envelope is the full strike, not the last frame's decay.
    expect(slow.kick).toBeCloseTo(0.28, 12);
    expect(slow.hat).toBeCloseTo(0.5 * 0.28, 12);
  });

  /**
   * T1227 — the centroid, from the documented envelopes and the band centres. On the
   * off-beat eighth (t = 1.25 s, beat 2.5) the hat has just struck and the kick is half a
   * beat into its decay, so the amplitudes are known in closed form; the expected value is
   * derived from THOSE, not read back from the node.
   */
  it("publishes a centroid that brightens on a hat, darkens on a kick, and ignores gain", () => {
    const centre = { low: Math.sqrt(20 * 250), lowMid: Math.sqrt(250 * 2000), highMid: Math.sqrt(2000 * 6000), high: Math.sqrt(6000 * 16000) };
    const kickTail = Math.exp(-0.5 * 7);
    const amplitude = { low: 0.12 + 0.88 * kickTail, lowMid: 0.15 + 0.15 * kickTail, highMid: 0.1 + 0.5 * 0.5, high: 0.06 + 0.45 * 0.5 };
    const weight = amplitude.low + amplitude.lowMid + amplitude.highMid + amplitude.high;
    const hz =
      (amplitude.low * centre.low + amplitude.lowMid * centre.lowMid + amplitude.highMid * centre.highMid + amplitude.high * centre.high) /
      weight;
    const hatStrike = channelsAt(1.25);
    expect(hatStrike.centroid).toBeCloseTo((hz - 20) / (16000 - 20), 12);

    // The kick's strike adds weight at the bottom: darker than the rest just before it.
    const rest = channelsAt(1.45);
    const kickStrike = channelsAt(1.5);
    expect(hatStrike.centroid).toBeGreaterThan(rest.centroid as number);
    expect(kickStrike.centroid).toBeLessThan(rest.centroid as number);
    // Gain cancels out of a ratio, as it does on a live centroid.
    expect(channelsAt(1.25, 1 / 60, { amount: 0.5 }).centroid).toBeCloseTo(hatStrike.centroid as number, 12);
  });

  /**
   * The structure channels, by exact value, on a clock chosen so every one of them is
   * distinctive — §V461. At 120bpm a beat is half a second, so t = 5.25s is beat 10.5:
   * bar 2 (of four beats), half way through beat 10, and five-eighths through bar 2. Zero
   * appears nowhere, so a channel silently stuck at zero cannot pass this.
   */
  it("counts beats and bars from the in point, and ramps inside each (T548)", () => {
    // At 120bpm a beat is half a second, so t = 5.25s is beat 10.5: beat 10, half way
    // through it, bar 2 of four-beat bars, five-eighths through that bar. §V461 — zero
    // appears nowhere here, so a channel silently stuck at zero cannot pass.
    const bag = channelsAt(5.25, 1 / 60, { beatsPerBar: 4 });
    expect(bag.beat).toBe(10);
    expect(bag.beatPhase).toBeCloseTo(0.5, 12);
    expect(bag.bar).toBe(2);
    expect(bag.barPhase).toBeCloseTo(0.625, 12);

    // The time signature is honoured rather than assumed: the SAME instant in 3/4 is a
    // different bar, which is what makes `beatsPerBar` a real parameter and not decoration.
    const waltz = channelsAt(5.25, 1 / 60, { beatsPerBar: 3 });
    expect(waltz.bar).toBe(3);
    expect(waltz.barPhase).toBeCloseTo(0.5, 12);
    // And the BEAT is untouched by the signature — a bar is a grouping, not a re-clocking.
    expect(waltz.beat).toBe(10);
  });

  it("the bar count advances and never goes backwards as the piece runs", () => {
    // Monotone alone is satisfied by a constant, and a constant bar count is its own bug,
    // so the exact sequence is asserted rather than the ordering.
    const bars = [0, 2, 4, 6, 8, 10].map((seconds) => channelsAt(seconds, 1 / 60, { beatsPerBar: 4 }).bar);
    expect(bars).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

