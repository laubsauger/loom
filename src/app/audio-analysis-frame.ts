/**
 * T1226 — hops in, one frame's `AudioFeatures` out.
 *
 * The worklet posts a hop every 512 samples; the frame driver reads once per displayed
 * frame. This reducer sits between them and is where §V357's two fields get their hop
 * fidelity: over the hops that ARRIVED since the last read, `onsetCount` is the number of
 * rising crossings of the fixed event level (several per interval are now countable) and
 * `onsetMax` is the peak of the hop flux (the interval's true max, not the last reading).
 *
 * Everything else stays v1 by construction: the bands, `level` and `onset` come from
 * `computeAudioFeatures` on the LATEST hop's bytes — the same function on the same shape
 * of bytes as the polled path, only with the bytes taken on a hop grid instead of at
 * rAF. A frame with no new hop (a 120 Hz display outruns a 94 Hz hop grid now and then)
 * reads the same bytes again: same bands, flux 0, nothing counted — what the analyser
 * would report between two quanta too. Before the first hop the bytes are silence
 * (frequency 0, time-domain 128).
 *
 * `bandFlux` (interval max) and `bandEvents` (interval count) per SuperFlux stream are
 * reduced the same way and returned beside the v1 record for T1227 to write into v2;
 * nothing reads them yet, which is deliberate (the record is written from what the
 * engine delivers, then consumed).
 *
 * Pure of the clock and the port: a test feeds hops and reads frames.
 */
import type { AudioFeatures } from "@domain/types/frame.ts";
import type { HopFeatures } from "@domain/audio/analysis/hop-analyser.ts";
import { computeAudioFeatures, type AudioAnalysisState } from "./audio-features.ts";

export interface AudioFrameFeatures {
  /** The v1 record: bands, level and onset from the latest hop; count and max over the interval. */
  readonly features: AudioFeatures;
  /** Hops that arrived since the previous read. */
  readonly hops: number;
  /** Per SuperFlux stream (0 whole spectrum, then the bands): the interval's max flux. */
  readonly bandFlux: readonly number[];
  /** Per stream: adaptive events in the interval. */
  readonly bandEvents: readonly number[];
}

export interface AudioHopReducer {
  push(hop: HopFeatures): void;
  /** Reduce everything pushed since the last read into one frame, and start the next interval. */
  read(): AudioFrameFeatures;
}

export function createAudioHopReducer(fftSize: number, sampleRate: number, streams: number): AudioHopReducer {
  const state: AudioAnalysisState = { previousSpectrum: null, previousOnset: 0 };
  let frequency: Uint8Array = new Uint8Array(fftSize / 2);
  let timeDomain: Uint8Array = new Uint8Array(fftSize).fill(128);
  let hops = 0;
  let count = 0;
  let max = 0;
  const bandFlux = new Array<number>(streams).fill(0);
  const bandEvents = new Array<number>(streams).fill(0);

  return {
    push(hop) {
      frequency = hop.frequency;
      timeDomain = hop.timeDomain;
      hops += 1;
      if (hop.event) count += 1;
      if (hop.flux > max) max = hop.flux;
      for (let stream = 0; stream < streams; stream += 1) {
        const flux = hop.bandFlux[stream] ?? 0;
        if (flux > (bandFlux[stream] as number)) bandFlux[stream] = flux;
        if (hop.bandEvents[stream]) bandEvents[stream] = (bandEvents[stream] as number) + 1;
      }
    },
    read() {
      const v1 = computeAudioFeatures({ frequency, timeDomain, sampleRate, fftSize, state });
      const features: AudioFeatures =
        hops === 0
          ? v1
          : {
              ...v1,
              // The frame-to-frame reading is itself one reading of the interval; the hop
              // grid can only ADD readings, never lose that one. A rise spread over the
              // whole interval crosses the level frame-to-frame and on no single hop —
              // the polled path counted it, so this path counts it too (max, not sum:
              // one rise is one event however many grids see it).
              onsetCount: Math.max(count, v1.onsetCount),
              onsetMax: Math.max(v1.onset, max),
            };
      const frame: AudioFrameFeatures = { features, hops, bandFlux: [...bandFlux], bandEvents: [...bandEvents] };
      hops = 0;
      count = 0;
      max = 0;
      bandFlux.fill(0);
      bandEvents.fill(0);
      return frame;
    },
  };
}
