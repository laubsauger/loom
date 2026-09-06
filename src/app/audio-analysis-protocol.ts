/**
 * T1225/T1226 — what crosses the port between the main thread and the analysis worklet.
 *
 * Side-effect free on purpose: the worklet module registers a processor when it is
 * evaluated, so nothing on the main thread may import IT — both sides import this.
 *
 * Every decision the engine makes is CONFIGURED from here (`AUDIO_ANALYSIS_OPTIONS`) and
 * travels to the audio thread as `processorOptions`, so the worklet holds no numbers of
 * its own and the main thread — the side a test can reach — is the one place a hop
 * size or a threshold is chosen (§V747).
 */
import type { HopAnalyserOptions, HopFeatures } from "@domain/audio/analysis/hop-analyser.ts";
import { AUDIO_BAND_EDGES_HZ, ONSET_EVENT_THRESHOLD } from "./audio-features.ts";

export const AUDIO_ANALYSIS_PROCESSOR_NAME = "loom-audio-analysis";

/** What the main thread hands `AudioWorkletNode` as `processorOptions`. The sample rate is the context's. */
export interface AudioAnalysisProcessorOptions extends Omit<HopAnalyserOptions, "sampleRate"> {
  /** Samples between analysed windows. */
  readonly hop: number;
}

/**
 * The engine as shipped. 2048/512 is a 42.7 ms window every 10.7 ms at 48 kHz — four
 * hops per 60 Hz frame, so §V357's count and max are real. The band edges and the v1
 * event level are `audio-features.ts`'s, so a hop's `flux`/`event` mean what a frame's
 * `onset`/`onsetCount` always meant. SuperFlux lag 2 (21 ms) with a ±1 bin (±23 Hz) max
 * filter is Böck's setting scaled to this grid. The picker's ~1 s history (96 hops),
 * 0.05 floor (≈13 byte-levels of mean rise in a band) and 32 ms gap are first values:
 * nothing consumes `bandEvents` until the v2 record (T1227), which is where they get
 * measured against material and retuned.
 */
export const AUDIO_ANALYSIS_OPTIONS: AudioAnalysisProcessorOptions = {
  fftSize: 2048,
  hop: 512,
  bands: [AUDIO_BAND_EDGES_HZ.low, AUDIO_BAND_EDGES_HZ.lowMid, AUDIO_BAND_EDGES_HZ.highMid, AUDIO_BAND_EDGES_HZ.high],
  eventThreshold: ONSET_EVENT_THRESHOLD,
  superflux: { lag: 2, halfWidth: 1 },
  picker: { historyHops: 96, delta: 0.05, minGapHops: 3 },
};

/** One analysed window, posted per hop. `end` is the processor's sample count at the window's end. */
export interface AudioAnalysisHopMessage extends HopFeatures {
  readonly type: "hop";
  readonly end: number;
}

/** A barrier: every hop posted before the ping arrives before its pong. */
export interface AudioAnalysisPingMessage {
  readonly type: "ping";
  readonly id: number;
}

export interface AudioAnalysisPongMessage {
  readonly type: "pong";
  readonly id: number;
}

export type AudioAnalysisWorkletMessage = AudioAnalysisHopMessage | AudioAnalysisPongMessage;
