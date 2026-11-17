import type { CompiledNodeDescription, NodeDefinition, StatefulDeclaration } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { absTimeSecondsOf } from "../../domain/types/frame.ts";
import { createKeyEstimator, type KeyEstimator } from "../../domain/audio/analysis/chord.ts";
import { CHROMA_NAMES } from "../../domain/audio/tonal-fields.ts";
import { readMidiEvents } from "../../domain/midi/midi-events.ts";
import {
  advanceKeyboard,
  applyMidiEvent,
  beginKeyboardFrame,
  createKeyboardState,
  isSounding,
  keyboardChroma,
  keyboardTriad,
  type KeyboardSettings,
  type KeyboardState,
  type KeyState,
} from "../../domain/midi/midi-notes.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * T1762b — MIDI Notes: a keyboard as voices, the way MIDI In is a controller as channels.
 *
 * ## A node of its own, beside MIDI In
 *
 * MIDI In is the LEARNED-controls node: you name a knob and it publishes that name. A
 * keyboard is not learned and is not a bag of independent controls; it is notes, whose
 * meaning depends on each other and on the pedals. So it is a second input-less node
 * reading the same session (§V182, one listener), and MIDI In stays what it is.
 * TouchDesigner's MIDI In CHOP gives a channel per note number with the velocity as its
 * value, which is 128 channels and no notion of a voice or a pedal; this publishes the
 * voices a picture is driven from, and can publish the per-key channels as well.
 *
 * ## It reads the seam, in order
 *
 * No listener here. The session appends every channel-voice message to a ring it publishes
 * through `ValueEvaluateContext.channels` (`midi-events.ts`), and this node reads forward
 * from where it last stopped. The model is `midi-notes.ts`; this file is its parameters
 * and its channel names. A headless caller that feeds `channels` replays a performance.
 *
 * ## The names are shared on purpose
 *
 * `voiceNPitch`, `voiceNPitchClass`, `voiceNPositionPitch`, `voiceNVelocity`,
 * `voiceNEnvelope`, `voiceNStart`, `voiceNId`, `noteDensity`, `root` and the per-key
 * `note<p>Envelope` / `note<p>Start` are the `harmony` bag's names with the harmony bag's
 * meanings; `chroma0…11`, `chromaConfidence`, `chordQuality`, `chordConfidence`,
 * `chordChangeCount`, `chordAge`, `tonalCenter`, `keyMode`, `keyConfidence`, `voiceCount`,
 * `voiceNOnsetCount`, `lagSeconds` and `lagFrames` are the audio tonal nodes'. A network driven from a score, from audio or
 * from a keyboard reads the same channels.
 *
 * ## Absence is the normal state (§T948)
 *
 * No Web MIDI, no permission, no keyboard: no messages. Every channel publishes its rest
 * value (0; a voice's Start is −1) and the document loads and renders.
 */
const NOTES_STATEFUL: StatefulDeclaration = {
  reset: true,
  deterministicReplay: true,
  checkpoint: false,
  randomAccess: false,
};

const numberOr = (value: ParameterValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const MIDI_NOTES_MAX_VOICES = 16;

export function keyboardSettingsOf(values: Readonly<Record<string, ParameterValue>>): KeyboardSettings {
  return {
    voices: Math.min(MIDI_NOTES_MAX_VOICES, Math.max(1, Math.floor(numberOr(values["voices"], 8)))),
    channel: Math.min(16, Math.max(0, Math.floor(numberOr(values["channel"], 0)))),
    decay: Math.max(0.01, numberOr(values["decay"], 4)),
    decayTracking: Math.min(1, Math.max(0, numberOr(values["decayTracking"], 0.5))),
    release: Math.max(0.001, numberOr(values["release"], 0.15)),
    pedalThreshold: Math.min(1, Math.max(0, numberOr(values["pedalThreshold"], 0.5))),
    halfPedal: values["halfPedal"] !== false,
  };
}

interface ChordMemory {
  root: number;
  quality: number;
  age: number;
}

export const midiNotesNode: NodeDefinition = {
  type: "midiNotes",
  version: 1,
  title: "MIDI Notes",
  category: "input",
  description:
    "A MIDI keyboard as voices: the keys pressed, how hard, and what the pedals are doing to them. Each of Voices slots follows one note and publishes voiceNPitch (the MIDI note), voiceNPitchClass (0..11, C = 0), voiceNPositionPitch (the pitch with the bend wheel added, for placing things), voiceNVelocity (0..1), voiceNEnvelope (the note's level now), voiceNHeld (1 while the finger is on the key), voiceNSounding (1 while it is held OR a pedal is holding it), voiceNStart (when it was struck, on the absolute clock; -1 before any), voiceNId (a number that changes with every strike), voiceNOnsetCount (strikes this frame), voiceNReleaseVelocity (where the keyboard sends one) and voiceNPressure (polyphonic aftertouch). A voice keeps its slot for as long as its note sounds, and a pitch struck again while it is still ringing re-strikes its own voice. When more notes sound than there are voices the new note takes, in this order: a voice that is only ringing out, then the quietest voice a pedal is holding, and a key under a finger last; of equals the oldest. THE PEDALS: sustain, sostenuto and soft are published 0..1. A key released while Sustain is at or above Pedal Threshold keeps sounding until the pedal comes up; the order of the two is exact. With Half Pedal on a pedalled note is damped by how far the pedal is from the floor (a continuous pedal half way down lets notes fade at half the Release rate); off, a pedal above the threshold holds fully, which is what a switch pedal wants. Sostenuto holds only the keys that were down when it engaged. MIDI carries no sound, so the ENVELOPE IS A MODEL, and its numbers are yours: a strike starts at the velocity, falls like a string over Decay (faster up the keyboard by Decay Tracking), and a released, unpedalled note is damped over Release. chroma0 … chroma11 are the pitch classes of every sounding key (not only the held ones, and not only the ones with a voice), each against the strongest, with chromaConfidence 1 while anything sounds; root, chordQuality (0 none, 1 major, 2 minor), chordConfidence, chordChangeCount and chordAge name the triad those classes make, and claim none (all 0) when they do not make one. tonalCenter, keyMode (1 major, 2 minor) and keyConfidence name the KEY of what has been played over the last twenty seconds or so: a slow claim, 0 until there is music to make it from. pressure is channel aftertouch, bend the wheel (-1..1); noteOnCount and noteOffCount count this frame's events; heldCount, voiceCount and noteDensity count keys down, voices in use and notes ringing. Per Key adds note0Envelope … note127Envelope and note0Start … note127Start for a Note Field. The names are the Harmony node's and the audio tonal nodes' wherever the meaning is the same, so a score, a recording and a keyboard drive one network. Channel 0 listens to every MIDI channel. With no Web MIDI, no permission or no keyboard attached every channel reads its rest value and the document still loads and renders; the inspector's MIDI section says which it is and has the button that asks for access. DELTA-DRIVEN (§V436): the levels move by the frame step and read no clock position, so a timeline loop passes straight through a held chord. Live hardware: a render over it does not reproduce.",
  tags: ["value", "input", "midi", "keyboard", "piano", "notes", "velocity", "pedal", "aftertouch", "chord"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    device: {
      type: "string",
      label: "Device",
      default: "",
      description: "MIDI input port id, from the inspector's device picker. Empty = any attached input.",
    },
    channel: {
      type: "number",
      label: "Channel",
      default: 0,
      min: 0,
      max: 16,
      step: 1,
      range: "bounded",
      description: "The MIDI channel to listen to, 1 to 16. 0 listens to all of them, which is right for one keyboard.",
    },
    voices: {
      type: "number",
      label: "Voices",
      default: 8,
      min: 1,
      max: MIDI_NOTES_MAX_VOICES,
      step: 1,
      range: "bounded",
      description:
        "How many voice slots are published (voice0 … voiceN-1). The keyboard model keeps every key whatever this says; this is how many of them a picture can address one by one. Five matches the Harmony node.",
    },
    decay: {
      type: "number",
      label: "Decay",
      group: "Envelope",
      default: 4,
      min: 0.01,
      max: 60,
      range: "floor",
      step: 0.01,
      unit: "seconds",
      description: "How long a sounding note at middle C takes to fall to about a third of its level (one e-fold), held or pedalled. A model of a string: MIDI sends no level.",
    },
    decayTracking: {
      type: "number",
      label: "Decay Tracking",
      group: "Envelope",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      step: 0.01,
      description: "How much shorter high notes ring than low ones. 0: every key decays alike. 1: the decay time halves with each octave up and doubles with each octave down.",
    },
    release: {
      type: "number",
      label: "Release",
      group: "Envelope",
      default: 0.15,
      min: 0.001,
      max: 10,
      range: "floor",
      step: 0.001,
      unit: "seconds",
      description: "How fast the dampers stop a note that is neither held nor pedalled: the time for one e-fold.",
    },
    pedalThreshold: {
      type: "number",
      label: "Pedal Threshold",
      group: "Pedals",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      step: 0.01,
      description: "How far down the sustain and sostenuto pedals must be to count as down. A switch pedal sends 0 or 1 and any value between works; lower it for a continuous pedal that should catch early.",
    },
    halfPedal: {
      type: "boolean",
      label: "Half Pedal",
      group: "Pedals",
      default: true,
      description:
        "On: a note the sustain pedal is holding is damped by how far the pedal is from the floor, so a continuous pedal part way down lets notes fade. A switch pedal is unaffected (fully down damps nothing). Off: any pedal at or above the threshold holds fully.",
    },
    bendRange: {
      type: "number",
      label: "Bend Range",
      default: 2,
      min: 0,
      max: 24,
      range: "bounded",
      step: 1,
      description: "How many semitones the bend wheel moves voiceNPositionPitch at full travel.",
    },
    perKey: {
      type: "boolean",
      label: "Per Key",
      default: false,
      description: "Also publish note0Envelope … note127Envelope and note0Start … note127Start: every key's level and strike time (-1 when it is not ringing), the channels a Note Field reads. 256 more channels, so off unless something reads them.",
    },
  },
  stateful: NOTES_STATEFUL,
  valueEvaluate: ({ values, frame, channels, state }) => {
    const settings = keyboardSettingsOf(values);
    const device = typeof values["device"] === "string" ? values["device"] : "";
    const keyboard = (state["keyboard"] ??= createKeyboardState()) as KeyboardState;
    const energies = (state["energies"] ??= new Float64Array(12)) as Float64Array;
    const profile = (state["profile"] ??= new Float64Array(12)) as Float64Array;
    const chord = (state["chord"] ??= { root: 0, quality: 0, age: 0 }) as ChordMemory;
    const now = absTimeSecondsOf(frame);
    const delta = Math.max(0, frame.deltaSeconds);

    // Time first, then this frame's messages: a strike read now publishes its whole velocity.
    beginKeyboardFrame(keyboard, settings);
    advanceKeyboard(keyboard, delta, settings);
    const read = readMidiEvents(channels, device, state["cursor"] as number | undefined);
    state["cursor"] = read.cursor;
    for (const event of read.events) applyMidiEvent(keyboard, event, now, settings);

    const bag: Record<string, number> = {};
    const bendRange = Math.max(0, numberOr(values["bendRange"], 2));
    let voiceCount = 0;
    for (let slot = 0; slot < keyboard.slots.length; slot += 1) {
      const pitch = keyboard.slots[slot] as number;
      const key: KeyState | undefined = pitch < 0 ? undefined : keyboard.keys[pitch];
      const memory = keyboard.memory[slot] as KeyboardState["memory"][number];
      if (key !== undefined) voiceCount += 1;
      const prefix = `voice${String(slot)}`;
      bag[`${prefix}Pitch`] = memory.pitch;
      bag[`${prefix}PitchClass`] = memory.pitch % 12;
      bag[`${prefix}PositionPitch`] = memory.pitch + keyboard.bend * bendRange;
      bag[`${prefix}Velocity`] = memory.velocity;
      bag[`${prefix}Envelope`] = key?.level ?? 0;
      bag[`${prefix}Held`] = key?.down === true ? 1 : 0;
      bag[`${prefix}Sounding`] = key !== undefined && isSounding(key) ? 1 : 0;
      bag[`${prefix}Start`] = memory.start;
      bag[`${prefix}Id`] = memory.id;
      bag[`${prefix}OnsetCount`] = key?.strikes ?? 0;
      bag[`${prefix}ReleaseVelocity`] = key === undefined ? memory.releaseVelocity : key.releaseVelocity;
      bag[`${prefix}Pressure`] = key?.pressure ?? 0;
    }

    let heldCount = 0;
    let ringing = 0;
    for (const key of keyboard.keys) {
      if (key.down) heldCount += 1;
      if (key.level > 0) ringing += 1;
    }
    bag["sustain"] = keyboard.sustain;
    bag["sostenuto"] = keyboard.sostenuto;
    bag["soft"] = keyboard.soft;
    bag["pressure"] = keyboard.pressure;
    bag["bend"] = keyboard.bend;
    bag["noteOnCount"] = keyboard.noteOnCount;
    bag["noteOffCount"] = keyboard.noteOffCount;
    bag["heldCount"] = heldCount;
    bag["voiceCount"] = voiceCount;
    bag["noteDensity"] = ringing;

    const lowest = keyboardChroma(keyboard, energies);
    const triad = keyboardTriad(energies, lowest, profile);
    CHROMA_NAMES.forEach((name, pitchClass) => {
      bag[name] = profile[pitchClass] as number;
    });
    bag["chromaConfidence"] = lowest < 0 ? 0 : 1;
    // A different triad, or a claim where there was none (or none where there was one), is a change.
    const changed = triad.root !== chord.root || triad.quality !== chord.quality;
    chord.age = changed ? 0 : chord.age + delta;
    chord.root = triad.root;
    chord.quality = triad.quality;
    bag["root"] = triad.root;
    bag["chordQuality"] = triad.quality;
    bag["chordConfidence"] = triad.confidence;
    bag["chordChangeCount"] = changed ? 1 : 0;
    bag["chordAge"] = triad.quality === 0 ? 0 : chord.age;
    // T1764b: the key, by the estimator the audio Chord node's key comes from, fed the
    // sounding keys' classes for as long as anything sounds — the same claim, the same names.
    const key = ((state["key"] ??= createKeyEstimator()) as KeyEstimator).push(profile, lowest < 0 ? 0 : 1, delta);
    bag["tonalCenter"] = key.tonic;
    bag["keyMode"] = key.mode;
    bag["keyConfidence"] = key.confidence;
    // A key is read the frame it is pressed: nothing is behind the sound.
    bag["lagSeconds"] = 0;
    bag["lagFrames"] = 0;

    if (values["perKey"] === true) {
      for (let pitch = 0; pitch < 128; pitch += 1) {
        const key = keyboard.keys[pitch] as KeyState;
        bag[`note${String(pitch)}Envelope`] = key.level;
        bag[`note${String(pitch)}Start`] = key.level > 0 ? key.start : -1;
      }
    }
    return bag;
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
