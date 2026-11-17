import type { AudioFeatures, FrameTempo, TempoSourceKind } from "../types/frame.ts";
import { DEFAULT_PROJECT_BPM, tempoAlong } from "../types/frame.ts";
import type { ProjectSettings } from "../types/graph.ts";
import { createMidiClockFollower } from "./midi-clock.ts";
import { BPM_MAX, BPM_MIN, createTapTempo, roundBpm, type TapResult } from "./tap-tempo.ts";

/**
 * T1785b — THE PROJECT TEMPO: one tempo and one beat clock for the whole project, in the
 * transport, the way TouchDesigner and Notch keep it. Design and the comparison:
 * `docs/project-tempo-design-2026-11-16.md`.
 *
 * The BPM and its source are DOCUMENT state (`ProjectSettings.bpm`, `.tempoSource`), so they
 * save, undo and reach an agent like every other setting. The PHASE is session state: where
 * the beat is depends on when somebody tapped or when a clock master started, and that is
 * a fact about this performance, the line `playing` and `looping` already sit on.
 *
 * §V1038: the clock reaches a frame ONLY as `FrameEvaluationInput.tempo`, stamped by the
 * transport through a `TempoReader`. Taps, MIDI pulses and audio claims happen on the wall
 * clock; this module is handed that clock (`now`) by the app and turns them into one
 * reading per frame. No node definition and no expression reads a clock for it (§V44).
 * An offline render uses `documentTempo`, which is the frame's absolute time and the
 * document's BPM and nothing else.
 */

/** What a transport tells the tempo about the frame it is producing. */
export interface TempoClockInput {
  /** The frame's absolute time (T461) and the step that reached it. */
  readonly absTimeSeconds: number;
  readonly absDeltaSeconds: number;
  /** The frame is live playback: the beat follows the wall clock. False for a step, a seek and a render. */
  readonly presenting: boolean;
}

/** Supplies `FrameEvaluationInput.tempo`. A transport option, as `fps` and `seed` are. */
export type TempoReader = (clock: TempoClockInput) => FrameTempo;

type TempoSettings = Pick<ProjectSettings, "bpm" | "tempoSource">;

/** The one answer to "what tempo is this project" (as `projectFps` is for the rate). */
export function projectBpm(settings: Pick<ProjectSettings, "bpm">): number {
  const bpm = settings.bpm;
  return typeof bpm === "number" && Number.isFinite(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX ? bpm : DEFAULT_PROJECT_BPM;
}

export function projectTempoSource(settings: Pick<ProjectSettings, "tempoSource">): TempoSourceKind {
  return settings.tempoSource ?? "manual";
}

/**
 * The DETERMINISTIC tempo: the document's BPM counted along the frame's absolute clock.
 * What `pnpm render` and every other offline transport stamps. The source is reported as
 * the document's; a source that is not `manual` has nothing to follow offline, so the
 * reading is unlocked and holds the document's BPM.
 */
export function documentTempo(settings: () => TempoSettings): TempoReader {
  return (clock) => {
    const current = settings();
    return tempoAlong(projectBpm(current), clock.absTimeSeconds, clock.absDeltaSeconds, projectTempoSource(current));
  };
}

/** Below this an audio tempo claim is not followed; the last tempo is held (T1227's confidence). */
export const AUDIO_TEMPO_CONFIDENCE = 0.5;

/** The two verbs a Tempo node's pulses fire (`tempo-commands.ts` registers them; T1787b). */
export const TEMPO_TAP_COMMAND = "tempo.tap";
export const TEMPO_RESYNC_COMMAND = "tempo.resync";

export interface ProjectTempoOptions {
  /**
   * The wall clock in SECONDS, on the timebase taps and MIDI timestamps use
   * (`performance.now() / 1000` in the app). The only clock this reads.
   */
  readonly now: () => number;
  /** The document's settings, read per frame: an undo, a load and an agent edit all arrive by themselves. */
  readonly settings: () => TempoSettings;
}

export interface ProjectTempo {
  /** The transport's reader: one call per frame produced. */
  readonly read: TempoReader;
  /**
   * A tap at `atSeconds` (default: now). The tap lands on the nearest beat, so the phase is
   * set by the latest tap; the result carries the tapped tempo for the caller to store.
   */
  tap(atSeconds?: number): TapResult;
  /** Beat zero of bar zero is `atSeconds` (default: now). */
  resync(atSeconds?: number): void;
  /** One MIDI realtime message (0xF8 clock, 0xFA start, 0xFB continue, 0xFC stop) and its time. */
  midiRealtime(status: number, atSeconds: number): void;
  /** The audio analysis' tempo claim for a frame, or null when no audio is live. */
  observeAudio(audio: Pick<AudioFeatures, "bpm" | "bpmConfidence"> | null): void;
  /** A take starts: the beat is counted from the absolute clock at `absSeconds`, as offline. */
  restartAt(absSeconds: number): void;
  /** The clock as it stands now, outside any frame: for a command's result and a surface. */
  snapshot(): FrameTempo;
}

export function createProjectTempo(options: ProjectTempoOptions): ProjectTempo {
  const taps = createTapTempo();
  const midi = createMidiClockFollower();
  let beats = 0;
  let lastNow: number | null = null;
  let documentBpm = projectBpm(options.settings());
  /** The tempo in effect: the document's, or the last one a source delivered. */
  let held = documentBpm;
  let audioLocked = false;
  /**
   * A beat was PUT on the grid (tap, resync, a take's start on a beat): the next frame
   * pulses. The session's first frame does not: nobody put a beat there (T1787b).
   */
  let landed = false;

  const effective = (now: number): { bpm: number; source: TempoSourceKind; locked: boolean; midiBeats: number | null; midiRejoined: boolean } => {
    const settings = options.settings();
    const source = projectTempoSource(settings);
    const stated = projectBpm(settings);
    // A new document tempo (typed, tapped, undone, loaded) is the tempo until a source says otherwise.
    if (stated !== documentBpm || source === "manual") held = stated;
    documentBpm = stated;
    if (source === "manual") return { bpm: held, source, locked: true, midiBeats: null, midiRejoined: false };
    if (source === "audio") return { bpm: held, source, locked: audioLocked, midiBeats: null, midiRejoined: false };
    const reading = midi.reading(now);
    if (reading.bpm !== null) held = reading.bpm;
    return { bpm: held, source, locked: reading.locked, midiBeats: reading.locked ? reading.beats : null, midiRejoined: reading.rejoined };
  };

  const advanceTo = (now: number, bpm: number): void => {
    if (lastNow !== null) beats += (Math.max(0, now - lastNow) * bpm) / 60;
    lastNow = now;
  };

  return {
    read(clock) {
      const now = options.now();
      const state = effective(now);
      const before = beats;
      if (clock.presenting) advanceTo(now, state.bpm);
      else {
        // A step, a seek's frame or a render: the beat moves by the frame's own step, so
        // the same frames give the same beats whatever the wall clock did meanwhile.
        beats += (Math.max(0, clock.absDeltaSeconds) * state.bpm) / 60;
        lastNow = now;
      }
      // A locked MIDI clock IS the position: its pulse count, not this clock's own run.
      // T1787b: unless the pulses stopped and came back with no Start. The master then says
      // nothing about where it is, and this clock ran the beat on through the gap, so the
      // count takes THIS position and carries on from it (it used to snap back to the count
      // as it stood when the pulses stopped).
      if (clock.presenting && state.midiBeats !== null) {
        if (state.midiRejoined) midi.hold(beats, now);
        else beats = state.midiBeats;
      }
      let pulse = Math.max(0, Math.floor(beats) - Math.floor(before));
      // A beat put on the grid, or a master that started over, lands on this frame.
      if (landed || beats < before - 0.5) pulse = Math.max(pulse, 1);
      landed = false;
      return { bpm: state.bpm, beats, pulse, source: state.source, locked: state.locked };
    },
    tap(atSeconds = options.now()) {
      const result = taps.tap(atSeconds);
      advanceTo(atSeconds, effective(atSeconds).bpm);
      beats = Math.round(beats);
      landed = true;
      return result;
    },
    resync(atSeconds = options.now()) {
      effective(atSeconds);
      lastNow = atSeconds;
      beats = 0;
      landed = true;
      midi.rezero(atSeconds);
    },
    midiRealtime(status, atSeconds) {
      midi.message(status, atSeconds);
    },
    observeAudio(audio) {
      if (projectTempoSource(options.settings()) !== "audio") {
        audioLocked = false;
        return;
      }
      const confident = audio !== null && audio.bpmConfidence >= AUDIO_TEMPO_CONFIDENCE && audio.bpm >= BPM_MIN && audio.bpm <= BPM_MAX;
      audioLocked = confident;
      if (confident) held = audio.bpm;
    },
    restartAt(absSeconds) {
      const state = effective(options.now());
      beats = Math.max(0, (absSeconds * state.bpm) / 60);
      lastNow = options.now();
      landed = beats === Math.floor(beats);
    },
    snapshot() {
      const now = options.now();
      const state = effective(now);
      const ran = beats + (lastNow === null ? 0 : (Math.max(0, now - lastNow) * state.bpm) / 60);
      const position = state.midiRejoined ? ran : (state.midiBeats ?? ran);
      return { bpm: state.bpm, beats: position, pulse: 0, source: state.source, locked: state.locked };
    },
  };
}

/** A tempo as a surface shows it and the document stores it. */
export { roundBpm };
