import { describe, expect, it } from "vitest";

import { createHarness, alice, contextFor } from "../commands/test-support.ts";
import { evaluateExpression, scopeFromFrame } from "../expressions/evaluate.ts";
import { liveClock } from "../transport/live-clock.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import type { EvaluationFrame } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createValueGraphSession } from "../channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { NO_FLATTENING } from "../parameters/node-references.ts";
import { MIDI_CLOCK, MIDI_START } from "./midi-clock.ts";
import { createProjectTempo, documentTempo, projectBpm, projectTempoSource } from "./project-tempo.ts";
import { registerTempoCommands } from "./tempo-commands.ts";

/**
 * T1785b / T1786b — the project tempo, read the way a project reads it: an expression
 * evaluated against the frame the transport produced. Every test here drives the REAL
 * bus, the real `tempo.*` commands, the real live clock (or offline transport) and the
 * real expression scope, on a wall clock the test owns. Nothing asserts what the beat
 * clock holds inside: only `bpm`, `beat`, `beatphase`, `beatpulse`, `bar`, `barphase` and
 * `tempolocked` as an expression gets them — which is what goes wrong if a wire is cut.
 */
function session() {
  const { bus, store } = createHarness();
  let seconds = 100;
  const tempo = createProjectTempo({ now: () => seconds, settings: () => store.view.getSettings() });
  registerTempoCommands(bus, tempo);
  // The transport of the running app: live, presenting, the tempo stamped on every frame.
  const clock = liveClock({ now: () => seconds * 1000, presenting: () => true, tempo: tempo.read, fps: 60 });
  const context = contextFor(alice);
  return {
    bus,
    store,
    tempo,
    clock,
    at: (next: number): void => void (seconds = next),
    advance: (by: number): void => void (seconds += by),
    now: (): number => seconds,
    run: <N extends "tempo.set" | "tempo.tap" | "tempo.resync" | "tempo.setSource">(name: N, input: object = {}) => bus.execute(name, input as never, context),
    /** What an expression reads on the next frame the transport produces. */
    read: (source: string): number => read(clock.next(), source),
  };
}

function read(frame: EvaluationFrame, source: string): number {
  const result = evaluateExpression(source, scopeFromFrame(frame));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("the project tempo is document state (T1785b)", () => {
  it("a document that states none is at 120, manual; one that states them reads them", () => {
    expect([projectBpm({}), projectTempoSource({})]).toEqual([120, "manual"]);
    expect([projectBpm({ bpm: 87.5 }), projectTempoSource({ tempoSource: "midiClock" })]).toEqual([87.5, "midiClock"]);
    // A number the schema would refuse is not a tempo: the default, never a clock at NaN beats a minute.
    expect([projectBpm({ bpm: 0 }), projectBpm({ bpm: Number.NaN })]).toEqual([120, 120]);
  });

  it("tempo.set stores the BPM in the project's settings, as one undo entry, and the next frame's `bpm` is it", async () => {
    const s = session();
    expect(s.read("bpm")).toBe(120);
    const result = await s.run("tempo.set", { bpm: 140 });
    expect(result.status).toBe("applied");
    expect(result.output).toEqual({ bpm: 140, source: "manual", locked: true });
    expect(s.store.view.getSettings().bpm).toBe(140);
    expect(s.read("bpm")).toBe(140);
    await s.bus.execute("graph.undo", {}, contextFor(alice));
    expect(s.store.view.getSettings().bpm).toBeUndefined();
    expect(s.read("bpm")).toBe(120);
  });

  it("a tempo outside 20..999 is refused and the project keeps the one it had", async () => {
    const s = session();
    const result = await s.run("tempo.set", { bpm: 5 });
    expect(result.status).not.toBe("applied");
    expect(s.read("bpm")).toBe(120);
  });
});

describe("the beat clock as an expression reads it (T1785b)", () => {
  it("counts beats and bars along the wall clock: phase ramps 0..1, four beats to the bar, one pulse per beat", () => {
    const s = session();
    // 120 bpm: a beat every 0.5 s. The first frame is the downbeat.
    s.clock.next();
    s.advance(0.25);
    const half = s.clock.next();
    expect([read(half, "beat"), read(half, "beatphase"), read(half, "beatpulse"), read(half, "bar")]).toEqual([0, 0.5, 0, 0]);
    expect(read(half, "barphase")).toBeCloseTo(0.125, 12);
    s.advance(0.375);
    const second = s.clock.next();
    // 0.625 s in: beat 1, a quarter through it, and THIS is the frame beat 1 landed in.
    expect([read(second, "beat"), read(second, "beatpulse")]).toEqual([1, 1]);
    expect(read(second, "beatphase")).toBeCloseTo(0.25, 12);
    s.advance(0.1);
    expect(s.read("beatpulse")).toBe(0);
    s.advance(1.525);
    const bar = s.clock.next();
    // 2.25 s in: beat 4 = bar 1, beat 0.
    expect([read(bar, "beat"), read(bar, "bar")]).toEqual([4, 1]);
    expect(read(bar, "barphase")).toBeCloseTo(0.125, 12);
  });

  it("the first frame is the downbeat, and nothing landed on it: a project that opens does not pulse (T1787b)", () => {
    const s = session();
    const first = s.clock.next();
    expect([read(first, "beat"), read(first, "beatphase"), read(first, "beatpulse"), read(first, "tempolocked")]).toEqual([0, 0, 0, 1]);
    // The beats after it land as ever.
    s.advance(0.5);
    expect(s.read("beatpulse")).toBe(1);
  });

  it("a frame with no step and no stamped tempo (the compile's zero frame) does not pulse (T1787b)", () => {
    const zero = { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0, mode: "realtime", randomSeed: 1 } as const;
    expect([read(zero as unknown as EvaluationFrame, "beat"), read(zero as unknown as EvaluationFrame, "beatpulse")]).toEqual([0, 0]);
    // A frame that steps onto a beat does: 0.5 s at the default 120 is beat 1.
    const stepped = { ...zero, timeSeconds: 0.5, deltaSeconds: 1 / 60, frameIndex: 30 };
    expect([read(stepped as unknown as EvaluationFrame, "beat"), read(stepped as unknown as EvaluationFrame, "beatpulse")]).toEqual([1, 1]);
  });

  it("a transport that stamps NO tempo reads the default, not the project's — the wire this suite stands on", async () => {
    const s = session();
    await s.run("tempo.set", { bpm: 90 });
    const unwired = liveClock({ now: () => s.now() * 1000, presenting: () => true, fps: 60 });
    expect(read(unwired.next(), "bpm")).toBe(120);
    expect(s.read("bpm")).toBe(90);
  });

  it("a value node publishes the beat as a channel: the value graph reads the same clock", async () => {
    const s = session();
    await s.run("tempo.set", { bpm: 60 });
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const node: GraphNode = {
      id: "c" as NodeId,
      type: "constant",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      label: "constant_beat",
      parameters: { value: { mode: "expression", bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source: "beat + beatphase" } } } },
    };
    const graph = { nodes: { c: node }, edges: {}, groups: {}, revision: 0 } as unknown as GraphDocument;
    const values = createValueGraphSession(registry);
    s.clock.next();
    s.advance(2.5);
    const result = values.evaluate(flatDocument(graph), s.clock.next(), { flattening: NO_FLATTENING });
    // 2.5 s at 60 bpm is two and a half beats.
    expect(result.byName.get("constant_beat")?.["value"]).toBeCloseTo(2.5, 12);
  });
});

describe("tap tempo (T1785b)", () => {
  it("two taps make a tempo; the project's BPM and the next frame's `bpm` are the tapped rate", async () => {
    const s = session();
    s.clock.next();
    s.at(101);
    expect((await s.run("tempo.tap")).output).toMatchObject({ bpm: 120, taps: 1 });
    s.at(101.4);
    expect((await s.run("tempo.tap")).output).toMatchObject({ bpm: 150, taps: 2 });
    expect(s.store.view.getSettings().bpm).toBe(150);
    expect(s.read("bpm")).toBe(150);
  });

  it("the rate is the MEDIAN of the last intervals: one late tap does not move it", async () => {
    const s = session();
    s.clock.next();
    // Seven intervals of 0.5 s (120 bpm) with one of 0.8 s among them.
    let time = 101;
    for (const gap of [0, 0.5, 0.5, 0.8, 0.5, 0.5, 0.5, 0.5]) {
      time += gap;
      s.at(time);
      await s.run("tempo.tap");
    }
    expect(s.read("bpm")).toBe(120);
  });

  it("keeps eight taps: a new tempo tapped after an old one replaces it within eight taps", async () => {
    const s = session();
    s.clock.next();
    let time = 101;
    for (let tap = 0; tap < 8; tap += 1) {
      s.at((time += 0.5));
      await s.run("tempo.tap");
    }
    expect(s.read("bpm")).toBe(120);
    for (let tap = 0; tap < 7; tap += 1) {
      s.at((time += 0.4));
      await s.run("tempo.tap");
    }
    // The window now holds seven intervals of 0.4 s and none of the old ones.
    expect(s.read("bpm")).toBe(150);
  });

  it("a gap of more than two seconds starts a new count: the tap after it is a first tap", async () => {
    const s = session();
    s.clock.next();
    s.at(101);
    await s.run("tempo.tap");
    s.at(101.5);
    await s.run("tempo.tap");
    s.at(104.5);
    const after = await s.run("tempo.tap");
    // Not 20 bpm from a three-second "interval": one tap, and the tempo is still 120.
    expect(after.output).toMatchObject({ bpm: 120, taps: 1 });
    expect(s.read("bpm")).toBe(120);
  });

  it("the latest tap sets the beat phase: the tap IS a beat, and it pulses", async () => {
    const s = session();
    s.clock.next();
    // 0.2 s in, the clock is 0.4 of the way through beat 0. A tap there says "the beat is now".
    s.advance(0.2);
    expect(s.read("beatphase")).toBeCloseTo(0.4, 12);
    await s.run("tempo.tap");
    const onTap = s.clock.next();
    expect([read(onTap, "beatphase"), read(onTap, "beatpulse")]).toEqual([0, 1]);
    // And it stays there: a quarter second on at 120 is half a beat past the tap.
    s.advance(0.25);
    expect(s.read("beatphase")).toBeCloseTo(0.5, 12);
  });

  it("a tap lands on the NEAREST beat, so tapping late in a bar does not lose the bar", async () => {
    const s = session();
    s.clock.next();
    s.advance(1.9); // beat 3.8 at 120
    await s.run("tempo.tap");
    const frame = s.clock.next();
    expect([read(frame, "beat"), read(frame, "bar")]).toEqual([4, 1]);
  });

  it("resync puts beat zero of bar zero at now", async () => {
    const s = session();
    s.clock.next();
    s.advance(1.3);
    expect(s.read("beat")).toBe(2);
    s.advance(0.1);
    await s.run("tempo.resync");
    const frame = s.clock.next();
    expect([read(frame, "beat"), read(frame, "bar"), read(frame, "beatphase"), read(frame, "beatpulse")]).toEqual([0, 0, 0, 1]);
  });
});

describe("the tempo source (T1785b, T1786b)", () => {
  /** `count` clock pulses at `bpm`, the last one at the session's now. */
  const pulses = (s: ReturnType<typeof session>, bpm: number, count: number): void => {
    const step = 60 / (bpm * 24);
    for (let index = 0; index < count; index += 1) {
      s.advance(step);
      s.tempo.midiRealtime(MIDI_CLOCK, s.now());
    }
  };

  it("midiClock: the frame's tempo is the master's, and manual stops following it", async () => {
    const s = session();
    await s.run("tempo.setSource", { source: "midiClock" });
    // No pulses yet: the project's tempo is held, and the reading says nothing is delivering.
    const idle = s.clock.next();
    expect([read(idle, "bpm"), read(idle, "tempolocked")]).toEqual([120, 0]);
    s.tempo.midiRealtime(MIDI_START, s.now());
    pulses(s, 150, 49);
    const locked = s.clock.next();
    expect(read(locked, "bpm")).toBeCloseTo(150, 9);
    expect(read(locked, "tempolocked")).toBe(1);
    // 48 pulses after the one that started the count: beat 2 exactly.
    expect([read(locked, "beat"), read(locked, "bar")]).toEqual([2, 0]);
    expect(read(locked, "beatphase")).toBeCloseTo(0, 9);

    // Back to manual: the tempo that was playing becomes the project's, and pulses at
    // another tempo no longer move the clock.
    const back = await s.run("tempo.setSource", { source: "manual" });
    expect(back.output).toEqual({ bpm: 150, source: "manual", locked: true });
    expect(s.store.view.getSettings()).toMatchObject({ bpm: 150, tempoSource: "manual" });
    pulses(s, 90, 49);
    expect(s.read("bpm")).toBe(150);
  });

  it("midiClock pulses do nothing to a MANUAL project", () => {
    const s = session();
    s.clock.next();
    pulses(s, 150, 49);
    const frame = s.clock.next();
    expect([read(frame, "bpm"), read(frame, "tempolocked")]).toEqual([120, 1]);
    // 49 pulses at 150 took 0.8167 s: at the project's 120 that is beat 1, not the master's beat 2.
    expect(read(frame, "beat")).toBe(1);
  });

  it("midiClock: when pulses stop for half a second the last tempo is held, unlocked, and the beat runs on", async () => {
    const s = session();
    await s.run("tempo.setSource", { source: "midiClock" });
    s.tempo.midiRealtime(MIDI_START, s.now());
    pulses(s, 150, 49);
    s.clock.next();
    s.advance(0.6);
    const lost = s.clock.next();
    expect(read(lost, "tempolocked")).toBe(0);
    expect(read(lost, "bpm")).toBeCloseTo(150, 9);
    // 0.6 s at the held 150 is a beat and a half past beat 2.
    expect(read(lost, "beat")).toBe(3);
    expect(read(lost, "beatphase")).toBeCloseTo(0.5, 9);
  });

  it("midiClock: pulses that come back with no Start carry on from the position the clock held (T1787b)", async () => {
    const s = session();
    await s.run("tempo.setSource", { source: "midiClock" });
    s.tempo.midiRealtime(MIDI_START, s.now());
    pulses(s, 150, 49);
    s.clock.next();
    // The master goes quiet for 0.6 s: beat 2 runs on to beat 3.5 at the held 150.
    s.advance(0.6);
    expect(s.read("tempolocked")).toBe(0);
    // It comes back, with no Start. 24 pulses are one more beat: 4.5, not the 3 the count
    // alone would say (2 where it stopped, plus the 24 pulses since).
    pulses(s, 150, 24);
    const back = s.clock.next();
    expect(read(back, "tempolocked")).toBe(1);
    expect(read(back, "beat") + read(back, "beatphase")).toBeCloseTo(4.5, 6);
    // And it is the master's count again from there: 12 pulses are half a beat.
    pulses(s, 150, 12);
    const on = s.clock.next();
    expect(read(on, "beat") + read(on, "beatphase")).toBeCloseTo(5, 6);
    // A Start does say where the master is: the next pulse is beat zero.
    s.advance(0.6);
    s.clock.next();
    s.tempo.midiRealtime(MIDI_START, s.now());
    pulses(s, 150, 25);
    const restarted = s.clock.next();
    expect(read(restarted, "beat") + read(restarted, "beatphase")).toBeCloseTo(1, 6);
  });

  it("audio: follows a confident claim, holds the last tempo through an unconfident one, and manual ignores both", async () => {
    const s = session();
    s.tempo.observeAudio({ bpm: 128, bpmConfidence: 0.9 });
    expect(s.read("bpm")).toBe(120);
    await s.run("tempo.setSource", { source: "audio" });
    const before = s.clock.next();
    expect([read(before, "bpm"), read(before, "tempolocked")]).toEqual([120, 0]);
    s.tempo.observeAudio({ bpm: 128, bpmConfidence: 0.9 });
    const following = s.clock.next();
    expect([read(following, "bpm"), read(following, "tempolocked")]).toEqual([128, 1]);
    s.tempo.observeAudio({ bpm: 61, bpmConfidence: 0.2 });
    const holding = s.clock.next();
    expect([read(holding, "bpm"), read(holding, "tempolocked")]).toEqual([128, 0]);
    s.tempo.observeAudio(null);
    expect(s.read("bpm")).toBe(128);
  });
});

describe("offline, the beat is a function of the frame (§V1038)", () => {
  const render = (settings: { bpm?: number; tempoSource?: "manual" | "audio" | "midiClock" }, frames: number): EvaluationFrame[] => {
    const transport = offlineTransport({ fps: 60, tempo: documentTempo(() => settings) });
    return Array.from({ length: frames }, () => transport.next());
  };

  it("frame N at 150 bpm is at N / 60 * 2.5 beats, the same on every run", () => {
    const first = render({ bpm: 150 }, 49);
    const again = render({ bpm: 150 }, 49);
    expect(first.map((frame) => frame.tempo)).toEqual(again.map((frame) => frame.tempo));
    // Frame 24 is 0.4 s: beat 1 exactly, and the frame it lands in.
    expect([read(first[24] as EvaluationFrame, "beat"), read(first[24] as EvaluationFrame, "beatpulse")]).toEqual([1, 1]);
    expect(read(first[36] as EvaluationFrame, "beatphase")).toBeCloseTo(0.5, 12);
    expect(first.filter((frame) => read(frame, "beatpulse") > 0).map((frame) => frame.frameIndex)).toEqual([0, 24, 48]);
  });

  it("a source with nothing to follow offline holds the document's tempo and says it is not locked", () => {
    const [frame] = render({ bpm: 96, tempoSource: "midiClock" }, 1);
    expect([read(frame as EvaluationFrame, "bpm"), read(frame as EvaluationFrame, "tempolocked")]).toEqual([96, 0]);
  });

  it("a take in the app counts the same beats: a stepped frame moves by its own step, not the wall clock", () => {
    const s = session();
    const stepped = liveClock({ now: () => s.now() * 1000, presenting: () => false, tempo: s.tempo.read, fps: 60 });
    s.tempo.restartAt(0);
    const beats: number[] = [];
    for (let frame = 0; frame < 31; frame += 1) {
      // The wall clock lurches between steps; a render must not hear it.
      s.advance(frame % 2 === 0 ? 3 : 0.001);
      beats.push(read(stepped.next(), "beat + beatphase"));
    }
    expect(beats[30]).toBeCloseTo(1, 9);
    expect(beats[15]).toBeCloseTo(0.5, 9);
  });
});

describe("a node's own names win over the tempo's (T1785b)", () => {
  it("an expression handed `bpm` and `beat` by its node keeps reading the node's", () => {
    const frame = offlineTransport({ fps: 60, tempo: documentTempo(() => ({ bpm: 150 })) }).next();
    const scope = scopeFromFrame(frame, { bpm: 99, beat: 7 });
    expect([scope["bpm"], scope["beat"], scope["barphase"]]).toEqual([99, 7, 0]);
  });
});
