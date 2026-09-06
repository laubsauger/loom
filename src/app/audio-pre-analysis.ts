import type { AudioFeatures } from "@domain/types/frame.ts";
import { readFeatureFrame } from "@domain/audio/feature-track.ts";
import type { FeatureTrack } from "@domain/audio/feature-track.ts";
import { mediaPlayhead } from "@domain/media/transport.ts";
import type { MediaTransportValues } from "@domain/media/transport.ts";
import { analyseOffline } from "./audio-offline-analysis.ts";
import type { OfflineAnalysis } from "./audio-offline-analysis.ts";
import type { DetectorSettings } from "./audio-analysis-protocol.ts";

/**
 * T1229 — from a bound file's BYTES to its `OfflineAnalysis`: decode, hash, walk, cache.
 *
 * ## Decoded at a FIXED rate
 *
 * The walk is bit-exact in its inputs, so its inputs must not depend on the machine. An
 * `AudioContext` decodes at the DEVICE's rate — 44.1 kHz on one interface, 48 on the next
 * — and the hop grid, the picker's gap in hops and the tempo grid all follow the rate. A
 * reproducible offline render cannot have its beats move because a different audio
 * interface was plugged in, so the decode goes through an `OfflineAudioContext` pinned to
 * `PRE_ANALYSIS_SAMPLE_RATE`, and the live capture's rate (which the AudioContext owns) is
 * simply not consulted. Mixed to mono as the worklet hears it (`channelCount: 1`).
 *
 * ## Cached in memory, by content
 *
 * Keyed by the SHA-256 of the file bytes plus everything else the walk reads (`fps` and the
 * detector knobs) — never by URL, which a blob: source changes on every pick. A re-bound
 * file or a re-pick of the same file is a hit; a knob change is a miss and a fresh walk.
 * The cache lives for the session. Persisting it across reloads (the asset row, §T230) is
 * the named follow-up; the key here is the one that store would use.
 *
 * ## Off the main thread, with a named fallback
 *
 * A five-minute track walks in about two seconds; on the frame loop that is two seconds of
 * dropped frames. The walk runs in a Worker and, where no Worker can be made or the one
 * made fails, on the main thread with the reason in the outcome (§V288: the status line
 * says so rather than the session silently stuttering once and never explaining).
 */

export const PRE_ANALYSIS_SAMPLE_RATE = 48_000;

export interface OfflineAnalysisRequest {
  readonly id: number;
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly fps: number;
  readonly detector: DetectorSettings;
}

export type OfflineAnalysisResponse =
  | { readonly id: number; readonly analysis: OfflineAnalysis }
  | { readonly id: number; readonly failure: string };

export interface MonoPcm {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** The slice of `AudioBuffer` the mix reads, so a test can hand in a plain object. */
export interface DecodedChannels {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** The mean of the channels — what a `channelCount: 1` worklet input receives. */
export function mixToMono(buffer: DecodedChannels): MonoPcm {
  const samples = new Float32Array(buffer.length);
  const channels = Math.max(1, buffer.numberOfChannels);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] as number) + (data[i] as number) / channels;
  }
  return { samples, sampleRate: buffer.sampleRate };
}

/** Decode through an `OfflineAudioContext` pinned to the fixed rate — see the docblock for why. */
export async function decodeAtFixedRate(bytes: ArrayBuffer): Promise<MonoPcm> {
  if (typeof OfflineAudioContext === "undefined") throw new Error("This environment has no OfflineAudioContext to decode with.");
  const context = new OfflineAudioContext(1, 1, PRE_ANALYSIS_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes.slice(0));
  return mixToMono(buffer);
}

export async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function preAnalysisKey(hash: string, fps: number, detector: DetectorSettings): string {
  return `${hash}|${String(fps)}|${String(detector.threshold)}|${String(detector.retrigger)}`;
}

/** One walk in a Worker of its own; rejects with the reason where it could not run there. */
export function runInWorker(request: OfflineAnalysisRequest): Promise<OfflineAnalysis> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("this environment has no Worker"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./audio-offline-analysis.worker.ts", import.meta.url), { type: "module" });
    const done = (): void => worker.terminate();
    worker.onmessage = (event: MessageEvent<OfflineAnalysisResponse>) => {
      if (event.data.id !== request.id) return;
      done();
      if ("failure" in event.data) reject(new Error(event.data.failure));
      else resolve(event.data.analysis);
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(event.message || "the worker failed"));
    };
    // The samples are handed over, not copied: the caller's copy is gone after this.
    worker.postMessage(request, [request.samples.buffer]);
  });
}

export interface PreAnalysisOutcome {
  readonly analysis: OfflineAnalysis;
  /** Null when the walk ran off the main thread; otherwise the reason it did not. */
  readonly fallback: string | null;
}

export interface PreAnalyserDeps {
  readonly decode: (bytes: ArrayBuffer) => Promise<MonoPcm>;
  readonly hash: (bytes: ArrayBuffer) => Promise<string>;
  readonly run: (request: OfflineAnalysisRequest) => Promise<OfflineAnalysis>;
}

export interface PreAnalyser {
  analyse(bytes: ArrayBuffer, fps: number, detector: DetectorSettings): Promise<PreAnalysisOutcome>;
}

const BROWSER_DEPS: PreAnalyserDeps = { decode: decodeAtFixedRate, hash: contentHash, run: runInWorker };

export function createPreAnalyser(deps: Partial<PreAnalyserDeps> = {}): PreAnalyser {
  const { decode, hash, run } = { ...BROWSER_DEPS, ...deps };
  // Promises, not results: two captures of one file in flight share the walk.
  const cache = new Map<string, Promise<PreAnalysisOutcome>>();
  let nextId = 0;

  const walk = async (bytes: ArrayBuffer, fps: number, detector: DetectorSettings): Promise<PreAnalysisOutcome> => {
    const { samples, sampleRate } = await decode(bytes);
    const id = nextId;
    nextId += 1;
    try {
      // The worker takes the buffer with it; the fallback below needs its own copy.
      const analysis = await run({ id, samples: samples.slice(0), sampleRate, fps, detector });
      return { analysis, fallback: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        analysis: analyseOffline(samples, sampleRate, fps, detector),
        fallback: `Pre-analysis ran on the main thread: ${reason}.`,
      };
    }
  };

  return {
    async analyse(bytes, fps, detector) {
      const key = preAnalysisKey(await hash(bytes), fps, detector);
      const held = cache.get(key);
      if (held !== undefined) return held;
      const pending = walk(bytes, fps, detector);
      cache.set(key, pending);
      // A failed decode is not a result to keep: the next bind tries again.
      pending.catch(() => cache.delete(key));
      return pending;
    },
  };
}

/**
 * The timeline read: the track's frame at where the transport puts the file at
 * `timelineSeconds` — the SAME `mediaPlayhead` arithmetic `sync` applies to the element
 * (under the lock, elapsed IS the timeline), so trim, cue and extend index the track
 * exactly as they position the sound. A pure function of its arguments: that is the
 * whole of "bit-exact scrub" — read frame N after any history, or first, and it is the
 * same record. Past the file's end, or before it under `extend: "black"`, it is SILENCE.
 */
export function readTrackAtPlayhead(
  track: FeatureTrack,
  transport: MediaTransportValues,
  timelineSeconds: number,
  duration: number,
): AudioFeatures {
  const head = mediaPlayhead(transport, timelineSeconds, duration);
  if (!head.visible) return readFeatureFrame(track, -1);
  return readFeatureFrame(track, Math.floor(head.position * track.fps));
}
