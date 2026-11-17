import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harmonyNotesBetween, type HarmonyConfig, type HarmonyNote } from "../domain/music/harmony.ts";
import { loadHarmonyPiano } from "./harmony-piano.ts";
import { createHarmonyAudio } from "./harmony-audio.ts";

vi.mock("../domain/music/harmony.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../domain/music/harmony.ts")>(),
  harmonyNotesBetween: vi.fn(),
}));

vi.mock("./harmony-piano.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./harmony-piano.ts")>(), loadHarmonyPiano: vi.fn(),
}));

class Param {
  value = 0;
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}
class Node {
  connect = vi.fn();
  disconnect = vi.fn();
}
class Oscillator extends Node {
  buffer = null;
  playbackRate = new Param();
  type = "sine";
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}
function fakeContext() {
  const oscillators: Oscillator[] = [];
  const gains: (Node & { gain: Param })[] = [];
  const buffers: Float32Array[][] = [];
  const context = {
    currentTime: 0,
    sampleRate: 8000,
    state: "running",
    destination: new Node(),
    createGain() { const node = Object.assign(new Node(), { gain: new Param() }); gains.push(node); return node; },
    createBufferSource() { const node = new Oscillator(); oscillators.push(node); return node; },
    createWaveShaper: () => Object.assign(new Node(), { curve: null, oversample: "none" }),
    createStereoPanner: () => Object.assign(new Node(), { pan: new Param() }),
    createConvolver: () => Object.assign(new Node(), { buffer: null }),
    createBuffer(channels: number, length: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      buffers.push(data);
      return { getChannelData: (channel: number) => data[channel]! };
    },
  };
  return { context, oscillators, gains, buffers, audio: context as unknown as AudioContext };
}
const recording = { duration: 20 } as AudioBuffer;
const bank = { samples: [
  { root: 69, layer: 3 as const, fundamental: 440, buffer: recording },
  { root: 69, layer: 6 as const, fundamental: 440, buffer: recording },
] };
const config: HarmonyConfig = { seed: 1, tempo: 120, initialKey: 0, initialMode: "major", harmonicComplexity: 0.5, evolutionRate: 0.5, musicalEnergy: 0.5 };
const note = (startTime: number, id = startTime): HarmonyNote => ({ id, pitch: 69, velocity: 0.5, startTime, duration: 0.4 });
function notes(events: HarmonyNote[]) {
  vi.mocked(harmonyNotesBetween).mockImplementation((from, to) => events.filter(event => event.startTime >= from && event.startTime < to));
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(harmonyNotesBetween).mockReset(); notes([]); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("harmony audio", () => {
  it("holds its requested start during sample loading and reports an explicit load failure", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(loadHarmonyPiano).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const fake = fakeContext();const synth = createHarmonyAudio(fake.audio);
    synth.update(5, config, true, 1);
    fake.context.currentTime = 10;vi.advanceTimersByTime(25);
    expect(synth.timeSeconds()).toBe(5);
    expect(synth.readiness().kind).toBe("loading");
    expect(fake.oscillators).toHaveLength(0);
    reject(new Error("missing recording"));await Promise.resolve();
    expect(synth.readiness()).toEqual({ kind: "error", message: expect.stringContaining("missing recording") });
    synth.dispose();
  });

  it("schedules on the audio clock without render updates and never duplicates an onset", () => {
    const fake = fakeContext();
    notes([note(0), note(0.2), note(0.3)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 0.5);
    expect(fake.oscillators).toHaveLength(2);
    fake.context.currentTime = 0.1;
    vi.advanceTimersByTime(25);
    synth.update(0.1, { ...config }, true, 0.5);
    expect(fake.oscillators).toHaveLength(6);
    expect(synth.timeSeconds()).toBeCloseTo(0.1);
    expect(fake.oscillators[2]!.start).toHaveBeenCalledWith(0.2, 0);
    fake.context.currentTime = 0.15;
    synth.update(0.1, config, true, 0.5);
    expect(synth.timeSeconds()).toBeCloseTo(0.15);
    expect(fake.oscillators).toHaveLength(6);
    synth.dispose();
  });

  it("retains the requested first onset when the audio clock advances during setup", () => {
    const fake = fakeContext();
    let clock = 0;
    Object.defineProperty(fake.context, "currentTime", { get: () => (clock += 0.00001) });
    notes([note(0)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 1);
    expect(fake.oscillators).toHaveLength(2);
    synth.dispose();
  });

  it("plays tuned stereo recordings and crossfades the two velocity layers", () => {
    const fake = fakeContext(); notes([note(0)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 1);
    expect(fake.oscillators).toHaveLength(2);
    expect(fake.oscillators.every(source => source.buffer === recording)).toBe(true);
    expect(fake.oscillators[0]!.playbackRate.value).toBe(1);
    expect(fake.gains[2]!.gain.linearRampToValueAtTime).toHaveBeenCalledOnce();
    synth.dispose();
  });

  it("reconstructs ringing voices when playback starts between note onsets", () => {
    const fake = fakeContext();
    notes([{ ...note(0), duration: 9 }]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(2, config, true, 1);
    expect(fake.oscillators).toHaveLength(2);
    expect(fake.oscillators[0]!.start).toHaveBeenCalledWith(0, 2);
    expect(fake.oscillators[0]!.stop).toHaveBeenCalledWith(7);
    synth.dispose();
  });

  it("skips missed onsets after timer stalls instead of playing a late burst", () => {
    const fake = fakeContext();
    notes([note(0), note(0.4), note(0.8), note(2.1)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 1);
    fake.context.currentTime = 2;
    vi.advanceTimersByTime(25);
    expect(fake.oscillators).toHaveLength(4);
    expect(fake.oscillators[2]!.start).toHaveBeenCalledWith(2.1, 0);
    expect(vi.mocked(harmonyNotesBetween).mock.calls.at(-1)!.slice(0, 2)).toEqual([2, 2.2]);
    synth.update(0.016, config, true, 1);
    expect(synth.timeSeconds()).toBe(2);
    expect(fake.oscillators).toHaveLength(4);
    synth.dispose();
  });

  it("cancels voices on pause, seek, configuration change and mute; disposal is idempotent", () => {
    const fake = fakeContext();
    notes([note(0), note(10), note(20)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 1);
    synth.update(10, config, true, 1);
    expect(fake.oscillators[0]!.disconnect).toHaveBeenCalledOnce();
    expect(fake.oscillators[2]!.start).toHaveBeenCalledWith(0, 0);
    synth.update(10, { ...config, seed: 2 }, true, 1);
    expect(fake.oscillators[2]!.disconnect).toHaveBeenCalledOnce();
    synth.update(10, config, false, 1);
    expect(synth.timeSeconds()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    synth.update(20, config, true, 1);
    synth.update(20, config, true, 0);
    expect(vi.getTimerCount()).toBe(0);
    synth.update(20, config, true, 1);
    synth.dispose();
    synth.dispose();
    synth.update(0, config, true, 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(synth.timeSeconds()).toBeUndefined();
    expect(fake.oscillators.every(oscillator => oscillator.disconnect.mock.calls.length === 1)).toBe(true);
    expect(fake.gains[0]!.gain.value).toBe(0);
  });

  it("holds a suspended context silent and anchors the frozen time on resume", () => {
    const fake = fakeContext();
    fake.context.state = "suspended";
    notes([note(5), note(5.2)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(5, config, true, 1);
    vi.advanceTimersByTime(1000);
    for (let frame = 1; frame <= 60; frame++) synth.update(5 + frame / 60, config, true, 1);
    expect(synth.timeSeconds()).toBe(5);
    expect(fake.oscillators).toHaveLength(0);
    fake.context.state = "running";
    fake.context.currentTime = 2;
    vi.advanceTimersByTime(25);
    expect(fake.oscillators[0]!.start).toHaveBeenCalledWith(2, 0);
    expect(synth.timeSeconds()).toBe(5);
    fake.context.currentTime = 2.1;
    fake.context.state = "suspended";
    vi.advanceTimersByTime(25);
    expect(synth.timeSeconds()).toBeCloseTo(5.1);
    expect(fake.gains[0]!.gain.value).toBe(0);
    fake.context.currentTime = 10;
    fake.context.state = "running";
    vi.advanceTimersByTime(25);
    expect(synth.timeSeconds()).toBeCloseTo(5.1);
    synth.dispose();
  });

  it("bounds simultaneous voices and releases all nodes on natural completion", () => {
    const fake = fakeContext();
    notes(Array.from({ length: 100 }, (_, id) => note(0, id)));
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 1);
    expect(fake.oscillators.filter(oscillator => !oscillator.disconnect.mock.calls.length)).toHaveLength(64 * 2);
    fake.context.currentTime = 2;
    vi.advanceTimersByTime(25);
    expect(fake.oscillators.every(oscillator => oscillator.disconnect.mock.calls.length === 1)).toBe(true);
    synth.dispose();
  });

  it("reclaims a voice from its ended event without waiting for the scheduler", () => {
    const fake = fakeContext();
    notes([note(0)]);
    const synth = createHarmonyAudio(fake.audio, bank);
    synth.update(0, config, true, 1);
    fake.oscillators[0]!.onended!();
    expect(fake.oscillators.every(oscillator => oscillator.disconnect.mock.calls.length === 1)).toBe(true);
    synth.dispose();
  });

  it("creates deterministic stereo reverb and reports unsupported capabilities", () => {
    const a = fakeContext();
    const b = fakeContext();
    const first = createHarmonyAudio(a.audio, bank);
    const second = createHarmonyAudio(b.audio, bank);
    expect(a.buffers[0]).toEqual(b.buffers[0]);
    expect(a.buffers[0]![0]).not.toEqual(a.buffers[0]![1]);
    expect(() => createHarmonyAudio({ createGain() {} } as unknown as AudioContext)).toThrow("createBufferSource");
    first.dispose(); second.dispose();
  });
});
