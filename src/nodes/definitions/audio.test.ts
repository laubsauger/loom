import { describe, expect, it } from "vitest";

import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import type { AudioFeatures, FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
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

const FEATURES: AudioFeatures = {
  level: 0.5,
  low: 0.9,
  lowMid: 0.4,
  highMid: 0.2,
  high: 0.05,
  onset: 0.75,
  onsetCount: 1,
  onsetMax: 0.8,
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
    expect(result.byName.get("audio1")).toEqual({
      level: 0.5,
      low: 0.9,
      lowMid: 0.4,
      highMid: 0.2,
      high: 0.05,
      onset: 0.75,
      onsetCount: 1,
      onsetMax: 0.8,
    });
  });

  it("is SILENT — all zeros, not absent — when the session has no audio (§V329)", () => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(audioGraph(), frame(0));
    // Zeros, so every downstream stage keeps evaluating deterministically; a missing
    // bag would make `driven` parameters dangle instead.
    expect(result.byName.get("audio1")).toEqual({
      level: 0,
      low: 0,
      lowMid: 0,
      highMid: 0,
      high: 0,
      onset: 0,
      onsetCount: 0,
      onsetMax: 0,
    });
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

  it("says what onset IS in the one place users read — and never claims 'beat'", () => {
    const definition = registry.get("audioIn");
    expect(definition?.description).toContain("onset");
    expect(definition?.description).toContain("not a beat detector");
    const channels = definition?.valueEvaluate?.({
      inputs: {},
      values: {},
      frame: frame(0),
      audio: FEATURES,
      state: {},
    });
    expect(Object.keys(channels ?? {})).not.toContain("beat");
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
    expect(channels).toEqual({
      level: 0.5,
      low: 0.9,
      lowMid: 0.4,
      highMid: 0.2,
      high: 0.05,
      onset: 0.75,
      onsetCount: 1,
      onsetMax: 0.8,
    });
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
    expect(slow.onsetMax).toBe(1);
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
   * audioIn's, and the extra set is EXACTLY the four structure channels. A fifth channel
   * added to either node lands in one of those two lists and has to be argued for.
   */
  it("publishes every audioIn channel under the same name, so a live source still swaps in", () => {
    const pattern = Object.keys(channelsAt(0));
    const live = Object.keys(
      registry.get("audioIn")?.valueEvaluate?.({ inputs: {}, values: {}, frame: frame(0), state: {} }) ?? {},
    ).sort();
    expect(pattern.filter((name) => live.includes(name)).sort()).toEqual(live);
  });

  it("adds EXACTLY the structure channels a live source cannot know (T548, §V403)", () => {
    const pattern = Object.keys(channelsAt(0));
    const live = Object.keys(
      registry.get("audioIn")?.valueEvaluate?.({ inputs: {}, values: {}, frame: frame(0), state: {} }) ?? {},
    );
    expect(pattern.filter((name) => !live.includes(name)).sort()).toEqual(["bar", "barPhase", "beat", "beatPhase"]);
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

