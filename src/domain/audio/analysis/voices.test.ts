import { describe, expect, it } from "vitest";

import { TONAL_ANALYSIS } from "../tonal-fields.ts";
import { createPeakWorkspace, hannWindow, spectralPeaks, type SpectralPeaks } from "./chroma.ts";
import { createVoiceTracker, pickNotes, VOICE_BIRTH_FRAMES, VOICE_DEATH_FRAMES, type VoiceState } from "./voices.ts";

/**
 * T1756b — voices, on notes synthesised with partials and put through the real peak finder.
 * The claims are about WHICH notes are found and that a voice keeps its slot; pitches are
 * asserted to the nearest note and to a few cents.
 */
const SAMPLE_RATE = 48_000;
const SIZE = TONAL_ANALYSIS.windowSize;
const STEP = TONAL_ANALYSIS.hop / SAMPLE_RATE;
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const amplitudeOf = (energy: number): number => (Math.sqrt(energy) * 4) / SIZE;
const window = hannWindow(SIZE);

/** `[midi, amplitude]` notes with six partials at 1/h. */
function peaksOf(...notes: ReadonlyArray<readonly [number, number]>): SpectralPeaks {
  const samples = new Float64Array(SIZE);
  for (const [midi, amplitude] of notes) {
    for (let h = 1; h <= 6; h += 1) {
      for (let i = 0; i < SIZE; i += 1) samples[i] = (samples[i] as number) + (amplitude / h) * Math.sin((2 * Math.PI * hz(midi) * h * i) / SAMPLE_RATE + midi * h);
    }
  }
  const workspace = createPeakWorkspace(SIZE);
  const peaks = spectralPeaks(samples, window, { sampleRate: SAMPLE_RATE, lowHz: TONAL_ANALYSIS.lowHz, highHz: TONAL_ANALYSIS.highHz, floorDecibels: TONAL_ANALYSIS.floorDecibels, floorAmplitude: TONAL_ANALYSIS.floorAmplitude }, workspace);
  return { frequency: peaks.frequency.slice(0, peaks.count), energy: peaks.energy.slice(0, peaks.count), count: peaks.count };
}
const nearest = (notes: ReadonlyArray<{ pitch: number }>): number[] => notes.map((note) => Math.round(note.pitch)).sort((a, b) => a - b);
const alive = (voices: readonly VoiceState[]): VoiceState[] => voices.filter((voice) => voice.confidence > 0);

describe("pickNotes — which notes a frame holds", () => {
  it("one note with six partials is ONE note, within three cents: its partials are not five more", () => {
    const picked = pickNotes(peaksOf([57, 0.2]), amplitudeOf, 7);
    expect(picked).toHaveLength(1);
    expect(Math.abs(picked[0]!.pitch - 57) * 100).toBeLessThan(3);
    expect(picked[0]!.partials).toBe(5);
  });

  it("a triad is its three notes and nothing else — no octave, no twelfth", () => {
    for (const chord of [[48, 52, 55], [60, 64, 67], [57, 60, 64]]) {
      expect(nearest(pickNotes(peaksOf(...chord.map((midi) => [midi, 0.15] as const)), amplitudeOf, 7))).toEqual(chord);
    }
  });

  it("a real note an octave above another is kept: it is louder than a second partial would be", () => {
    expect(nearest(pickNotes(peaksOf([48, 0.15], [60, 0.15]), amplitudeOf, 7))).toEqual([48, 60]);
    // And a tenth: two notes, no ghost between or below them.
    expect(nearest(pickNotes(peaksOf([48, 0.15], [64, 0.15]), amplitudeOf, 7))).toEqual([48, 64]);
  });

  it("the loudest comes first, and a note 30 dB under it is not picked at all", () => {
    const picked = pickNotes(peaksOf([60, 0.05], [67, 0.2]), amplitudeOf, 7);
    expect(picked.map((note) => Math.round(note.pitch))).toEqual([67, 60]);
    expect(nearest(pickNotes(peaksOf([60, 0.2], [67, 0.006]), amplitudeOf, 7))).toEqual([60]);
  });

  it("no peaks, no notes", () => {
    expect(pickNotes({ frequency: new Float64Array(0), energy: new Float64Array(0), count: 0 }, amplitudeOf, 7)).toEqual([]);
  });
});

describe("createVoiceTracker — a voice keeps its slot", () => {
  const run = (frames: ReadonlyArray<SpectralPeaks>): Array<readonly VoiceState[]> => {
    const tracker = createVoiceTracker();
    return frames.map((peaks) => tracker.push(peaks, amplitudeOf, 1, STEP));
  };
  const repeat = (peaks: SpectralPeaks, count: number): SpectralPeaks[] => Array.from({ length: count }, () => peaks);
  const silence: SpectralPeaks = { frequency: new Float64Array(0), energy: new Float64Array(0), count: 0 };

  it("a note is born on its second frame — one frame of anything is not a note — with an onset, an id and an age that then counts", () => {
    const frames = run(repeat(peaksOf([60, 0.2]), 4));
    expect(alive(frames[0]!)).toEqual([]);
    const born = frames[VOICE_BIRTH_FRAMES - 1]![0]!;
    expect([Math.round(born.pitch), born.onset, born.id, born.age, born.confidence]).toEqual([60, true, 1, 0, 1]);
    const next = frames[VOICE_BIRTH_FRAMES]![0]!;
    expect([next.onset, next.id, next.age]).toEqual([false, 1, STEP]);
    // 0.2 + 0.2/2 + … of its six partials' shares, on the decibel scale.
    expect(born.level).toBeGreaterThan(0.75);
    expect(born.level).toBeLessThan(0.95);
  });

  it("THE FLICKER PROPERTY: a held note keeps slot 0 and its id while three other notes come and go above it", () => {
    const held = [48, 0.2] as const;
    const frames = run([
      ...repeat(peaksOf(held), 4),
      ...repeat(peaksOf(held, [64, 0.15]), 6),
      ...repeat(peaksOf(held, [67, 0.15]), 6),
      ...repeat(peaksOf(held, [72, 0.15]), 6),
    ]);
    for (const voices of frames.slice(1)) expect([Math.round(voices[0]!.pitch), voices[0]!.id]).toEqual([48, 1]);
    // The arpeggio is three notes with three onsets, in whichever upper slot is empty when
    // each is born (the one before it is still coasting out) — never in slot 0.
    const upper = frames.flatMap((voices) => voices.slice(1).filter((voice) => voice.confidence > 0 && voice.onset));
    expect(upper.map((voice) => Math.round(voice.pitch))).toEqual([64, 67, 72]);
    expect(new Set(frames.flatMap((voices) => alive(voices).map((voice) => voice.id))).size).toBe(4);
  });

  it("a voice ends three frames after its note does, fading as it coasts, and the slot REMEMBERS the pitch", () => {
    const frames = run([...repeat(peaksOf([60, 0.2]), 4), ...repeat(silence, 5)]);
    const after = frames.slice(4).map((voices) => voices[0]!);
    expect(after.slice(0, VOICE_DEATH_FRAMES - 1).every((voice) => voice.confidence > 0)).toBe(true);
    expect(after[0]!.confidence).toBeGreaterThan(after[1]!.confidence);
    const gone = after[VOICE_DEATH_FRAMES]!;
    expect([gone.confidence, gone.level, gone.age, Math.round(gone.pitch), gone.id]).toEqual([0, 0, 0, 60, 1]);
  });

  it("the same key struck again is an onset in the SAME slot with a new id: the level came up by 6 dB", () => {
    const frames = run([...repeat(peaksOf([60, 0.2]), 3), ...repeat(peaksOf([60, 0.04]), 3), ...repeat(peaksOf([60, 0.2]), 3)]);
    const onsets = frames.flatMap((voices, index) => (voices[0]!.onset ? [[index, voices[0]!.id]] : []));
    expect(onsets).toEqual([[1, 1], [6, 2]]);
    // Getting quieter is not an onset, and neither is staying loud.
    expect(frames.slice(2, 6).some((voices) => voices[0]!.onset)).toBe(false);
  });

  it("a note drifting a third of a semitone (vibrato, a bend) is the same voice", () => {
    const frames = run(Array.from({ length: 12 }, (_, index) => peaksOf([60 + 0.3 * Math.sin(index / 2), 0.2])));
    expect(new Set(frames.slice(1).map((voices) => voices[0]!.id))).toEqual(new Set([1]));
    expect(frames.slice(2).some((voices) => voices[0]!.onset)).toBe(false);
  });

  it("five slots: a sixth note waits, and takes the slot of the first voice to end", () => {
    // Five notes none of which is a partial of another (an octave above a sounding note is the
    // one the salience share drops first in a chord this dense).
    const five = [48, 52, 55, 59, 62].map((midi) => [midi, 0.15] as const);
    const frames = run([...repeat(peaksOf(...five), 3), ...repeat(peaksOf(...five, [65, 0.15]), 3), ...repeat(peaksOf(...five.slice(1), [65, 0.15]), 6)]);
    expect(nearest(alive(frames[5]!))).toEqual([48, 52, 55, 59, 62]);
    const last = frames[frames.length - 1]!;
    expect(nearest(alive(last))).toEqual([52, 55, 59, 62, 65]);
    // 48 held a slot; 65 has that slot now, and the other four never moved.
    const before = frames[5]!.map((voice) => Math.round(voice.pitch));
    const slot = before.indexOf(48);
    expect(last.map((voice) => Math.round(voice.pitch))).toEqual(before.map((pitch, index) => (index === slot ? 65 : pitch)));
  });

  it("a frame that is barely tonal still tracks, at low confidence — never at 0, which is the empty slot's value", () => {
    const tracker = createVoiceTracker();
    tracker.push(peaksOf([60, 0.2]), amplitudeOf, 0, STEP);
    const voice = tracker.push(peaksOf([60, 0.2]), amplitudeOf, 0, STEP)[0]!;
    expect(voice.confidence).toBe(0.01);
  });
});
