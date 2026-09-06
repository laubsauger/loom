import type { AudioFeatures } from "@domain/types/frame.ts";
import { createHopAnalyser } from "@domain/audio/analysis/hop-analyser.ts";
import { beatTrack, estimateBar } from "@domain/audio/analysis/tempo.ts";
import { NO_TEMPO_CLAIM, createFeatureTrackRecorder } from "@domain/audio/feature-track.ts";
import type { FeatureTrack } from "@domain/audio/feature-track.ts";
import { createAudioHopReducer } from "./audio-analysis-frame.ts";
import { analysisOptionsFor } from "./audio-analysis-protocol.ts";
import type { DetectorSettings } from "./audio-analysis-protocol.ts";

/**
 * T1229 — OFFLINE pre-analysis of a whole file: the SAME engine the live path runs, walked
 * over decoded PCM on the project's frame grid, into a playhead-indexed `FeatureTrack`.
 *
 * ## Why the same core, and why per frame
 *
 * The live path is worklet hops (`audio-analysis.worklet.ts`, windows of `fftSize` ending
 * every `hop` samples) reduced into one record per displayed frame (`audio-analysis-frame.ts`,
 * "the hops that arrived since the last read"). This walk is that, made deterministic: hop
 * `k` is the window ending at sample `fftSize + k·hop`, and frame `i` of the track reduces
 * the hops whose window ends in `((i − 1)·sr/fps, i·sr/fps]` — what a frame loop running
 * exactly on time would have read at `i/fps`. Same picker, same reducer, so the record a
 * scrub lands on is the one the live path would have produced on a perfect clock, not a
 * second opinion computed by a different detector.
 *
 * Bit-exact by construction: pure functions of the samples, the settings and `fps`. Two
 * walks of the same PCM produce identical frames, which is what makes a scrub under
 * `playMode: timeline` reproducible and an offline render of it exact (§T431's replay half).
 *
 * ## Tempo is whole-track, so it is written back into every frame
 *
 * The live record's tempo fields hold a claim made while listening (T1228, `NO_TEMPO_CLAIM`
 * otherwise). Offline the whole file is in hand, so the claim is the track's: one BPM from
 * the whole-spectrum SuperFlux envelope (`bandFlux[0]`, Ellis's programme in `tempo.ts`),
 * and per frame the phase against the tracked beats — interpolated between two beats, and
 * extrapolated at the global period before the first and after the last. `bpmConfidence`
 * stays strictly below 1: 1 is DECLARED (`audio.ts`), and an estimate never is.
 *
 * The bar estimate is NOT in the record — there is no `bar` field in `AudioFeatures`, and
 * adding one to carry a guess would make every recording answer for it (§V352). It rides in
 * the result for the status line, where a person can copy it into the node's Declared knobs.
 */

export interface OfflineTempo {
  readonly bpm: number;
  /** In (0, 1) when a claim is made; 0 when the envelope gave nothing to claim. */
  readonly confidence: number;
}

export interface OfflineBar {
  /** 3 or 4, or 0 for no estimate. */
  readonly beatsPerBar: number;
  /** The first downbeat, in seconds from the start of the file; 0 with no estimate. */
  readonly downbeatSeconds: number;
  readonly confidence: number;
}

export interface OfflineAnalysis {
  readonly track: FeatureTrack;
  readonly tempo: OfflineTempo;
  readonly bar: OfflineBar;
  /** The tracked beats, in seconds from the start of the file. */
  readonly beats: readonly number[];
}

/** An estimate's ceiling: 1 is `bpmConfidence`'s DECLARED value, so an estimate stops short of it. */
const ESTIMATE_CONFIDENCE_CEILING = 0.99;

/**
 * Walks `samples` (mono, at `sampleRate`) into a `FeatureTrack` at `fps` under `detector`.
 *
 * A beat's time is the END of the hop window that fired it (`(fftSize + k·hop) / sr`), which
 * is where the live path reports it too — up to one window late of the sound itself, and
 * the same lateness for every beat, so phase between beats is unaffected.
 */
export function analyseOffline(
  samples: Float32Array,
  sampleRate: number,
  fps: number,
  detector: DetectorSettings,
): OfflineAnalysis {
  if (!(sampleRate > 0) || !(fps > 0)) throw new Error(`analyseOffline: bad rates ${String(sampleRate)}/${String(fps)}`);
  const options = analysisOptionsFor(detector, sampleRate);
  const { fftSize, hop } = options;
  const analyser = createHopAnalyser({ ...options, sampleRate });
  const reducer = createAudioHopReducer(fftSize, sampleRate);
  const recorder = createFeatureTrackRecorder(fps, { detector });
  const samplesPerFrame = sampleRate / fps;
  // Frames up to and including the one at the file's end, so a playhead at `duration` reads
  // a recorded frame rather than SILENCE.
  const frameCount = Math.ceil(samples.length / samplesPerFrame) + 1;

  // The worklet copies each window into a Float64Array before analysing; same here, so
  // the engine sees the same numbers (a float32 sample is exact in float64).
  const window = new Float64Array(fftSize);
  const envelope: number[] = [];
  const frames: AudioFeatures[] = [];
  let cursor = 0;
  for (let end = fftSize; end <= samples.length; end += hop) {
    const frame = Math.ceil(end / samplesPerFrame);
    while (cursor < frame) {
      frames.push(reducer.read().features);
      cursor += 1;
    }
    for (let i = 0; i < fftSize; i += 1) window[i] = samples[end - fftSize + i] as number;
    const features = analyser.analyse(window);
    envelope.push(features.bandFlux[0] as number);
    reducer.push(features);
  }
  while (cursor < frameCount) {
    frames.push(reducer.read().features);
    cursor += 1;
  }

  const hopRate = sampleRate / hop;
  const tracked = beatTrack(new Float64Array(envelope), { hopRate });
  const beats = tracked.beats.map((index) => (fftSize + index * hop) / sampleRate);
  const claimed = tracked.tempo.confidence > 0 && beats.length >= 2;
  const tempo: OfflineTempo = claimed
    ? { bpm: tracked.tempo.bpm, confidence: Math.min(tracked.tempo.confidence, ESTIMATE_CONFIDENCE_CEILING) }
    : { bpm: 0, confidence: 0 };
  const phase = claimed ? beatPhaseReader(beats, 60 / tempo.bpm, frameCount / fps) : null;

  for (let index = 0; index < frameCount; index += 1) {
    const features = frames[index] as AudioFeatures;
    const time = index / fps;
    recorder.capture(
      index,
      phase === null
        ? { ...features, ...NO_TEMPO_CLAIM }
        : {
            ...features,
            bpm: tempo.bpm,
            bpmConfidence: tempo.confidence,
            ...phase(time, index === 0 ? -Infinity : (index - 1) / fps),
          },
    );
  }

  const barEstimate = estimateBar(new Float64Array(envelope), tracked.beats);
  const bar: OfflineBar =
    barEstimate.beatsPerBar === 0 || barEstimate.downbeat < 0
      ? { beatsPerBar: 0, downbeatSeconds: 0, confidence: 0 }
      : { beatsPerBar: barEstimate.beatsPerBar, downbeatSeconds: beats[barEstimate.downbeat] as number, confidence: barEstimate.confidence };

  return { track: recorder.track(), tempo, bar, beats };
}

/**
 * The per-frame tempo fields from the tracked beats: the grid is the beats themselves,
 * extended at `period` back to the start of the file and forward past its end, so every
 * frame time sits between two grid beats. `beat` counts grid beats at or before the frame
 * from the start of the file; `beatCount` is those in `(previousTime, time]` (§V357's
 * interval shape).
 */
function beatPhaseReader(
  beats: readonly number[],
  period: number,
  endSeconds: number,
): (time: number, previousTime: number) => Pick<AudioFeatures, "beatPhase" | "beat" | "beatCount"> {
  const grid: number[] = [];
  for (let time = (beats[0] as number) - period; time >= 0; time -= period) grid.unshift(time);
  grid.push(...beats);
  for (let time = (beats[beats.length - 1] as number) + period; time <= endSeconds + period; time += period) grid.push(time);
  const before = (grid[0] as number) - period;

  return (time, previousTime) => {
    // Grid beats at or before `time`: the count is `beat`, and the last of them anchors the phase.
    let count = 0;
    while (count < grid.length && (grid[count] as number) <= time) count += 1;
    const previous = count === 0 ? before : (grid[count - 1] as number);
    const next = count < grid.length ? (grid[count] as number) : previous + period;
    const span = next - previous;
    let beatCount = 0;
    for (let index = count - 1; index >= 0 && (grid[index] as number) > previousTime; index -= 1) beatCount += 1;
    return { beatPhase: span > 0 ? (time - previous) / span : 0, beat: count, beatCount };
  };
}
