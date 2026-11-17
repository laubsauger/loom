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
import { createLeadPitch, type LeadPitch } from "@domain/audio/analysis/pitch.ts";
import { createTonalAnalyser, type TonalAnalyser } from "@domain/audio/analysis/tonal-analyser.ts";
import {
  AUDIO_ANALYSIS_PROCESSOR_NAME,
  type AudioAnalysisHopMessage,
  type AudioAnalysisPitchMessage,
  type AudioAnalysisTonalMessage,
  type AudioAnalysisPingMessage,
  type AudioAnalysisPongMessage,
  type AudioAnalysisProcessorOptions,
  type AudioAnalysisStopMessage,
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
  /** §T1548b: told the capture is over; `process` lets the node go. */
  private stopped = false;
  /** T1751b: the tonal pass, when the capture asked for one. */
  private readonly tonal: { readonly engine: TonalAnalyser; readonly windowSize: number; readonly hop: number; readonly frame: Float64Array } | null;
  private nextTonalEnd = 0;
  private tonalFrames = 0;
  /** T1755b: the lead pitch, on the hop window, when the capture asked for the tonal pass. */
  private readonly pitch: LeadPitch | null;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { hop, tonal, ...analyser } = (options?.processorOptions ?? {}) as Partial<AudioAnalysisProcessorOptions>;
    if (!hop || hop <= 0 || !analyser.fftSize) {
      throw new Error(`audio analysis worklet: fftSize and a positive hop are required, got ${analyser.fftSize}/${hop}`);
    }
    // The core validates the rest and throws by name; a throw here surfaces as `processorerror`.
    this.engine = createHopAnalyser({ ...(analyser as Omit<AudioAnalysisProcessorOptions, "hop">), sampleRate });
    this.fftSize = analyser.fftSize;
    this.hop = hop;
    this.pitch = tonal === undefined ? null : createLeadPitch({ sampleRate, windowSize: analyser.fftSize, hop, everyHops: tonal.pitchEveryHops });
    if (tonal === undefined) this.tonal = null;
    else {
      if (!(tonal.hop > 0)) throw new Error(`audio analysis worklet: the tonal hop must be positive, got ${tonal.hop}`);
      this.tonal = {
        engine: createTonalAnalyser({ sampleRate, windowSize: tonal.windowSize }),
        windowSize: tonal.windowSize,
        hop: tonal.hop,
        frame: new Float64Array(tonal.windowSize),
      };
      this.nextTonalEnd = tonal.windowSize;
    }
    // Room for the longest window plus the quantum that completes it, at any hop alignment.
    // Both windows are powers of two (each core throws otherwise), so the larger one doubled is too.
    this.ring = new Float32Array(Math.max(this.fftSize, tonal?.windowSize ?? 0) * 2);
    this.frame = new Float64Array(this.fftSize);
    this.nextEnd = this.fftSize;
    this.port.onmessage = (event: MessageEvent<AudioAnalysisPingMessage | AudioAnalysisStopMessage>) => {
      if (event.data?.type === "stop") this.stopped = true;
      else if (event.data?.type === "ping") {
        const pong: AudioAnalysisPongMessage = { type: "pong", id: event.data.id };
        this.port.postMessage(pong);
      }
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
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
      // T1755b: the same window, read for its pitch on the hops the pass takes.
      const pitched = this.pitch?.push(this.frame) ?? null;
      if (pitched !== null) {
        const pitchMessage: AudioAnalysisPitchMessage = { type: "pitch", end, ...pitched };
        this.port.postMessage(pitchMessage);
      }
      this.nextEnd += this.hop;
    }
    const tonal = this.tonal;
    while (tonal !== null && this.written >= this.nextTonalEnd) {
      const end = this.nextTonalEnd;
      const start = end - tonal.windowSize;
      for (let i = 0; i < tonal.windowSize; i += 1) tonal.frame[i] = ring[(start + i) & mask] as number;
      const frame = tonal.engine.analyse(tonal.frame, this.tonalFrames === 0 ? 0 : tonal.hop);
      this.tonalFrames += 1;
      const message: AudioAnalysisTonalMessage = { type: "tonal", end, ...frame };
      this.port.postMessage(message, [frame.chroma.buffer]);
      this.nextTonalEnd += tonal.hop;
    }
    return true;
  }
}

registerProcessor(AUDIO_ANALYSIS_PROCESSOR_NAME, AudioAnalysisProcessor);
