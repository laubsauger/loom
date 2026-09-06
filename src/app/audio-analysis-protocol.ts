/**
 * T1225 — what crosses the port between the main thread and the analysis worklet.
 *
 * Side-effect free on purpose: the worklet module registers a processor when it is
 * evaluated, so nothing on the main thread may import IT — both sides import this.
 */

export const AUDIO_ANALYSIS_PROCESSOR_NAME = "loom-audio-analysis";

/** What the main thread hands `AudioWorkletNode` as `processorOptions`. */
export interface AudioAnalysisProcessorOptions {
  readonly fftSize: number;
  readonly hop: number;
}

/** One analysed window, posted per hop. `end` is the processor's sample count at the window's end. */
export interface AudioAnalysisHopMessage {
  readonly type: "hop";
  readonly end: number;
  /** `fftSize / 2` bytes, `getByteFrequencyData`-shaped. */
  readonly frequency: Uint8Array;
  /** `fftSize` bytes, `getByteTimeDomainData`-shaped. */
  readonly timeDomain: Uint8Array;
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
