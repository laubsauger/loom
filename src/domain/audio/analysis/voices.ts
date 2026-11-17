/**
 * T1756b — NOTE VOICES: the strongest few notes sounding, each in a slot it keeps.
 *
 * Not a transcription. A transcription answers "which notes were played"; this answers
 * "which few notes can a picture follow right now", and what it must never do is flicker:
 * `voice2` is the same note until that note ends.
 *
 * ## From the peaks the chroma already found (`chroma.ts`), no second transform
 *
 * 1. SALIENCE. A candidate note is a peak; its salience is the amplitude of its partials
 *    1 to 8, each weighted 0.8 per step up. Only a peak can be a note: a candidate with no
 *    energy at its own frequency is the common period of other notes, not a note (§T1755b
 *    measured that a fifth and a major triad are as periodic as a single tone).
 * 2. PICK, WITH CANCELLATION. Take the most salient candidate, then take out of the
 *    remaining peaks what that note's partials account for — a 1/h share of its
 *    fundamental — and pick again. That is what stops one note being three voices an octave
 *    and a twelfth apart; and because only the EXPECTED share is removed, a real note an
 *    octave above (louder than a second partial would be) survives it.
 * 3. TRACK. A picked note within `VOICE_MATCH_SEMITONES` of a living voice continues it,
 *    in its slot. An unmatched one must be picked `VOICE_BIRTH_FRAMES` frames running
 *    before it takes a slot (one frame of anything is not a note); a voice not picked for
 *    `VOICE_DEATH_FRAMES` frames ends. Slots never reorder.
 *
 * ## What the numbers are
 *
 * `pitch` is a MIDI note number with a fraction. `level` is the note's amplitude on a
 * decibel scale, −60 dBFS at 0 and full scale at 1 (the analyser bands' kind of number).
 * `confidence` is how much of a note it looks like — partials found above its fundamental,
 * times how tonal the frame is — and 0 means the slot is empty. `id` changes with every
 * onset; an ONSET is a birth, or a level that rose by `VOICE_REONSET_DECIBELS` over two
 * frames (the same key struck again).
 */
import { midiOf, type SpectralPeaks } from "./chroma.ts";

export const VOICE_SLOTS = 5;
export const VOICE_PARTIALS = 8;
export const VOICE_PARTIAL_WEIGHT = 0.8;
/** How close a peak must be to a partial's place to be that partial. */
export const VOICE_PARTIAL_CENTS = 35;
export const VOICE_MATCH_SEMITONES = 0.8;
export const VOICE_BIRTH_FRAMES = 2;
export const VOICE_DEATH_FRAMES = 3;
export const VOICE_REONSET_DECIBELS = 6;
/**
 * A candidate under this share of the frame's most salient note is not picked. Set on ONE
 * piano recording (§T1756b's score): at 0.12 a voice names a sounding note 80.5 % of the
 * time, at 0.2 84.0 %, at 0.3 86.6 %, and it hears fewer of the notes as it rises.
 */
export const VOICE_SALIENCE_SHARE = 0.2;
/** The amplitude that reads level 0: −60 dBFS. */
export const VOICE_FLOOR_DECIBELS = -60;

export interface VoiceState {
  /** A MIDI note number with a fraction; the last note's while the slot is empty. */
  readonly pitch: number;
  /** 0..1, decibel-scaled; 0 while empty. */
  readonly level: number;
  /** 0 is an EMPTY slot. */
  readonly confidence: number;
  /** Seconds since the note's last onset; 0 while empty. */
  readonly age: number;
  /** An onset on this frame. */
  readonly onset: boolean;
  /** Changes with every onset; 0 before the slot's first note. */
  readonly id: number;
}

export interface VoiceTracker {
  /**
   * One frame's peaks. `amplitudeOf` turns a peak's energy into a sine amplitude (the
   * window's scale), `tonal` is the frame's chroma confidence, `seconds` the time since the
   * previous frame.
   */
  push(peaks: SpectralPeaks, amplitudeOf: (energy: number) => number, tonal: number, seconds: number): readonly VoiceState[];
}

interface Picked {
  readonly pitch: number;
  readonly amplitude: number;
  readonly partials: number;
}

interface Living {
  pitch: number;
  level: number;
  confidence: number;
  age: number;
  id: number;
  missed: number;
  /** The level two frames ago and one frame ago, for the re-onset test. */
  before: number;
  last: number;
}

const levelOf = (amplitude: number): number => {
  if (amplitude <= 0) return 0;
  const level = 1 - (20 * Math.log10(amplitude)) / VOICE_FLOOR_DECIBELS;
  return level <= 0 ? 0 : level >= 1 ? 1 : level;
};

/** The notes of one frame, most salient first: salience by harmonic summation, picked with cancellation. */
export function pickNotes(peaks: SpectralPeaks, amplitudeOf: (energy: number) => number, limit: number): Picked[] {
  const count = peaks.count;
  const frequency = peaks.frequency;
  /** What is left of each peak's amplitude as notes are taken out. */
  const residual = new Float64Array(count);
  for (let index = 0; index < count; index += 1) residual[index] = amplitudeOf(peaks.energy[index] as number);
  const tolerance = 2 ** (VOICE_PARTIAL_CENTS / 1200);
  /** The peak nearest `target` Hz within the tolerance, or −1. Peaks ascend in frequency. */
  const peakAt = (target: number): number => {
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((frequency[middle] as number) < target) low = middle + 1;
      else high = middle;
    }
    let best = -1;
    for (const candidate of [low - 1, low]) {
      if (candidate < 0 || candidate >= count) continue;
      const ratio = (frequency[candidate] as number) / target;
      if (ratio > tolerance || ratio < 1 / tolerance) continue;
      if (best < 0 || Math.abs(Math.log(ratio)) < Math.abs(Math.log((frequency[best] as number) / target))) best = candidate;
    }
    return best;
  };

  const picked: Picked[] = [];
  let first = 0;
  while (picked.length < limit) {
    let chosen = -1;
    let chosenSalience = 0;
    for (let index = 0; index < count; index += 1) {
      const fundamental = residual[index] as number;
      if (fundamental <= 0) continue;
      let salience = fundamental;
      let weight = VOICE_PARTIAL_WEIGHT;
      for (let h = 2; h <= VOICE_PARTIALS; h += 1) {
        const at = peakAt((frequency[index] as number) * h);
        if (at >= 0) salience += weight * (residual[at] as number);
        weight *= VOICE_PARTIAL_WEIGHT;
      }
      if (salience > chosenSalience) {
        chosenSalience = salience;
        chosen = index;
      }
    }
    if (chosen < 0) break;
    if (picked.length === 0) first = chosenSalience;
    else if (chosenSalience < VOICE_SALIENCE_SHARE * first) break;
    const fundamental = residual[chosen] as number;
    let amplitude = fundamental;
    let partials = 0;
    residual[chosen] = 0;
    for (let h = 2; h <= VOICE_PARTIALS; h += 1) {
      const at = peakAt((frequency[chosen] as number) * h);
      if (at < 0) continue;
      // The note accounts for a 1/h share of its fundamental at partial h; a peak louder than
      // that keeps the rest, which is how a real note an octave up survives.
      const taken = Math.min(residual[at] as number, fundamental / h);
      if (taken > 0) {
        amplitude += taken;
        partials += 1;
        residual[at] = (residual[at] as number) - taken;
      }
    }
    picked.push({ pitch: midiOf(frequency[chosen] as number, 440), amplitude, partials });
  }
  return picked;
}

export function createVoiceTracker(): VoiceTracker {
  const slots: Array<Living | null> = new Array<Living | null>(VOICE_SLOTS).fill(null);
  /** What each slot last carried, published while it is empty. */
  const memory: Array<{ pitch: number; id: number }> = Array.from({ length: VOICE_SLOTS }, () => ({ pitch: 0, id: 0 }));
  /** Notes picked but not yet born: their pitch and how many frames running. */
  let pending: Array<{ pitch: number; frames: number }> = [];
  let nextId = 1;

  return {
    push(peaks, amplitudeOf, tonal, seconds) {
      // More candidates than slots, so a newcomer can be seen while every slot is taken.
      const picked = pickNotes(peaks, amplitudeOf, VOICE_SLOTS + 2);
      const taken = new Array<boolean>(picked.length).fill(false);
      const onsets = new Array<boolean>(VOICE_SLOTS).fill(false);
      // Never 0 for a living voice: 0 is the empty slot's value.
      const confidenceOf = (note: Picked): number => Math.max(0.01, tonal * (0.5 + 0.5 * Math.min(1, note.partials / 2)));

      // 1. Living voices continue with the nearest picked note in reach.
      for (let slot = 0; slot < VOICE_SLOTS; slot += 1) {
        const voice = slots[slot];
        if (voice === null || voice === undefined) continue;
        let match = -1;
        for (let index = 0; index < picked.length; index += 1) {
          if (taken[index]) continue;
          const distance = Math.abs((picked[index] as Picked).pitch - voice.pitch);
          if (distance <= VOICE_MATCH_SEMITONES && (match < 0 || distance < Math.abs((picked[match] as Picked).pitch - voice.pitch))) match = index;
        }
        if (match < 0) {
          voice.missed += 1;
          voice.age += seconds;
          if (voice.missed >= VOICE_DEATH_FRAMES) slots[slot] = null;
          continue;
        }
        taken[match] = true;
        const note = picked[match] as Picked;
        const level = levelOf(note.amplitude);
        // The same key struck again: the level is up by the re-onset step over two frames.
        const rise = (level - Math.min(voice.before, voice.last)) * -VOICE_FLOOR_DECIBELS;
        const again = voice.missed === 0 && rise >= VOICE_REONSET_DECIBELS;
        voice.before = again ? level : voice.last;
        voice.last = level;
        voice.pitch = note.pitch;
        voice.level = level;
        voice.confidence = confidenceOf(note);
        voice.missed = 0;
        voice.age = again ? 0 : voice.age + seconds;
        if (again) {
          voice.id = nextId;
          nextId += 1;
          onsets[slot] = true;
        }
      }

      // 2. Unmatched notes wait; one seen often enough is born into the lowest empty slot.
      const waiting: Array<{ pitch: number; frames: number }> = [];
      for (let index = 0; index < picked.length; index += 1) {
        if (taken[index]) continue;
        const note = picked[index] as Picked;
        const seen = pending.find((entry) => Math.abs(entry.pitch - note.pitch) <= VOICE_MATCH_SEMITONES);
        const frames = (seen?.frames ?? 0) + 1;
        const slot = frames >= VOICE_BIRTH_FRAMES ? slots.indexOf(null) : -1;
        if (slot < 0) {
          waiting.push({ pitch: note.pitch, frames });
          continue;
        }
        const level = levelOf(note.amplitude);
        slots[slot] = { pitch: note.pitch, level, confidence: confidenceOf(note), age: 0, id: nextId, missed: 0, before: level, last: level };
        nextId += 1;
        onsets[slot] = true;
      }
      pending = waiting;

      return slots.map((voice, slot) => {
        const kept = memory[slot] as { pitch: number; id: number };
        if (voice === null || voice === undefined) return { pitch: kept.pitch, level: 0, confidence: 0, age: 0, onset: false, id: kept.id };
        kept.pitch = voice.pitch;
        kept.id = voice.id;
        // A voice coasting through a missed frame keeps its place and says it is fading.
        const fade = voice.missed === 0 ? 1 : 1 - voice.missed / VOICE_DEATH_FRAMES;
        return { pitch: voice.pitch, level: voice.level * fade, confidence: voice.confidence * fade, age: voice.age, onset: onsets[slot] as boolean, id: voice.id };
      });
    },
  };
}
