/**
 * T1225/T1226 — the audio analysis worklet: the engine, on the AUDIO thread, at a fixed hop.
 *
 * Today's polled path is one `AnalyserNode` read once per displayed frame: whatever 2048
 * samples it happens to hold when rAF fires. Transients that land between two polls are
 * never seen (`audio-features.ts` T437 note). This processor sees every render quantum,
 * keeps the last `fftSize` samples in a ring, and every `hop` samples hands the window to
 * the engine core (`@domain/audio/analysis/hop-analyser.ts`) — posting the analyser-shaped
 * bytes `computeAudioFeatures` already eats plus the hop's flux and events. The main
 * thread accumulates hops between displayed frames (`audio-analysis-frame.ts`); nothing
 * downstream of `FrameInputs.audio` learns how the bytes were made.
 *
 * This file is the THREAD SHIM (§V747): ring, hop schedule, message port. No analysis
 * math and no constants live here — every option arrives as `processorOptions` from
 * `audio-analysis-protocol.ts` (nothing on the main thread may import THIS file —
 * evaluating it registers a processor). Loaded through `audio-analysis-worklet-url.ts`
 * by `use-audio-input.ts`.
 */
import { createHopAnalyser } from "@domain/audio/analysis/hop-analyser.ts";
import {
  AUDIO_ANALYSIS_PROCESSOR_NAME,
  type AudioAnalysisHopMessage,
  type AudioAnalysisPingMessage,
  type AudioAnalysisPongMessage,
  type AudioAnalysisProcessorOptions,
} from "./audio-analysis-protocol.ts";

/*
 * `lib.dom` types the node side of the worklet (`AudioWorkletNode`) and nothing of the
 * global scope this file runs in. The four names below are the whole surface it uses.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
/** The context's sample rate, a global of `AudioWorkletGlobalScope`. */
declare const sampleRate: number;

class AudioAnalysisProcessor extends AudioWorkletProcessor {
  private readonly fftSize: number;
  private readonly hop: number;
  private readonly ring: Float32Array;
  private readonly frame: Float64Array;
  private readonly engine: ReturnType<typeof createHopAnalyser>;
  /** Samples written so far; the ring index is `written % ring.length`. */
  private written = 0;
  /** The sample count at which the next window ends. */
  private nextEnd: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { hop, ...analyser } = (options?.processorOptions ?? {}) as Partial<AudioAnalysisProcessorOptions>;
    if (!hop || hop <= 0 || !analyser.fftSize) {
      throw new Error(`audio analysis worklet: fftSize and a positive hop are required, got ${analyser.fftSize}/${hop}`);
    }
    // The core validates the rest and throws by name; a throw here surfaces as `processorerror`.
    this.engine = createHopAnalyser({ ...(analyser as Omit<AudioAnalysisProcessorOptions, "hop">), sampleRate });
    this.fftSize = analyser.fftSize;
    this.hop = hop;
    // Room for a whole window plus the quantum that completes it, at any hop alignment.
    this.ring = new Float32Array(this.fftSize * 2);
    this.frame = new Float64Array(this.fftSize);
    this.nextEnd = this.fftSize;
    this.port.onmessage = (event: MessageEvent<AudioAnalysisPingMessage>) => {
      if (event.data?.type === "ping") {
        const pong: AudioAnalysisPongMessage = { type: "pong", id: event.data.id };
        this.port.postMessage(pong);
      }
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    // A disconnected input renders as silence, exactly as the analyser would see it.
    const quantum = channel?.length ?? 128;
    const ring = this.ring;
    const mask = ring.length - 1;
    for (let i = 0; i < quantum; i += 1) {
      ring[(this.written + i) & mask] = channel ? (channel[i] as number) : 0;
    }
    this.written += quantum;

    while (this.written >= this.nextEnd) {
      const end = this.nextEnd;
      const start = end - this.fftSize;
      for (let i = 0; i < this.fftSize; i += 1) this.frame[i] = ring[(start + i) & mask] as number;
      const hop = this.engine.analyse(this.frame);
      const message: AudioAnalysisHopMessage = { type: "hop", end, ...hop };
      this.port.postMessage(message, [
        hop.frequency.buffer,
        hop.timeDomain.buffer,
        hop.bandFlux.buffer,
        hop.bandEvents.buffer,
      ]);
      this.nextEnd += this.hop;
    }
    return true;
  }
}

registerProcessor(AUDIO_ANALYSIS_PROCESSOR_NAME, AudioAnalysisProcessor);
