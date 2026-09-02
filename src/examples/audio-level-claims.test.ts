import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { valueLagNode } from "../nodes/definitions/value-graph-nodes.ts";
import { audioLevelHost } from "./starter-components.ts";

/**
 * The AudioLevel component's ONE measured claim (T821/T822): the seven-node auto-level
 * chain takes THREE different source levels all to 0.000..1.000, so a parameter tuned
 * against its output keeps its range whatever the track's level. That is the entire reason
 * to ship an analyser rather than let every example rebuild the affine map by hand (E27,
 * E43), and it is the property no schema, byte comparison or render check can see — all of
 * those are equally happy with a chain that passes the raw band straight through.
 *
 * The test reads the SHIPPED host graph, so a STRUCTURAL break of the chain — the division
 * that makes it affine turned into a multiply, the floor subtraction dropped, the clamp
 * removed — fails HERE, not silently (red-verified: multiply instead of divide drops the
 * normalised max to 0.06). The two follower ratios are TUNING, not structure — the range
 * invariant survives them, which is exactly why `responsiveness` can be a published knob;
 * what those constants move is the SAG between hits, a separate claim from range.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

/** The host with `beat.amount` set — the source level under test. */
function hostAtAmount(amount: number): GraphDocument {
  const graph = structuredClone(audioLevelHost.graph) as GraphDocument;
  const beat = graph.nodes["beat"];
  if (beat === undefined) throw new Error("host has no `beat`");
  (beat.parameters as Record<string, unknown>)["amount"] = amount;
  return graph;
}

/** The host with peak's release ratio (the Responsiveness knob) set — feel under test. */
function hostAtRatio(ratio: number): GraphDocument {
  const graph = structuredClone(audioLevelHost.graph) as GraphDocument;
  const peak = graph.nodes["peak"];
  if (peak === undefined) throw new Error("host has no `peak`");
  (peak.parameters as Record<string, unknown>)["releaseRatio"] = ratio;
  return graph;
}

const frameAt = (index: number): FrameEvaluationInput => ({
  timeSeconds: index / 60,
  deltaSeconds: 1 / 60,
  frameIndex: index,
  mode: "offline",
  randomSeed: 1,
});

/** Run the value graph for `frames`, collecting one node's `low` channel each frame.
 *  Keyed by id: the host graph is unflattened, so its nodes carry no label yet (byName). */
function traceLow(graph: GraphDocument, nodeId: string, frames: number): number[] {
  const session = createValueGraphSession(registry);
  const out: number[] = [];
  for (let index = 0; index < frames; index += 1) {
    const result = session.evaluate(graph, frameAt(index), {});
    out.push(result.byId.get(nodeId as never)?.["low"] ?? NaN);
  }
  return out;
}

/** Statistics over the settled tail (the followers need ~3 s to charge, T821 read from 200). */
function settledRange(values: number[]): { min: number; max: number } {
  const tail = values.slice(200);
  return { min: Math.min(...tail), max: Math.max(...tail) };
}

describe("AudioLevel — the auto-level chain adapts every source level to 0..1 (T821)", () => {
  // The three levels T821 measured, with the raw ranges its re-run at HEAD reported. The
  // raw band is what the chain must NOT already look like — proof the normaliser did work.
  const CASES = [
    { amount: 1, rawMin: 0.7128, rawMax: 0.975 },
    { amount: 0.5, rawMin: 0.6268, rawMax: 0.889 },
    { amount: 0.25, rawMin: 0.5407, rawMax: 0.803 },
  ];

  it.each(CASES)("amount $amount: raw sits high and narrow, normalised reaches 0..1", ({ amount, rawMin, rawMax }) => {
    const graph = hostAtAmount(amount);

    // The raw band, straight off the source: high and level-dependent — NOT already 0..1.
    // This is the thing a hand-tuned constant map gets wrong when the track's level moves.
    const raw = settledRange(traceLow(graph, "beat", 400));
    expect(raw.min).toBeCloseTo(rawMin, 2);
    expect(raw.max).toBeCloseTo(rawMax, 2);
    expect(raw.min).toBeGreaterThan(0.1); // never near 0 on its own — the floor is what finds 0

    // The normalised band: the SAME chain, the SAME constants, driven to the full 0..1
    // whatever the source level above. min within a hair of 0, max within a hair of 1.
    const norm = settledRange(traceLow(graph, "clamp", 400));
    expect(norm.min).toBeLessThan(0.001);
    expect(norm.max).toBeGreaterThan(0.999);
    expect(norm.min).toBeGreaterThanOrEqual(0); // the clamp holds the floor legal
    expect(norm.max).toBeLessThanOrEqual(1); // and the ceiling
  });

  it("the adaptation is REAL: the raw ranges differ across levels but all normalise alike", () => {
    // If the three raw ranges were identical the claim would be vacuous — the source would
    // be doing the levelling. They are not: louder source, higher and wider raw band.
    const rawByAmount = CASES.map(({ amount }) => settledRange(traceLow(hostAtAmount(amount), "beat", 400)));
    expect(rawByAmount[0]!.max).toBeGreaterThan(rawByAmount[1]!.max);
    expect(rawByAmount[1]!.max).toBeGreaterThan(rawByAmount[2]!.max);

    // Yet every normalised max lands at 1 — the chain, not the source, did the levelling.
    for (const { amount } of CASES) {
      expect(settledRange(traceLow(hostAtAmount(amount), "clamp", 400)).max).toBeGreaterThan(0.999);
    }
  });
});

/**
 * T844 (§V793, §V799) — gate the SAG, the property Responsiveness exists for.
 *
 * §V799 found that the range gate above is blind to the release ratio: a hit charges the
 * 5 ms attack whatever the release, so the max always reaches 1. So the knob that exists
 * SPECIFICALLY for the release — Responsiveness, whose own description argues 15.8% vs
 * 26.8% — had no test at all, and someone could narrow §T823's travel back to 10 and
 * nothing would notice, INCLUDING the sentence making the case for 100 (§V793: an identity
 * claim proves the OFF state and says nothing about the ON one).
 *
 * The measured quantity is the peak-follower's droop — how far its reference falls below
 * its own ceiling between hits (`1 - mean/max` over the settled window). A low ratio lets
 * the reference sag, so the same raw level maps to a jumpier normalised output; a high
 * ratio holds it. Per §V767 this is a RECORD WITH A DISCRIMINATING GAP, not a tight bound:
 * the two ratios sit in loose bands and must differ by a clear margin — tight enough to
 * catch a reverted travel, loose enough that a pattern change need not be chased.
 */
function peakSagAtRatio(ratio: number): number {
  const peak = traceLow(hostAtRatio(ratio), "peak", 500).slice(200);
  const mean = peak.reduce((sum, value) => sum + value, 0) / peak.length;
  const max = Math.max(...peak);
  return 1 - mean / max;
}

describe("AudioLevel — Responsiveness moves the sag, and its useful setting is reachable (T844)", () => {
  it("a slow release (ratio 100) sags less than a fast one (ratio 10), by a clear margin", () => {
    const sag100 = peakSagAtRatio(100); // measured 0.078
    const sag10 = peakSagAtRatio(10); //  measured 0.184

    // Loose bands around the measured values (§V767) — a record, not a bound.
    expect(sag100).toBeGreaterThan(0.05);
    expect(sag100).toBeLessThan(0.11);
    expect(sag10).toBeGreaterThan(0.15);
    expect(sag10).toBeLessThan(0.22);

    // The discriminating gap: ratio 100 buys real stability over ratio 10. Measured 0.105;
    // asserting > 0.05 catches a travel reverted to 10 without chasing the exact pattern.
    expect(sag10 - sag100).toBeGreaterThan(0.05);
  });

  it("Release Ratio's drag travel reaches the setting the sag argument needs (T823)", () => {
    // The sag above is the WHY; this is the AND — the published Responsiveness knob must be
    // draggable to 100, or §T823's fix is silently gone even though the sag claim still holds.
    const max = valueLagNode.parameters["releaseRatio"]?.type === "number"
      ? valueLagNode.parameters["releaseRatio"].max
      : undefined;
    expect(max).toBeGreaterThanOrEqual(100);
  });
});
