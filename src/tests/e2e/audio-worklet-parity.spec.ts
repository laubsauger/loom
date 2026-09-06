import { expect, test } from "@playwright/test";
import { computeAudioFeatures } from "@/app/audio-features.ts";

/**
 * T1225 — THE ANALYSIS WORKLET LOADS UNDER VITE, AND MATCHES THE ANALYSER BYTE FOR BYTE.
 *
 * Two questions, both answered in a real Chromium against a real `AnalyserNode`:
 *
 * 1. Does `audio-analysis.worklet.ts` — a TypeScript module with an `@domain` import —
 *    reach `AudioWorklet.addModule` through the dev server? `?worker&url` is the form
 *    `audio-analysis-worklet-url.ts` commits to; if Vite serves it wrong, `addModule`
 *    rejects and this spec fails at the first await with the browser's own reason.
 *    (The production half of the same question is `pnpm build`: the module is emitted
 *    as its own ES chunk under `assets/` now that T1226 wired the URL into
 *    `use-audio-input.ts`; `audio-engine.spec.ts` asserts the product path loads it.)
 *
 * 2. Do the bytes the worklet posts equal the bytes the analyser would have returned
 *    for THE SAME 2048 SAMPLES? Only identical samples make "within byte quantisation"
 *    a statement about the math and not about noise variance between two windows. An
 *    `OfflineAudioContext` gives that exactly: it renders deterministically, `suspend(t)`
 *    halts on a render-quantum boundary, and at a halt the analyser holds precisely the
 *    `fftSize` samples ending at `t` while the worklet, fed the same quanta from the
 *    same source, has just analysed the window ending at the same sample. Comparing at
 *    every hop is the hop-schedule check for free: window k ends at fftSize + k·hop.
 *
 * The comparison runs through `computeAudioFeatures`, the shipping function, so what is
 * confirmed is the channel value the value graph sees. §V147: the tolerance is one byte
 * count (float→trunc at a bin sitting on a boundary, the slack T702 measured on the
 * node itself), which on a band average is 1/255 = 0.0039 at worst.
 */

const FFT_SIZE = 2048;
const HOP = 512;
/** Windows compared. 40 hops of 512 at 48 kHz is 0.43 s of signal after the first window. */
const HOPS = 40;
const SAMPLE_RATE = 48_000;

interface Capture {
  readonly end: number;
  readonly frequency: number[];
  readonly timeDomain: number[];
}

interface Measurement {
  readonly sampleRate: number;
  readonly analyser: Capture[];
  readonly worklet: Capture[];
}

interface WorkletUrlModule {
  readonly AUDIO_ANALYSIS_WORKLET_URL: string;
}
interface ProtocolModule {
  readonly AUDIO_ANALYSIS_PROCESSOR_NAME: string;
  readonly AUDIO_ANALYSIS_OPTIONS: { readonly fftSize: number; readonly hop: number };
}

const BANDS = ["low", "lowMid", "highMid", "high"] as const;

function featuresOf(capture: Capture, sampleRate: number) {
  return computeAudioFeatures({
    frequency: Uint8Array.from(capture.frequency),
    timeDomain: Uint8Array.from(capture.timeDomain),
    sampleRate,
    fftSize: FFT_SIZE,
    state: { previousSpectrum: null, previousOnset: 0 },
  });
}

test.describe("T1225 — the analysis worklet against a live AnalyserNode on identical samples", () => {
  test("loads through Vite and reproduces every hop's bytes within one count", async ({ page }) => {
    await page.goto("/");

    const measurement = await page.evaluate(
      async ({ fftSize, hop, hops, sampleRate }): Promise<Measurement> => {
        // Variables, not literals: the spec's own tsconfig must not try to resolve these.
        const urlModulePath = "/src/app/audio-analysis-worklet-url.ts";
        const protocolModulePath = "/src/app/audio-analysis-protocol.ts";
        const { AUDIO_ANALYSIS_WORKLET_URL } = (await import(/* @vite-ignore */ urlModulePath)) as WorkletUrlModule;
        const { AUDIO_ANALYSIS_PROCESSOR_NAME, AUDIO_ANALYSIS_OPTIONS } = (await import(
          /* @vite-ignore */ protocolModulePath
        )) as ProtocolModule;

        const length = fftSize + hop * hops + 128;
        const context = new OfflineAudioContext(1, length, sampleRate);
        await context.audioWorklet.addModule(AUDIO_ANALYSIS_WORKLET_URL);

        /*
         * Deterministic broadband noise plus two tones, so every band holds bins well
         * inside [-100, -30] dB where a one-count difference is a real difference (a bin
         * pinned at 0 or 255 by clamping would agree for free).
         */
        const buffer = context.createBuffer(1, length, sampleRate);
        const channel = buffer.getChannelData(0);
        let seed = 0x2f6e2b1;
        for (let i = 0; i < length; i += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const noise = (seed / 0x3fffffff - 1) * 0.15;
          const t = i / sampleRate;
          channel[i] = noise + 0.2 * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * 3000 * t);
        }
        const source = context.createBufferSource();
        source.buffer = buffer;

        const analyser = context.createAnalyser();
        analyser.fftSize = fftSize;
        analyser.smoothingTimeConstant = 0;
        const mute = context.createGain();
        mute.gain.value = 0;
        source.connect(analyser).connect(mute).connect(context.destination);

        const node = new AudioWorkletNode(context, AUDIO_ANALYSIS_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          // T1226: the shipped engine options, on this spec's grid.
          processorOptions: { ...AUDIO_ANALYSIS_OPTIONS, fftSize, hop },
        });
        source.connect(node);

        const workletCaptures: Capture[] = [];
        let pong: (() => void) | null = null;
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data as
            | { type: "hop"; end: number; frequency: Uint8Array; timeDomain: Uint8Array }
            | { type: "pong"; id: number };
          if (data.type === "hop") {
            workletCaptures.push({
              end: data.end,
              frequency: Array.from(data.frequency),
              timeDomain: Array.from(data.timeDomain),
            });
          } else if (data.type === "pong") {
            pong?.();
          }
        };

        const analyserCaptures: Capture[] = [];
        for (let k = 0; k <= hops; k += 1) {
          const end = fftSize + k * hop;
          void context.suspend(end / sampleRate).then(() => {
            const frequency = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(frequency);
            const timeDomain = new Uint8Array(fftSize);
            analyser.getByteTimeDomainData(timeDomain);
            analyserCaptures.push({ end, frequency: Array.from(frequency), timeDomain: Array.from(timeDomain) });
            void context.resume();
          });
        }

        source.start(0);
        await context.startRendering();

        // Barrier: the port delivers in order, so a pong after rendering means every hop is in.
        await new Promise<void>((resolve) => {
          pong = resolve;
          node.port.postMessage({ type: "ping", id: 1 });
        });

        return { sampleRate: context.sampleRate, analyser: analyserCaptures, worklet: workletCaptures };
      },
      { fftSize: FFT_SIZE, hop: HOP, hops: HOPS, sampleRate: SAMPLE_RATE },
    );

    const { sampleRate, analyser, worklet } = measurement;
    const report: string[] = [];
    report.push(
      `offline context: sampleRate=${sampleRate} fftSize=${FFT_SIZE} hop=${HOP} ` +
        `analyser captures=${analyser.length} worklet hops=${worklet.length}`,
    );

    // The hop schedule: one worklet window per suspend point, ending at the same sample.
    const byEnd = new Map(worklet.map((capture) => [capture.end, capture]));
    expect(analyser.length).toBe(HOPS + 1);
    for (const capture of analyser) expect(byEnd.has(capture.end), `worklet window ending at ${capture.end}`).toBe(true);

    let frequencyBins = 0;
    let frequencyMismatches = 0;
    let worstFrequencyError = 0;
    let timeSamples = 0;
    let timeMismatches = 0;
    let worstTimeError = 0;
    const channelDeltas = { low: 0, lowMid: 0, highMid: 0, high: 0, level: 0 };
    let binsInWindow = 0;

    for (const live of analyser) {
      const ours = byEnd.get(live.end) as Capture;
      for (let bin = 0; bin < live.frequency.length; bin += 1) {
        const a = live.frequency[bin] as number;
        const b = ours.frequency[bin] as number;
        const error = Math.abs(a - b);
        frequencyBins += 1;
        if (a > 0 && a < 255) binsInWindow += 1;
        if (error > 0) frequencyMismatches += 1;
        worstFrequencyError = Math.max(worstFrequencyError, error);
      }
      for (let i = 0; i < live.timeDomain.length; i += 1) {
        const error = Math.abs((live.timeDomain[i] as number) - (ours.timeDomain[i] as number));
        timeSamples += 1;
        if (error > 0) timeMismatches += 1;
        worstTimeError = Math.max(worstTimeError, error);
      }
      const liveFeatures = featuresOf(live, sampleRate);
      const ourFeatures = featuresOf(ours, sampleRate);
      for (const band of BANDS) {
        channelDeltas[band] = Math.max(channelDeltas[band], Math.abs(liveFeatures[band] - ourFeatures[band]));
      }
      channelDeltas.level = Math.max(channelDeltas.level, Math.abs(liveFeatures.level - ourFeatures.level));
    }

    report.push(
      `frequency bytes: worst error ${worstFrequencyError} count, mismatched ${frequencyMismatches}/${frequencyBins} ` +
        `(${((100 * frequencyMismatches) / frequencyBins).toFixed(3)}%), ${binsInWindow} bins strictly inside 0..255`,
    );
    report.push(
      `time-domain bytes: worst error ${worstTimeError} count, mismatched ${timeMismatches}/${timeSamples} ` +
        `(${((100 * timeMismatches) / timeSamples).toFixed(3)}%)`,
    );
    report.push(
      `channel |delta| max: ` +
        (["low", "lowMid", "highMid", "high", "level"] as const)
          .map((name) => `${name} ${channelDeltas[name].toFixed(6)}`)
          .join(", "),
    );
    console.log(report.join("\n"));

    // Not a degenerate comparison: most bins sit inside the byte window, where a wrong
    // window or scale WOULD show. (Half the spectrum is above 16 kHz and near the floor.)
    expect(binsInWindow).toBeGreaterThan(frequencyBins / 3);
    // One count of float→trunc slack, the same slack the node showed against its own dB (T702).
    expect(worstFrequencyError).toBeLessThanOrEqual(1);
    expect(worstTimeError).toBeLessThanOrEqual(1);
    // A boundary bin is rare; if most bins disagree the quantiser is wrong, not marginal.
    expect(frequencyMismatches / frequencyBins).toBeLessThan(0.02);
    expect(timeMismatches / timeSamples).toBeLessThan(0.02);
    // And therefore the channels agree within one count of a band average.
    for (const band of BANDS) expect(channelDeltas[band]).toBeLessThanOrEqual(1 / 255);
    expect(channelDeltas.level).toBeLessThanOrEqual(1 / 255);
  });
});
