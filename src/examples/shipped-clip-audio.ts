import type { AudioFeatures } from "../domain/types/frame.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { storedStaticValue } from "../domain/parameters/slots.ts";
import { mediaTransportFrom } from "../domain/media/transport.ts";
import type { FeatureTrack } from "../domain/audio/feature-track.ts";
import { analyseOffline } from "../app/audio-offline-analysis.ts";
import { readTrackAtPlayhead } from "../app/audio-pre-analysis.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "../nodes/definitions/audio.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, renderShowcaseBeat } from "./build-showcase-beat.ts";

/**
 * T1236 — WHAT A HEADLESS RENDER HEARS when a document binds a shipped clip.
 *
 * The look instrument, the thumbnail and the liveness baselines render with no audio
 * capture, which was honest while every audio example drove from `audioPattern`: the
 * pattern is a function of the clock, so the render heard exactly what the app plays. E66
 * is the first example whose demonstrated path is a FILE, and a file is not a function of
 * the clock — it is bytes the app decodes and pre-analyses (T1229). Rendered with nothing
 * on the seam, every `levels` and `hits` lane would sit at rest, the card would be the
 * silent picture, and the baselines would gate a picture no user sees. That is T650's
 * "measuring a blank and reporting green" with sound instead of pixels, and the repair is
 * the same: a deterministic stand-in the gates can hear.
 *
 * The stand-in is not a fake. `showcase-beat.m4a` is GENERATED from `renderShowcaseBeat()`,
 * so its samples exist in code, and the app's own walk (`analyseOffline`, the function the
 * pre-analysis worker runs) turns them into the same feature track the app would read at
 * the same fps and detector settings. What the frame driver then reads is
 * `readTrackAtPlayhead` under the node's own transport — trim, cue, speed and extend
 * index the track exactly as they position the sound. The only difference from the app is
 * the decode: PCM straight from the generator rather than the AAC round trip, and the
 * counts survive that (`e66-showcase.test.ts` pins them on the PCM; the encode was
 * re-analysed by hand at 56/28/75 when the clip landed).
 *
 * Keyed by the FILE PARAMETER'S VALUE, which is the only thing the document knows about
 * the clip — a document binding a file this map does not name hears nothing, as before,
 * because nothing here can render it. `§V760`: the fixture and the gate that renders it are
 * one instrument, so this lives beside `look-instrument.ts` and both callers reach it.
 */

interface ShippedClip {
  readonly render: () => Float32Array;
  readonly sampleRate: number;
}

export const SHIPPED_CLIPS: Readonly<Record<string, ShippedClip>> = {
  [SHOWCASE_BEAT_FILE]: { render: renderShowcaseBeat, sampleRate: SHOWCASE_BEAT.sampleRate },
};

/** One walk per (file, fps, knobs) for the process — the walk is ~1 s and every gate asks. */
const tracks = new Map<string, { track: FeatureTrack; duration: number }>();

function trackFor(file: string, clip: ShippedClip, fps: number, threshold: number, retrigger: number) {
  const key = `${file}|${String(fps)}|${String(threshold)}|${String(retrigger)}`;
  const held = tracks.get(key);
  if (held !== undefined) return held;
  const samples = clip.render();
  const walked = {
    track: analyseOffline(samples, clip.sampleRate, fps, { threshold, retrigger }).track,
    duration: samples.length / clip.sampleRate,
  };
  tracks.set(key, walked);
  return walked;
}

/**
 * The harness's `audio` seam for `graph`, or `undefined` when no node binds a shipped clip.
 * Scans the graph it is handed — the ROOT document, since the source node sits beside the
 * component that analyses it, never inside one.
 */
export function shippedClipAudio(
  graph: GraphDocument,
  fps: number,
): ((frameIndex: number) => AudioFeatures | null) | undefined {
  const bound = Object.values(graph.nodes).filter((node) => {
    if (node.type !== "audioFileIn") return false;
    const file = storedStaticValue(node.parameters["file"]);
    if (typeof file !== "string" || !(file in SHIPPED_CLIPS)) return false;
    // The app reads the track ONLY under the timeline lock (`use-audio-input.ts`); a free-run
    // file plays on the element's own clock, which no offline render can stand in for.
    return mediaTransportFrom((key) => storedStaticValue(node.parameters[key])).playMode !== "freeRun";
  });
  if (bound.length === 0) return undefined;
  // The value graph carries ONE audio record per frame (`FrameEvaluationInput.audio`), so
  // two sources bound to two clips could not both be heard; say so rather than pick one.
  if (bound.length > 1) {
    throw new Error(`${String(bound.length)} audioFileIn nodes bind shipped clips; the audio seam carries one record`);
  }
  const node = bound[0]!;
  const read = (key: string) => storedStaticValue(node.parameters[key]);
  const file = read("file") as string;
  const number = (key: string, fallback: number): number => {
    const value = read(key);
    return typeof value === "number" ? value : fallback;
  };
  const { track, duration } = trackFor(
    file,
    SHIPPED_CLIPS[file]!,
    fps,
    number("threshold", AUDIO_DETECTOR_DEFAULTS.threshold),
    number("retrigger", AUDIO_DETECTOR_DEFAULTS.retrigger),
  );
  const transport = mediaTransportFrom(read);
  // T1312b: the document's sync offset, applied here for the same reason the transport is —
  // an offline render that skipped it would hear a different frame than the app does, which
  // is the §V47 divergence this parameter exists inside, not beside.
  const lead = number("syncOffset", 0);
  // Under the timeline lock the harness's frame index IS the timeline (`useAudioInput.read`).
  return (frameIndex) => readTrackAtPlayhead(track, transport, frameIndex / fps, duration, lead);
}
