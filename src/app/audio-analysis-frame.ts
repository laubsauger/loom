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
import type { LeadPitchFrame } from "@domain/audio/analysis/pitch.ts";
import type { TonalFrame } from "@domain/audio/analysis/tonal-analyser.ts";
import { NO_TEMPO_CLAIM } from "@domain/audio/feature-track.ts";
import { CHROMA_NAMES, NOTE_VOICE_COUNT, NO_TONAL_CLAIM, type AudioTonalFields } from "@domain/audio/tonal-fields.ts";
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
  /**
   * T1751b: one tonal window. The LATEST one is what a frame reads, held until the next
   * arrives (a window every 43 ms against a frame every 17), the way the bands hold between
   * hops. Never called on a capture with no tonal pass, and the record then reads NO CLAIM.
   */
  pushTonal(frame: TonalFrame): void;
  /** T1755b: one lead-pitch reading. The latest is what a frame reads; its onsets are counted over the interval. */
  pushPitch(frame: LeadPitchFrame): void;
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
  let tonal: AudioTonalFields = NO_TONAL_CLAIM;
  /** T1753b: chord changes among the tonal windows since the last read — interval-shaped, like the detector counts. */
  let chordChanges = 0;
  /** T1755b: the latest lead-pitch reading, and the note onsets since the last read. */
  let pitch: LeadPitchFrame | null = null;
  let pitchOnsets = 0;
  /** T1756b: each voice's onsets among the tonal windows since the last read. */
  const voiceOnsets = new Array<number>(NOTE_VOICE_COUNT).fill(0);

  return {
    pushPitch(frame) {
      pitch = frame;
      if (frame.onset) pitchOnsets += 1;
    },
    pushTonal(frame) {
      const fields: Record<string, number> = { ...NO_TONAL_CLAIM };
      CHROMA_NAMES.forEach((name, pitchClass) => {
        fields[name] = frame.chroma[pitchClass] as number;
      });
      fields["chromaConfidence"] = frame.confidence;
      fields["tuning"] = frame.tuning;
      fields["tonalLag"] = frame.lag;
      // T1753b: the claims as the analyser makes them. `chordChangeCount` is written at the read.
      fields["chordRoot"] = frame.chord.root;
      fields["chordQuality"] = frame.chord.quality;
      fields["chordConfidence"] = frame.chord.confidence;
      fields["chordAge"] = frame.chord.age;
      fields["keyTonic"] = frame.key.tonic;
      fields["keyMode"] = frame.key.mode;
      fields["keyConfidence"] = frame.key.confidence;
      if (frame.chord.changed) chordChanges += 1;
      // T1756b: the voices as tracked. Each `voiceNOnsetCount` is written at the read.
      let alive = 0;
      for (let slot = 0; slot < NOTE_VOICE_COUNT; slot += 1) {
        const voice = frame.voices[slot];
        if (voice === undefined) continue;
        const prefix = `voice${String(slot)}`;
        fields[`${prefix}Pitch`] = voice.pitch;
        fields[`${prefix}Level`] = voice.level;
        fields[`${prefix}Confidence`] = voice.confidence;
        fields[`${prefix}Age`] = voice.age;
        fields[`${prefix}Id`] = voice.id;
        if (voice.confidence > 0) alive += 1;
        if (voice.onset) voiceOnsets[slot] = (voiceOnsets[slot] as number) + 1;
      }
      fields["voiceCount"] = alive;
      tonal = fields as unknown as AudioTonalFields;
    },
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
        ...tonal,
        chordChangeCount: chordChanges,
        ...(pitch === null ? {} : { pitch: pitch.pitch, pitchConfidence: pitch.confidence, pitchLag: pitch.lag }),
        pitchOnsetCount: pitchOnsets,
        ...Object.fromEntries(voiceOnsets.map((onsets, slot) => [`voice${String(slot)}OnsetCount`, onsets])),
      };
      const frame: AudioFrameFeatures = { features, hops };
      hops = 0;
      chordChanges = 0;
      pitchOnsets = 0;
      voiceOnsets.fill(0);
      count = 0;
      max = 0;
      bandFlux.fill(0);
      bandEvents.fill(0);
      return frame;
    },
  };
}
