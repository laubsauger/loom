/**
 * T1751b — THE TONAL FIELDS OF THE FEATURE RECORD: which pitch classes sound, and (from
 * §T1753b) the chord and key they make.
 *
 * The bands and the spectrum answer "how much energy, how high"; nothing in the record said
 * WHICH NOTE. It cannot be recovered downstream either: the spectrum that leaves the hop
 * analyser is 8-bit decibels of a 2048-sample window (23.4 Hz bins at 48 kHz, wider than a
 * semitone below about 400 Hz, clipped at −30 dB). So the pitch classes are measured where
 * the samples are (§T821: detectors live where the bins live), by a second, longer window
 * (`analysis/tonal-analyser.ts`), and carried here.
 *
 * ## The names are indices, C = 0
 *
 * `chroma0` is C, `chroma1` C sharp, … `chroma11` B: the numbering a chord root and a
 * voice's pitch class use, so "the class a fifth above the root" is index arithmetic and not
 * a table of note names. (The spectrum's names are frequencies a person says; a pitch class
 * is a number a person adds to.)
 *
 * ## Recorded contract (§V352)
 *
 * The window, the frequency range, the fold and the normalisation below are what a track's
 * `chroma*` MEAN, pinned by `feature-track.test.ts`; moving one is a versioning event.
 *
 * ## The chord and key are CLAIMS, and an empty claim says so
 *
 * §T1227's pattern: a field that declares itself empty rather than carrying a plausible
 * default. `chordConfidence` 0 is NO CLAIM and then `chordRoot`, `chordQuality` and
 * `chordAge` are 0; `keyConfidence` 0 likewise for `keyTonic` and `keyMode`. They shipped
 * empty with the chroma (§T1751b) and are estimated since §T1753b (`analysis/chord.ts`):
 * forward while listening, over the whole file when it is pre-analysed.
 */
export const CHROMA_NAMES = [
  "chroma0",
  "chroma1",
  "chroma2",
  "chroma3",
  "chroma4",
  "chroma5",
  "chroma6",
  "chroma7",
  "chroma8",
  "chroma9",
  "chroma10",
  "chroma11",
] as const;

export type ChromaName = (typeof CHROMA_NAMES)[number];

export type AudioChroma = { readonly [K in ChromaName]: number };

/** T1755b: the voices the record carries. Five, the `harmony` node's count. */
export const NOTE_VOICE_COUNT = 5;
const VOICE_FIELDS = ["Pitch", "Level", "Confidence", "Age", "OnsetCount", "Id"] as const;
type VoiceIndex = 0 | 1 | 2 | 3 | 4;
export type VoiceFieldName = `voice${VoiceIndex}${(typeof VOICE_FIELDS)[number]}`;

/**
 * T1756b — one tracked note per voice slot: `voiceNPitch` (MIDI number), `voiceNLevel`
 * (0..1), `voiceNConfidence` (0 is no voice), `voiceNAge` (seconds since its onset),
 * `voiceNOnsetCount` (onsets within the frame interval) and `voiceNId` (changes with every
 * note). Reserved by §T1755b at NO CLAIM (all 0), as the chord fields were by §T1751b.
 */
export type AudioVoices = { readonly [K in VoiceFieldName]: number };

/** The voice fields in record order: voice 0's six, then voice 1's, … */
export const VOICE_FIELD_NAMES: readonly VoiceFieldName[] = Array.from({ length: NOTE_VOICE_COUNT }, (_, voice) =>
  VOICE_FIELDS.map((field) => `voice${String(voice)}${field}` as VoiceFieldName),
).flat();

export interface AudioTonalFields extends AudioChroma, AudioVoices {
  /**
   * 0..1 — how much of the folded energy the four strongest classes hold, mapped so a flat
   * profile (one third) is 0 and `CHROMA_CONFIDENCE_FULL` is 1. A single tone and a clean
   * triad read exactly 1; noise and drums read near 0. 0 with no claim.
   */
  readonly chromaConfidence: number;
  /** The tuning the classes were folded against, in cents from A = 440 Hz, −50..50. */
  readonly tuning: number;
  /**
   * How far behind the sound the tonal fields are, in seconds: half the analysis window on
   * the live path, 0 on a pre-analysed file, whose windows are centred on the frame
   * (§T1752b). A field of the record so a replay reproduces it; 0 when the tonal pass did
   * not run.
   */
  readonly tonalLag: number;
  /** The chord's root, 0..11, C = 0. 0 with no claim. */
  readonly chordRoot: number;
  /** 0 none, 1 major, 2 minor. */
  readonly chordQuality: number;
  /** The chord's lead over the next best triad, 0..1. 0 is NO CLAIM, and root, quality and age are then 0. */
  readonly chordConfidence: number;
  /** Chord changes within the frame interval (§V357's shape): a new chord, or a claim beginning or ending. */
  readonly chordChangeCount: number;
  /** Seconds the current chord has held. */
  readonly chordAge: number;
  /** The key's tonic, 0..11, C = 0. 0 with no claim. */
  readonly keyTonic: number;
  /** 0 none, 1 major, 2 minor. */
  readonly keyMode: number;
  /** The key's lead over the next key, scaled by how much music has been heard. 0 is NO CLAIM, and tonic and mode are then 0. */
  readonly keyConfidence: number;
  /**
   * T1755b: the LEAD PITCH — the one note a single voice or instrument is playing — as a
   * fractional MIDI note number (69 is A = 440 Hz). 0 with no claim.
   */
  readonly pitch: number;
  /** T1755b: how periodic the window was, 0..1. 0 is NO CLAIM (a chord, noise, silence), and `pitch` is then 0. */
  readonly pitchConfidence: number;
  /** T1755b: lead-pitch note onsets within the frame interval (§V357's shape). */
  readonly pitchOnsetCount: number;
  /** T1755b: how far behind the sound the lead pitch is, in seconds; 0 when the pass did not run. */
  readonly pitchLag: number;
  /** T1756b: how many voices are alive. 0 until then. */
  readonly voiceCount: number;
}

/** The tonal fields in record order: the chroma in ascending pitch class, then the rest. */
export const TONAL_FIELD_NAMES = [
  ...CHROMA_NAMES,
  "chromaConfidence",
  "tuning",
  "tonalLag",
  "chordRoot",
  "chordQuality",
  "chordConfidence",
  "chordChangeCount",
  "chordAge",
  "keyTonic",
  "keyMode",
  "keyConfidence",
  // 5 (T1755b): the lead pitch, then the voices.
  "pitch",
  "pitchConfidence",
  "pitchOnsetCount",
  "pitchLag",
  "voiceCount",
  ...VOICE_FIELD_NAMES,
] as const satisfies ReadonlyArray<keyof AudioTonalFields>;

/** Every tonal field at 0: silence, and a capture with no tonal pass. */
export const NO_TONAL_CLAIM: AudioTonalFields = Object.fromEntries(
  TONAL_FIELD_NAMES.map((name) => [name, 0]),
) as unknown as AudioTonalFields;

/**
 * The analysis the chroma is defined over. 8192 samples is the shortest window that still
 * names a triad at C2 (measured: 4096 names the wrong chord there, 16384 gains nothing and
 * doubles the lag); a window every 2048 samples is 23.4 a second at 48 kHz.
 */
export const TONAL_ANALYSIS = {
  windowSize: 8192,
  hop: 2048,
  /** Peaks outside this range do not fold: below A1 the bins cannot place a semitone, above C8 are partials only. */
  lowHz: 55,
  highHz: 4200,
  /** A peak this far under the frame's strongest is leakage or noise, not a partial. */
  floorDecibels: -60,
  /**
   * And no partial is quieter than this amplitude (−100 dBFS), whatever else sounds. Without
   * it a frame with nothing inside the range (a hat, a sine at 9 kHz) has only rounding
   * residue there, and the relative floor would promote that residue to notes.
   */
  floorAmplitude: 1e-5,
  /** A frame whose mean square is under this (−70 dBFS) is silence: no claim. */
  silenceMeanSquare: 1e-7,
  referenceHz: 440,
} as const;

/**
 * T1755b — the lead pitch's grid: the hop analyser's own 2048 window, read on every second
 * hop (47 a second at 48 kHz). Recorded contract with the rest.
 */
export const PITCH_ANALYSIS = { everyHops: 2 } as const;

/** The four-class share that reads as full confidence. FIRST VALUE (synthetic signals only): triad 0.96, white noise 0.43. */
export const CHROMA_CONFIDENCE_FULL = 0.9;

/**
 * The node types that read the tonal fields. The capture runs the tonal pass only while the
 * document holds one of them (`captureConfigOf`), because the pass costs audio-thread time
 * every document without a tonal node should not pay.
 */
export const TONAL_NODE_TYPES: readonly string[] = ["audioChroma", "audioChord", "audioNotes"];
