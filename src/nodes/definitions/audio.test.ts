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

  it("strikes the kick EXACTLY on the beat: full low at phase zero, decayed just before", () => {
    // 120 bpm: a beat every 0.5s. On the boundary the kick envelope is exp(0) = 1.
    const onBeat = channelsAt(1.0);
    expect(onBeat.low).toBe(1);
    expect(onBeat.onsetCount).toBe(1);
    // Just before the next beat the envelope has decayed to exp(-phase*7).
    const late = channelsAt(1.49);
    const phase = (1.49 * 2) % 1;
    expect(late.low).toBeCloseTo(0.12 + 0.88 * Math.exp(-phase * 7), 10);
    expect(late.onsetCount).toBe(0);
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

  it("shares audioIn's channel NAMES exactly, so a live source swaps in as one node", () => {
    const pattern = Object.keys(channelsAt(0)).sort();
    const live = Object.keys(
      registry.get("audioIn")?.valueEvaluate?.({ inputs: {}, values: {}, frame: frame(0), state: {} }) ?? {},
    ).sort();
    expect(pattern).toEqual(live);
  });
});

