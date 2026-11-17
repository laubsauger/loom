import { describe, expect, it } from "vitest";

import type { MidiEvent } from "./midi-events.ts";
import {
  advanceKeyboard,
  applyMidiEvent,
  beginKeyboardFrame,
  createKeyboardState,
  dampingOf,
  decaySecondsAt,
  isSounding,
  keyboardChroma,
  keyboardTriad,
  LEVEL_FLOOR,
  type KeyboardSettings,
  type KeyboardState,
} from "./midi-notes.ts";

/**
 * T1762b — the keyboard model on event lists whose outcome a pianist could say in advance.
 * Every level is the model's own arithmetic, written out: a strike is the velocity, a step
 * multiplies by exp(−dt · rate), and the rate is 1/decay plus the damping share over release.
 */
const SETTINGS: KeyboardSettings = { voices: 4, channel: 0, decay: 4, decayTracking: 0, release: 0.15, pedalThreshold: 0.5, halfPedal: true };

const on = (pitch: number, velocity = 100, channel = 1): MidiEvent => ({ kind: 0x90, channel, data1: pitch, data2: velocity });
const off = (pitch: number, velocity = 0, channel = 1): MidiEvent => ({ kind: 0x80, channel, data1: pitch, data2: velocity });
const cc = (number: number, value: number): MidiEvent => ({ kind: 0xb0, channel: 1, data1: number, data2: value });
const sustain = (value: number): MidiEvent => cc(64, value);
const sostenuto = (value: number): MidiEvent => cc(66, value);

function keyboard(settings: KeyboardSettings = SETTINGS) {
  const state = createKeyboardState();
  beginKeyboardFrame(state, settings);
  let now = 0;
  return {
    state,
    play(...events: MidiEvent[]): void {
      for (const event of events) applyMidiEvent(state, event, now, settings);
    },
    wait(seconds: number): void {
      now += seconds;
      advanceKeyboard(state, seconds, settings);
    },
    key: (pitch: number) => state.keys[pitch]!,
  };
}

const V = 100 / 127;
const string = (seconds: number, decay = 4): number => Math.exp(-seconds / decay);
const damped = (seconds: number, share = 1): number => Math.exp(-seconds * (1 / 4 + share / 0.15));

describe("a key: strike, decay, release", () => {
  it("a strike is the velocity; held, it falls like a string and nothing damps it", () => {
    const k = keyboard();
    k.play(on(60));
    expect(k.key(60).level).toBe(V);
    expect([k.key(60).down, isSounding(k.key(60)), k.key(60).id, k.state.slotOf[60]]).toEqual([true, true, 1, 0]);
    k.wait(0.5);
    expect(k.key(60).level).toBeCloseTo(V * string(0.5), 12);
  });

  it("Decay Tracking shortens the high notes: an octave up at tracking 1 rings half as long", () => {
    const tracked = { ...SETTINGS, decayTracking: 1 };
    expect(decaySecondsAt(60, tracked)).toBe(4);
    expect(decaySecondsAt(72, tracked)).toBe(2);
    expect(decaySecondsAt(48, tracked)).toBe(8);
    expect(decaySecondsAt(72, SETTINGS)).toBe(4);
    const k = keyboard(tracked);
    k.play(on(72));
    k.wait(0.5);
    expect(k.key(72).level).toBeCloseTo(V * string(0.5, 2), 12);
  });

  it("released with no pedal it is damped over Release, stops sounding at once, and gives its voice back when it has stopped ringing", () => {
    const k = keyboard();
    k.play(on(60));
    k.play(off(60, 64));
    expect([k.key(60).down, isSounding(k.key(60)), k.key(60).releaseVelocity]).toEqual([false, false, 64 / 127]);
    // Still ringing, so the voice is still its own.
    k.wait(0.05);
    expect(k.key(60).level).toBeCloseTo(V * damped(0.05), 12);
    expect(k.state.slotOf[60]).toBe(0);
    k.wait(2);
    expect(k.key(60).level).toBe(0);
    expect([k.state.slotOf[60], k.state.slots[0]]).toEqual([-1, -1]);
  });

  it("a note-on at velocity 0 is a note-off, and carries no release velocity", () => {
    const k = keyboard();
    k.play(on(60), on(60, 0));
    expect([k.key(60).down, k.key(60).releaseVelocity, k.state.noteOnCount, k.state.noteOffCount]).toEqual([false, 0, 1, 1]);
  });

  it("a held key that has decayed to nothing keeps its voice until the finger lifts", () => {
    const k = keyboard({ ...SETTINGS, decay: 0.05 });
    k.play(on(60));
    k.wait(1);
    expect(k.key(60).level).toBe(0);
    expect(k.state.slotOf[60]).toBe(0);
    k.play(off(60));
    k.wait(0.01);
    expect(k.state.slotOf[60]).toBe(-1);
  });

  it("listens to one MIDI channel when asked, and to all at 0", () => {
    const only2 = keyboard({ ...SETTINGS, channel: 2 });
    only2.play(on(60, 100, 1), on(64, 100, 2));
    expect([only2.key(60).down, only2.key(64).down]).toEqual([false, true]);
    const all = keyboard();
    all.play(on(60, 100, 1), on(64, 100, 2));
    expect([all.key(60).down, all.key(64).down]).toEqual([true, true]);
  });
});

describe("the sustain pedal: ORDER decides, and depth damps", () => {
  it("pedal down, THEN key up: the note keeps sounding, undamped, until the pedal comes up", () => {
    const k = keyboard();
    k.play(on(60), sustain(127), off(60));
    expect([k.key(60).down, k.key(60).sustained, isSounding(k.key(60))]).toEqual([false, true, true]);
    k.wait(1);
    // A pedal on the floor: the string's own decay and nothing else.
    expect(k.key(60).level).toBeCloseTo(V * string(1), 12);
    k.play(sustain(0));
    expect([k.key(60).sustained, isSounding(k.key(60))]).toEqual([false, false]);
    k.wait(0.1);
    expect(k.key(60).level).toBeCloseTo(V * string(1) * damped(0.1), 12);
  });

  it("key up, THEN pedal down: the note was already released, and the pedal catches nothing", () => {
    const k = keyboard();
    k.play(on(60), off(60), sustain(127));
    expect([k.key(60).sustained, isSounding(k.key(60))]).toEqual([false, false]);
    k.wait(0.1);
    expect(k.key(60).level).toBeCloseTo(V * damped(0.1), 12);
  });

  it("the two orders differ inside ONE batch of messages — which is why notes cross the seam as an ordered list", () => {
    const caught = keyboard();
    caught.play(on(60), sustain(127), off(60));
    const missed = keyboard();
    missed.play(on(60), off(60), sustain(127));
    expect([isSounding(caught.key(60)), isSounding(missed.key(60))]).toEqual([true, false]);
  });

  it("HALF PEDAL: a pedal part way down holds the note and damps it by its distance from the floor", () => {
    const k = keyboard();
    // 89 / 127 = 0.70: above the threshold, so the note is caught; the dampers take the other 30 %.
    k.play(on(60), sustain(89), off(60));
    expect(k.key(60).sustained).toBe(true);
    expect(dampingOf(k.key(60), k.state, SETTINGS)).toBeCloseTo(1 - 89 / 127, 12);
    k.wait(0.2);
    expect(k.key(60).level).toBeCloseTo(V * damped(0.2, 1 - 89 / 127), 12);
    // Easing the pedal up, still above the threshold, damps more without letting go.
    k.play(sustain(70));
    expect(k.key(60).sustained).toBe(true);
    expect(dampingOf(k.key(60), k.state, SETTINGS)).toBeCloseTo(1 - 70 / 127, 12);
    // Below the threshold lets go.
    k.play(sustain(60));
    expect([k.key(60).sustained, dampingOf(k.key(60), k.state, SETTINGS)]).toEqual([false, 1]);
  });

  it("a pedal BELOW the threshold catches nothing, and the threshold is a parameter", () => {
    const k = keyboard();
    k.play(on(60), sustain(40), off(60));
    expect(k.key(60).sustained).toBe(false);
    const early = keyboard({ ...SETTINGS, pedalThreshold: 0.25 });
    early.play(on(60), sustain(40), off(60));
    expect(early.key(60).sustained).toBe(true);
  });

  it("Half Pedal off: a pedal at or above the threshold holds FULLY, as a switch pedal means it", () => {
    const settings = { ...SETTINGS, halfPedal: false };
    const k = keyboard(settings);
    k.play(on(60), sustain(89), off(60));
    expect(dampingOf(k.key(60), k.state, settings)).toBe(0);
    k.wait(0.2);
    expect(k.key(60).level).toBeCloseTo(V * string(0.2), 12);
  });

  it("a switch pedal (0 or 127) is unaffected by Half Pedal: fully down damps nothing", () => {
    const k = keyboard();
    k.play(on(60), sustain(127), off(60));
    expect(dampingOf(k.key(60), k.state, SETTINGS)).toBe(0);
  });

  it("RE-STRIKE UNDER THE PEDAL: the same pitch retriggers its own voice — one slot, a new id, the new velocity", () => {
    const k = keyboard();
    k.play(on(60, 100), sustain(127), off(60));
    k.wait(0.5);
    const slot = k.state.slotOf[60];
    k.play(on(60, 50));
    expect(k.state.slotOf[60]).toBe(slot);
    expect(k.state.slots.filter((pitch) => pitch >= 0)).toEqual([60]);
    expect([k.key(60).level, k.key(60).id, k.key(60).down, k.key(60).sustained, k.key(60).strikes]).toEqual([50 / 127, 2, true, false, 2]);
    // And released again under the same pedal it is caught again.
    k.play(off(60));
    expect(k.key(60).sustained).toBe(true);
  });
});

describe("the sostenuto pedal: only the keys down when it engaged", () => {
  it("catches the held key and not the one struck after; a caught key is not damped; lifting it lets go", () => {
    const k = keyboard();
    k.play(on(48), sostenuto(127), on(60), off(48), off(60));
    expect([k.key(48).sostenuto, isSounding(k.key(48))]).toEqual([true, true]);
    expect([k.key(60).sostenuto, isSounding(k.key(60))]).toEqual([false, false]);
    expect(dampingOf(k.key(48), k.state, SETTINGS)).toBe(0);
    k.wait(0.3);
    expect(k.key(48).level).toBeCloseTo(V * string(0.3), 12);
    expect(k.key(60).level).toBeCloseTo(V * damped(0.3), 12);
    k.play(sostenuto(0));
    expect([k.key(48).sostenuto, isSounding(k.key(48)), dampingOf(k.key(48), k.state, SETTINGS)]).toEqual([false, false, 1]);
  });

  it("a key released BEFORE it engaged is not caught", () => {
    const k = keyboard();
    k.play(on(48), off(48), sostenuto(127));
    expect(k.key(48).sostenuto).toBe(false);
  });

  it("a caught key struck again stays caught, and lifting sustain does not release it", () => {
    const k = keyboard();
    k.play(on(48), sostenuto(127), sustain(127), off(48), on(48, 60), off(48), sustain(0));
    expect([k.key(48).sostenuto, k.key(48).sustained, isSounding(k.key(48))]).toEqual([true, false, true]);
  });
});

describe("voices: slot-stable, and a stated steal order", () => {
  const slotsOf = (state: KeyboardState): number[] => [...state.slots];

  it("notes take the lowest empty slot and keep it while they sound", () => {
    const k = keyboard();
    k.play(on(60), on(64), on(67));
    expect(slotsOf(k.state)).toEqual([60, 64, 67, -1]);
    k.play(off(64));
    k.wait(3);
    expect(slotsOf(k.state)).toEqual([60, -1, 67, -1]);
    k.play(on(72));
    expect(slotsOf(k.state)).toEqual([60, 72, 67, -1]);
  });

  it("STEAL ORDER: the quietest PEDALLED voice goes before any HELD key; among held keys the quietest, and of equals the oldest", () => {
    const k = keyboard({ ...SETTINGS, voices: 3 });
    // Slot 0: 60 held, struck softly. Slots 1 and 2: pedalled, louder than the held key.
    k.play(on(60, 20), sustain(127), on(64, 90), on(67, 70), off(64), off(67));
    expect(slotsOf(k.state)).toEqual([60, 64, 67]);
    // A fourth note: the held key is the quietest of all, and is NOT taken. The quieter pedalled one is.
    k.play(on(72, 100));
    expect(slotsOf(k.state)).toEqual([60, 64, 72]);
    expect(k.state.slotOf[67]).toBe(-1);
    // The key that lost its voice still sounds in the model.
    expect([isSounding(k.key(67)), k.key(67).level]).toEqual([true, 70 / 127]);
    // A fifth: the remaining pedalled voice goes, still before either held key.
    k.play(on(74, 100));
    expect(slotsOf(k.state)).toEqual([60, 74, 72]);
    // A sixth: only held keys are left. 60 is the quietest of them.
    k.play(on(76, 100));
    expect(slotsOf(k.state)).toEqual([76, 74, 72]);
    // A seventh: three held keys at the same level; the oldest strike (72) goes.
    k.play(on(77, 100));
    expect(slotsOf(k.state)).toEqual([76, 74, 77]);
  });

  it("a ringing-out voice is taken before a pedalled one, even when the pedalled one is quieter", () => {
    const k = keyboard({ ...SETTINGS, voices: 2 });
    k.play(sustain(127), on(60, 10), off(60));
    k.play(sustain(0), sustain(127));
    // 60 was let go by the pedal lift and is ringing out. 64 is then struck loud and pedalled.
    k.play(on(64, 5), off(64));
    expect(slotsOf(k.state)).toEqual([60, 64]);
    k.play(on(67, 100));
    // 64 (pedalled, level 5/127) is quieter than 60 (ringing out, level 10/127). 60 goes all the same.
    expect(slotsOf(k.state)).toEqual([67, 64]);
  });

  it("shrinking Voices drops the highest slots; the keys go on sounding", () => {
    const k = keyboard();
    k.play(on(60), on(64), on(67));
    beginKeyboardFrame(k.state, { ...SETTINGS, voices: 2 });
    expect(slotsOf(k.state)).toEqual([60, 64]);
    expect([k.state.slotOf[67], k.key(67).down]).toEqual([-1, true]);
  });
});

describe("the other messages", () => {
  it("aftertouch per key and per channel, the bend wheel, the soft pedal", () => {
    const k = keyboard();
    k.play(on(60), { kind: 0xa0, channel: 1, data1: 60, data2: 127 }, { kind: 0xd0, channel: 1, data1: 64, data2: 0 }, cc(67, 127));
    expect([k.key(60).pressure, k.state.pressure, k.state.soft]).toEqual([1, 64 / 127, 1]);
    // Centre is 8192: LSB 0, MSB 64. Full up is 16383.
    k.play({ kind: 0xe0, channel: 1, data1: 0, data2: 64 });
    expect(k.state.bend).toBe(0);
    k.play({ kind: 0xe0, channel: 1, data1: 127, data2: 127 });
    expect(k.state.bend).toBe(16383 / 8192 - 1);
    k.play({ kind: 0xe0, channel: 1, data1: 0, data2: 0 });
    expect(k.state.bend).toBe(-1);
  });

  it("All Notes Off lets go of every key and pedal hold; All Sound Off also silences them", () => {
    const k = keyboard();
    k.play(on(60), sustain(127), on(64), off(64), cc(123, 0));
    expect([k.key(60).down, k.key(64).sustained, k.key(60).level]).toEqual([false, false, V]);
    k.play(on(60), cc(120, 0));
    expect(k.key(60).level).toBe(0);
  });

  it("a level under the floor is silence", () => {
    const k = keyboard();
    k.play(on(60, 1), off(60));
    k.wait(0.7);
    expect((1 / 127) * damped(0.7)).toBeLessThan(LEVEL_FLOOR);
    expect(k.key(60).level).toBe(0);
  });
});

describe("pitch classes and the chord come from every SOUNDING key", () => {
  const read = (state: KeyboardState) => {
    const energies = new Float64Array(12);
    const profile = new Float64Array(12);
    const lowest = keyboardChroma(state, energies);
    return { lowest, triad: keyboardTriad(energies, lowest, profile), profile: [...profile] };
  };

  it("C, E and G held: three classes at 1, C major at full confidence", () => {
    const k = keyboard();
    k.play(on(48), on(64), on(67));
    const { profile, triad, lowest } = read(k.state);
    expect(profile).toEqual([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
    expect(triad).toEqual({ root: 0, quality: 1, confidence: 1 });
    expect(lowest).toBe(48);
  });

  it("an arpeggio under the pedal is still the chord: no key is held, all three sound", () => {
    const k = keyboard();
    k.play(sustain(127), on(57), off(57), on(60), off(60), on(64), off(64));
    expect(k.state.keys.filter((key) => key.down)).toHaveLength(0);
    expect(read(k.state).triad).toEqual({ root: 9, quality: 2, confidence: 1 });
  });

  it("a key that lost its voice still counts; the class is the amplitude ratio against the strongest", () => {
    const k = keyboard({ ...SETTINGS, voices: 1 });
    k.play(on(60, 127), on(67, 64));
    expect(k.state.slotOf[60]).toBe(-1);
    const { profile } = read(k.state);
    expect(profile[0]).toBe(1);
    expect(profile[7]).toBeCloseTo(64 / 127, 12);
  });

  it("two notes an octave apart are one class, their energies summed", () => {
    const k = keyboard();
    k.play(on(48, 127), on(60, 127), on(55, 127));
    // C twice (energy 2) against G once (energy 1): G reads √(1/2).
    expect(read(k.state).profile[7]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("nothing sounding: no classes, no chord, no lowest note", () => {
    expect(read(keyboard().state)).toEqual({ lowest: -1, triad: { root: 0, quality: 0, confidence: 0 }, profile: new Array(12).fill(0) });
  });
});
