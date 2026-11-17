import type { CompiledNodeDescription, NodeDefinition, StatefulDeclaration } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { absTimeSecondsOf } from "../../domain/types/frame.ts";
import { CHROMA_NAMES, NOTE_VOICE_COUNT, TONAL_ANALYSIS } from "../../domain/audio/tonal-fields.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * T1751b — THE TONAL NODES: projections of the session record's tonal fields.
 *
 * ## Why these are nodes of their own, with no input
 *
 * TouchDesigner and Notch both keep an analysis as its own operator beside the source, and
 * neither widens the source's output when an analysis is added. Their wire carries samples.
 * Loom's value wire carries a bag of numbers, and the session has exactly ONE capture of
 * which every audio node is a projection (§T414, §T434) — so these are SIBLINGS of Audio
 * In, reading the same record through `ValueEvaluateContext.audio`, and a wire from a
 * source into them would carry nothing. The alternative, the fields as more channels on
 * the sources, was measured and refused (see `AudioSourceFields` in `audio.ts`).
 *
 * The analysis itself is not here: it runs where the samples are (§T821) and only while the
 * document holds one of these nodes (`TONAL_NODE_TYPES`, `captureConfigOf`).
 *
 * ## THESE NODES SMOOTH, and the sources deliberately do not
 *
 * `audio.ts` keeps smoothing out of the source because a trigger wants the raw transient.
 * That holds for EVENTS, and every event the tonal nodes publish stays raw and
 * interval-shaped. The continuous channels are different in kind: a pitch class is a new
 * reading 23 times a second, which steps visibly at 60 frames a second, and the owner asked
 * for a picture that "would look pretty with any kind of audio source". So Attack and
 * Release default ON here and 0 gives the reading as it arrived. A decided difference from
 * the sources, named so it is not read as drift.
 */
const TONAL_STATEFUL: StatefulDeclaration = {
  reset: true,
  deterministicReplay: true,
  checkpoint: false,
  randomAccess: false,
};

const numberOr = (value: ParameterValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Hermite step from 0 at `low` to 1 at `high`. */
function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * Where the confidence gate opens and where it is fully open. FIRST VALUES, from synthetic
 * signals: white noise reads a confidence near 0.17, a triad under loud noise 0.9.
 */
export const CHROMA_GATE = { closed: 0.2, open: 0.6 } as const;

export const audioChromaNode: NodeDefinition = {
  type: "audioChroma",
  version: 1,
  title: "Chroma",
  category: "input",
  description:
    "Which NOTES sound, whatever octave they are in: twelve channels chroma0 … chroma11, one per pitch class with C = 0 (chroma0 is C, chroma1 C sharp, chroma9 A), read from the session's audio capture — the same one Audio In and Audio File In publish, so the document needs one of those to hear anything. Each value is that class's strength against the strongest class sounding, 0..1, so the loudest note reads 1 however quiet the music is; loudness is Audio In's level. chromaConfidence says how much to believe them: near 1 for a note, an interval or a chord, near 0 for noise, drums or silence, and with Gate on (the default) the twelve channels are multiplied by it, so a drum break fades the notes out instead of flickering them. tuning is how far the music sits from A = 440 Hz, in cents; it is measured, and the classes are read against it, so a recording a third of a semitone sharp still lands on the right names. THIS NODE SMOOTHS, unlike the audio sources: Attack and Release ease the twelve channels (a new reading arrives about 23 times a second, which would step at 60 frames a second), and 0 on both gives the readings exactly as they arrive. lagSeconds is how far behind the sound the reading is (about 0.085 s live: half the analysis window; 0 under Audio File In's timeline lock, where the file is known ahead and each frame reads the window centred on it) and lagFrames is the same in frames at this frame's step — delay a sibling branch by it to line the two up. Not a chord and not a melody: Chord and Notes are separate nodes. All zeros when no audio is live. CLOCKLESS (§V436): what was heard, so a timeline loop passes straight through it; under Audio File In's timeline lock it is read from the pre-analysed file at the playhead and a scrub finds the same notes every time.",
  tags: ["value", "input", "audio", "music", "chroma", "pitch", "note", "harmony", "key"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    gate: {
      type: "boolean",
      label: "Gate",
      default: true,
      description:
        "Multiply the twelve classes by a smooth step on chromaConfidence, so input with no pitch in it (drums, noise, a crowd) reads as no notes instead of twelve flickering ones. Off publishes the profile as measured; chromaConfidence is published either way.",
    },
    attack: {
      type: "number",
      label: "Attack",
      default: 0.03,
      min: 0,
      max: 2,
      range: "floor",
      step: 0.001,
      unit: "seconds",
      description: "The time a class takes to rise toward a new reading. 0 with Release 0 publishes the readings as they arrive.",
    },
    release: {
      type: "number",
      label: "Release",
      default: 0.25,
      min: 0,
      max: 10,
      range: "floor",
      step: 0.001,
      unit: "seconds",
      description: "The time a class takes to fall. Longer than Attack by default, so a note lights quickly and fades.",
    },
  },
  stateful: TONAL_STATEFUL,
  valueEvaluate: ({ audio, values, frame, state }) => {
    const confidence = audio?.chromaConfidence ?? 0;
    const gate = values["gate"] === false ? 1 : smoothstep(CHROMA_GATE.closed, CHROMA_GATE.open, confidence);
    const attack = Math.max(0, numberOr(values["attack"], 0.03));
    const release = Math.max(0, numberOr(values["release"], 0.25));
    const delta = frame.deltaSeconds;
    const held = (state["held"] ?? {}) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const name of CHROMA_NAMES) {
      const target = (audio?.[name] ?? 0) * gate;
      // First sight starts ON the reading (no swoop-in); a paused frame holds.
      const current = held[name] ?? target;
      const seconds = target > current ? attack : release;
      const next = seconds <= 0 ? target : delta <= 0 ? current : current + (target - current) * (1 - Math.exp(-delta / seconds));
      held[name] = next;
      out[name] = next;
    }
    state["held"] = held;
    const lagSeconds = audio?.tonalLag ?? 0;
    out["chromaConfidence"] = confidence;
    out["tuning"] = audio?.tuning ?? 0;
    out["lagSeconds"] = lagSeconds;
    out["lagFrames"] = delta > 0 ? lagSeconds / delta : 0;
    return out;
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

/**
 * How long the LIVE chord decode typically takes to report a change, beyond the analysis
 * window's own lag: an unrelated chord about 0.2 s, one sharing two notes about 0.4 s
 * (`CHORD_PENALTY`). A typical figure, published so a sibling branch can be delayed to meet
 * the chord; a pre-analysed file needs none, and its record says so by carrying a lag of 0.
 */
export const CHORD_LIVE_DECODE_SECONDS = 0.25;

/**
 * T1753b — Chord: the triad and the key the pitch classes make, as the record claims them.
 *
 * A pure projection, and stateless: the estimates are made where the samples are
 * (`analysis/chord.ts`) and live in the record, so a scrub under the timeline lock lands on
 * the same chord every time, and a file's chords begin on the frame their notes do. Nothing
 * to smooth here either: a chord already changes only when the decode says it has.
 *
 * `root` and `tonalCenter` are the `harmony` node's names, with its meanings (a pitch
 * class, C = 0), so a network reads the chord the same way from a score, from audio and
 * from a keyboard.
 */
export const audioChordNode: NodeDefinition = {
  type: "audioChord",
  version: 1,
  title: "Chord",
  category: "input",
  description:
    "The CHORD and the KEY of the session's audio, read from the same capture Audio In and Audio File In publish (the document needs one of those). root is the chord's root as a pitch class (0..11, C = 0), chordQuality is 1 for major, 2 for minor, and chordConfidence says what the claim is worth: how far this triad leads the next best one, 0..1. 0 is NO CLAIM, and root and quality are then 0 — silence, drums, a single note and a bare fifth all read no chord, never a guessed one. Major and minor triads only: a seventh reads as the triad inside it. chordChangeCount is the chord changes this frame (wire it to a Trigger or a Count) and chordAge the seconds the chord has held. A chord changes at musical rates, not per frame: live it is reported a few tenths of a second after it sounds (lagSeconds, about 0.34 s; lagFrames is the same in frames), under Audio File In's timeline lock the whole file is decoded ahead and a chord begins on the frame its notes do (lagSeconds 0). tonalCenter is the key's tonic (0..11), keyMode 1 major or 2 minor, keyConfidence its lead over the next key; a key is a slow fact, taking ten seconds or more of music to claim live and to change, and the relative major and minor are its honest confusion (the confidence drops there). Min Confidence (0 by default) hides a chord weaker than it. Not smoothed and not gated further: these are claims, published as made. All zeros when no audio is live. CLOCKLESS (§V436): what was heard, so a timeline loop passes straight through it.",
  tags: ["value", "input", "audio", "music", "chord", "harmony", "key", "root", "tonal"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    minConfidence: {
      type: "number",
      label: "Min Confidence",
      default: 0,
      min: 0,
      max: 1,
      range: "bounded",
      step: 0.01,
      description: "A chord claimed below this confidence is published as no chord (root, quality, confidence and age 0). 0, the default, publishes every claim the analysis makes: it already claims a chord only for a stretch that earns it, and holds the claim through that stretch. Raise this for fewer, surer chords, at the price that a held chord can blink out when its confidence dips.",
    },
  },
  valueEvaluate: ({ audio, values, frame }) => {
    const confidence = audio?.chordConfidence ?? 0;
    const shown = confidence > 0 && confidence >= Math.max(0, numberOr(values["minConfidence"], 0));
    const tonalLag = audio?.tonalLag ?? 0;
    // A lag of 0 in the record is the pre-analysed file: decoded ahead, nothing to wait for.
    const lagSeconds = tonalLag > 0 ? tonalLag + CHORD_LIVE_DECODE_SECONDS : 0;
    return {
      root: shown ? (audio?.chordRoot ?? 0) : 0,
      chordQuality: shown ? (audio?.chordQuality ?? 0) : 0,
      chordConfidence: shown ? confidence : 0,
      // An event is published raw, as every tonal node's events are: the change happened.
      chordChangeCount: audio?.chordChangeCount ?? 0,
      chordAge: shown ? (audio?.chordAge ?? 0) : 0,
      tonalCenter: audio?.keyTonic ?? 0,
      keyMode: audio?.keyMode ?? 0,
      keyConfidence: audio?.keyConfidence ?? 0,
      lagSeconds,
      lagFrames: frame.deltaSeconds > 0 ? lagSeconds / frame.deltaSeconds : 0,
    };
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

/**
 * T1755b — Notes: the melodic material of the session's audio: the LEAD PITCH, and (T1756b)
 * the tracked VOICES.
 *
 * The voices are the strongest few notes sounding, each in a slot it keeps until the note
 * ends (`analysis/voices.ts`). They wear the `harmony` node's names — `voiceNPitch`,
 * `voiceNPitchClass`, `voiceNPositionPitch`, `voiceNVelocity`, `voiceNEnvelope`,
 * `voiceNStart`, `voiceNId`, `noteDensity` — with its meanings, so a network that reads a
 * score's voices reads a recording's the same way; `voiceNOnsetCount`, `voiceNConfidence`
 * and `voiceCount` are this family's own. An empty slot keeps the pitch of the note it last
 * carried, as the keyboard node's does. What the audio cannot know is not published
 * (`voiceNDuration`: a note's length is known when it ends).
 *
 * The lead pitch is for ONE voice or instrument (a singer, a flute, a bass line on its own
 * stem): it is fast (about 40 ms behind) and exact to a few cents, and on anything that is
 * not one periodic sound it claims nothing — `pitchConfidence` 0 — instead of jumping
 * between the notes of a chord.
 *
 * Like Chroma, and unlike the sources, it eases: Glide moves `pitch` between notes, and Hold
 * keeps the last pitch while there is no claim, so a picture placed by pitch does not fall
 * to the floor in every rest. The confidence and the onset count are published raw.
 */
/** What Notes keeps per voice slot between frames. */
interface VoiceMemory {
  id: number;
  velocity: number;
  start: number;
  position: number;
  envelope: number;
}

/** The rate the tonal window's step is quoted at: the pre-analysis rate, 48 kHz. A live context at 44.1 kHz is 8 % off this figure. */
const PRE_ANALYSIS_RATE = 48_000;

export const audioNotesNode: NodeDefinition = {
  type: "audioNotes",
  version: 1,
  title: "Notes",
  category: "input",
  description:
    "The LEAD PITCH of the session's audio: the one note a single voice or instrument is playing, read from the same capture Audio In and Audio File In publish (the document needs one of those). pitch is a MIDI note number with a fraction (60 is middle C, 69 is A = 440 Hz, 69.5 a quarter tone above it), pitchClass the nearest note's class (0..11, C = 0), and pitchConfidence how periodic the sound is, 0..1. 0 is NO CLAIM: a chord, drums, noise and silence have no single pitch and read none, never the loudest partial. pitchOnsetCount is the notes that began this frame (a claim beginning, or the pitch moving most of a semitone and staying). For one voice at a time — a singer, a flute, a bass stem: on a full mix it mostly, and rightly, claims nothing. Two notes an octave apart read as the lower one; an instrument whose lowest partial is far weaker than the ones above it (the bottom octave of a piano, anything through a small speaker) reads no pitch, because that is also what several notes sounding together look like, and no claim is the honest answer to both. THIS NODE EASES, unlike the audio sources: Glide moves pitch between notes over that time (0 is the readings as they arrive), and Hold keeps the last pitch through a rest, so something placed by pitch stays where the last note left it while pitchConfidence says there is no note; Hold off publishes 0 with no claim. The range is about 47 Hz to 2 kHz. lagSeconds is how far behind the sound the lead reading is (about 0.04 s) and lagFrames the same in frames. THE VOICES are for everything else — a piano, a band, a mix: the strongest few notes sounding, each in a slot it KEEPS until its note ends, so voice2 is one note for as long as that note lasts and nothing driven from it flickers. Per slot (voice0 … up to Voices): voiceNPitch (the MIDI note), voiceNPitchClass (0..11, C = 0), voiceNPositionPitch (the pitch with its fraction, eased by Glide, for placing things), voiceNVelocity (the note's level when it began, 0..1), voiceNEnvelope (its level now, eased by Attack and Release; 0 is −60 dB and 1 full scale), voiceNStart (when it began, on the absolute clock; −1 before any), voiceNId (changes with every note), voiceNOnsetCount (notes begun this frame: a new note, or the same one struck again) and voiceNConfidence (how much of a note it looks like; 0 is an empty slot, which keeps showing the pitch of the note it last carried). voiceCount and noteDensity count the slots in use. NOT a transcription: on a solo piano recording a voice names a note that is sounding about five times in six, hears about half of the loudest notes, and reports a note about a tenth of a second after it begins (voiceLagSeconds; 0.043 s for a pre-analysed file); dense mixes do worse, and say so through the confidence. The names are the Harmony node's wherever the meaning is the same, so a score, a recording and a keyboard drive one network. All zeros when no audio is live. CLOCKLESS in what it reads, DELTA-DRIVEN in its glide and envelopes (§V436): a timeline loop passes straight through it.",
  tags: ["value", "input", "audio", "music", "pitch", "note", "melody", "voice", "tuner"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    glide: {
      type: "number",
      label: "Glide",
      default: 0.03,
      min: 0,
      max: 2,
      range: "floor",
      step: 0.001,
      unit: "seconds",
      description: "The time pitch takes to move to a new reading. 0 publishes the readings as they arrive. A note that begins after a rest starts ON its pitch: there is nothing to glide from.",
    },
    hold: {
      type: "boolean",
      label: "Hold",
      default: true,
      description: "Keep the last claimed pitch while there is no claim (a rest, a chord, noise), so a picture placed by pitch does not drop to 0. pitchConfidence is 0 there either way. Off: pitch and pitchClass read 0 with no claim.",
    },
    voices: {
      type: "number",
      label: "Voices",
      group: "Voices",
      default: 4,
      min: 1,
      max: NOTE_VOICE_COUNT,
      step: 1,
      range: "bounded",
      description: "How many voice slots are published (voice0 … voiceN-1). The analysis tracks five; five matches the Harmony node.",
    },
    attack: {
      type: "number",
      label: "Attack",
      group: "Voices",
      default: 0.01,
      min: 0,
      max: 2,
      range: "floor",
      step: 0.001,
      unit: "seconds",
      description: "The time a voice's envelope takes to rise to its note's level. 0 with Release 0 publishes the level as read.",
    },
    release: {
      type: "number",
      label: "Release",
      group: "Voices",
      default: 0.3,
      min: 0,
      max: 10,
      range: "floor",
      step: 0.001,
      unit: "seconds",
      description: "The time a voice's envelope takes to fall, as its note fades and after it ends.",
    },
  },
  stateful: TONAL_STATEFUL,
  valueEvaluate: ({ audio, values, frame, state }) => {
    const confidence = audio?.pitchConfidence ?? 0;
    const claimed = confidence > 0;
    const glide = Math.max(0, numberOr(values["glide"], 0.03));
    const hold = values["hold"] !== false;
    const delta = frame.deltaSeconds;
    const held = state["pitch"] as number | undefined;
    /** Whether the previous frame had a claim: a note after a rest starts on its pitch. */
    const wasClaimed = state["claimed"] === true;
    let pitch = 0;
    if (claimed) {
      const target = audio?.pitch ?? 0;
      pitch = held === undefined || !wasClaimed || glide <= 0 ? target : delta <= 0 ? held : held + (target - held) * (1 - Math.exp(-delta / glide));
      state["pitch"] = pitch;
    } else if (hold && held !== undefined) {
      pitch = held;
    }
    state["claimed"] = claimed;
    const lagSeconds = audio?.pitchLag ?? 0;
    const bag: Record<string, number> = {
      pitch,
      pitchClass: pitch > 0 ? ((Math.round(pitch) % 12) + 12) % 12 : 0,
      pitchConfidence: confidence,
      pitchOnsetCount: audio?.pitchOnsetCount ?? 0,
      lagSeconds,
      lagFrames: delta > 0 ? lagSeconds / delta : 0,
    };

    // T1756b: the voices.
    const count = Math.min(NOTE_VOICE_COUNT, Math.max(1, Math.floor(numberOr(values["voices"], 4))));
    const attack = Math.max(0, numberOr(values["attack"], 0.01));
    const release = Math.max(0, numberOr(values["release"], 0.3));
    const now = absTimeSecondsOf(frame);
    const record = audio as unknown as Readonly<Record<string, number>> | undefined;
    const memory = (state["voices"] ??= []) as VoiceMemory[];
    let alive = 0;
    for (let slot = 0; slot < count; slot += 1) {
      const prefix = `voice${String(slot)}`;
      const read = (field: string): number => record?.[`${prefix}${field}`] ?? 0;
      const heard = read("Confidence") > 0;
      const id = read("Id");
      const kept = (memory[slot] ??= { id: 0, velocity: 0, start: -1, position: 0, envelope: 0 });
      const target = read("Pitch");
      if (id !== kept.id) {
        // A new note: its level now is its velocity, its start is its age ago, and its
        // position starts ON its pitch.
        kept.id = id;
        kept.velocity = read("Level");
        kept.start = now - read("Age");
        kept.position = target;
      } else if (heard) {
        kept.position = glide <= 0 ? target : delta <= 0 ? kept.position : kept.position + (target - kept.position) * (1 - Math.exp(-delta / glide));
      }
      const level = heard ? read("Level") : 0;
      const seconds = level > kept.envelope ? attack : release;
      kept.envelope = seconds <= 0 ? level : delta <= 0 ? kept.envelope : kept.envelope + (level - kept.envelope) * (1 - Math.exp(-delta / seconds));
      if (heard) alive += 1;
      // The pitch is the record's, which keeps the last note's while the slot is empty.
      const nearest = Math.round(target);
      bag[`${prefix}Pitch`] = nearest;
      bag[`${prefix}PitchClass`] = ((nearest % 12) + 12) % 12;
      bag[`${prefix}PositionPitch`] = kept.position;
      bag[`${prefix}Velocity`] = kept.velocity;
      bag[`${prefix}Envelope`] = kept.envelope;
      bag[`${prefix}Start`] = kept.start;
      bag[`${prefix}Id`] = id;
      bag[`${prefix}OnsetCount`] = read("OnsetCount");
      bag[`${prefix}Confidence`] = read("Confidence");
    }
    bag["voiceCount"] = alive;
    bag["noteDensity"] = alive;
    // The voices are read off the long window and confirmed over one more: half a window
    // (0 for a pre-analysed file, whose windows are centred) plus a window step.
    const voiceLag = (audio?.tonalLag ?? 0) + (audio === undefined ? 0 : TONAL_ANALYSIS.hop / PRE_ANALYSIS_RATE);
    bag["voiceLagSeconds"] = voiceLag;
    bag["voiceLagFrames"] = delta > 0 ? voiceLag / delta : 0;
    return bag;
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

/**
 * T1757b — Tone Pattern: the TONAL nodes' understudy, as Audio Pattern is the sources'.
 *
 * A four-chord progression with a bass, a triad and an arpeggiated lead, as channels,
 * from the FRAME CLOCK alone: no capture, no permission, no file, and replayable by
 * construction. It publishes the union of Chroma's, Chord's and Notes' channels under the
 * same names, so a network built on it takes a real analysis by replacing one node per
 * family and keeping the label — and a shipped example that reads notes plays the moment it
 * opens (§V363).
 *
 * Audio Pattern gains nothing from this row, deliberately: it mirrors the SOURCES, which
 * publish no tonal channel, and a drum pattern has no honest pitch classes (§T776: a
 * fixture that invents a signal trains every consumer on something music does not send).
 *
 * SHAPE, NOT MEASUREMENT, and said so (§T1347b's words for the pattern's spectrum). The
 * pitch classes are computed from the notes that are sounding and a fixed harmonic series —
 * each note's partial h at 1/h, so its fifth and its third leak into the classes as they do
 * in a real spectrum — through the profile the analysis publishes (`sqrt(E / E_max)`).
 * What it guarantees: the names, the ranges, which class leads, and that the chord, the key
 * and the voices agree with each other. Confidences are 1: this node does not estimate
 * music, it IS the music, as Audio Pattern's tempo claim is 1.
 */
const TONE_PROGRESSION = {
  // I – V – vi – IV, and the same shape from the relative minor: i – VI – III – VII.
  major: [
    [0, 1],
    [7, 1],
    [9, 2],
    [5, 1],
  ],
  minor: [
    [0, 2],
    [8, 1],
    [3, 1],
    [10, 1],
  ],
} as const;
const TONE_BEATS_PER_BAR = 4;
/** How a struck note falls: e-fold times, in seconds, for the held chord and the lead. */
const TONE_CHORD_DECAY = 2.5;
const TONE_LEAD_DECAY = 0.6;
const TONE_VOICES = 4;
/** Partial h of a note lands on this interval above it, in semitones mod 12. */
const TONE_PARTIAL_INTERVALS = [0, 0, 7, 0, 4, 7] as const;

export const tonePatternNode: NodeDefinition = {
  type: "tonePattern",
  version: 1,
  title: "Tone Pattern",
  category: "value",
  description:
    "A deterministic test PROGRESSION as tonal channels — four chords, a bar each (I, V, vi, IV in a major key; i, VI, III, VII in a minor one), with a bass, the triad above it and a lead that plays one chord tone a beat — synthesized from the frame clock. Publishes EVERY channel Chroma, Chord and Notes do, under the same names, so swapping in a real analysis is one node per family: chroma0 … chroma11 with chromaConfidence and tuning; root, chordQuality, chordConfidence, chordChangeCount, chordAge, tonalCenter, keyMode, keyConfidence; pitch, pitchClass, pitchConfidence, pitchOnsetCount for the lead; and four voices (voice0 the bass, voice1 to voice3 the triad) each with Pitch, PitchClass, PositionPitch, Velocity, Envelope, Start, Id, OnsetCount and Confidence, plus voiceCount and noteDensity. The pitch classes are shaped from the sounding notes and their partials, so a note's fifth shows faintly beside it as it does in a real recording; the confidences are 1, because this node does not estimate the music, it is the music. Amount scales the envelopes and silences everything at 0. No microphone, no file, replayable by construction. TIMELINE-ANCHORED by design (§V436): it stands in for a piece playing along the timeline, so bar one lands at the in point and a scrub finds the same chord every time.",
  tags: ["value", "audio", "music", "test", "chord", "notes", "pattern", "deterministic"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    bpm: { type: "number", label: "BPM", default: 90, min: 20, max: 300, range: "floor", description: "Beats a minute. A chord lasts four beats; the lead plays one note a beat." },
    key: { type: "number", label: "Key", default: 0, min: 0, max: 11, step: 1, range: "bounded", description: "The tonic as a pitch class: C = 0, C sharp = 1, D = 2, through B = 11." },
    mode: {
      type: "enum",
      label: "Mode",
      default: "major",
      options: [
        { value: "major", label: "Major" },
        { value: "minor", label: "Minor" },
      ],
      description: "Major plays I, V, vi, IV; minor plays i, VI, III, VII.",
    },
    amount: { type: "number", label: "Amount", default: 1, min: 0, max: 1, range: "bounded", description: "Master gain on every envelope. 0 is silence: no notes, no classes, no claims." },
  },
  valueEvaluate: ({ values, frame }) => {
    const bpm = Math.max(1, numberOr(values["bpm"], 90));
    const key = ((Math.floor(numberOr(values["key"], 0)) % 12) + 12) % 12;
    const minor = values["mode"] === "minor";
    const amount = Math.min(1, Math.max(0, numberOr(values["amount"], 1)));
    const sounding = amount > 0 ? 1 : 0;
    // TIMELINE-ANCHORED (§V436), on purpose: the wrapping clock, so bar one lands on the in
    // point every lap, as Audio Pattern's beat does. A frame with no time (a caller that
    // passed no rate) is the in point, not a crash.
    const stamped = frame.timeSeconds;
    const clock = Number.isFinite(stamped) ? stamped : 0;
    const step = Number.isFinite(frame.deltaSeconds) ? frame.deltaSeconds : 0;
    const time = Math.max(0, clock);
    const before = Math.max(0, clock - step);
    const beatSeconds = 60 / bpm;
    const barSeconds = beatSeconds * TONE_BEATS_PER_BAR;
    const beats = time / beatSeconds;
    const bar = Math.floor(beats / TONE_BEATS_PER_BAR);
    const beat = Math.floor(beats);
    const [interval, quality] = (minor ? TONE_PROGRESSION.minor : TONE_PROGRESSION.major)[bar % 4] as readonly [number, number];
    const root = (key + interval) % 12;
    const third = quality === 1 ? 4 : 3;
    // T437's interval arithmetic: the bars and beats crossed in (before, time], so a slow
    // frame under a fast tempo honestly reports 2. Bar one's start, at the in point, is not
    // a crossing INTO it from anywhere.
    const barsCrossed = Math.max(0, bar - Math.floor(before / barSeconds)) + (clock - step < 0 && clock >= 0 ? 1 : 0);
    const beatsCrossed = Math.max(0, beat - Math.floor(before / beatSeconds)) + (clock - step < 0 && clock >= 0 ? 1 : 0);
    const barStart = bar * barSeconds;
    const chordLevel = Math.exp(-(time - barStart) / TONE_CHORD_DECAY);
    const leadLevel = Math.exp(-(time - beat * beatSeconds) / TONE_LEAD_DECAY);

    // The notes: a bass an octave under the triad, and the lead an octave over it.
    const chordPitches = [48 + root, 60 + root, 60 + root + third, 60 + root + 7];
    const velocities = [0.8, 0.7, 0.6, 0.6];
    const lead = 72 + root + ([0, third, 7, third][beat % 4] as number);
    const leadVelocity = 0.7;

    // The pitch classes: each sounding note's partials at 1/h, as energies, then the profile.
    const energies = new Array<number>(12).fill(0);
    const add = (pitch: number, amplitude: number): void => {
      TONE_PARTIAL_INTERVALS.forEach((semitones, index) => {
        const pitchClass = (pitch + semitones) % 12;
        energies[pitchClass] = (energies[pitchClass] as number) + (amplitude / (index + 1)) ** 2;
      });
    };
    chordPitches.forEach((pitch, slot) => add(pitch, (velocities[slot] as number) * chordLevel * amount));
    add(lead, leadVelocity * leadLevel * amount);
    const strongest = Math.max(...energies);

    const bag: Record<string, number> = {};
    CHROMA_NAMES.forEach((name, pitchClass) => {
      bag[name] = strongest > 0 ? Math.sqrt((energies[pitchClass] as number) / strongest) : 0;
    });
    bag["chromaConfidence"] = sounding;
    bag["tuning"] = 0;
    bag["lagSeconds"] = 0;
    bag["lagFrames"] = 0;
    bag["root"] = sounding * root;
    bag["chordQuality"] = sounding * quality;
    bag["chordConfidence"] = sounding;
    bag["chordChangeCount"] = sounding * barsCrossed;
    bag["chordAge"] = sounding * (time - barStart);
    bag["tonalCenter"] = sounding * key;
    bag["keyMode"] = sounding * (minor ? 2 : 1);
    bag["keyConfidence"] = sounding;
    bag["pitch"] = sounding * lead;
    bag["pitchClass"] = sounding * (lead % 12);
    bag["pitchConfidence"] = sounding;
    bag["pitchOnsetCount"] = sounding * beatsCrossed;
    for (let slot = 0; slot < TONE_VOICES; slot += 1) {
      const pitch = chordPitches[slot] as number;
      const prefix = `voice${String(slot)}`;
      bag[`${prefix}Pitch`] = sounding * pitch;
      bag[`${prefix}PitchClass`] = sounding * (pitch % 12);
      bag[`${prefix}PositionPitch`] = sounding * pitch;
      bag[`${prefix}Velocity`] = (velocities[slot] as number) * amount;
      bag[`${prefix}Envelope`] = (velocities[slot] as number) * chordLevel * amount;
      bag[`${prefix}Start`] = sounding === 1 ? barStart : -1;
      bag[`${prefix}Id`] = sounding * (bar * TONE_VOICES + slot + 1);
      bag[`${prefix}OnsetCount`] = sounding * barsCrossed;
      bag[`${prefix}Confidence`] = sounding;
    }
    bag["voiceCount"] = sounding * TONE_VOICES;
    bag["noteDensity"] = sounding * TONE_VOICES;
    bag["voiceLagSeconds"] = 0;
    bag["voiceLagFrames"] = 0;
    return bag;
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
