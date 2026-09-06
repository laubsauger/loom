/**
 * T1225 — the audio analysis worklet: the analyser, on the AUDIO thread, at a fixed hop.
 *
 * Today's engine is one `AnalyserNode` polled once per displayed frame: whatever 2048
 * samples it happens to hold when rAF fires. Transients that land between two polls are
 * never seen (`audio-features.ts` T437 note). This processor sees every render quantum,
 * keeps the last `fftSize` samples in a ring, and every `hop` samples runs the SAME
 * analysis the node runs (`@domain/audio/analysis/stft.ts`) — posting the two byte
 * arrays `computeAudioFeatures` already eats. The main thread accumulates hops between
 * displayed frames; nothing downstream of `FrameInputs.audio` learns how the bytes were
 * made.
 *
 * This file is the THREAD SHIM (§V747): ring, hop schedule, message port. No analysis
 * math lives here; the port protocol is `audio-analysis-protocol.ts` (nothing on the
 * main thread may import THIS file — evaluating it registers a processor). It is loaded
 * through `audio-analysis-worklet-url.ts`; T1226 wires it
 * into `use-audio-input.ts`, this row only proves it loads under Vite and matches the
 * node byte for byte (`src/tests/e2e/audio-worklet-parity.spec.ts`).
 */
import { analyserBytes, blackmanWindow } from "@domain/audio/analysis/stft.ts";
import {
  AUDIO_ANALYSIS_PROCESSOR_NAME,
  type AudioAnalysisHopMessage,
  type AudioAnalysisPingMessage,
  type AudioAnalysisPongMessage,
  type AudioAnalysisProcessorOptions,
} from "./audio-analysis-protocol.ts";

/*
 * `lib.dom` types the node side of the worklet (`AudioWorkletNode`) and nothing of the
 * global scope this file runs in. The three names below are the whole surface it uses.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class AudioAnalysisProcessor extends AudioWorkletProcessor {
  private readonly fftSize: number;
  private readonly hop: number;
  private readonly ring: Float32Array;
  private readonly window: Float64Array;
  private readonly frame: Float64Array;
  private readonly scratch: Float64Array;
  /** Samples written so far; the ring index is `written % ring.length`. */
  private written = 0;
  /** The sample count at which the next window ends. */
  private nextEnd: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { fftSize, hop } = (options?.processorOptions ?? {}) as Partial<AudioAnalysisProcessorOptions>;
    if (!fftSize || !hop || (fftSize & (fftSize - 1)) !== 0 || hop <= 0) {
      throw new Error(`audio analysis worklet: fftSize must be a power of two and hop positive, got ${fftSize}/${hop}`);
    }
    this.fftSize = fftSize;
    this.hop = hop;
    // Room for a whole window plus the quantum that completes it, at any hop alignment.
    this.ring = new Float32Array(fftSize * 2);
    this.window = blackmanWindow(fftSize);
    this.frame = new Float64Array(fftSize);
    this.scratch = new Float64Array(fftSize / 2);
    this.nextEnd = fftSize;
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
      const frequency = new Uint8Array(this.fftSize / 2);
      const timeDomain = new Uint8Array(this.fftSize);
      analyserBytes(this.frame, this.window, frequency, timeDomain, this.scratch);
      const message: AudioAnalysisHopMessage = { type: "hop", end, frequency, timeDomain };
      this.port.postMessage(message, [frequency.buffer, timeDomain.buffer]);
      this.nextEnd += this.hop;
    }
    return true;
  }
}

registerProcessor(AUDIO_ANALYSIS_PROCESSOR_NAME, AudioAnalysisProcessor);
