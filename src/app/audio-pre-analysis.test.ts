import { describe, expect, it, vi } from "vitest";

import { AUDIO_DETECTOR_DEFAULTS } from "@nodes/definitions/audio.ts";
import { SILENCE, createFeatureTrackRecorder, featureTrackLength } from "@domain/audio/feature-track.ts";
import type { MediaTransportValues } from "@domain/media/transport.ts";
import { analyseOffline } from "./audio-offline-analysis.ts";
import { contentHash, createPreAnalyser, mixToMono, preAnalysisKey, readTrackAtPlayhead } from "./audio-pre-analysis.ts";
import type { MonoPcm, OfflineAnalysisRequest } from "./audio-pre-analysis.ts";

/**
 * T1229 — the service around the walk: what is cached, by what, and what the outcome
 * says when the walk could not leave the main thread. The walk itself is pinned in
 * `audio-offline-analysis.test.ts`; the decode needs a browser and is not exercised here.
 */

const SAMPLE_RATE = 48_000;

function tone(seconds: number, amplitude: number): MonoPcm {
  const samples = new Float32Array(SAMPLE_RATE * seconds);
  for (let i = 0; i < samples.length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * 110 * i) / SAMPLE_RATE);
  return { samples, sampleRate: SAMPLE_RATE };
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("mixToMono — the mean of the channels, as the worklet's mono input hears them", () => {
  it("averages two channels sample by sample and keeps the buffer's rate", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0, 1]);
    const mono = mixToMono({ numberOfChannels: 2, length: 3, sampleRate: 44_100, getChannelData: (c) => (c === 0 ? left : right) });
    expect(Array.from(mono.samples)).toEqual([0.5, 0, 0]);
    expect(mono.sampleRate).toBe(44_100);
  });
});

describe("the cache is keyed by CONTENT and every input the walk reads", () => {
  it("hashes the bytes, and the key names fps and both knobs", async () => {
    const hash = await contentHash(bytesOf("abc"));
    // SHA-256("abc"), the standard test vector.
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(preAnalysisKey(hash, 60, { threshold: 0.05, retrigger: 0.032 })).toBe(`${hash}|60|0.05|0.032`);
  });

  it("walks the same bytes once, a changed knob again, and hands out one analysis for both hits", async () => {
    const run = vi.fn((request: OfflineAnalysisRequest) =>
      Promise.resolve(analyseOffline(request.samples, request.sampleRate, request.fps, request.detector)),
    );
    const analyser = createPreAnalyser({ decode: () => Promise.resolve(tone(1, 0.5)), hash: contentHash, run });

    const first = await analyser.analyse(bytesOf("same file"), 60, AUDIO_DETECTOR_DEFAULTS);
    const second = await analyser.analyse(bytesOf("same file"), 60, AUDIO_DETECTOR_DEFAULTS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.fallback).toBeNull();
    expect(featureTrackLength(first.analysis.track)).toBe(61);

    await analyser.analyse(bytesOf("same file"), 60, { ...AUDIO_DETECTOR_DEFAULTS, threshold: 0.2 });
    expect(run).toHaveBeenCalledTimes(2);
    await analyser.analyse(bytesOf("same file"), 30, AUDIO_DETECTOR_DEFAULTS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("a decode that fails is not remembered: the next bind tries again", async () => {
    let attempts = 0;
    const analyser = createPreAnalyser({
      decode: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("EncodingError: Unable to decode audio data")) : Promise.resolve(tone(1, 0.5));
      },
      hash: contentHash,
      run: (request) => Promise.resolve(analyseOffline(request.samples, request.sampleRate, request.fps, request.detector)),
    });
    await expect(analyser.analyse(bytesOf("file"), 60, AUDIO_DETECTOR_DEFAULTS)).rejects.toThrow("Unable to decode");
    const retried = await analyser.analyse(bytesOf("file"), 60, AUDIO_DETECTOR_DEFAULTS);
    expect(retried.fallback).toBeNull();
    expect(attempts).toBe(2);
  });
});

describe("§V288 — where the walk cannot leave the main thread, the outcome says so", () => {
  it("runs the same walk on the main thread and names the reason", async () => {
    const analyser = createPreAnalyser({
      decode: () => Promise.resolve(tone(1, 0.5)),
      hash: contentHash,
      run: () => Promise.reject(new Error("this environment has no Worker")),
    });
    const outcome = await analyser.analyse(bytesOf("file"), 60, AUDIO_DETECTOR_DEFAULTS);
    expect(outcome.fallback).toBe("Pre-analysis ran on the main thread: this environment has no Worker.");
    // The fallback is the SAME function: its track is the one the worker would have sent.
    const direct = analyseOffline(tone(1, 0.5).samples, SAMPLE_RATE, 60, AUDIO_DETECTOR_DEFAULTS);
    expect(outcome.analysis.track).toEqual(direct.track);
  });
});

describe("readTrackAtPlayhead — the timeline read is the transport's arithmetic, then the track (T1229)", () => {
  // A track whose frame N holds level N/1000, so a read names the frame it landed on.
  const FPS = 60;
  const DURATION = 10;
  const recorder = createFeatureTrackRecorder(FPS);
  for (let index = 0; index <= DURATION * FPS; index += 1) recorder.capture(index, { ...SILENCE, level: index / 1000 });
  const track = recorder.track();
  const timeline: MediaTransportValues = {
    playMode: "timeline",
    play: true,
    speed: 1,
    cue: false,
    cuePoint: 0,
    trimStart: 0,
    trimEnd: 0,
    extend: "hold",
  };
  const frameOf = (features: { level: number }): number => Math.round(features.level * 1000);

  it("is a pure function of the timeline second: any order, any history, the same frame", () => {
    expect(frameOf(readTrackAtPlayhead(track, timeline, 2.5, DURATION))).toBe(150);
    expect(frameOf(readTrackAtPlayhead(track, timeline, 0.25, DURATION))).toBe(15);
    expect(frameOf(readTrackAtPlayhead(track, timeline, 2.5, DURATION))).toBe(150);
    // Within a frame's 1/fps the floor holds: 2.5 + 0.9/60 is still frame 150.
    expect(frameOf(readTrackAtPlayhead(track, timeline, 2.5 + 0.9 / FPS, DURATION))).toBe(150);
  });

  it("reads frame N for timeline second N / fps, for EVERY N — one ulp under a boundary is not the frame before", () => {
    // The app hands over `frame / fps`, and `(frame / fps) * fps` lands one ulp under
    // `frame` for 22 of the first 1900 frames at 60 fps (123, 245, 246, 247, 490, …). A
    // bare floor then read the PREVIOUS record on those frames, and a count lane — 1 on
    // exactly one record — lost its event: E66's snare on 2 of bar 3 (frame 292) never
    // flashed the ring, which is how `e66-meter-claims.gpu.test.ts` found it.
    const missed: number[] = [];
    for (let frame = 0; frame <= DURATION * FPS; frame += 1) {
      if (frameOf(readTrackAtPlayhead(track, timeline, frame / FPS, DURATION)) !== frame) missed.push(frame);
    }
    expect(missed).toEqual([]);
  });

  it("trim, cue, speed and loop move the read exactly as they move the sound", () => {
    expect(frameOf(readTrackAtPlayhead(track, { ...timeline, trimStart: 4 }, 1, DURATION))).toBe(300);
    expect(frameOf(readTrackAtPlayhead(track, { ...timeline, cue: true, cuePoint: 7 }, 1, DURATION))).toBe(420);
    expect(frameOf(readTrackAtPlayhead(track, { ...timeline, speed: 2 }, 1, DURATION))).toBe(120);
    // Loop over a 2 s window from 3 s: timeline 5.5 s is 1.5 s into the second lap.
    expect(frameOf(readTrackAtPlayhead(track, { ...timeline, trimStart: 3, trimEnd: 5, extend: "loop" }, 5.5, DURATION))).toBe(270);
  });

  it("holds the file's last frame under `hold` and reads SILENCE where `black` shows nothing", () => {
    expect(frameOf(readTrackAtPlayhead(track, timeline, 12, DURATION))).toBe(DURATION * FPS);
    expect(readTrackAtPlayhead(track, { ...timeline, extend: "black" }, 12, DURATION)).toEqual(SILENCE);
    expect(readTrackAtPlayhead(track, { ...timeline, trimStart: 4, extend: "black" }, -1, DURATION)).toEqual(SILENCE);
  });
});
