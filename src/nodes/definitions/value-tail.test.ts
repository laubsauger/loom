import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1348b — TAIL: instant up, a shaped fall, by its own arithmetic (§V147).
 *
 * A linear tail of 0.25 s at 60 fps falls 1/15 of its peak per frame and is 0 on frame 15
 * exactly; an exponential one reads e^(-k/15) on frame k. Both are closed forms, so the
 * assertions are the numbers. Driven through the real session — a `constant` whose value
 * the test rewrites per frame is how a headless test feeds an arbitrary signal without
 * calling `valueEvaluate` by hand (the per-channel state lives in the session).
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 60;
const frameAt = (frameIndex: number, deltaSeconds = 1 / FPS): FrameEvaluationInput => ({
  timeSeconds: frameIndex / FPS,
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
      tail: { id: "tail", type: "valueTail", definitionVersion: 1, position: { x: 0, y: 0 }, label: "tail1", parameters },
    },
    edges: { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "tail", portId: "in" } } },
  } as unknown as GraphDocument;
}

/** Feeds `signal[k]` on frame k and returns what `tail1` read each frame. */
function run(parameters: Record<string, unknown>, signal: readonly number[], deltas?: readonly number[]): number[] {
  const doc = graph(parameters);
  const session = createValueGraphSession(registry);
  return signal.map((value, index) => {
    // An edit is another node object, as in a real document: the session keeps a node's
    // stored constants by the object (T1179), so a value written in place is never seen.
    (doc.nodes as Record<string, unknown>)["src"] = { ...doc.nodes["src"]!, parameters: { value } };
    const result = session.evaluate(flatDocument(doc), frameAt(index, deltas?.[index]), { flattening: NO_FLATTENING });
    expect(result.diagnostics).toEqual([]);
    return result.byName.get("tail1")!["value"]!;
  });
}

describe("T1348b — Tail holds the peak and lets it fall", () => {
  it("linear: a strike of 1 reaches 0 exactly Tail seconds later, 1/15 per frame at 0.25 s", () => {
    const read = run({ tail: 0.25, decay: "linear" }, [1, ...new Array(20).fill(0)]);
    expect(read[0]).toBe(1);
    for (let frame = 1; frame <= 15; frame += 1) expect(read[frame]).toBeCloseTo(Math.max(0, 1 - frame / 15), 12);
    // 1/60 is not a binary number: fifteen steps of it sum to 0.25 − 1 ulp, so frame 15 is 0
    // to 2e-16 and frame 16 is the clamp's exact 0. Stated rather than hidden behind a snap.
    expect(read[15]).toBeCloseTo(0, 12);
    expect(read[16]).toBe(0);
    expect(read[20]).toBe(0);
  });

  it("linear measures its rate against the peak it fell from: a strike of 0.5 also reaches 0 in Tail seconds", () => {
    const read = run({ tail: 0.25, decay: "linear" }, [0.5, ...new Array(16).fill(0)]);
    expect(read[5]).toBeCloseTo(0.5 * (1 - 5 / 15), 12);
    expect(read[15]).toBeCloseTo(0, 12);
    expect(read[16]).toBe(0);
  });

  it("exponential: e^(-k/15) on frame k, and never quite 0", () => {
    const read = run({ tail: 0.25, decay: "exponential" }, [1, ...new Array(30).fill(0)]);
    for (let frame = 0; frame <= 30; frame += 1) expect(read[frame]).toBeCloseTo(Math.exp(-frame / 15), 12);
    expect(read[30]).toBeGreaterThan(0);
  });

  it("jumps UP the frame the input is higher, and a fresh peak restarts the fall from there", () => {
    const read = run({ tail: 0.25, decay: "linear" }, [1, 0, 0, 0.9, 0, 0]);
    expect(read[3]).toBe(0.9);
    expect(read[4]).toBeCloseTo(0.9 * (1 - 1 / 15), 12);
    // Below the held value the input is ignored: frame 1's 0 did not pull it down to 0.
    expect(read[1]).toBeCloseTo(1 - 1 / 15, 12);
  });

  it("Tail 0 is no tail: gone the frame after", () => {
    expect(run({ tail: 0, decay: "linear" }, [1, 0, 0])).toEqual([1, 0, 0]);
  });

  it("is DELTA-DRIVEN (§V436): a frame with no elapsed time leaves the fall where it is, a double step falls twice", () => {
    const read = run({ tail: 0.25, decay: "linear" }, [1, 0, 0, 0], [1 / 60, 0, 2 / 60, 1 / 60]);
    expect(read[1]).toBe(1);
    expect(read[2]).toBeCloseTo(1 - 2 / 15, 12);
    expect(read[3]).toBeCloseTo(1 - 3 / 15, 12);
  });
});
