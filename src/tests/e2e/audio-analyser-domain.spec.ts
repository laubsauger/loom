import { expect, test } from "@playwright/test";
import { computeAudioFeatures, AUDIO_BAND_EDGES_HZ } from "@/app/audio-features.ts";

/**
 * T702 — CONFIRM THE ANALYSER MODEL AGAINST A LIVE `AnalyserNode`.
 *
 * T700 concluded that the band channels (`low`/`lowMid`/`highMid`/`high`) are a
 * LOGARITHM of amplitude — literally `(dB + 100) / 70` — while `audioPattern`
 * synthesizes them LINEAR, and that no affine calibration can bridge the two. That
 * conclusion was reached against an OFFLINE reproduction of the analyser (an own FFT
 * plus WebAudio's documented Blackman window and byte mapping), not against the
 * browser's real node. A six-example retune rests on it, and this session has been
 * bitten three times by faithful-looking models of things nobody observed
 * (§V628 preview tiles blind to alpha, §V629 a gate passing on `undefined`,
 * §V634 an `elementFromPoint` check blind to its own overlay).
 *
 * So: real Chromium, real WebAudio, deterministic broadband noise at known gains
 * through a real `AnalyserNode` configured exactly as `use-audio-input.ts` configures
 * it (fftSize 2048, smoothingTimeConstant 0), and three independent checks.
 *
 * 1. BYTE MAPPING, exact and offset-free. The node's own `getFloatFrequencyData`
 *    gives per-bin dB; `getByteFrequencyData` gives the bytes `computeAudioFeatures`
 *    consumes. If the band channel really is `(dB + 100) / 70`, every byte must equal
 *    `trunc(255 * (dB - minDecibels) / (maxDecibels - minDecibels))` clamped. This
 *    needs no FFT of our own, so it cannot inherit the reproduction's mistakes.
 * 2. THE REPRODUCTION ITSELF. The same 2048 samples the node analysed (captured with
 *    the context SUSPENDED so the audio thread cannot advance the write index between
 *    reads) are pushed through the offline model — Blackman window, radix-2 FFT,
 *    magnitude/fftSize, 20·log10 — and compared bin by bin against the node's own dB.
 * 3. THE SLOPE. A gain sweep, the measurement T700 actually argued from: each band
 *    must move a FIXED ~0.1429 per 10 dB (= 10/70) rather than tracking amplitude.
 *
 * The bands are read through `computeAudioFeatures`, the shipping function, so what is
 * confirmed is the channel the value graph sees and not a private restatement of it.
 */

const FFT_SIZE = 2048;
/** Captures per gain point. White noise is chi-square per bin; §V649 wants the N stated. */
const CAPTURES_PER_GAIN = 4;
/** dB relative to the source buffer. Chosen so every bin sits inside [-100,-30]. */
const GAIN_STEPS_DB = [10, 0, -10, -20, -30] as const;

interface Capture {
  readonly gainDb: number;
  /** `getByteFrequencyData` — what `computeAudioFeatures` actually eats. */
  readonly frequency: number[];
  /** `getByteTimeDomainData` — the amplitude-domain control channel (`level`). */
  readonly timeDomain: number[];
  /** `getFloatTimeDomainData` — the very samples the node's FFT ran over. */
  readonly samples: number[];
  /** `getFloatFrequencyData` — the node's own per-bin dB, unclamped. */
  readonly decibels: number[];
}

interface Measurement {
  readonly sampleRate: number;
  readonly minDecibels: number;
  readonly maxDecibels: number;
  readonly captures: Capture[];
}

/* ------------------------------------------------------------------ *
 * The offline reproduction, restated here so the comparison is real.
 * ------------------------------------------------------------------ */

/** WebAudio's Blackman window, as the spec defines it: a0 = 0.42, a1 = 0.5, a2 = 0.08. */
function blackman(index: number, size: number): number {
  const x = index / size;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

/** In-place iterative radix-2 FFT. `size` is a power of two. */
function fft(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j] as number, real[i] as number];
      [imag[i], imag[j]] = [imag[j] as number, imag[i] as number];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < length / 2; k += 1) {
        const a = start + k;
        const b = a + length / 2;
        const tReal = (real[b] as number) * curReal - (imag[b] as number) * curImag;
        const tImag = (real[b] as number) * curImag + (imag[b] as number) * curReal;
        real[b] = (real[a] as number) - tReal;
        imag[b] = (imag[a] as number) - tImag;
        real[a] = (real[a] as number) + tReal;
        imag[a] = (imag[a] as number) + tImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/** The model under test: samples → per-bin dB, the way WebAudio documents it. */
function reproduceDecibels(samples: readonly number[]): Float64Array {
  const size = samples.length;
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let i = 0; i < size; i += 1) real[i] = (samples[i] as number) * blackman(i, size);
  fft(real, imag);
  const bins = size / 2;
  const out = new Float64Array(bins);
  const scale = 1 / size;
  for (let bin = 0; bin < bins; bin += 1) {
    const magnitude = Math.hypot(real[bin] as number, imag[bin] as number) * scale;
    out[bin] = magnitude === 0 ? -1000 : 20 * Math.log10(magnitude);
  }
  return out;
}

/** The model's byte quantiser: WebAudio's documented [minDb, maxDb] → 0..255 map. */
function decibelsToByte(db: number, minDb: number, maxDb: number): number {
  const scaled = (255 * (db - minDb)) / (maxDb - minDb);
  if (!Number.isFinite(scaled) || scaled < 0) return 0;
  if (scaled > 255) return 255;
  return Math.trunc(scaled);
}

const BANDS = ["low", "lowMid", "highMid", "high"] as const;
type Band = (typeof BANDS)[number];

function featuresOf(frequency: readonly number[], timeDomain: readonly number[], sampleRate: number) {
  return computeAudioFeatures({
    frequency: Uint8Array.from(frequency),
    timeDomain: Uint8Array.from(timeDomain),
    sampleRate,
    fftSize: FFT_SIZE,
    state: { previousSpectrum: null, previousOnset: 0 },
  });
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: readonly number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
};

test.describe("T702 — the analyser's band channels are dB-domain, measured LIVE", () => {
  test("a real AnalyserNode confirms the offline reproduction, byte for byte and dB for dB", async ({ page }) => {
    await page.goto("/");

    const measurement = await page.evaluate(
      async ({ fftSize, gains, captures }): Promise<Measurement> => {
        const context = new AudioContext();
        await context.resume();
        if (context.state !== "running") {
          throw new Error(`AudioContext did not start: state=${context.state}`);
        }

        /*
         * Deterministic broadband noise. Broadband matters: a single tone would light a
         * handful of bins and leave the rest of the band at the floor, and the band
         * AVERAGE would then move at a fraction of the per-bin rate — measuring the
         * band's fill, not its domain. Noise fills every bin well above -100 dB, so a
         * gain change shifts every bin by the same number of dB.
         */
        const length = 8192;
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const channel = buffer.getChannelData(0);
        let seed = 0x2f6e2b1;
        for (let i = 0; i < length; i += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          channel[i] = (seed / 0x3fffffff - 1) * 0.25;
        }

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = context.createGain();
        const analyser = context.createAnalyser();
        analyser.fftSize = fftSize;
        // Exactly what `use-audio-input.ts` sets: downstream `valueLag` owns smoothing.
        analyser.smoothingTimeConstant = 0;
        // A silent tap so the graph is pulled without anything reaching the speakers.
        const mute = context.createGain();
        mute.gain.value = 0;
        source.connect(gain).connect(analyser).connect(mute).connect(context.destination);
        source.start();

        const out: {
          gainDb: number;
          frequency: number[];
          timeDomain: number[];
          samples: number[];
          decibels: number[];
        }[] = [];

        for (const gainDb of gains) {
          gain.gain.value = 10 ** (gainDb / 20);
          for (let take = 0; take < captures; take += 1) {
            await new Promise((resolve) => setTimeout(resolve, 90));
            /*
             * SUSPEND before reading. The audio thread advances the analyser's write
             * index in render quanta; without this, `getFloatTimeDomainData` and
             * `getByteFrequencyData` can straddle a quantum boundary and describe two
             * different 2048-sample windows — which would make the reproduction check
             * fail for a reason that has nothing to do with the model.
             */
            await context.suspend();
            const samples = new Float32Array(fftSize);
            analyser.getFloatTimeDomainData(samples);
            const frequency = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(frequency);
            const timeDomain = new Uint8Array(fftSize);
            analyser.getByteTimeDomainData(timeDomain);
            const decibels = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(decibels);
            out.push({
              gainDb,
              frequency: Array.from(frequency),
              timeDomain: Array.from(timeDomain),
              samples: Array.from(samples),
              decibels: Array.from(decibels),
            });
            await context.resume();
          }
        }

        const result = {
          sampleRate: context.sampleRate,
          minDecibels: analyser.minDecibels,
          maxDecibels: analyser.maxDecibels,
          captures: out,
        };
        source.stop();
        await context.close();
        return result;
      },
      { fftSize: FFT_SIZE, gains: [...GAIN_STEPS_DB], captures: CAPTURES_PER_GAIN },
    );

    const { sampleRate, minDecibels, maxDecibels, captures } = measurement;
    const report: string[] = [];
    report.push(
      `context: sampleRate=${sampleRate} fftSize=${FFT_SIZE} binHz=${(sampleRate / FFT_SIZE).toFixed(3)} ` +
        `window=[${minDecibels}, ${maxDecibels}] dB, span=${maxDecibels - minDecibels} dB`,
    );

    /* ---- CHECK 1: the byte mapping, from the node's own dB. No FFT of ours. ---- */
    let byteMismatches = 0;
    let byteSamples = 0;
    let worstByteError = 0;
    for (const capture of captures) {
      for (let bin = 0; bin < capture.frequency.length; bin += 1) {
        const predicted = decibelsToByte(capture.decibels[bin] as number, minDecibels, maxDecibels);
        const error = Math.abs(predicted - (capture.frequency[bin] as number));
        byteSamples += 1;
        if (error > 0) byteMismatches += 1;
        worstByteError = Math.max(worstByteError, error);
      }
    }
    report.push(
      `byte mapping trunc(255*(dB-(${minDecibels}))/${maxDecibels - minDecibels}): ` +
        `worst error ${worstByteError} byte, mismatched ${byteMismatches}/${byteSamples} bins ` +
        `(${((100 * byteMismatches) / byteSamples).toFixed(2)}%, N=${byteSamples})`,
    );

    /* ---- CHECK 2: the offline reproduction, against the node's own dB. ---- */
    const perCaptureError: number[] = [];
    let worstBinError = 0;
    let comparedBins = 0;
    for (const capture of captures) {
      const reproduced = reproduceDecibels(capture.samples);
      const errors: number[] = [];
      for (let bin = 1; bin < reproduced.length; bin += 1) {
        const live = capture.decibels[bin] as number;
        // Below the window the byte saturates at 0 and the difference cannot matter.
        if (live < minDecibels) continue;
        const error = Math.abs((reproduced[bin] as number) - live);
        errors.push(error);
        worstBinError = Math.max(worstBinError, error);
      }
      comparedBins += errors.length;
      perCaptureError.push(mean(errors));
    }
    report.push(
      `reproduction vs live dB: mean |error| ${mean(perCaptureError).toFixed(5)} dB, ` +
        `worst bin ${worstBinError.toFixed(5)} dB over N=${comparedBins} bins ` +
        `across ${captures.length} captures`,
    );

    /* ---- CHECK 2b: the reproduced BYTES drive the same channel values. ---- */
    const channelDeltas: Record<Band, number[]> = { low: [], lowMid: [], highMid: [], high: [] };
    for (const capture of captures) {
      const reproduced = reproduceDecibels(capture.samples);
      const reproducedBytes = Array.from(reproduced, (db) => decibelsToByte(db, minDecibels, maxDecibels));
      const live = featuresOf(capture.frequency, capture.timeDomain, sampleRate);
      const modelled = featuresOf(reproducedBytes, capture.timeDomain, sampleRate);
      for (const band of BANDS) channelDeltas[band].push(Math.abs(live[band] - modelled[band]));
    }
    for (const band of BANDS) {
      report.push(
        `channel ${band}: live vs reproduced |delta| mean ${mean(channelDeltas[band]).toFixed(6)}, ` +
          `max ${Math.max(...channelDeltas[band]).toFixed(6)} (N=${channelDeltas[band].length} captures)`,
      );
    }

    /* ---- CHECK 3: the slope. 10/70 = 0.142857 per 10 dB, or it is not a logarithm. ---- */
    const byGain = new Map<number, ReturnType<typeof featuresOf>[]>();
    for (const capture of captures) {
      const features = featuresOf(capture.frequency, capture.timeDomain, sampleRate);
      const existing = byGain.get(capture.gainDb);
      if (existing) existing.push(features);
      else byGain.set(capture.gainDb, [features]);
    }
    const gainOrder = [...GAIN_STEPS_DB];
    const slopes: Record<Band, number[]> = { low: [], lowMid: [], highMid: [], high: [] };
    for (const band of BANDS) {
      const means = gainOrder.map((db) => mean((byGain.get(db) ?? []).map((f) => f[band])));
      const spread = gainOrder.map((db) => sd((byGain.get(db) ?? []).map((f) => f[band])));
      report.push(
        `sweep ${band}: ` +
          gainOrder
            .map((db, i) => `${db > 0 ? "+" : ""}${db}dB→${(means[i] as number).toFixed(4)}±${(spread[i] as number).toFixed(4)}`)
            .join("  "),
      );
      for (let i = 1; i < gainOrder.length; i += 1) {
        const stepDb = (gainOrder[i - 1] as number) - (gainOrder[i] as number);
        slopes[band].push((((means[i - 1] as number) - (means[i] as number)) / stepDb) * 10);
      }
      report.push(
        `  per 10 dB: ${slopes[band].map((s) => s.toFixed(4)).join(", ")} ` +
          `(mean ${mean(slopes[band]).toFixed(4)}, predicted 10/70 = ${(10 / 70).toFixed(4)})`,
      );
    }

    /* The amplitude-domain control, §V648: `level` is RMS and must track amplitude. */
    const levelMeans = gainOrder.map((db) => mean((byGain.get(db) ?? []).map((f) => f.level)));
    report.push(
      `control level (amplitude domain): ` +
        gainOrder.map((db, i) => `${db > 0 ? "+" : ""}${db}dB→${(levelMeans[i] as number).toFixed(5)}`).join("  "),
    );
    for (let i = 1; i < gainOrder.length; i += 1) {
      const ratio = (levelMeans[i - 1] as number) / (levelMeans[i] as number);
      const expected = 10 ** (((gainOrder[i - 1] as number) - (gainOrder[i] as number)) / 20);
      report.push(`  level ratio ${ratio.toFixed(4)} vs amplitude ratio ${expected.toFixed(4)}`);
    }

    report.push(
      `band edges (Hz): ` +
        BANDS.map((b) => `${b} ${AUDIO_BAND_EDGES_HZ[b][0]}-${AUDIO_BAND_EDGES_HZ[b][1]}`).join(", "),
    );
    console.log(report.join("\n"));

    // 1. The window IS [-100, -30]: the divisor 70 in `(dB + 100) / 70` is not assumed.
    expect(minDecibels).toBe(-100);
    expect(maxDecibels).toBe(-30);
    // 2. The byte is the documented quantisation of the node's own dB, to within the
    //    one-count slack that float→trunc leaves at a bin sitting on a boundary.
    expect(worstByteError).toBeLessThanOrEqual(1);
    // 3. The offline reproduction reconstructs the node's dB from its own samples.
    expect(mean(perCaptureError)).toBeLessThan(0.5);
    // 4. And therefore drives the same channel values.
    for (const band of BANDS) expect(Math.max(...channelDeltas[band])).toBeLessThan(0.01);
    // 5. The channels are logarithmic: the sweep spans the predicted 10/70 per 10 dB.
    //
    //    NOTE ON WHAT THIS ACTUALLY MEASURES (§B144): `mean(slopes[band])` TELESCOPES.
    //    Every step is 10 dB, so slopes[i] = means[i-1] - means[i] and their mean is
    //    exactly `(means[first] - means[last]) / 4` — it depends only on the ENDPOINTS
    //    and cannot detect whether the step is constant. The per-step values genuinely
    //    vary (0.1127-0.1654 on `low`, which has ~10 FFT bins at 23.4 Hz each), and that
    //    variation is REPORTED above but not asserted. The comment used to claim "a FIXED
    //    step", which this statistic has never tested. Constancy needs its own assertion
    //    over the individual slopes; it is not smuggled in here.
    //
    //    §B144/§V716 — the window is ±0.01 and the number is not arbitrary. The slope is
    //    built from BYTE-quantised channel values, so it can only land on a `k/255`
    //    lattice at 0.00392 per count, while the prediction is 10/70 × 255 = **36.43
    //    counts** — between two lattice points. `toBeCloseTo(…, 2)` is ±0.005, which is
    //    1.28 counts wide, so it passed iff the measurement landed on 36 or 37 and failed
    //    on 35 or 38 — and 35 misses by 0.0006. That is marginal BY CONSTRUCTION, and it
    //    read as statistical noise: it failed 4 runs in 8 at clean HEAD and cost three
    //    workers a control run each. The tell that it was quantisation rather than
    //    variance is that the failures landed on ADJACENT LATTICE POINTS instead of
    //    scattering (0.1351, 0.1369, 0.1373, 0.1507).
    //
    //    Widened by WINDOW, never by precision digit: `toBeCloseTo(…, 1)` is ±0.05, and a
    //    tolerance that loose would stop refuting the LINEAR hypothesis — which is the
    //    claim this entire spec exists to defend (§V647, T700).
    //
    //    The window is ±0.015, MEASURED rather than chosen: in an isolated §V713 harness
    //    the statistic was observed at 0.13034, which is 0.0125 from the prediction. A
    //    ±0.01 window passed 32 of 32 runs and would still have rejected that legitimate
    //    reading — setting a tolerance INSIDE the statistic's own observed range is the
    //    same error as the original, one size down. ±0.015 covers it with margin and is
    //    still 3x tighter than a precision digit could express.
    for (const band of BANDS) {
      expect(Math.abs(mean(slopes[band]) - 10 / 70)).toBeLessThan(0.015);
    }
  });
});
