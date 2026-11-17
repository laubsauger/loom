import { describe, expect, it } from "vitest";

import { TONAL_ANALYSIS } from "../tonal-fields.ts";
import { createTonalAnalyser, estimateTuningOver, TUNING_SECONDS } from "./tonal-analyser.ts";

/**
 * T1751b — the analyser every path runs (worklet, offline walk), on windows whose reading
 * is known exactly: a tone on a bin, silence, seeded noise.
 */
const SIZE = TONAL_ANALYSIS.windowSize;
const HOP = TONAL_ANALYSIS.hop;

/** A rate that puts `frequency` exactly on bin 80 of the window. */
const rateFor = (frequency: number): number => (frequency * SIZE) / 80;

function tone(frequency: number, sampleRate: number, amplitude = 0.5): Float64Array {
  return Float64Array.from({ length: SIZE }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
}

/** Deterministic white noise in −1..1. */
function noise(seed: number): Float64Array {
  let state = seed >>> 0;
  return Float64Array.from({ length: SIZE }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 2 - 1;
  });
}

describe("createTonalAnalyser", () => {
  it("A4: class 9 reads exactly 1, the other eleven exactly 0, at full confidence, tuning 0, half a window late", () => {
    const sampleRate = rateFor(440);
    const frame = createTonalAnalyser({ sampleRate, windowSize: SIZE }).analyse(tone(440, sampleRate), 0);
    expect([...frame.chroma]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(frame.confidence).toBe(1);
    expect(frame.tuning).toBe(0);
    expect(frame.lag).toBe(SIZE / 2 / sampleRate);
  });

  it("the same note four times as loud reads the same: the profile carries which note, not how loud", () => {
    const sampleRate = rateFor(440);
    const quiet = createTonalAnalyser({ sampleRate, windowSize: SIZE }).analyse(tone(440, sampleRate, 0.05), 0);
    const loud = createTonalAnalyser({ sampleRate, windowSize: SIZE }).analyse(tone(440, sampleRate, 0.2), 0);
    expect([...quiet.chroma]).toEqual([...loud.chroma]);
  });

  it("silence is NO CLAIM: twelve zeros and confidence 0, and so is anything under −70 dBFS", () => {
    const analyser = createTonalAnalyser({ sampleRate: 48000, windowSize: SIZE });
    for (const samples of [new Float64Array(SIZE), tone(440, 48000, 1e-4)]) {
      const frame = analyser.analyse(samples, HOP);
      expect([...frame.chroma]).toEqual(new Array(12).fill(0));
      expect(frame.confidence).toBe(0);
    }
  });

  it("white noise is not twelve notes: its confidence stays under one half, and it never moves the tuning", () => {
    const analyser = createTonalAnalyser({ sampleRate: 48000, windowSize: SIZE });
    for (let seed = 1; seed <= 20; seed += 1) {
      const frame = analyser.analyse(noise(seed), HOP);
      expect(frame.confidence).toBeLessThan(0.5);
      expect(frame.tuning).toBe(0);
    }
  });

  it("the tuning eases toward what confident frames measure, on the circle, by the samples that passed", () => {
    // A4 35 cents sharp, on a bin: every frame's own estimate is exactly 35.
    const frequency = 440 * 2 ** (35 / 1200);
    const sampleRate = rateFor(frequency);
    const analyser = createTonalAnalyser({ sampleRate, windowSize: SIZE });
    const samples = tone(frequency, sampleRate);
    const k = 1 - Math.exp(-HOP / sampleRate / TUNING_SECONDS);
    const angle = (2 * Math.PI * 35) / 100;
    // The first window has no past (advanced 0) and teaches nothing; each later one is
    // folded against what was known, then teaches. So call m reports m − 2 lessons.
    const readings: number[] = [];
    readings.push(analyser.analyse(samples, 0).tuning);
    for (let call = 2; call <= 200; call += 1) readings.push(analyser.analyse(samples, HOP).tuning);
    const after = (lessons: number): number => {
      const kept = (1 - k) ** lessons;
      return (Math.atan2((1 - kept) * Math.sin(angle), kept + (1 - kept) * Math.cos(angle)) / (2 * Math.PI)) * 100;
    };
    expect(readings[0]).toBe(0);
    expect(readings[1]).toBe(0);
    expect(readings[2]).toBeCloseTo(after(1), 9);
    expect(readings[199]).toBeCloseTo(after(198), 9);
    // And the class never left A while it moved: 35 cents sharp of A is still A.
    expect(analyser.analyse(samples, HOP).chroma[9]).toBe(1);
  });

  it("refuses a window of the wrong size, and a size that is not a power of two", () => {
    const analyser = createTonalAnalyser({ sampleRate: 48000, windowSize: SIZE });
    expect(() => analyser.analyse(new Float64Array(SIZE / 2), HOP)).toThrow(/expected 8192 samples, got 4096/);
    expect(() => createTonalAnalyser({ sampleRate: 48000, windowSize: 6000 })).toThrow(/power of two/);
  });
});

describe("T1752b — a tuning known in advance, and one measured over a file", () => {
  // A4 35 cents sharp, at a rate that puts it exactly on a bin: every window's own estimate is exactly 35.
  const frequency = 440 * 2 ** (35 / 1200);
  const sampleRate = rateFor(frequency);

  it("a fixed tuning is applied from the first window and never learned away from", () => {
    const analyser = createTonalAnalyser({ sampleRate: rateFor(440), windowSize: SIZE, tuning: -20 });
    for (let call = 0; call < 50; call += 1) expect(analyser.analyse(tone(440, rateFor(440)), HOP).tuning).toBe(-20);
    // And it is what the classes are folded against: on a grid 60 cents sharp, 440 Hz is 40
    // cents above the grid's G sharp and no longer its A.
    const shifted = createTonalAnalyser({ sampleRate: rateFor(440), windowSize: SIZE, tuning: 60 }).analyse(tone(440, rateFor(440)), 0);
    expect([shifted.chroma[8], shifted.chroma[9]]).toEqual([1, 0]);
  });

  it("estimateTuningOver: a whole file of the sharp note reads exactly 35; silence and noise read 0", () => {
    const file = Float64Array.from({ length: SIZE * 6 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
    expect(estimateTuningOver(file, sampleRate, SIZE)).toBeCloseTo(35, 9);
    expect(estimateTuningOver(new Float64Array(SIZE * 3), 48000, SIZE)).toBe(0);
    const hiss = new Float64Array(SIZE * 4);
    for (let block = 0; block < 4; block += 1) hiss.set(noise(block + 1), block * SIZE);
    expect(estimateTuningOver(hiss, 48000, SIZE)).toBe(0);
  });

  it("noise in a file does not move the note's tuning: only confident windows count", () => {
    const file = new Float64Array(SIZE * 6);
    for (let i = 0; i < SIZE * 3; i += 1) file[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    for (let block = 3; block < 6; block += 1) file.set(noise(block), block * SIZE);
    expect(estimateTuningOver(file, sampleRate, SIZE)).toBeCloseTo(35, 9);
  });
});

