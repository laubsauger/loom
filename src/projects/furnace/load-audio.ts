import { readFileSync } from "node:fs";
import type { AudioFeatures } from "../../domain/types/frame.ts";
import type { FeatureTrack } from "../../domain/audio/feature-track.ts";
import { analyseOffline } from "../../app/audio-offline-analysis.ts";
import { readTrackAtPlayhead } from "../../app/audio-pre-analysis.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "../../nodes/definitions/audio.ts";
import { mediaTransportFrom } from "../../domain/media/transport.ts";

/**
 * T1354b — node-only: a WAV off disk, walked by the app's own offline analysis
 * (`analyseOffline`, what the pre-analysis worker runs), read per frame the way the app
 * reads a timeline-locked file. So a headless render hears the track as the app does.
 */

export interface DecodedWav {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly duration: number;
}

/** PCM WAV (8/16/24/32-bit int or 32-bit float), mixed to mono. */
export function decodeWav(path: string): DecodedWav {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path} is not a RIFF/WAVE file.`);
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { start: number; length: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      data = { start: body, length: Math.min(size, bytes.length - body) };
    }
    offset = body + size + (size % 2);
  }
  if (data === undefined || channels === 0) throw new Error(`${path}: no fmt/data chunk.`);
  if (format !== 1 && format !== 3) throw new Error(`${path}: WAV format ${format} is not PCM or float.`);
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = data.start + (frame * channels + channel) * width;
      sum +=
        format === 3 ? view.getFloat32(at, true)
        : bits === 16 ? view.getInt16(at, true) / 32768
        : bits === 24 ? ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608)
        : bits === 32 ? view.getInt32(at, true) / 2147483648
        : (view.getUint8(at) - 128) / 128;
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate, duration: frames / sampleRate };
}

export interface TrackSeam {
  readonly track: FeatureTrack;
  readonly duration: number;
  /** The harness `audio` seam: frame index → features, with the track started at `startSeconds`. */
  seam(fps: number, startSeconds: number): (frameIndex: number) => AudioFeatures | null;
}

/**
 * The offline analysis reads TRAILING windows: frame k carries the windows that ended in the
 * frame before it, so a transient reaches the lanes late. Measured on the working track
 * (82 kicks, low-band PCM onsets against the lane's kick frames, 2026-09-25): +27 ms median,
 * +47 ms p90 — and end to end the picture fires on the lane's own frame, so that is the whole
 * lag. Reading one analysis frame ahead moves the median to −3 ms; the owner still read the
 * picture as late (smoothed lanes add their own lag on top), so it reads TWO ahead: the picture
 * about 30 ms early — inside what the eye forgives when light leads sound (a flash seen before
 * its bang is physical; the reverse is not).
 */
export const ANALYSIS_LOOKAHEAD_FRAMES = 2;

export function walkTrack(path: string, fps: number): TrackSeam {
  const wav = decodeWav(path);
  const { track } = analyseOffline(wav.samples, wav.sampleRate, fps, {
    threshold: AUDIO_DETECTOR_DEFAULTS.threshold,
    retrigger: AUDIO_DETECTOR_DEFAULTS.retrigger,
  }, false, 0);
  const transport = mediaTransportFrom((key) => (key === "playMode" ? "timeline" : undefined));
  return {
    track,
    duration: wav.duration,
    seam: (rate, startSeconds) => (frameIndex) =>
      readTrackAtPlayhead(track, transport, startSeconds + (frameIndex + ANALYSIS_LOOKAHEAD_FRAMES) / rate, wav.duration, 0),
  };
}
