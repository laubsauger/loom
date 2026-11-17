import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1348b — BEAT: a hit is a crossing outside the hold-off, and a hit is a whole event.
 *
 * The signal below crosses 0.5 upward every three frames (every 0.05 s at 60 fps). With a
 * 0.09 s hold-off the node must fire on frames 0, 6 and 12 and REFUSE frames 3 and 9 — the
 * thing Trigger cannot do, and the reason this node exists. The hold-off is compared in
 * elapsed seconds, so the frame-rate test at the end feeds the same crossings at a slower
 * step and expects the SAME wall-time behaviour. All numbers are closed forms (§V147).
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const frameAt = (frameIndex: number, deltaSeconds: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex * deltaSeconds,
  deltaSeconds,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

function graph(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      src: { id: "src", type: "constant", definitionVersion: 1, position: { x: 0, y: 0 }, label: "src1", parameters: { value: 0 } },
      beat: { id: "beat", type: "valueBeat", definitionVersion: 1, position: { x: 0, y: 0 }, label: "beat1", parameters },
    },
    edges: { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "beat", portId: "in" } } },
  } as unknown as GraphDocument;
}

function run(parameters: Record<string, unknown>, signal: readonly number[], deltaSeconds = 1 / 60): number[] {
  const doc = graph(parameters);
  const session = createValueGraphSession(registry);
  return signal.map((value, index) => {
    // An edit is another node object, as in a real document: the session keeps a node's
    // stored constants by the object (T1179), so a value written in place is never seen.
    (doc.nodes as Record<string, unknown>)["src"] = { ...doc.nodes["src"]!, parameters: { value } };
    const result = session.evaluate(flatDocument(doc), frameAt(index, deltaSeconds), { flattening: NO_FLATTENING });
    expect(result.diagnostics).toEqual([]);
    return result.byName.get("beat1")!["value"]!;
  });
}

/** 1 on every third frame from 0, else 0: an upward crossing of 0.5 every 0.05 s at 60 fps. */
const EVERY_THIRD = Array.from({ length: 16 }, (_, index) => (index % 3 === 0 ? 1 : 0));

describe("T1348b — Beat fires on a crossing outside the hold-off", () => {
  it("with Tail 0 it is a pulse with a hold-off: frames 0, 6, 12 fire; 3, 9, 15 are inside 0.09 s and do not", () => {
    const read = run({ threshold: 0.5, retrigger: 0.09, tail: 0 }, EVERY_THIRD);
    expect(read).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("with no hold-off it is Trigger: every crossing fires", () => {
    const read = run({ threshold: 0.5, retrigger: 0, tail: 0 }, EVERY_THIRD);
    expect(read).toEqual(EVERY_THIRD);
  });

  it("a hit is a whole event: 1 on its frame, then the linear tail 1/15 per frame at 0.25 s, and a new hit restarts it", () => {
    const read = run({ threshold: 0.5, retrigger: 0.09, tail: 0.25, decay: "linear" }, EVERY_THIRD);
    for (let frame = 0; frame < 6; frame += 1) expect(read[frame]).toBeCloseTo(1 - frame / 15, 12);
    // Frame 3 crossed inside the hold-off: the tail kept falling, nothing restarted.
    expect(read[3]).toBeCloseTo(1 - 3 / 15, 12);
    expect(read[6]).toBe(1);
    expect(read[7]).toBeCloseTo(1 - 1 / 15, 12);
  });

  it("exponential: e^(-k/15) after the hit", () => {
    const read = run({ threshold: 0.5, retrigger: 1, tail: 0.25, decay: "exponential" }, [1, 0, 0, 0, 0, 0]);
    for (let frame = 0; frame < 6; frame += 1) expect(read[frame]).toBeCloseTo(Math.exp(-frame / 15), 12);
  });

  it("a level that STAYS above the threshold fires once — it is a crossing detector, not a gate", () => {
    const read = run({ threshold: 0.5, retrigger: 0, tail: 0 }, [0, 1, 1, 1, 0, 1]);
    expect(read).toEqual([0, 1, 0, 0, 0, 1]);
  });

  it("the hold-off is SECONDS, not frames (§V436): the same crossings at 30 fps refuse the same hits", () => {
    // At 30 fps every third frame is every 0.1 s, so a 0.09 s hold-off lets every crossing
    // through; a 0.15 s hold-off refuses every other one. Frames alone could not tell these apart.
    expect(run({ threshold: 0.5, retrigger: 0.09, tail: 0 }, EVERY_THIRD, 1 / 30)).toEqual(EVERY_THIRD);
    expect(run({ threshold: 0.5, retrigger: 0.15, tail: 0 }, EVERY_THIRD, 1 / 30)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  });
});
