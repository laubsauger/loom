import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { valueLagNode } from "../nodes/definitions/value-graph-nodes.ts";
import { audioAnalysisHost } from "./starter-components.ts";

/**
 * T1230 — the AudioAnalysis component's two measured claims, read off the SHIPPED host
 * graph so a structural break of either lane fails here and not in someone's patch.
 *
 * 1. The `levels` lane is §V952's chain, second lag INCLUDED: `signal → lag → NORMALIZE →
 *    lag`. The rank normaliser re-ranks every frame, so its output steps a third to two
 *    thirds of its span between two frames on the shipped pattern; `settle` is a one-pole
 *    follower whose per-frame step is bounded by `1 − exp(−dt/lag)` of the span. Cut
 *    `settle` out (read `rank` instead) and the bound fails — that is the red-verify.
 *
 * 2. Channel choice is a measurement (§V952): a COUNT run through `levels` does not rest at
 *    0, it rests at its mid-rank, because a percentile removes skew but cannot spread a tie.
 *    Through `hits` — a 1 ms follower with a 250 ms release — the same count peaks at
 *    exactly 1 and decays below 0.2 before the next kick. That is the reason the component
 *    ships two outputs; a single conditioned bag would silently hand a kick count to a
 *    parameter as "about 0.5 always".
 *
 * Per §V767 these are records with a discriminating gap, not tight bounds: the exact
 * numbers move with the pattern, the RELATION between the lanes does not.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (index: number): FrameEvaluationInput => ({
  timeSeconds: index / 60,
  deltaSeconds: 1 / 60,
  frameIndex: index,
  mode: "offline",
  randomSeed: 1,
});

/** Run the value graph for `frames`, collecting one channel from several nodes each frame. */
function trace(
  graph: GraphDocument,
  nodeIds: readonly string[],
  channel: string,
  frames: number,
): Record<string, number[]> {
  const session = createValueGraphSession(registry);
  const out: Record<string, number[]> = Object.fromEntries(nodeIds.map((id) => [id, []]));
  for (let index = 0; index < frames; index += 1) {
    const result = session.evaluate(graph, frameAt(index), {});
    for (const id of nodeIds) out[id]!.push(result.byId.get(id as never)?.[channel] ?? NaN);
  }
  return out;
}

/** The settled tail: the 16 s rank window and the followers have charged by 10 s (T1230 read from 600). */
const SETTLED_FROM = 600;
const FRAMES = 2400;

function largestStep(values: number[]): number {
  const tail = values.slice(SETTLED_FROM);
  let largest = 0;
  for (let index = 1; index < tail.length; index += 1) {
    largest = Math.max(largest, Math.abs(tail[index]! - tail[index - 1]!));
  }
  return largest;
}

function span(values: number[]): number {
  const tail = values.slice(SETTLED_FROM);
  return Math.max(...tail) - Math.min(...tail);
}

function median(values: number[]): number {
  const sorted = [...values.slice(SETTLED_FROM)].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The lag `settle` ships with, read from the host so a retune moves the bound with it. */
function settleLag(graph: GraphDocument): number {
  const lag = graph.nodes["settle"]?.parameters["lag"];
  if (typeof lag !== "number") throw new Error("host has no numeric `settle.lag`");
  return lag;
}

const host = audioAnalysisHost.graph as GraphDocument;

describe("AudioAnalysis — the levels lane is lag → normalize → lag, second lag included (§V952)", () => {
  it("rank steps a third of its span in one frame; settle bounds the step to the follower's own limit", () => {
    const { rank, settle } = trace(host, ["rank", "settle"], "low", FRAMES);

    // The percentile re-ranks every frame: a large step is what a rank output DOES on a
    // beat pattern (measured 0.36..0.68 of span across the bands). Not a defect — the
    // reason the second lag is not optional.
    expect(largestStep(rank!) / span(rank!)).toBeGreaterThan(0.3);

    // The follower is `state += k·(input − state)` with `k = 1 − exp(−dt/lag)`, so no frame
    // can move it more than k times its INPUT's span: 10.5% of rank's span at the shipped
    // 0.15 s. That is exact for the node, not a band around the pattern (measured 0.078).
    const bound = (1 - Math.exp(-(1 / 60) / settleLag(host))) * span(rank!);
    expect(largestStep(settle!)).toBeLessThanOrEqual(bound + 1e-9);
    // And the lane still MOVES — a follower that never charges would pass the bound trivially.
    expect(largestStep(settle!)).toBeGreaterThan(bound / 4);
  });
});

describe("AudioAnalysis — a count rests at mid-rank through levels and pulses through hits (T1230)", () => {
  it("kickCount: the levels lane holds it near 0.5, the hits lane takes it to 1 and back below 0.2", () => {
    const { settle, decay } = trace(host, ["settle", "decay"], "kickCount", FRAMES);
    const settled = settle!.slice(SETTLED_FROM);
    const pulsed = decay!.slice(SETTLED_FROM);

    // Through `levels`: a channel that is 0 on most frames and 1 on a few is a tie the
    // percentile cannot spread, so it rests at its mid-rank. Measured median 0.532, range
    // 0.236..0.659 — never near 0, never near 1. Loose bands (§V767).
    expect(median(settle!)).toBeGreaterThan(0.4);
    expect(median(settle!)).toBeLessThan(0.65);
    expect(Math.min(...settled)).toBeGreaterThan(0.2);
    expect(Math.max(...settled)).toBeLessThan(0.8);

    // Through `hits`: the 1 ms attack reaches the count's 1 on the hit frame, the 250 ms
    // release decays it to ~0.12 before the next kick at 112 BPM.
    expect(Math.max(...pulsed)).toBeGreaterThan(0.999);
    expect(Math.min(...pulsed)).toBeLessThan(0.2);

    // The discriminating gap: the two lanes disagree about the SAME channel by a wide
    // margin at both ends — this is what a single output could not offer.
    expect(Math.max(...pulsed) - Math.max(...settled)).toBeGreaterThan(0.2);
    expect(Math.min(...settled) - Math.min(...pulsed)).toBeGreaterThan(0.1);
  });

  it("Hit Decay's travel reaches the shipped 250 and the one-second swell (T823 precedent)", () => {
    // The published `hitDecay` is `decay.releaseRatio`; its default is 250 and its ceiling
    // 1000, both past the 100 T823 widened for AudioLevel. A travel narrowed back below the
    // default leaves the shipped component past its own slider, which the authorability
    // census flags — but the census does not say WHY 1000; this does.
    const schema = effectiveParameterSchema(valueLagNode, {});
    const ratio = schema["releaseRatio"];
    const max = ratio?.type === "number" ? ratio.max : undefined;
    expect(max).toBeGreaterThanOrEqual(1000);
    expect(host.nodes["decay"]?.parameters["releaseRatio"]).toBe(250);
  });
});
