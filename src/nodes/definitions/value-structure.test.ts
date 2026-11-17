import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1370b — the structure nodes, by their own arithmetic (§V147): a ramp of slope 2 rises by
 * exactly 2 across a 1 s window; a hit every 15 frames at 60 fps is exactly 4 per second; a
 * step from 1 to 3 is novelty |3−1| ÷ (3+1) = 0.5 once both windows hold one side each; a
 * counter counts crossings, not frames, and honours its hold-off; a delay of 2 hands back
 * frame k−2. Driven through the real session with a `constant` rewritten per frame.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 60;
const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / FPS,
  deltaSeconds: 1 / FPS,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

function run(type: string, parameters: Record<string, unknown>, signal: readonly number[]): Array<Record<string, number>> {
  const doc = {
    revision: 1,
    groups: {},
    nodes: {
      src: { id: "src", type: "constant", definitionVersion: 1, position: { x: 0, y: 0 }, label: "src1", parameters: { value: 0 } },
      subject: { id: "subject", type, definitionVersion: 1, position: { x: 0, y: 0 }, label: "subject1", parameters },
    },
    edges: { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "subject", portId: "in" } } },
  } as unknown as GraphDocument;
  const session = createValueGraphSession(registry);
  return signal.map((value, index) => {
    // An edit is another node object, as in a real document: the session keeps a node's
    // stored constants by the object (T1179), so a value written in place is never seen.
    (doc.nodes as Record<string, unknown>)["src"] = { ...doc.nodes["src"]!, parameters: { value } };
    const result = session.evaluate(flatDocument(doc), frameAt(index), { flattening: NO_FLATTENING });
    expect(result.diagnostics).toEqual([]);
    return result.byName.get("subject1")!;
  });
}

describe("T1370b — the structure nodes", () => {
  it("Trend: a ramp of slope 2 rises by exactly 1 across a 0.5 s window, however it is offset", () => {
    // Half a second, not one: at a 1 s window "the rise across the window" and "the slope per
    // second" are the same number, and a test that cannot tell them apart proves neither.
    const ramp = Array.from({ length: 120 }, (_, k) => 5 + (2 * k) / FPS);
    const read = run("valueTrend", { window: 0.5 }, ramp);
    expect(read[0]!["value"]).toBe(0); // one sample fits no line
    expect(read[119]!["value"]).toBeCloseTo(1, 9);
    // A held signal has no trend.
    expect(run("valueTrend", { window: 1 }, new Array(90).fill(0.7))[89]!["value"]).toBeCloseTo(0, 12);
  });

  it("Rate: a hit every 15 frames at 60 fps is exactly 4 per second over a 1 s window", () => {
    const hits = Array.from({ length: 180 }, (_, k) => (k % 15 === 0 ? 1 : 0));
    const read = run("valueRate", { window: 1 }, hits);
    for (const frame of [60, 99, 179]) expect(read[frame]!["value"]).toBe(4);
  });

  it("Novelty: a step from 1 to 3 reads |3−1| ÷ (3+1) = 0.5 once each window holds one side", () => {
    const step = Array.from({ length: 200 }, (_, k) => (k < 100 ? 1 : 3));
    const read = run("valueNovelty", { recent: 0.5, reference: 1 }, step);
    expect(read[99]!["novelty"]).toBe(0); // the same sound on both sides
    // 30 frames after the step the recent 0.5 s is all 3 and the reference 1 s before it all 1.
    expect(read[129]!["novelty"]).toBeCloseTo(0.5, 12);
    // …and once the reference has also turned over, it is the same sound again.
    expect(read[199]!["novelty"]).toBe(0);
  });

  it("Count: counts crossings, not held frames, honours the hold-off, and reports seconds since", () => {
    //            frame: 0  1  2  3  4  5  6  7  8  9
    const pulses = [0, 1, 1, 0, 1, 0, 0, 0, 0, 1];
    // Hold-off 0.05 s = 3 frames: the crossing on frame 4 is 3 frames after frame 1 → counts;
    // with a hold-off of 0.1 s (6 frames) it would not.
    const read = run("valueCount", { threshold: 0.5, holdoff: 0.05 }, pulses);
    expect(read.map((bag) => bag["value"])).toEqual([0, 1, 1, 1, 2, 2, 2, 2, 2, 3]);
    expect(read[8]!["valueSince"]).toBeCloseTo(4 / FPS, 12);
    expect(read[9]!["valueSince"]).toBe(0);
    const strict = run("valueCount", { threshold: 0.5, holdoff: 0.1 }, pulses);
    expect(strict.map((bag) => bag["value"])).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  });

  it("Delay: two frames back, the first value until the history exists", () => {
    const read = run("valueDelay", { frames: 2 }, [10, 20, 30, 40, 50]);
    expect(read.map((bag) => bag["value"])).toEqual([10, 10, 10, 20, 30]);
  });
});

describe("T1370b — Expression computes channels from wired channels", () => {
  it("reads every incoming channel and earlier statements, and publishes one channel per statement", () => {
    const read = run("valueExpression", { expressions: "twice = value * 2; gate = (twice % 4 == 0) * (value > 1)" }, [1, 2, 3, 4]);
    expect(read.map((bag) => [bag["twice"], bag["gate"]])).toEqual([[2, 0], [4, 1], [6, 0], [8, 1]]);
  });

  it("a missing channel reads its default, so the statements using it still publish; a wired channel beats its default", () => {
    // `since` is not wired — a counter before its first event. Without the default the
    // whole `late` statement publishes nothing, and so does everything reading it: the
    // furnace director's cut gate deadlocked on exactly this.
    const unset = run("valueExpression", { expressions: "late = (since > 10) + value" }, [1]);
    expect(unset[0]?.["late"]).toBeUndefined();
    const read = run("valueExpression", { expressions: "late = (since > 10) + value", defaults: "since = 99; value = 100" }, [1, 2]);
    expect(read.map((bag) => bag["late"])).toEqual([2, 3]);
  });

  it("refuses a statement that does not parse, by name, at compile", () => {
    const registryView = createNodeRegistry(allNodeDefinitions).view();
    const definition = registryView.get("valueExpression")!;
    const compiled = definition.compile({ nodeId: "x", parameters: { expressions: "ok = 1; bad = (1 +" } } as never);
    expect(compiled.diagnostics?.map((d) => d.message)).toEqual([expect.stringMatching(/bad:/)]);
  });
});

/**
 * T1793b — the Expression node keeps ONE scope per program and writes each result into it,
 * remembers repeated subtrees, and keeps the results of a program that reads no name. What a
 * consumer reads must be what the per-statement rebuild gave: these are the cases where a
 * wrong scope, a stale remembered value or a wrongly kept result publishes another number.
 */
describe("T1793b — an Expression program reads like lines of a program, whatever it shares", () => {
  it("a statement may overwrite a wired channel, and the lines after it read the new value", () => {
    const read = run("valueExpression", { expressions: "value = value + 1; twice = value * 2" }, [3, 5]);
    expect(read).toEqual([{ value: 4, twice: 8 }, { value: 6, twice: 12 }]);
  });

  it("a name published twice holds its latest value for the lines after, and keeps its first place in the bag", () => {
    const [bag] = run("valueExpression", { expressions: "b = 1; a = b + 1; b = b + 10; c = a + b" }, [0]);
    expect(bag).toEqual({ b: 11, a: 2, c: 13 });
    expect(Object.keys(bag!)).toEqual(["b", "a", "c"]);
  });

  it("a statement that fails publishes nothing and leaves the earlier value standing: an unknown name, a division by zero, an overflow", () => {
    const [bag] = run("valueExpression", { expressions: "a = 2; a = missing + 1; b = a; c = 1 / (value - value); d = 10 ^ 400; e = b + 1" }, [7]);
    expect(bag).toEqual({ a: 2, b: 2, e: 3 });
  });

  it("a clock keeps its name: `time = 5` is published, and the lines after still read the clock", () => {
    // Frame 30 at 60 fps: the clock reads 0.5. The channel `time` leaves the node as 5.
    const read = run("valueExpression", { expressions: "time = 5; t2 = time * 2; frame = 9; f2 = frame + 1" }, [0, 0]);
    expect(read[1]).toEqual({ time: 5, t2: (1 / FPS) * 2, frame: 9, f2: 2 });
  });

  it("a tempo name is the node's to take: a statement or a wire named `bpm` is what the lines after read", () => {
    const [bag] = run("valueExpression", { expressions: "was = bpm; bpm = 90; now = bpm" }, [0]);
    expect(bag?.["now"]).toBe(90);
    expect(bag?.["was"]).not.toBe(90);
  });

  it("a repeated term is recomputed once a name it reads is published again", () => {
    // `(x * 2)` is one tree, written eight times. After `x = x + 10` it is another number,
    // and after the next frame's wire it is another again.
    const expressions = "x = value + 1; y = (x * 2) + (x * 2) + (x * 2) + (x * 2); x = x + 10; z = (x * 2) + (x * 2) + (x * 2) + (x * 2)";
    const read = run("valueExpression", { expressions }, [1, 2]);
    expect(read).toEqual([{ x: 12, y: 16, z: 96 }, { x: 13, y: 24, z: 104 }]);
  });

  it("a repeated term that failed is asked again once the name it lacked exists", () => {
    const expressions = "y = (late * 2) + (late * 2) + (late * 2); late = value; z = (late * 2) + (late * 2) + (late * 2)";
    const [bag] = run("valueExpression", { expressions }, [5]);
    expect(bag).toEqual({ late: 5, z: 30 });
  });

  it("a default reads the clock and the defaults before it, never the wire of the same name", () => {
    // `value` is wired (1, then 2). `since` is not, so it reads its default, which is built
    // from the DEFAULT `value` (100) and the clock, on every frame.
    const read = run("valueExpression", { expressions: "late = since + value", defaults: "value = 100; since = value + frame" }, [1, 2]);
    expect(read.map((bag) => bag["late"])).toEqual([100 + 0 + 1, 100 + 1 + 2]);
  });

  it("defaults that read nothing give the same numbers on every frame, and two nodes with one text do not share a wire", () => {
    const read = run("valueExpression", { expressions: "out = since * 2 + value; k = 3 * 4", defaults: "since = 68 * 0.5 / 4; value = 100" }, [1, 2, 3]);
    expect(read).toEqual([{ out: 18, k: 12 }, { out: 19, k: 12 }, { out: 20, k: 12 }]);
  });
});

