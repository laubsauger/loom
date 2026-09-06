/**
 * T1226 — hops in, one frame's `AudioFeatures` out.
 *
 * The worklet posts a hop every 512 samples; the frame driver reads once per displayed
 * frame. This reducer sits between them and is where §V357's two fields get their hop
 * fidelity: over the hops that ARRIVED since the last read, `onsetCount` is the number of
 * rising crossings of the fixed event level (several per interval are now countable) and
 * `onsetMax` is the peak of the hop flux (the interval's true max, not the last reading).
 *
 * Everything v1 stays v1 by construction: the bands, `level` and `onset` come from
 * `computeAudioFeatures` on the LATEST hop's bytes — the same function on the same shape
 * of bytes as the polled path, only with the bytes taken on a hop grid instead of at
 * rAF. A frame with no new hop (a 120 Hz display outruns a 94 Hz hop grid now and then)
 * reads the same bytes again: same bands, flux 0, nothing counted — what the analyser
 * would report between two quanta too. Before the first hop the bytes are silence
 * (frequency 0, time-domain 128).
 *
 * T1227 — the v2 record is written HERE from what the streams deliver: per detector
 * stream (`DETECTOR_STREAM`), the interval's max SuperFlux is the envelope (`kick`) and
 * the interval's adaptive events are the count (`kickCount`) — interval-shaped like
 * `onsetMax`/`onsetCount`, for the same reason. `centroid` rides with the bytes. The
 * tempo fields are `NO_TEMPO_CLAIM` until something makes one (T1228).
 *
 * Pure of the clock and the port: a test feeds hops and reads frames. The polled
 * fallback feeds it too (`use-audio-input.ts`), one window per frame instead of four.
 */
import type { AudioFeatures } from "@domain/types/frame.ts";
import type { HopFeatures } from "@domain/audio/analysis/hop-analyser.ts";
import { NO_TEMPO_CLAIM } from "@domain/audio/feature-track.ts";
import { DETECTOR_STREAM, STREAM_COUNT } from "./audio-analysis-protocol.ts";
import { computeAudioFeatures, type AudioAnalysisState } from "./audio-features.ts";

export interface AudioFrameFeatures {
  /** The v2 record: bytes-derived fields from the latest hop; counts and maxima over the interval. */
  readonly features: AudioFeatures;
  /** Hops that arrived since the previous read. */
  readonly hops: number;
}

export interface AudioHopReducer {
  push(hop: HopFeatures): void;
  /** Reduce everything pushed since the last read into one frame, and start the next interval. */
  read(): AudioFrameFeatures;
}

export function createAudioHopReducer(fftSize: number, sampleRate: number): AudioHopReducer {
  const state: AudioAnalysisState = { previousSpectrum: null, previousOnset: 0 };
  let frequency: Uint8Array = new Uint8Array(fftSize / 2);
  let timeDomain: Uint8Array = new Uint8Array(fftSize).fill(128);
  let hops = 0;
  let count = 0;
  let max = 0;
  const bandFlux = new Float64Array(STREAM_COUNT);
  const bandEvents = new Uint32Array(STREAM_COUNT);

  return {
    push(hop) {
      if (hop.bandFlux.length !== STREAM_COUNT || hop.bandEvents.length !== STREAM_COUNT) {
        throw new Error(
          `audio hop reducer: expected ${STREAM_COUNT} streams, got ${hop.bandFlux.length}/${hop.bandEvents.length}`,
        );
      }
      frequency = hop.frequency;
      timeDomain = hop.timeDomain;
      hops += 1;
      if (hop.event) count += 1;
      if (hop.flux > max) max = hop.flux;
      for (let stream = 0; stream < STREAM_COUNT; stream += 1) {
        const flux = hop.bandFlux[stream] as number;
        if (flux > (bandFlux[stream] as number)) bandFlux[stream] = flux;
        if (hop.bandEvents[stream]) bandEvents[stream] = (bandEvents[stream] as number) + 1;
      }
    },
    read() {
      const spectral = computeAudioFeatures({ frequency, timeDomain, sampleRate, fftSize, state });
      const features: AudioFeatures = {
        ...spectral,
        // The frame-to-frame reading is itself one reading of the interval; the hop
        // grid can only ADD readings, never lose that one. A rise spread over the
        // whole interval crosses the level frame-to-frame and on no single hop —
        // the polled path counted it, so this path counts it too (max, not sum:
        // one rise is one event however many grids see it).
        onsetCount: Math.max(count, spectral.onsetCount),
        onsetMax: Math.max(spectral.onset, max),
        kick: bandFlux[DETECTOR_STREAM.kick] as number,
        kickCount: bandEvents[DETECTOR_STREAM.kick] as number,
        snare: bandFlux[DETECTOR_STREAM.snare] as number,
        snareCount: bandEvents[DETECTOR_STREAM.snare] as number,
        hat: bandFlux[DETECTOR_STREAM.hat] as number,
        hatCount: bandEvents[DETECTOR_STREAM.hat] as number,
        ...NO_TEMPO_CLAIM,
      };
      const frame: AudioFrameFeatures = { features, hops };
      hops = 0;
      count = 0;
      max = 0;
      bandFlux.fill(0);
      bandEvents.fill(0);
      return frame;
    },
  };
}
