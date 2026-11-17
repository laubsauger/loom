import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { harmonyAt, harmonyNotesBetween, noteEnvelope, HARMONY_NOTE_DURATION, type HarmonyConfig, type HarmonyNote } from "../../domain/music/harmony.ts";
import { VALUE_PORT } from "./common-ports.ts";
import { absTimeSecondsOf } from "../../domain/types/frame.ts";

/** Shared by the value graph and the app's audio scheduler. */
export function harmonyConfig(values: Readonly<Record<string, ParameterValue>>): HarmonyConfig {
  return {
    seed: Number(values["seed"]), tempo: Number(values["tempo"]),
    initialKey: Number(values["initialKey"]), initialMode: String(values["initialMode"]),
    harmonicComplexity: Number(values["harmonicComplexity"]),
    evolutionRate: Number(values["evolutionRate"]), musicalEnergy: Number(values["musicalEnergy"]),
  };
}

export const harmonyNode: NodeDefinition = {
  type: "harmony", version: 1, title: "Harmony", category: "value",
  description: "Seeded, evolving five-voice harmony. Publishes musical state and persistent per-voice note identities, MIDI pitches, pitch classes, velocities, start times, durations and envelopes. Per-pitch note0Envelope/Start through note127Envelope/Start retain ringing notes from earlier chords until their finite piano release; envelopes use the shared audio note envelope and Start is the latest unexpired onset, or -1. Note Field maps this metadata into a 48-key register window. The live app synthesizes these same notes on its shared audio clock. No microphone or MIDI device required. FREE-RUNNING: time follows the absolute frame clock, so timeline laps do not restart the composition. Offline value evaluation is silent and reproducible.",
  tags: ["music", "harmony", "notes", "generative", "seed", "audio"],
  inputs: [], outputs: [{ id: "out", label: "Music", type: VALUE_PORT }],
  parameters: {
    seed: { type: "number", label: "Seed", default: 31415, min: 0, max: 2147483647, step: 1 },
    tempo: { type: "number", label: "Tempo", default: 68, min: 30, max: 180 },
    initialKey: { type: "number", label: "Initial Key", default: 2, min: 0, max: 11, step: 1, description: "Pitch class: C = 0, C sharp = 1, D = 2, through B = 11." },
    initialMode: { type: "enum", label: "Initial Mode", default: "minor", options: [{ value: "major", label: "Major" }, { value: "minor", label: "Minor" }, { value: "dorian", label: "Dorian" }] },
    harmonicComplexity: { type: "number", label: "Harmonic Complexity", default: 0.58, min: 0, max: 1 },
    evolutionRate: { type: "number", label: "Evolution Rate", default: 0.35, min: 0, max: 1 },
    musicalEnergy: { type: "number", label: "Musical Energy", default: 0.45, min: 0, max: 1 },
    volume: { type: "number", label: "Volume", default: 0.55, min: 0, max: 1, description: "Live piano output gain. Offline image rendering does not emit sound." },
  },
  valueEvaluate: ({ values, frame, state }) => {
    const config = harmonyConfig(values);
    const time = Math.max(0, absTimeSecondsOf(frame));
    const music = harmonyAt(time, config);
    const onset = music.startTime;
    const previous = music.index === 0 ? music : harmonyAt(Math.max(0, onset - 0.000001), config);
    const transition = 1 - Math.exp(-Math.max(0, time - onset) / 0.7);
    const beat = time * config.tempo / 60;
    const bag: Record<string, number> = {
      harmonicTension: previous.tension + (music.tension - previous.tension) * transition,
      harmonicBrightness: music.brightness,
      harmonicComplexity: previous.complexity + (music.complexity - previous.complexity) * transition,
      musicalEnergy: music.energy,
      tonalCenter: music.tonalCenter, root: music.root, chordIndex: music.index,
      phraseProgress: music.phraseProgress, beat: Math.floor(beat), beatPhase: beat % 1,
      noteDensity: 0, bpm: config.tempo, chordStart: onset, chordDuration: music.duration, chordProgress: (time - onset) / music.duration,
    };
    music.notes.forEach((note, i) => {
      const envelope = noteEnvelope(note, time);
      const prefix = `voice${i}`;
      bag[`${prefix}Id`] = note.id;
      bag[`${prefix}Pitch`] = note.pitch;
      bag[`${prefix}PositionPitch`] = previous.notes[i]!.pitch + (note.pitch - previous.notes[i]!.pitch) * transition;
      bag[`${prefix}PitchClass`] = note.pitch % 12;
      bag[`${prefix}Velocity`] = note.velocity;
      bag[`${prefix}Start`] = note.startTime;
      bag[`${prefix}Duration`] = note.duration;
      bag[`${prefix}Envelope`] = time < note.startTime ? 0 : envelope;
    });
    // A piano chord overlaps its successors. Retain every still-ringing pitch, not
    // just this chord's five voices. Memoization changes cost only, never the output.
    const windowStart = Math.floor(time / 20) * 20;
    const signature = JSON.stringify([config, windowStart]);
    let ringing = state["ringing"] as { signature: string; notes: readonly HarmonyNote[] } | undefined;
    if (ringing?.signature !== signature) {
      ringing = { signature, notes: harmonyNotesBetween(Math.max(0, windowStart - HARMONY_NOTE_DURATION), windowStart + 20, config) };
      state["ringing"] = ringing;
    }
    for (let pitch = 0; pitch < 128; pitch++) {
      bag[`note${pitch}Envelope`] = 0;
      bag[`note${pitch}Start`] = -1;
    }
    let activeNotes = 0;
    for (const note of ringing.notes) {
      if (noteEnvelope(note, time) > 0.0001) activeNotes += 1;
      bag[`note${note.pitch}Envelope`] = Math.max(bag[`note${note.pitch}Envelope`]!, noteEnvelope(note, time));
      if (note.startTime <= time && note.startTime + note.duration > time) bag[`note${note.pitch}Start`] = Math.max(bag[`note${note.pitch}Start`]!, note.startTime);
    }
    bag["noteDensity"] = activeNotes;
    return bag;
  },
  compile: () => ({ passes: [] }),
};

export const noteFieldNode: NodeDefinition = {
  type: "noteField", version: 1, title: "Note Field", category: "value",
  description: "Maps a structured Harmony channel bag into five spatial attractors, spectral colors and a 48-key register window. keyBase anchors the bank at the lowest current voice’s octave, clamped to MIDI 0..80. key0Pitch/Envelope/Start through key47Pitch/Envelope/Start map consecutive MIDI pitches directly to their per-pitch ringing metadata, including sustained notes no longer in the current chord; pitches outside the window are not folded into it. Two 24-string fans consume keys 0..23 and 24..47. Preserves note channels and identities. Pitch controls height, pitch class controls hue, velocity controls intensity. FREE-RUNNING: drift follows absolute time through timeline laps. Wire its channels to Point Kernel parameters or ordinary geometry controls. No connected music input publishes no field.",
  tags: ["music", "notes", "field", "attractor", "color"],
  inputs: [{ id: "in", label: "Music", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Field", type: VALUE_PORT }],
  parameters: {
    spatialComplexity: { type: "number", label: "Spatial Complexity", default: 0.55, min: 0, max: 1 },
    colorRichness: { type: "number", label: "Color Richness", default: 0.7, min: 0, max: 1 },
    visualIntensity: { type: "number", label: "Visual Intensity", default: 0.7, min: 0, max: 1 },
  },
  valueEvaluate: ({ inputs, values, frame }) => {
    const music = inputs["in"];
    if (music === undefined || Object.keys(music).length === 0) return {};
    const bag: Record<string, number> = { ...music };
    const time = absTimeSecondsOf(frame);
    const pitches: number[] = [];
    for (let i = 0; i < 5; i++) {
      const prefix = `voice${i}`;
      const pitch = music[`${prefix}PositionPitch`];
      const midiPitch = music[`${prefix}Pitch`];
      const envelope = music[`${prefix}Envelope`];
      if (pitch === undefined || envelope === undefined || midiPitch === undefined ||
        !Number.isInteger(midiPitch) || midiPitch < 0 || midiPitch > 127) throw new Error("Note Field requires five structured Harmony voices.");
      pitches.push(midiPitch);
      const angle = i * Math.PI * 2 / 5 + 0.13 * Math.sin(time * 0.071);
      const radius = 1.3 + Number(values["spatialComplexity"]) * 0.65;
      bag[`${prefix}X`] = Math.cos(angle) * radius;
      bag[`${prefix}Y`] = (pitch - 60) * 0.055;
      bag[`${prefix}Z`] = Math.sin(angle) * radius;
      const hue = (pitch % 12) / 12;
      const richness = Number(values["colorRichness"]);
      for (const [component, phase] of [["R", 0], ["G", 2 / 3], ["B", 1 / 3]] as const) {
        bag[`${prefix}${component}`] = (1 - richness) * 0.65 + richness * (0.5 + 0.5 * Math.cos(2 * Math.PI * (hue + phase)));
      }
      bag[`${prefix}Intensity`] = (0.15 + envelope * 0.85) * Number(values["visualIntensity"]);
    }
    const base = Math.max(0, Math.min(80, 12 * Math.floor(Math.min(...pitches) / 12)));
    bag["keyBase"] = base;
    for (let slot = 0; slot < 48; slot++) {
      const pitch = base + slot;
      const envelope = music[`note${pitch}Envelope`];
      const start = music[`note${pitch}Start`];
      if (envelope === undefined || start === undefined || !Number.isFinite(envelope) || !Number.isFinite(start)) {
        throw new Error(`Note Field requires Harmony ringing metadata note${pitch}Envelope and note${pitch}Start.`);
      }
      bag[`key${slot}Pitch`] = pitch;
      bag[`key${slot}Envelope`] = envelope;
      bag[`key${slot}Start`] = start;
    }
    return bag;
  },
  compile: () => ({ passes: [] }),
};
