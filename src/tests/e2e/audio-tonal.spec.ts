import { expect, test } from "@playwright/test";

/**
 * T1751b — CHROMA THROUGH THE SHIPPED WORKLET, in a real Chromium.
 *
 * A C major chord then an F major chord, rendered through an `OfflineAudioContext` into the
 * shipped processor with the tonal pass on: one `tonal` message per 2048 samples from the
 * first whole 8192 window, and every one of them EQUAL, number for number, to
 * `createTonalAnalyser` run in the page over the same windows. The values themselves are
 * pinned analytically in `chroma.test.ts` and `tonal-analyser.test.ts`; this is the ring,
 * the grid and the port. Without `tonal` in the options the processor posts no tonal
 * message at all — a document with no tonal node pays nothing.
 *
 * The product path behind it (capture, reducer, record, node, tile) is
 * `chroma-node.spec.ts`, in the lane with a real adapter: a value tile reads nothing
 * until a plan is installed on a device.
 */

const SAMPLE_RATE = 48_000;
const WINDOW = 8192;
const TONAL_HOP = 2048;
/** The chord changes here: not on a window boundary. */
const CHANGE = WINDOW + TONAL_HOP * 20 + 777;
const LENGTH = CHANGE + WINDOW + TONAL_HOP * 20;

interface TonalRecord {
  readonly end: number;
  readonly chroma: number[];
  readonly confidence: number;
  readonly tuning: number;
  readonly lag: number;
}

test.describe("T1751b — chroma", () => {
  test("the shipped worklet posts the analyser's own frames, one per tonal hop, and none when not asked", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(
      async ({ sampleRate, length, change, windowSize, tonalHop }) => {
        const urlModulePath = "/src/app/audio-analysis-worklet-url.ts";
        const protocolModulePath = "/src/app/audio-analysis-protocol.ts";
        const analyserModulePath = "/src/domain/audio/analysis/tonal-analyser.ts";
        const { AUDIO_ANALYSIS_WORKLET_URL } = (await import(/* @vite-ignore */ urlModulePath)) as { AUDIO_ANALYSIS_WORKLET_URL: string };
        const { AUDIO_ANALYSIS_PROCESSOR_NAME, AUDIO_ANALYSIS_OPTIONS, AUDIO_TONAL_OPTIONS } = (await import(
          /* @vite-ignore */ protocolModulePath
        )) as { AUDIO_ANALYSIS_PROCESSOR_NAME: string; AUDIO_ANALYSIS_OPTIONS: object; AUDIO_TONAL_OPTIONS: object };
        const { createTonalAnalyser } = (await import(/* @vite-ignore */ analyserModulePath)) as {
          createTonalAnalyser: (options: { sampleRate: number; windowSize: number }) => {
            analyse(samples: ArrayLike<number>, advanced: number): { chroma: Float64Array; confidence: number; tuning: number; lag: number };
          };
        };

        const pcm = new Float32Array(length);
        const chord = (notes: number[], from: number, to: number): void => {
          for (const note of notes) {
            const frequency = 440 * 2 ** ((note - 69) / 12);
            for (let h = 1; h <= 6; h += 1) {
              for (let i = from; i < to; i += 1) pcm[i] = (pcm[i] as number) + (0.1 / h) * Math.sin((2 * Math.PI * frequency * h * i) / sampleRate);
            }
          }
        };
        chord([60, 64, 67], 0, change);
        chord([65, 69, 72], change, length);

        const render = async (tonal: boolean): Promise<{ tonal: TonalRecord[]; hops: number; pitches: number; voiced: number }> => {
          const context = new OfflineAudioContext(1, length, sampleRate);
          await context.audioWorklet.addModule(AUDIO_ANALYSIS_WORKLET_URL);
          const buffer = context.createBuffer(1, length, sampleRate);
          buffer.getChannelData(0).set(pcm);
          const source = context.createBufferSource();
          source.buffer = buffer;
          const node = new AudioWorkletNode(context, AUDIO_ANALYSIS_PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: tonal ? { ...AUDIO_ANALYSIS_OPTIONS, tonal: AUDIO_TONAL_OPTIONS } : AUDIO_ANALYSIS_OPTIONS,
          });
          source.connect(node);
          const records: TonalRecord[] = [];
          let hops = 0;
          let pitches = 0;
          let voiced = 0;
          let pong: (() => void) | null = null;
          node.port.onmessage = (event: MessageEvent) => {
            const data = event.data as
              | { type: "tonal"; end: number; chroma: Float64Array; confidence: number; tuning: number; lag: number }
              | { type: "hop" }
              | { type: "pitch"; confidence: number }
              | { type: "pong" };
            if (data.type === "tonal") {
              records.push({ end: data.end, chroma: Array.from(data.chroma), confidence: data.confidence, tuning: data.tuning, lag: data.lag });
            } else if (data.type === "hop") hops += 1;
            else if (data.type === "pitch") {
              pitches += 1;
              if (data.confidence > 0) voiced += 1;
            } else pong?.();
          };
          source.start(0);
          await context.startRendering();
          await new Promise<void>((resolve) => {
            pong = resolve;
            node.port.postMessage({ type: "ping", id: 1 });
          });
          return { tonal: records, hops, pitches, voiced };
        };

        const withPass = await render(true);
        const withoutPass = await render(false);

        // The same windows through the same analyser, in the page: what the worklet must equal.
        const analyser = createTonalAnalyser({ sampleRate, windowSize });
        const expected: TonalRecord[] = [];
        for (let end = windowSize, index = 0; end <= length; end += tonalHop, index += 1) {
          const frame = analyser.analyse(Float64Array.from(pcm.subarray(end - windowSize, end)), index === 0 ? 0 : tonalHop);
          expected.push({ end, chroma: Array.from(frame.chroma), confidence: frame.confidence, tuning: frame.tuning, lag: frame.lag });
        }
        return { withPass, withoutPass, expected };
      },
      { sampleRate: SAMPLE_RATE, length: LENGTH, change: CHANGE, windowSize: WINDOW, tonalHop: TONAL_HOP },
    );

    const { withPass, withoutPass, expected } = result;
    // An offline context renders whole 128-sample quanta, so every window that fits is posted.
    expect(withPass.tonal.length).toBe(Math.floor((LENGTH - WINDOW) / TONAL_HOP) + 1);
    expect(withPass.tonal).toEqual(expected);

    const leaders = (record: TonalRecord): number[] =>
      [...record.chroma.keys()].sort((a, b) => (record.chroma[b] as number) - (record.chroma[a] as number)).slice(0, 3).sort((a, b) => a - b);
    const before = withPass.tonal.filter((record) => record.end <= CHANGE);
    const after = withPass.tonal.filter((record) => record.end - WINDOW >= CHANGE);
    expect(before.length).toBeGreaterThan(15);
    expect(after.length).toBeGreaterThan(15);
    for (const record of before) expect(leaders(record)).toEqual([0, 4, 7]);
    for (const record of after) expect(leaders(record)).toEqual([0, 5, 9]);
    for (const record of withPass.tonal) expect(record.lag).toBe(WINDOW / 2 / SAMPLE_RATE);

    // Not asked for: the hops still arrive, in the same number, and not one tonal message.
    expect(withoutPass.tonal).toEqual([]);
    expect(withoutPass.hops).toBe(withPass.hops);
    expect(withoutPass.hops).toBeGreaterThan(100);
    // T1755b: the lead pitch rides the same switch — a reading on every second hop with the
    // pass on, none without it — and two chords are not a lead: not one reading claims a pitch.
    expect(withPass.pitches).toBe(Math.ceil(withPass.hops / 2));
    expect(withPass.voiced).toBe(0);
    expect(withoutPass.pitches).toBe(0);
  });
});
