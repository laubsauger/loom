import { describe, expect, it } from "vitest";
import type { HopFeatures } from "@domain/audio/analysis/hop-analyser.ts";
import { createAudioHopReducer } from "./audio-analysis-frame.ts";
import { computeAudioFeatures, ONSET_EVENT_THRESHOLD } from "./audio-features.ts";

/**
 * T1226 — the reducer against the v1 record's definitions (§V357): within one frame
 * interval, `onsetCount` is the number of rising crossings and `onsetMax` the peak.
 * The polled path could only ever answer 0/1 and "the last reading"; the numbers here
 * are the ones it structurally could not produce.
 */

const FFT_SIZE = 16;
const SAMPLE_RATE = 16 * 100; // 100 Hz per bin: bands are easy to place.
const STREAMS = 3;

function hop(overrides: Partial<HopFeatures> & { level?: number } = {}): HopFeatures {
  const { level = 0, ...rest } = overrides;
  return {
    frequency: new Uint8Array(FFT_SIZE / 2).fill(level),
    timeDomain: new Uint8Array(FFT_SIZE).fill(128),
    flux: 0,
    event: false,
    bandFlux: new Float64Array(STREAMS),
    bandEvents: new Uint8Array(STREAMS),
    ...rest,
  };
}

describe("createAudioHopReducer", () => {
  it("before any hop it reads silence: level 0, every band 0, nothing counted", () => {
    const frame = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS).read();
    expect(frame.hops).toBe(0);
    expect(frame.features).toEqual({
      level: 0,
      low: 0,
      lowMid: 0,
      highMid: 0,
      high: 0,
      onset: 0,
      onsetCount: 0,
      onsetMax: 0,
    });
  });

  it("three events on four hops in one interval count 3 — the polled path's ceiling was 1", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS);
    reducer.push(hop({ flux: 0.3, event: true }));
    reducer.push(hop({ flux: 0.01, event: false }));
    reducer.push(hop({ flux: 0.25, event: true }));
    reducer.push(hop({ flux: 0.5, event: true, level: 100 }));
    const frame = reducer.read();
    expect(frame.hops).toBe(4);
    expect(frame.features.onsetCount).toBe(3);
    // The interval's PEAK, which is not the last hop's reading and not the frame's own.
    expect(frame.features.onsetMax).toBe(0.5);
  });

  it("bands and level come from the LATEST hop through computeAudioFeatures, bit for bit", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS);
    reducer.push(hop({ level: 40 }));
    const last = hop({ level: 200 });
    (last.timeDomain as Uint8Array).fill(192);
    reducer.push(last);
    const frame = reducer.read();
    const expected = computeAudioFeatures({
      frequency: last.frequency,
      timeDomain: last.timeDomain,
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      state: { previousSpectrum: null, previousOnset: 0 },
    });
    expect(frame.features.level).toBe(expected.level);
    expect(frame.features.low).toBe(expected.low);
    expect(frame.features.high).toBe(expected.high);
    // 200 / 255 on every bin the low band covers (20..250 Hz at 100 Hz per bin: bins 1..2).
    expect(frame.features.low).toBe(200 / 255);
    expect(frame.features.level).toBe(0.5);
  });

  it("the frame-to-frame onset is v1's: flux against the PREVIOUS READ's bytes, and it feeds the max", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS);
    reducer.push(hop({ level: 0 }));
    reducer.read();
    // Every bin rises 0 → 51 between reads: onset 51 / 255 = 0.2, above every hop's flux.
    reducer.push(hop({ level: 51, flux: 0.05, event: true }));
    const frame = reducer.read();
    expect(frame.features.onset).toBe(0.2);
    expect(frame.features.onsetMax).toBe(0.2);
    expect(frame.features.onsetCount).toBe(1);
  });

  it("a rise that crosses the level only frame-to-frame still counts once (the polled path saw it)", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS);
    reducer.push(hop({ level: 0 }));
    reducer.read();
    // Four small hops, none an event on its own; the interval as a whole rose 0 → 40.
    for (let i = 1; i <= 4; i += 1) reducer.push(hop({ level: 10 * i, flux: 10 / 255 / 8, event: false }));
    const frame = reducer.read();
    expect(frame.features.onset).toBe(40 / 255);
    expect(frame.features.onset).toBeGreaterThan(ONSET_EVENT_THRESHOLD);
    expect(frame.features.onsetCount).toBe(1);
  });

  it("a read with no new hop repeats the bytes: same bands, onset 0, nothing counted", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS);
    reducer.push(hop({ level: 90, flux: 0.4, event: true }));
    const first = reducer.read();
    const again = reducer.read();
    expect(again.hops).toBe(0);
    expect(again.features.low).toBe(first.features.low);
    expect(again.features.onset).toBe(0);
    expect(again.features.onsetCount).toBe(0);
    expect(again.features.onsetMax).toBe(0);
  });

  it("per-stream SuperFlux reduces to the interval max and the event count, then clears", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE, STREAMS);
    reducer.push(hop({ bandFlux: Float64Array.from([0.1, 0.5, 0]), bandEvents: Uint8Array.from([0, 1, 0]) }));
    reducer.push(hop({ bandFlux: Float64Array.from([0.3, 0.2, 0]), bandEvents: Uint8Array.from([1, 1, 0]) }));
    const frame = reducer.read();
    expect(frame.bandFlux).toEqual([0.3, 0.5, 0]);
    expect(frame.bandEvents).toEqual([1, 2, 0]);
    expect(reducer.read().bandEvents).toEqual([0, 0, 0]);
  });
});
