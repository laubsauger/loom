import { describe, expect, it } from "vitest";
import { harmonyConfig, harmonyNode, noteFieldNode } from "./harmony.ts";
import { harmonyAt, harmonyNotesBetween, noteEnvelope, HARMONY_NOTE_DURATION } from "../../domain/music/harmony.ts";
import { defaultParameterValue } from "../../domain/parameters/validate.ts";
import { ZERO_FRAME } from "../../domain/types/frame.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";

function defaults(node: NodeDefinition) {
  return Object.fromEntries(Object.entries(node.parameters).map(([key, schema]) => [key, defaultParameterValue(schema)]));
}

function evaluate(node: NodeDefinition, time: number, inputs = {}, state: Record<string, unknown> = {}, overrides: Record<string, ParameterValue> = {}) {
  const values = { ...defaults(node), ...overrides };
  return node.valueEvaluate!({ values, inputs, frame: { ...ZERO_FRAME, timeSeconds: time, absTimeSeconds: time }, state });
}

describe("structured musical graph", () => {
  it("publishes persistent note identities and coherent per-note data", () => {
    const a = evaluate(harmonyNode, 0.4);
    const b = evaluate(harmonyNode, 0.5);
    for (let i = 0; i < 5; i++) {
      expect(a[`voice${i}Id`]).toBe(b[`voice${i}Id`]);
      expect(a[`voice${i}PitchClass`]).toBe(a[`voice${i}Pitch`]! % 12);
      expect(a[`voice${i}Envelope`]).toBeGreaterThan(0);
      expect(a[`voice${i}Duration`]).toBeGreaterThan(0);
    }
    expect(evaluate(harmonyNode, 180)).toEqual(evaluate(harmonyNode, 180));
  });

  it("continues through timeline wraps using absolute musical time", () => {
    const values = Object.fromEntries(Object.entries(harmonyNode.parameters).map(([key, schema]) => [key, defaultParameterValue(schema)]));
    const wrapped = harmonyNode.valueEvaluate!({ values, inputs: {}, frame: { ...ZERO_FRAME, timeSeconds: 0.2, absTimeSeconds: 180 }, state: {} });
    expect(wrapped).toEqual(evaluate(harmonyNode, 180));
  });

  it("preserves note data while producing finite attractors and spectral color", () => {
    const music = { ...evaluate(harmonyNode, 2) };
    const field = evaluate(noteFieldNode, 2, { in: music });
    expect(field["voice0Id"]).toBe(music["voice0Id"]);
    for (let i = 0; i < 5; i++) {
      for (const axis of ["X", "Y", "Z", "R", "G", "B", "Intensity"]) expect(Number.isFinite(field[`voice${i}${axis}`])).toBe(true);
    }
    expect(evaluate(noteFieldNode, 2)).toEqual({});
    expect(() => evaluate(noteFieldNode, 2, { in: { voice0Pitch: 60 } })).toThrow("five structured Harmony voices");
  });

  it("maps 48 consecutive MIDI pitches exactly, without folding unrelated notes into either fan", () => {
    const music = { ...evaluate(harmonyNode, 2) };
    for (let pitch = 0; pitch < 128; pitch++) {
      music[`note${pitch}Envelope`] = pitch / 127;
      music[`note${pitch}Start`] = pitch;
    }
    const field = evaluate(noteFieldNode, 2, { in: music });
    const pitches = Array.from({ length: 5 }, (_, i) => music[`voice${i}Pitch`]!);
    const base = 12 * Math.floor(Math.min(...pitches) / 12);
    expect(field["keyBase"]).toBe(base);
    for (let slot = 0; slot < 48; slot++) {
      expect(field[`key${slot}Pitch`]).toBe(base + slot);
      expect(field[`key${slot}Envelope`]).toBe((base + slot) / 127);
      expect(field[`key${slot}Start`]).toBe(base + slot);
    }
    expect(field["key24Pitch"]).toBe(field["key23Pitch"]! + 1);
    expect(field["key48Pitch"]).toBeUndefined();
  });

  it.each([
    [48, 60, 48], [49, 61, 48], [60, 72, 60], [0, 4, 0], [123, 127, 80],
  ])("anchors register %i..%i at %i, moving by octaves except at MIDI bounds", (low, high, base) => {
    const music = { ...evaluate(harmonyNode, 2) };
    for (let i = 0; i < 5; i++) music[`voice${i}Pitch`] = i === 4 ? high : low;
    // Smoothed spatial pitches must not move the key bank between integer octaves.
    for (let i = 0; i < 5; i++) music[`voice${i}PositionPitch`] = 99.5;
    const field = evaluate(noteFieldNode, 2, { in: music });
    expect(field["keyBase"]).toBe(base);
    expect(field["key0Pitch"]).toBe(base);
    expect(field["key47Pitch"]).toBe(base + 47);
  });

  it.each(["Envelope", "Start"])("refuses missing per-pitch %s metadata", suffix => {
    const music = { ...evaluate(harmonyNode, 2) };
    const field = evaluate(noteFieldNode, 2, { in: music });
    const pitch = field["key24Pitch"]!;
    delete music[`note${pitch}${suffix}`];
    expect(() => evaluate(noteFieldNode, 2, { in: music })).toThrow(`note${pitch}${suffix}`);
  });

  it("keeps earlier chord pitches ringing in their exact key slots after voices change", () => {
    const config = harmonyConfig(defaults(harmonyNode));
    const chordSeconds = 240 / config.tempo / (0.5 + 1.5 * config.evolutionRate);
    let checked = false;
    for (let index = 1; index <= 10 && !checked; index++) {
      const time = index * chordSeconds + 0.25;
      const current = harmonyAt(time, config);
      const music = evaluate(harmonyNode, time);
      const field = evaluate(noteFieldNode, time, { in: music });
      const base = field["keyBase"]!;
      const events = harmonyNotesBetween(Math.max(0, time - HARMONY_NOTE_DURATION), time, config);
      const older = events.find(note => note.startTime < current.notes[0]!.startTime &&
        !current.notes.some(voice => voice.pitch === note.pitch) && note.pitch >= base && note.pitch < base + 48);
      if (older === undefined) continue;
      const ringing = events.filter(note => note.pitch === older.pitch);
      const slot = older.pitch - base;
      expect(field[`key${slot}Pitch`]).toBe(older.pitch);
      expect(field[`key${slot}Envelope`]).toBe(Math.max(...ringing.map(note => noteEnvelope(note, time))));
      expect(field[`key${slot}Envelope`]).toBeGreaterThan(0);
      expect(field[`key${slot}Start`]).toBe(Math.max(...ringing.map(note => note.startTime)));
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("keeps a high bass in the bank instead of centering it out of the instrument", () => {
    const music = { ...evaluate(harmonyNode, 2) };
    for (const [i, pitch] of [47, 62, 67, 74, 79].entries()) music[`voice${i}Pitch`] = pitch;
    const field = evaluate(noteFieldNode, 2, { in: music });
    expect(field["keyBase"]).toBe(36);
    for (const pitch of [47, 62, 67, 74, 79]) expect(field[`key${pitch - 36}Pitch`]).toBe(pitch);
  });

  it("does not publish a future rolled attack and publishes a reply at its actual onset", () => {
    const config = harmonyConfig(defaults(harmonyNode));
    const note = harmonyAt(0, config).notes[4]!;
    const before = evaluate(harmonyNode, note.startTime - 0.0001);
    expect(before[`note${note.pitch}Start`]).toBe(-1);
    expect(before[`note${note.pitch}Envelope`]).toBe(0);
    const after = evaluate(harmonyNode, note.startTime + 0.02);
    expect(after[`note${note.pitch}Start`]).toBe(note.startTime);
    expect(after[`note${note.pitch}Envelope`]).toBeGreaterThan(0);
    const reply = harmonyNotesBetween(0, 30, config).find(n => n.id % 64 >= 5)!;
    expect(reply).toBeDefined();
    const music = evaluate(harmonyNode, reply.startTime + 0.01);
    expect(music[`note${reply.pitch}Start`]).toBe(reply.startTime);
    expect(music[`note${reply.pitch}Envelope`]).toBeGreaterThan(0);
  });

  it("expires keys at their finite release boundary using the shared envelope even within a cached chord", () => {
    const overrides = { tempo: 10, evolutionRate: 0 };
    const config = harmonyConfig({ ...defaults(harmonyNode), ...overrides });
    const note = harmonyAt(0, config).notes[0]!;
    const state = {};
    for (const time of [0.1, note.duration - 0.001, note.duration, note.duration + 0.1]) {
      const music = evaluate(harmonyNode, time, {}, state, overrides);
      const field = evaluate(noteFieldNode, time, { in: music });
      const slot = note.pitch - field["keyBase"]!;
      expect(field[`key${slot}Envelope`]).toBe(noteEnvelope(note, time));
      expect(field[`key${slot}Start`]).toBe(time < note.duration ? 0 : -1);
    }
  });

  it("produces identical cold, cached and sought keys independent of frame order or timeline time", () => {
    const state = {};
    for (const time of [0.1, 3.5, 20, 180, 180.2, 9, 2, 180]) {
      const cached = evaluate(harmonyNode, time, {}, state);
      const cold = evaluate(harmonyNode, time);
      expect(evaluate(noteFieldNode, time, { in: cached })).toEqual(evaluate(noteFieldNode, time, { in: cold }));
      const wrapped = harmonyNode.valueEvaluate!({ values: defaults(harmonyNode), inputs: {}, state,
        frame: { ...ZERO_FRAME, frameIndex: 999, timeSeconds: 0, absTimeSeconds: time } });
      expect(evaluate(noteFieldNode, time, { in: wrapped })).toEqual(evaluate(noteFieldNode, time, { in: cold }));
    }
  });
});
