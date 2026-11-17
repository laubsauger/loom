import { describe, expect, it, vi } from "vitest";

import type { GraphDocument } from "@domain/types/graph.ts";
import { readFeatureFrame } from "@domain/audio/feature-track.ts";
import { mediaTransportFrom } from "@domain/media/transport.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { AUDIO_DETECTOR_DEFAULTS, AUDIO_INPUT_GAIN_DB, audioFileInNode, audioInNode } from "@nodes/definitions/audio.ts";
import { inputGainLinear } from "./audio-analysis-protocol.ts";
import { captureConfigOf, inputGainDbOf } from "./audio-capture-config.ts";
import { analyseOffline } from "./audio-offline-analysis.ts";
import { createPreAnalyser, preAnalysisKey, readTrackAtPlayhead } from "./audio-pre-analysis.ts";
import type { OfflineAnalysisRequest } from "./audio-pre-analysis.ts";
import { captureKeyOf } from "./use-audio-input.ts";

/**
 * T1769b — THE INPUT GAIN, on the offline walk and on the capture's configuration.
 *
 * The walk is the path a FILE's features take under the timeline lock in the app and in
 * `pnpm render`, and it is the same engine the live capture runs, so the numbers below are
 * the claim about what the trim does to a reading. The live graph (the trim `GainNode`, the
 * monitor branch, a change that does not rebuild the capture) is `audio-input-gain.test.tsx`
 * and, in a real Chromium, `src/tests/e2e/audio-input-gain.spec.ts`.
 *
 * ## The signal, and why every expected number is derived and none is measured
 *
 * A sine on bin 64 of the 2048-sample window (1500 Hz at 48 kHz, a period of exactly 32
 * samples), sampled half a sample off the zero crossing so no sample is 0. The engine's
 * window is Blackman, 0.42 - 0.5 cos + 0.08 cos, whose transform of a bin-centred sine of
 * amplitude a is FIVE bins and nothing else: 0.21 a on the bin, 0.125 a on each neighbour,
 * 0.02 a on the next ones out (half the amplitude times 0.42, 0.25 and 0.04). The analyser
 * maps a bin's decibels onto a byte, trunc(255 (dB + 100) / 70) held to 0..255, and a band
 * is the mean byte of its bins over 255. `lowMid` is 250..2000 Hz, which at 23.4375 Hz a bin
 * is bins 11..85: 75 bins, the tone's five among them. `level` is the RMS of the time-domain
 * bytes, trunc(128 (1 + x)) held to 0..255, read back as (byte - 128) / 128.
 *
 * So for an amplitude a the reading is a closed form, and a gain of g dB must give the
 * closed form for a 10^(g / 20). That is the assertion: not "louder", the number.
 */

const SAMPLE_RATE = 48_000;
const FPS = 60;
const FFT_SIZE = 2048;
const TONE_BIN = 64;
/** `lowMid`, 250..2000 Hz, in 23.4375 Hz bins: ceil(10.67) = 11 to floor(85.33) = 85. */
const LOW_MID_BINS = 85 - 11 + 1;

const phaseOf = (index: number): number => (2 * Math.PI * TONE_BIN * (index + 0.5)) / FFT_SIZE;

function tone(amplitude: number, seconds = 1): Float32Array {
  const samples = new Float32Array(SAMPLE_RATE * seconds);
  for (let index = 0; index < samples.length; index += 1) samples[index] = amplitude * Math.sin(phaseOf(index));
  return samples;
}

/** The analyser's byte for a bin of linear magnitude `magnitude` (the Web Audio rule, written out). */
function binByte(magnitude: number): number {
  const scaled = (255 * (20 * Math.log10(magnitude) + 100)) / 70;
  return scaled < 0 ? 0 : scaled > 255 ? 255 : Math.trunc(scaled);
}

/** `lowMid` for the tone at `amplitude`: the five Blackman bins, over the band's 75. */
function expectedLowMid(amplitude: number): number {
  const bytes = binByte(0.21 * amplitude) + 2 * binByte(0.125 * amplitude) + 2 * binByte(0.02 * amplitude);
  return bytes / LOW_MID_BINS / 255;
}

/** `level` for the tone at `amplitude`: the RMS of one period's time-domain bytes (a window is 64 whole periods). */
function expectedLevel(amplitude: number): number {
  let sumSquares = 0;
  for (let index = 0; index < 32; index += 1) {
    const scaled = 128 * (1 + amplitude * Math.sin(phaseOf(index)));
    const byte = scaled < 0 ? 0 : scaled > 255 ? 255 : Math.trunc(scaled);
    sumSquares += ((byte - 128) / 128) ** 2;
  }
  return Math.sqrt(sumSquares / 32);
}

/**
 * The expectations above are computed in double precision from the ideal tone; the walk sees
 * float32 samples. A byte can differ between the two only where a scaled value sits within
 * float32's rounding of a whole number, so each case first proves none does: no time-domain
 * sample and no bin within 1e-3 of a byte boundary (float32 moves them by under 1e-5).
 */
function expectAwayFromByteBoundaries(amplitude: number): void {
  const near = (value: number): boolean => value > 0 && value < 255 && Math.abs(value - Math.round(value)) < 1e-3;
  for (let index = 0; index < 32; index += 1) {
    expect(near(128 * (1 + amplitude * Math.sin(phaseOf(index)))), `time sample ${String(index)} at ${String(amplitude)}`).toBe(false);
  }
  for (const coefficient of [0.21, 0.125, 0.02]) {
    expect(near((255 * (20 * Math.log10(coefficient * amplitude) + 100)) / 70), `bin ${String(coefficient)} at ${String(amplitude)}`).toBe(false);
  }
}

/** A frame half a second in: every hop behind it read a window that is all tone. */
const STEADY_FRAME = 30;

function readingAt(samples: Float32Array, inputGainDb: number) {
  const { track } = analyseOffline(samples, SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, inputGainDb);
  return readFeatureFrame(track, STEADY_FRAME);
}

describe("T1769b — decibels to a factor, and a parameter to decibels", () => {
  it("0 dB is exactly 1, +20 dB exactly 10, -20 dB exactly a tenth", () => {
    expect(inputGainLinear(0)).toBe(1);
    expect(inputGainLinear(20)).toBe(10);
    expect(inputGainLinear(-20)).toBe(0.1);
    expect(inputGainLinear(40)).toBe(100);
  });

  it("a document that never stored it is analysed at unity, and nothing that is not a number is a gain", () => {
    expect(inputGainDbOf(() => undefined)).toBe(0);
    expect(inputGainDbOf(() => Number.NaN)).toBe(0);
    expect(inputGainDbOf(() => Number.POSITIVE_INFINITY)).toBe(0);
    expect(inputGainDbOf(() => "12")).toBe(0);
    expect(inputGainDbOf((key) => (key === "inputGain" ? 12.5 : undefined))).toBe(12.5);
  });

  it("an expression cannot ask the trim for more than the declared range", () => {
    expect(inputGainDbOf(() => 400)).toBe(AUDIO_INPUT_GAIN_DB.max);
    expect(inputGainDbOf(() => -400)).toBe(AUDIO_INPUT_GAIN_DB.min);
    expect([AUDIO_INPUT_GAIN_DB.min, AUDIO_INPUT_GAIN_DB.max, AUDIO_INPUT_GAIN_DB.default]).toEqual([-24, 48, 0]);
  });

  it("both source nodes declare it, in the Analysis group, at 0 dB", () => {
    // The schema a freshly added node shows, through the one way to a node's parameters (§T903).
    for (const definition of [audioInNode, audioFileInNode]) {
      const parameter = effectiveParameterSchema(definition, {})["inputGain"];
      expect(parameter, `${definition.type} lost its Input Gain`).toMatchObject({ type: "number", group: "Analysis", default: 0, min: -24, max: 48, range: "bounded" });
    }
    // And the rule that makes two level controls on one node safe is written where a user reads it.
    const fileIn = effectiveParameterSchema(audioFileInNode, {});
    expect((fileIn["volume"] as { description: string }).description).toContain("Does NOT touch the analysis");
    expect((fileIn["inputGain"] as { description: string }).description).toContain("does not touch the monitor");
  });
});

describe("T1769b — a tone at a known level reads the closed form for its trimmed amplitude", () => {
  /** -40 dBFS: every one of the five bins is inside the window at -20, 0 and +20 dB. */
  const AMPLITUDE = 0.01;

  for (const [inputGainDb, factor] of [[0, 1], [20, 10], [-20, 0.1]] as const) {
    it(`${String(inputGainDb)} dB: lowMid and level are those of a tone at ${String(factor)} times the amplitude`, () => {
      const effective = AMPLITUDE * factor;
      expectAwayFromByteBoundaries(effective);
      const reading = readingAt(tone(AMPLITUDE), inputGainDb);
      expect(reading.lowMid).toBe(expectedLowMid(effective));
      expect(reading.level).toBe(expectedLevel(effective));
      // The tone is nowhere else: a trim lifts the signal, it does not spread it.
      expect([reading.low, reading.highMid, reading.high]).toEqual([0, 0, 0]);
    });
  }

  it("the three readings are three different numbers, 20 dB apart on the band's 70 dB window", () => {
    // What the closed form says, as numbers a reader can check: bytes 96/79/21, 169/152/94, 242/225/167 (each 20 dB is 72.857 bytes, so 72 or 73 after the truncation).
    expect(expectedLowMid(0.001)).toBe((96 + 2 * 79 + 2 * 21) / 75 / 255);
    expect(expectedLowMid(0.01)).toBe((169 + 2 * 152 + 2 * 94) / 75 / 255);
    expect(expectedLowMid(0.1)).toBe((242 + 2 * 225 + 2 * 167) / 75 / 255);
  });

  it("a gain IS a louder input: +20 dB on the samples reads what ten times the samples read at 0 dB, on every frame and every field", () => {
    const quiet = tone(AMPLITUDE);
    const trimmed = analyseOffline(quiet, SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 20).track;
    const louder = analyseOffline(quiet.map((sample) => sample * 10), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    expect(trimmed.frames).toEqual(louder.frames);
    // Cut the trim and it is a different track.
    const untrimmed = analyseOffline(quiet, SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    expect(untrimmed.frames).not.toEqual(trimmed.frames);
  });

  it("the caller's samples are not written: the sound an export carries stays at unity", () => {
    const samples = tone(AMPLITUDE, 0.25);
    const before = samples.slice(0);
    analyseOffline(samples, SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 20);
    expect(samples).toEqual(before);
  });
});

describe("T1769b — the case the parameter exists for, and its opposite", () => {
  it("a quiet input reads the FLOOR at 0 dB, every band 0, and a real value with gain", () => {
    // 2^-15, about -90 dBFS: the tone's own bin is 0.21 a = 6.4e-6, -103.9 dB, under the window's -100.
    const quiet = 2 ** -15;
    expect(20 * Math.log10(0.21 * quiet)).toBeLessThan(-100);
    const floor = readingAt(tone(quiet), 0);
    expect([floor.low, floor.lowMid, floor.highMid, floor.high]).toEqual([0, 0, 0, 0]);

    // +40 dB: the bin is at -63.9 dB, byte 131; its neighbours 115 and 57.
    const lifted = quiet * 100;
    expectAwayFromByteBoundaries(lifted);
    const heard = readingAt(tone(quiet), 40);
    expect(expectedLowMid(lifted)).toBe((131 + 2 * 115 + 2 * 57) / 75 / 255);
    expect(heard.lowMid).toBe(expectedLowMid(lifted));
    expect(heard.level).toBe(expectedLevel(lifted));
  });

  it("past full scale the analysers stop: level saturates near 1 and a bin stops at 255, they do not wrap or fail", () => {
    // Half scale trimmed +20 dB is five times full scale.
    const hot = 0.5 * 10;
    const reading = readingAt(tone(0.5), 20);
    // Every sample is past the ends of the byte: 255 above ((255 - 128) / 128) and 0 below (-1).
    expect(expectedLevel(hot)).toBeGreaterThan(0.9);
    expect(reading.level).toBe(expectedLevel(hot));
    // All five bins are above -30 dB, so each reads 255: the band reads 5 of its 75 bins full.
    expect(reading.lowMid).toBe(5 / 75);
    // Brought back by -20 dB it is inside the window again and reads its closed form.
    const tamed = 0.5 * 0.1;
    expectAwayFromByteBoundaries(tamed);
    expect(readingAt(tone(0.5), -20).lowMid).toBe(expectedLowMid(tamed));
  });
});

describe("T1769b — which door reads it how", () => {
  const node = (id: string, type: string, parameters: Record<string, unknown>) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id });
  const graphOf = (...nodes: ReturnType<typeof node>[]): GraphDocument =>
    ({ revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: {}, groups: {} }) as never;

  it("the capture carries the source node's gain at rest, and names the node that supplied it", () => {
    const mic = captureConfigOf(graphOf(node("mic", "audioIn", { inputGain: 18 })));
    expect(mic).toMatchObject({ source: "mic", inputGainDb: 18, sourceNodeId: "mic", nodeId: null });
    const file = captureConfigOf(graphOf(node("song", "audioFileIn", { file: "blob:a", inputGain: -6 })));
    expect(file).toMatchObject({ source: "file", inputGainDb: -6, sourceNodeId: "song", nodeId: "song" });
    expect(captureConfigOf(graphOf(node("mic", "audioIn", {})))?.inputGainDb).toBe(0);
  });

  it("a MICROPHONE's gain is not a rebuild door: a live trim must not reopen the device", () => {
    const at = (inputGain: number) => captureKeyOf(captureConfigOf(graphOf(node("mic", "audioIn", { inputGain }))), 0);
    expect(at(30)).toBe(at(0));
  });

  it("a FILE's gain is one: its pre-analysed track is walked at one gain, so a change re-analyses", () => {
    const at = (inputGain: number) => captureKeyOf(captureConfigOf(graphOf(node("song", "audioFileIn", { file: "blob:a", inputGain }))), 0, 60);
    expect(at(12)).not.toBe(at(0));
    expect(at(12)).toBe(at(12));
  });

  it("the pre-analysis cache keys on it: the same file at another gain is another walk, at the same gain a hit", async () => {
    const hash = "ab".repeat(32);
    expect(preAnalysisKey(hash, 60, AUDIO_DETECTOR_DEFAULTS, false, 12)).toBe(`${hash}|60|0.05|0.032|plain|12`);
    expect(preAnalysisKey(hash, 60, AUDIO_DETECTOR_DEFAULTS, false, 12)).not.toBe(preAnalysisKey(hash, 60, AUDIO_DETECTOR_DEFAULTS, false, 0));

    const run = vi.fn((request: OfflineAnalysisRequest) =>
      Promise.resolve(analyseOffline(request.samples, request.sampleRate, request.fps, request.detector, request.tonal, request.inputGainDb)),
    );
    const analyser = createPreAnalyser({ decode: () => Promise.resolve({ samples: tone(0.01, 0.25), sampleRate: SAMPLE_RATE }), hash: () => Promise.resolve(hash), run });
    const bytes = new ArrayBuffer(8);
    await analyser.analyse(bytes, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0);
    await analyser.analyse(bytes, FPS, AUDIO_DETECTOR_DEFAULTS, false, 12);
    await analyser.analyse(bytes, FPS, AUDIO_DETECTOR_DEFAULTS, false, 12);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("T1769b — offline equals the app, for a file", () => {
  /**
   * The two readers of a locked file: the app (`useAudioInput.read`: the pre-analyser's track
   * at the playhead) and `pnpm render` (`audioFeed`: `analyseOffline` at the playhead). Both
   * take the gain from `captureConfigOf` of the same document, which is the whole mechanism;
   * this runs each one's calls on one decode and compares what a frame reads.
   */
  it("the track the app reads and the track a render walks are the same records, and both are the trimmed file's", async () => {
    const graph = {
      revision: 1,
      nodes: { song: { id: "song", type: "audioFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file: "blob:a", playMode: "timeline", inputGain: 20 }, label: "song" } },
      edges: {},
      groups: {},
    } as unknown as GraphDocument;
    const config = captureConfigOf(graph);
    if (config === null) throw new Error("the file node is not the capture");
    const decoded = tone(0.01);

    // The app: decode, then the worker's walk (the request carries the gain), and its PCM for an export.
    const app = await createPreAnalyser({
      decode: () => Promise.resolve({ samples: decoded.slice(0), sampleRate: SAMPLE_RATE }),
      hash: () => Promise.resolve("h"),
      run: (request) => Promise.resolve(analyseOffline(request.samples, request.sampleRate, request.fps, request.detector, request.tonal, request.inputGainDb)),
    }).analyse(new ArrayBuffer(8), FPS, config.detector, config.tonal, config.inputGainDb);
    // The render: the same decode, walked directly.
    const render = analyseOffline(decoded, SAMPLE_RATE, FPS, config.detector, config.tonal, config.inputGainDb);

    const transport = mediaTransportFrom((key) => (key === "playMode" ? "timeline" : undefined));
    const inApp = readTrackAtPlayhead(app.analysis.track, transport, STEADY_FRAME / FPS, 1, 0);
    const rendered = readTrackAtPlayhead(render.track, transport, STEADY_FRAME / FPS, 1, 0);
    expect(inApp).toEqual(rendered);
    expect(app.analysis.track.frames).toEqual(render.track.frames);
    expect(rendered.lowMid).toBe(expectedLowMid(0.1));
    // The monitor's half of the rule: what an export carries is the file, not the trimmed file.
    expect(app.pcm.samples).toEqual(decoded);
  });
});
