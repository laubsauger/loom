import { describe, expect, it } from "vitest";

import { createMidiClockFollower, MIDI_CLOCK, MIDI_CONTINUE, MIDI_START, MIDI_STOP, type MidiClockFollower } from "./midi-clock.ts";

/**
 * T1786b — MIDI clock in, from a synthetic stream of realtime bytes at known timestamps.
 * What is asserted is the reading a project tempo takes from the follower: the tempo, the
 * position in beats, whether it is locked. (`project-tempo.test.ts` asserts the same
 * stream as an expression reads it, through the transport.)
 */
const pulseSeconds = (bpm: number): number => 60 / (bpm * 24);

/** Sends `count` 0xF8 at `bpm` starting one interval after `from`; returns the last one's time. */
function send(follower: MidiClockFollower, from: number, bpm: number, count: number, jitter: (index: number) => number = () => 0): number {
  let time = from;
  for (let index = 0; index < count; index += 1) {
    time += pulseSeconds(bpm);
    follower.message(MIDI_CLOCK, time + jitter(index));
  }
  return time;
}

describe("tempo from 0xF8 pulses (T1786b)", () => {
  it("24 pulses a quarter note: pulses 1/48 s apart are 120 bpm", () => {
    const follower = createMidiClockFollower();
    const last = send(follower, 10, 120, 49);
    const reading = follower.reading(last);
    expect(reading.locked).toBe(true);
    expect(reading.bpm).toBeCloseTo(120, 9);
  });

  it("locks within a quarter of a beat, and not on fewer pulses than make a measurement", () => {
    const follower = createMidiClockFollower();
    let last = send(follower, 10, 140, 6);
    // Six pulses are five intervals: not yet.
    expect(follower.reading(last)).toMatchObject({ locked: false, bpm: null });
    last = send(follower, last, 140, 1);
    expect(follower.reading(last).bpm).toBeCloseTo(140, 9);
  });

  it("holds still against a millisecond of jitter: within a third of a beat a minute of the master", () => {
    const follower = createMidiClockFollower();
    // Deterministic +-1 ms scatter on every pulse of a 128 bpm clock.
    const jitter = (index: number): number => (((index * 7919) % 21) - 10) / 10000;
    let last = 10;
    const seen: number[] = [];
    for (let beat = 0; beat < 16; beat += 1) {
      last = send(follower, last, 128, 24, (index) => jitter(beat * 24 + index));
      const bpm = follower.reading(last + 0.001).bpm;
      if (bpm !== null) seen.push(bpm);
    }
    expect(seen.length).toBe(16);
    for (const bpm of seen.slice(2)) expect(Math.abs(bpm - 128)).toBeLessThan(0.35);
  });

  it("follows a tempo change on the master within a third of a beat, not averaged in over two", () => {
    const follower = createMidiClockFollower();
    let last = send(follower, 10, 120, 49);
    last = send(follower, last, 150, 7);
    expect(follower.reading(last).bpm).toBeCloseTo(150, 0);
    last = send(follower, last, 150, 12);
    expect(follower.reading(last).bpm).toBeCloseTo(150, 6);
  });

  it("no pulse for more than half a second: unlocked, no tempo, and a new stream measures afresh", () => {
    const follower = createMidiClockFollower();
    const last = send(follower, 10, 120, 49);
    expect(follower.reading(last + 0.4).locked).toBe(true);
    expect(follower.reading(last + 0.6)).toMatchObject({ locked: false, bpm: null });
    // The master comes back at another tempo: the old window is not averaged into it.
    const again = send(follower, last + 5, 90, 7);
    expect(follower.reading(again).bpm).toBeCloseTo(90, 9);
  });
});

describe("position from start, stop, continue and the pulse count (T1786b)", () => {
  it("start puts the NEXT pulse on beat zero; 24 pulses later is beat one", () => {
    const follower = createMidiClockFollower();
    send(follower, 10, 120, 30);
    follower.message(MIDI_START, 11);
    let last = send(follower, 11, 120, 1);
    expect(follower.reading(last).beats).toBe(0);
    last = send(follower, last, 120, 24);
    expect(follower.reading(last).beats).toBe(1);
    last = send(follower, last, 120, 36);
    expect(follower.reading(last).beats).toBe(2.5);
  });

  it("between pulses the position carries on at the measured tempo, never past the next pulse", () => {
    const follower = createMidiClockFollower();
    follower.message(MIDI_START, 10);
    const last = send(follower, 10, 120, 25);
    const half = pulseSeconds(120) / 2;
    expect(follower.reading(last + half).beats).toBeCloseTo(1 + 1 / 48, 9);
    // A late pulse does not let the position run ahead of the count.
    expect(follower.reading(last + 0.2).beats).toBeCloseTo(1 + 1 / 24, 9);
  });

  it("stop holds the position while the master keeps sending clock; continue carries on from it", () => {
    const follower = createMidiClockFollower();
    follower.message(MIDI_START, 10);
    let last = send(follower, 10, 120, 25);
    follower.message(MIDI_STOP, last);
    last = send(follower, last, 120, 48);
    const stopped = follower.reading(last);
    expect(stopped).toMatchObject({ beats: 1, running: false, locked: true });
    expect(stopped.bpm).toBeCloseTo(120, 9);
    follower.message(MIDI_CONTINUE, last);
    last = send(follower, last, 120, 12);
    expect(follower.reading(last)).toMatchObject({ beats: 1.5, running: true });
  });

  it("a stream joined with no start counts from its first pulse", () => {
    const follower = createMidiClockFollower();
    const last = send(follower, 10, 120, 25);
    expect(follower.reading(last).beats).toBe(1);
  });

  it("rezero puts beat zero at now and keeps the tempo", () => {
    const follower = createMidiClockFollower();
    const last = send(follower, 10, 120, 40);
    follower.rezero(last + pulseSeconds(120) / 2);
    expect(follower.reading(last + pulseSeconds(120) / 2).beats).toBeCloseTo(0, 9);
    const later = send(follower, last, 120, 24);
    expect(follower.reading(later).beats).toBeCloseTo(1 - 1 / 48, 9);
    expect(follower.reading(later).bpm).toBeCloseTo(120, 9);
  });
});
