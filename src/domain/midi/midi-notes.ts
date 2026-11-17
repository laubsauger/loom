/**
 * T1762b — A KEYBOARD AS A MODEL: 128 keys, three pedals, and a fixed number of voices
 * over them. Pure: messages in order, a time step, numbers out.
 *
 * ## The keys are the truth, the voices are a view
 *
 * Every key has its own state, so nothing a pianist does is lost to a voice limit: a
 * twenty-note chord under the pedal is twenty sounding keys, and the pitch classes and the
 * chord are read from all of them. A VOICE is a slot that follows one sounding key, for a
 * consumer that wants "the fourth note" as channels. There are as many as the node asks
 * for, and a key that loses its slot goes on sounding in the model.
 *
 * ## A key, in the instrument's own words
 *
 *  - `down`: the finger is on it.
 *  - `sustained`: the finger came up WHILE the sustain pedal was at or above the
 *    threshold. Order decides it, which is why the messages arrive as an ordered list
 *    (`midi-events.ts`): up-then-pedal is a released note, pedal-then-up is a held one.
 *  - `sostenuto`: the key was down at the moment the sostenuto pedal engaged. Only those
 *    keys; a note struck after is not caught.
 *  - SOUNDING is any of the three. The key keeps its voice while it sounds.
 *  - `level`: MIDI carries no audio level, so this is a model of one, and it is published
 *    and parameterised rather than hidden. A strike sets it to the velocity. It then falls
 *    like a string, e-fold in `decay` seconds at middle C and faster up the keyboard
 *    (`decayTracking`). A key that is not sounding is DAMPED: it also falls e-fold in
 *    `release` seconds. A sustained key under a continuous pedal is damped in proportion to
 *    how far the pedal is from the floor: at depth 0.7 the dampers take 30 % of the full
 *    rate (half-pedalling). A caught sostenuto key is not damped at all.
 *
 * ## Time
 *
 * `advanceKeyboard` moves the levels by a step; `applyMidiEvent` applies one message at the
 * present. A frame advances first and applies its messages after, so a strike this frame
 * publishes its full velocity and a release starts damping on the next step.
 */
import { matchTriad, NO_TRIAD, type TriadMatch } from "../audio/triads.ts";
import type { MidiEvent } from "./midi-events.ts";

export interface KeyboardSettings {
  /** How many voices follow the sounding keys. */
  readonly voices: number;
  /** MIDI channel to listen to, 1..16; 0 listens to all of them. */
  readonly channel: number;
  /** Seconds for a sounding note's level to fall e-fold at middle C. */
  readonly decay: number;
  /** 0: every key decays alike. 1: the decay time halves for each octave above middle C and doubles below. */
  readonly decayTracking: number;
  /** Seconds for a damped note's level to fall e-fold. */
  readonly release: number;
  /** 0..1: the pedal reading at or above which the sustain and sostenuto pedals are down. */
  readonly pedalThreshold: number;
  /** A sustained key is damped by (1 − pedal depth). Off, a pedal at or above the threshold does not damp at all. */
  readonly halfPedal: boolean;
}

export interface KeyState {
  down: boolean;
  sustained: boolean;
  sostenuto: boolean;
  /** 0..1. */
  level: number;
  /** The last strike's velocity, 0..1. */
  velocity: number;
  /** The last note-off's velocity, 0..1; 0 while down and where the keyboard sends none. */
  releaseVelocity: number;
  /** Polyphonic aftertouch for this key, 0..1. */
  pressure: number;
  /** When the last strike was read (the caller's clock), or −1. */
  start: number;
  /** The last strike's serial number; 0 before any. */
  id: number;
  /** Strikes since `beginKeyboardFrame`. */
  strikes: number;
}

/** What a voice last followed, kept after the note ends so a consumer's pitch does not snap to 0. */
export interface VoiceMemory {
  pitch: number;
  velocity: number;
  start: number;
  id: number;
  releaseVelocity: number;
}

export interface KeyboardState {
  readonly keys: KeyState[];
  /** Slot → key, or −1. */
  slots: number[];
  /** Key → slot, or −1. */
  readonly slotOf: number[];
  memory: VoiceMemory[];
  /** Pedal depths, 0..1. */
  sustain: number;
  sostenuto: number;
  soft: number;
  /** Channel aftertouch, 0..1. */
  pressure: number;
  /** −1..1. */
  bend: number;
  nextId: number;
  /** Note-ons and note-offs since `beginKeyboardFrame`. */
  noteOnCount: number;
  noteOffCount: number;
}

/** Under this a level is silence; the key stops ringing. */
export const LEVEL_FLOOR = 1e-4;

const CC_SUSTAIN = 64;
const CC_SOSTENUTO = 66;
const CC_SOFT = 67;
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

export function createKeyboardState(): KeyboardState {
  return {
    keys: Array.from({ length: 128 }, () => ({
      down: false,
      sustained: false,
      sostenuto: false,
      level: 0,
      velocity: 0,
      releaseVelocity: 0,
      pressure: 0,
      start: -1,
      id: 0,
      strikes: 0,
    })),
    slots: [],
    slotOf: new Array<number>(128).fill(-1),
    memory: [],
    sustain: 0,
    sostenuto: 0,
    soft: 0,
    pressure: 0,
    bend: 0,
    nextId: 1,
    noteOnCount: 0,
    noteOffCount: 0,
  };
}

export const isSounding = (key: KeyState): boolean => key.down || key.sustained || key.sostenuto;

const pedalDown = (depth: number, settings: KeyboardSettings): boolean => depth >= settings.pedalThreshold && depth > 0;

/** Fits the slot table to the voice count: new slots are empty, removed ones let their key go on sounding unslotted. */
function resizeSlots(state: KeyboardState, voices: number): void {
  while (state.slots.length > voices) {
    const key = state.slots.pop() as number;
    if (key >= 0) state.slotOf[key] = -1;
    state.memory.pop();
  }
  while (state.slots.length < voices) {
    state.slots.push(-1);
    state.memory.push({ pitch: 0, velocity: 0, start: -1, id: 0, releaseVelocity: 0 });
  }
}

/** Clears the per-frame counts. Call once before a frame's `advanceKeyboard` and messages. */
export function beginKeyboardFrame(state: KeyboardState, settings: KeyboardSettings): void {
  resizeSlots(state, Math.max(0, Math.floor(settings.voices)));
  state.noteOnCount = 0;
  state.noteOffCount = 0;
  for (const key of state.keys) key.strikes = 0;
}

/** The e-fold time of a sounding note at `pitch`. */
export function decaySecondsAt(pitch: number, settings: KeyboardSettings): number {
  return Math.max(1e-6, settings.decay) * 2 ** ((-(pitch - 60) / 12) * settings.decayTracking);
}

/** The share of the full damping rate a key is under right now: 0 undamped, 1 the dampers fully on. */
export function dampingOf(key: KeyState, state: KeyboardState, settings: KeyboardSettings): number {
  if (key.down || key.sostenuto) return 0;
  if (!key.sustained) return 1;
  return settings.halfPedal ? Math.min(1, Math.max(0, 1 - state.sustain)) : 0;
}

/** Moves every level by `deltaSeconds`, and frees the slot of a key that has stopped ringing. */
export function advanceKeyboard(state: KeyboardState, deltaSeconds: number, settings: KeyboardSettings): void {
  if (!(deltaSeconds > 0)) return;
  const release = Math.max(1e-6, settings.release);
  for (let pitch = 0; pitch < 128; pitch += 1) {
    const key = state.keys[pitch] as KeyState;
    if (key.level > 0) {
      const rate = 1 / decaySecondsAt(pitch, settings) + dampingOf(key, state, settings) / release;
      key.level *= Math.exp(-deltaSeconds * rate);
      if (key.level < LEVEL_FLOOR) key.level = 0;
    }
    const slot = state.slotOf[pitch] as number;
    if (slot >= 0 && key.level === 0 && !isSounding(key)) {
      state.slots[slot] = -1;
      state.slotOf[pitch] = -1;
    }
  }
}

/**
 * The slot a new note takes: the lowest empty one, else one it steals.
 *
 * THE STEAL ORDER, stated and deterministic: a voice that is only ringing out (damped)
 * goes first; then one a pedal is holding; a key under a finger last. Within each, the
 * quietest; of equally quiet ones the oldest strike; of those the lowest slot. A held key
 * is never taken while a pedalled or ringing voice exists.
 */
function takeSlot(state: KeyboardState): number {
  const empty = state.slots.indexOf(-1);
  if (empty >= 0) return empty;
  let chosen = -1;
  let chosenRank = Infinity;
  let chosenLevel = Infinity;
  let chosenId = Infinity;
  for (let slot = 0; slot < state.slots.length; slot += 1) {
    const key = state.keys[state.slots[slot] as number] as KeyState;
    const rank = key.down ? 2 : isSounding(key) ? 1 : 0;
    if (rank < chosenRank || (rank === chosenRank && (key.level < chosenLevel || (key.level === chosenLevel && key.id < chosenId)))) {
      chosen = slot;
      chosenRank = rank;
      chosenLevel = key.level;
      chosenId = key.id;
    }
  }
  if (chosen >= 0) state.slotOf[state.slots[chosen] as number] = -1;
  return chosen;
}

function remember(state: KeyboardState, slot: number, pitch: number): void {
  const key = state.keys[pitch] as KeyState;
  state.memory[slot] = { pitch, velocity: key.velocity, start: key.start, id: key.id, releaseVelocity: key.releaseVelocity };
}

function releaseKey(state: KeyboardState, pitch: number, velocity: number, settings: KeyboardSettings): void {
  const key = state.keys[pitch] as KeyState;
  if (!key.down) return;
  key.down = false;
  key.releaseVelocity = velocity;
  // Order decides: the pedal's depth AT THIS MESSAGE is what catches the note.
  key.sustained = pedalDown(state.sustain, settings);
  state.noteOffCount += 1;
  const slot = state.slotOf[pitch] as number;
  if (slot >= 0) remember(state, slot, pitch);
}

/** Applies one message, at `now` on the caller's clock. Messages must arrive in order. */
export function applyMidiEvent(state: KeyboardState, event: MidiEvent, now: number, settings: KeyboardSettings): void {
  if (settings.channel !== 0 && event.channel !== settings.channel) return;
  switch (event.kind) {
    case 0x90: {
      if (event.data2 === 0) {
        // A note-on at velocity 0 is a note-off, and carries no release velocity.
        releaseKey(state, event.data1, 0, settings);
        return;
      }
      const key = state.keys[event.data1] as KeyState;
      key.down = true;
      key.sustained = false;
      key.velocity = event.data2 / 127;
      key.level = key.velocity;
      key.releaseVelocity = 0;
      key.start = now;
      key.id = state.nextId;
      key.strikes += 1;
      state.nextId += 1;
      state.noteOnCount += 1;
      // A pitch that is still ringing in a voice is RE-STRUCK there; it does not take a second slot.
      let slot = state.slotOf[event.data1] as number;
      if (slot < 0 && state.slots.length > 0) {
        slot = takeSlot(state);
        state.slots[slot] = event.data1;
        state.slotOf[event.data1] = slot;
      }
      if (slot >= 0) remember(state, slot, event.data1);
      return;
    }
    case 0x80:
      releaseKey(state, event.data1, event.data2 / 127, settings);
      return;
    case 0xa0:
      (state.keys[event.data1] as KeyState).pressure = event.data2 / 127;
      return;
    case 0xd0:
      state.pressure = event.data1 / 127;
      return;
    case 0xe0:
      state.bend = ((event.data2 << 7) | event.data1) / 8192 - 1;
      return;
    case 0xb0: {
      const depth = event.data2 / 127;
      if (event.data1 === CC_SUSTAIN) {
        const was = pedalDown(state.sustain, settings);
        state.sustain = depth;
        // The pedal coming up lets go of every key it was holding. Going down catches
        // nothing by itself: a key already released is released.
        if (was && !pedalDown(depth, settings)) for (const key of state.keys) key.sustained = false;
      } else if (event.data1 === CC_SOSTENUTO) {
        const was = pedalDown(state.sostenuto, settings);
        const is = pedalDown(depth, settings);
        state.sostenuto = depth;
        if (!was && is) for (const key of state.keys) key.sostenuto = key.down;
        else if (was && !is) for (const key of state.keys) key.sostenuto = false;
      } else if (event.data1 === CC_SOFT) {
        state.soft = depth;
      } else if (event.data1 === CC_ALL_NOTES_OFF || event.data1 === CC_ALL_SOUND_OFF) {
        for (const key of state.keys) {
          key.down = false;
          key.sustained = false;
          key.sostenuto = false;
          if (event.data1 === CC_ALL_SOUND_OFF) key.level = 0;
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Twelve pitch-class energies (level squared, summed) over EVERY ringing key, C = 0; and the lowest ringing key or −1. */
export function keyboardChroma(state: KeyboardState, out: Float64Array): number {
  out.fill(0);
  let lowest = -1;
  for (let pitch = 0; pitch < 128; pitch += 1) {
    const level = (state.keys[pitch] as KeyState).level;
    if (level <= 0) continue;
    if (lowest < 0) lowest = pitch;
    out[pitch % 12] = (out[pitch % 12] as number) + level * level;
  }
  return lowest;
}

/** The triad the ringing keys make: the tonal nodes' profile (`sqrt(E / E_max)`) through the shared matcher. */
export function keyboardTriad(energies: Float64Array, lowest: number, profile: Float64Array): TriadMatch {
  let strongest = 0;
  for (let index = 0; index < 12; index += 1) strongest = Math.max(strongest, energies[index] as number);
  for (let index = 0; index < 12; index += 1) profile[index] = strongest > 0 ? Math.sqrt((energies[index] as number) / strongest) : 0;
  return lowest < 0 ? NO_TRIAD : matchTriad(profile, lowest % 12);
}
