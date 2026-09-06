import { describe, expect, it } from "vitest";
import { createHopAnalyser, type HopFeatures } from "./hop-analyser.ts";
import { blackmanWindow, decibelsToByte } from "./stft.ts";

/**
 * T1226 — the engine on synthetic windows, against analytic values (§V147).
 *
 * Two signal shapes make every number derivable by hand:
 *
 * - An IMPULSE. The DFT of a windowed single-sample click at position p is flat:
 *   |X[k]| = w[p] for every bin, so after the analyser's 1/N scale every byte of that
 *   hop is `decibelsToByte(20·log10(w[p] / N))` — one number per hop, and the v1 flux
 *   is that byte / 255 on the hop the click enters. A click train on a real contiguous
 *   stream is therefore an exact count: one `event` per click, however many hops each
 *   click stays inside the sliding window.
 *
 * - A BIN-ALIGNED SINE filling the whole window. Five lines (stft.test.ts): bytes
 *   255, 255, 255 at k−1..k+1 and 240 at k±2, zero elsewhere, so a band's flux is a
 *   fraction with a visible numerator and the rest of the spectrum is exactly 0.
 */

const FFT_SIZE = 2048;
const HOP = 512;
const SAMPLE_RATE = 48_000;
const BANDS = [
  [20, 250],
  [250, 2000],
  [2000, 6000],
  [6000, 16000],
] as const;
/** `bandFlux` indices: 0 whole spectrum, then the bands above. */
const WHOLE = 0;
const LOW = 1;
const LOW_MID = 2;
const HIGH = 4;
/** 48 kHz / 2048: the low band is bins 1..10, lowMid 11..85. */
const LOW_BINS = 10;

function analyser(eventThreshold = 0.02) {
  return createHopAnalyser({
    fftSize: FFT_SIZE,
    sampleRate: SAMPLE_RATE,
    bands: BANDS,
    eventThreshold,
    superflux: { lag: 2, halfWidth: 1 },
    picker: { historyHops: 8, delta: 0.05, minGapHops: 0 },
  });
}

/** Feed a contiguous stream on the hop grid: window k is samples [k·hop, k·hop + fftSize). */
function analyseStream(stream: Float32Array, engine = analyser()): HopFeatures[] {
  const hops: HopFeatures[] = [];
  for (let end = FFT_SIZE; end <= stream.length; end += HOP) {
    hops.push(engine.analyse(stream.subarray(end - FFT_SIZE, end)));
  }
  return hops;
}

function sine(bin: number, amplitude = 1): Float64Array {
  const out = new Float64Array(FFT_SIZE);
  for (let n = 0; n < FFT_SIZE; n += 1) out[n] = amplitude * Math.sin((2 * Math.PI * bin * n) / FFT_SIZE);
  return out;
}

/** The single byte every bin of a click's hop holds, given where the click sits in the window. */
function clickByte(position: number): number {
  const window = blackmanWindow(FFT_SIZE);
  return decibelsToByte(20 * Math.log10((window[position] as number) / FFT_SIZE));
}

describe("createHopAnalyser — v1 flux and events at hop rate", () => {
  it("the first window reports flux 0 and no event, however loud it is", () => {
    const first = analyser().analyse(sine(100));
    expect(first.flux).toBe(0);
    expect(first.event).toBe(false);
    expect(first.frequency[100]).toBe(255);
  });

  it("a train of 5 clicks 10 hops apart is exactly 5 events, each on the hop the click enters", () => {
    const clicks = 5;
    // A multiple of the hop, so every click enters its window at the same position (1600,
    // w ≈ 0.25). At the very end of the window w is ~0.004, below the analyser's −100 dB
    // floor: a click there is byte 0 and rises on the NEXT hop — still one event, one hop
    // later, which is the fidelity a windowed analysis has and not a miscount.
    const spacing = HOP * 10;
    const stream = new Float32Array(FFT_SIZE + HOP * 60);
    // Click c sits at sample 3648 + c·4800: past the first window, so every click ENTERS a
    // window that already has a previous hop to rise against, at position 1600.
    const at: number[] = [];
    for (let c = 0; c < clicks; c += 1) {
      const sample = FFT_SIZE + 1600 + c * spacing;
      stream[sample] = 1;
      at.push(sample);
    }
    const hops = analyseStream(stream);
    const events = hops.map((hop, k) => (hop.event ? k : -1)).filter((k) => k >= 0);
    expect(events).toHaveLength(clicks);
    for (let c = 0; c < clicks; c += 1) {
      const sample = at[c] as number;
      // The first window ending after the click: end = fftSize + k·hop > sample.
      const enteringHop = Math.floor((sample - FFT_SIZE) / HOP) + 1;
      expect(events[c]).toBe(enteringHop);
      const position = sample - (enteringHop * HOP);
      const byte = clickByte(position);
      const hop = hops[enteringHop] as HopFeatures;
      expect(Array.from(hop.frequency).every((value) => value === byte)).toBe(true);
      // Flux on the entering hop: every bin rose from 0 to that byte.
      expect(hop.flux).toBe(byte / 255);
    }
    // Between clicks the window slides over silence: flux exactly 0 (the FFT of zeros is zeros).
    expect((hops[events[0] as number] as HopFeatures).flux).toBeGreaterThan(0.02);
    expect((hops[(events[0] as number) + 4] as HopFeatures).flux).toBe(0);
  });

  it("a click that stays above threshold for two hops is ONE event, not two", () => {
    const stream = new Float32Array(FFT_SIZE + HOP * 8);
    stream[FFT_SIZE + 1600] = 1;
    const hops = analyseStream(stream);
    // Position 1600 on hop 4 (w ≈ 0.25), 1088 on hop 5 (w ≈ 0.98): the bytes rise twice.
    expect(clickByte(1088)).toBeGreaterThan(clickByte(1600));
    expect((hops[5] as HopFeatures).flux).toBe((clickByte(1088) - clickByte(1600)) / 255);
    expect((hops[5] as HopFeatures).flux).toBeGreaterThan(0.02);
    expect(hops.filter((hop) => hop.event)).toHaveLength(1);
  });

  it("rejects a window of the wrong size and a non-power-of-two fftSize", () => {
    expect(() => analyser().analyse(new Float32Array(FFT_SIZE - 1))).toThrow(/expected 2048 samples/);
    expect(() =>
      createHopAnalyser({
        fftSize: 1000,
        sampleRate: SAMPLE_RATE,
        bands: BANDS,
        eventThreshold: 0.02,
        superflux: { lag: 2, halfWidth: 1 },
        picker: { historyHops: 8, delta: 0.05, minGapHops: 0 },
      }),
    ).toThrow(/power of two/);
  });
});

describe("createHopAnalyser — SuperFlux per band", () => {
  const silence = new Float64Array(FFT_SIZE);
  /** A sine on bin 5 fills the low band (bins 1..10) and nothing else: lines at bins 3..7. */
  const LINES = 255 + 255 + 255 + 240 + 240;

  it("a tone appearing in the low band is a low-band event, lag 2 against silence, and no other band moves", () => {
    const engine = analyser();
    engine.analyse(silence);
    engine.analyse(silence);
    const onset = engine.analyse(sine(5));
    expect(onset.bandFlux[LOW]).toBeCloseTo(LINES / LOW_BINS / 255, 12);
    expect(onset.bandFlux[WHOLE]).toBeCloseTo(LINES / (FFT_SIZE / 2) / 255, 12);
    expect(onset.bandFlux[LOW_MID]).toBe(0);
    expect(onset.bandFlux[HIGH]).toBe(0);
    // Whole-spectrum SuperFlux is the same 1245 over 1024 bins, 0.0048: under delta 0.05,
    // no event there, exactly as v1 below — a pure tone is not a broadband event, which
    // is what the per-band streams are for.
    expect(Array.from(onset.bandEvents)).toEqual([0, 1, 0, 0, 0]);
    // v1 sees the same rise as mean over 1024 bins: far below the fixed 0.02.
    expect(onset.flux).toBeCloseTo(LINES / (FFT_SIZE / 2) / 255, 12);
    expect(onset.event).toBe(false);
  });

  it("the tone holding is not a second event: hop 4 references hop 2's own spectrum, flux 0", () => {
    const engine = analyser();
    engine.analyse(silence);
    engine.analyse(silence);
    engine.analyse(sine(5));
    // Hop 3 still references hop 1 (silence): flux again, but the picker saw it rise already.
    const hold = engine.analyse(sine(5));
    expect(hold.bandFlux[LOW]).toBeCloseTo(LINES / LOW_BINS / 255, 12);
    expect(hold.bandEvents[LOW]).toBe(0);
    const settled = engine.analyse(sine(5));
    expect(settled.bandFlux[LOW]).toBe(0);
    expect(settled.bandEvents[LOW]).toBe(0);
  });

  it("vibrato — the tone sliding one bin — is 0 SuperFlux where the v1 formula reads a rise", () => {
    const engine = analyser();
    engine.analyse(silence);
    engine.analyse(silence);
    engine.analyse(sine(5));
    engine.analyse(sine(5));
    const slid = engine.analyse(sine(6));
    // v1, against the previous hop: bin 8 appears (0→240) and bin 7 climbs 240→255.
    expect(slid.flux).toBe((240 + 15) / (FFT_SIZE / 2) / 255);
    // SuperFlux, against hop 3 max-filtered ±1: bin 8 already holds 240 and bin 7 255.
    expect(slid.bandFlux[LOW]).toBe(0);
    expect(slid.bandEvents[LOW]).toBe(0);
  });

  it("the adaptive bar: a −60 dB tone fires over silence and is swallowed right after a full-scale one", () => {
    // Its five lines, from the window's a0/2, a1/4, a2/4 at amplitude 0.001: bytes 96, 79, 21.
    const amplitude = 0.001;
    const centre = decibelsToByte(20 * Math.log10((amplitude * 0.42) / 2));
    const inner = decibelsToByte(20 * Math.log10((amplitude * 0.5) / 4));
    const outer = decibelsToByte(20 * Math.log10((amplitude * 0.08) / 4));
    expect([centre, inner, outer]).toEqual([96, 79, 21]);
    const quiet = (centre + 2 * inner + 2 * outer) / LOW_BINS / 255;

    const fresh = analyser();
    fresh.analyse(silence);
    fresh.analyse(silence);
    const alone = fresh.analyse(sine(5, amplitude));
    expect(alone.bandFlux[LOW]).toBeCloseTo(quiet, 12);
    // Over silence the bar is delta 0.05, and 296 / 2550 = 0.116 clears it.
    expect(alone.bandEvents[LOW]).toBe(1);

    const engine = analyser();
    const loud = LINES / LOW_BINS / 255;
    engine.analyse(silence);
    engine.analyse(silence);
    engine.analyse(sine(5)); // low flux `loud`, event
    engine.analyse(sine(5)); // `loud` again (lag 2 still sees silence), no event
    engine.analyse(sine(5)); // 0
    engine.analyse(silence); // 0
    engine.analyse(silence); // 0
    // The low picker's history is [0, 0, loud, loud, 0, 0, 0]: bar 2·loud/7 + 0.05 = 0.1895.
    expect((2 * loud) / 7 + 0.05).toBeGreaterThan(quiet);
    const after = engine.analyse(sine(5, amplitude));
    expect(after.bandFlux[LOW]).toBeCloseTo(quiet, 12);
    expect(after.bandEvents[LOW]).toBe(0);
  });
});
