/**
 * T1805b: THE MUSIC FEATURES CONTRACT. What `MusicFeatures` (audio) and `MidiFeatures` (a
 * MIDI keyboard) publish, declared once: the generator (`music-features.ts`) names its
 * outputs from it, the claims test holds both shipped components to it, and the example
 * (E91) reads it.
 *
 * THE RULE: both components publish EVERY channel of the six shared groups on EVERY frame.
 * Where a side cannot know a value, the channel reads its `rest` and the confidence beside
 * it reads 0; nothing is invented. So a Switch, a crossfade or an Expression with no
 * Defaults works on either source.
 *
 * Conventions: lowerCamel names; indexed families are `voiceNField`, `regionN`, `laneN`;
 * a pitch class is 0..11 with C = 0; a pitch is a MIDI note number; a start time is in
 * seconds on `abstime`, -1 before the first strike; an event is raw, per frame.
 */

/** `voice0` is the bass, `voice4` the top, `voice1`..`voice3` the inner voices, low to high. */
export const MUSIC_VOICES = 5;
/** The five spectral regions of `levels`, as the spectrum rows (`band80` … `band16000`) each one averages. */
export const MUSIC_REGION_BANDS: readonly (readonly number[])[] = [
  [80, 109, 149, 204],
  [149, 204, 278, 380, 519],
  [380, 519, 709, 968, 1300],
  [968, 1300, 1800, 2500, 3400],
  [1800, 2500, 3400, 4600, 6300, 8600, 11700, 16000],
];
/** MidiFeatures only: five lanes between the bass and the top note, lane 0 at the bass. */
export const MIDI_LANES = 5;

export interface FeatureChannel {
  readonly name: string;
  /** Inclusive bounds. `max: null` is a count or a clock: it grows without a bound. */
  readonly min: number;
  readonly max: number | null;
  readonly unit: string;
  /**
   * What MusicFeatures reads in silence, from the first frame. `null` is a channel that
   * does not rest: the tempo in effect and the beat clock, which run with no music.
   */
  readonly rest: number | null;
  /** What MidiFeatures reads before any key, where that is not `rest`. */
  readonly restFromKeys?: number;
}

const channel = (name: string, min: number, max: number | null, unit: string, rest: number | null = 0, restFromKeys?: number): FeatureChannel => ({
  name,
  min,
  max,
  unit,
  rest,
  ...(restFromKeys === undefined ? {} : { restFromKeys }),
});
const unit = (name: string, rest = 0, restFromKeys?: number): FeatureChannel => channel(name, 0, 1, "0..1", rest, restFromKeys);
const indexed = (count: number, each: (index: number) => readonly FeatureChannel[]): FeatureChannel[] =>
  Array.from({ length: count }, (_, index) => each(index)).flat();
const smoothstep = (low: number, high: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** Before any key, MidiFeatures takes the bass as note 48 and the top as 72, and an empty role sits at its place between them. */
export const KEYS_REST_PITCH = (voice: number): number => 48 + ((72 - 48) * voice) / (MUSIC_VOICES - 1);
/**
 * `tension` does not rest at 0, on either side (T1806b). Audio's raw score is 0.2 while the
 * gate is shut; a keyboard's is 0.08 plus 0.1 of the bass-to-top span (24 of 36 semitones
 * at rest). Both go through the same curve.
 */
const TENSION_REST = smoothstep(0.1, 0.7, 0.2);
const TENSION_REST_FROM_KEYS = smoothstep(0.1, 0.7, 0.08 + 0.1 * ((72 - 48) / 36));

/** The six groups both components publish, in output order. */
export const MUSIC_FEATURE_GROUPS = {
  levels: [
    unit("inputLevel"),
    unit("gate"),
    unit("level"),
    unit("levelFast"),
    ...indexed(MUSIC_REGION_BANDS.length, (region) => [unit(`region${String(region)}`)]),
  ],
  beats: [
    unit("onset"),
    unit("onsetLow"),
    unit("kick"),
    unit("snare"),
    unit("hat"),
    unit("kickFast"),
    unit("snareFast"),
    unit("hatFast"),
    unit("drumPresence"),
  ],
  tempo: [
    // Never 0: the declared tempo, else the detected one, else the project's.
    channel("bpm", 20, 300, "beats a minute", null),
    channel("bpmDetected", 0, 180, "beats a minute; 0 = no claim, else folded into 60..180"),
    unit("bpmConfidence"),
    channel("beats", 0, null, "beats since the component started, at bpm", null),
    channel("beatPhase", 0, 1, "0..1, the fraction of beats", null),
  ],
  notes: [
    ...indexed(MUSIC_VOICES, (voice) => {
      const name = (field: string): string => `voice${String(voice)}${field}`;
      return [
        channel(name("Start"), -1, null, "abstime seconds of the last strike; -1 = none yet", -1),
        // MidiFeatures applies the pedals as a gain of up to 1.2 (T1806b).
        channel(name("Envelope"), 0, 1.2, "0..1 (to 1.2 from MIDI with the sustain pedal down)"),
        unit(name("Velocity"), 0, 0.5),
        channel(name("PitchClass"), 0, 11, "pitch class, C = 0", 0, KEYS_REST_PITCH(voice) % 12),
        // A Count at its default threshold (0.5) counts strikes from either source.
        channel(name("Onset"), 0, null, "1 while a strike is up (audio); strikes on this frame (MIDI); 0 at rest"),
        channel(name("Pitch"), 0, 127, "MIDI note; 0 = unknown", 0, KEYS_REST_PITCH(voice)),
      ];
    }),
    unit("notesConfidence", 0, 1),
    channel("noteDensity", 0, null, "sounding notes"),
    unit("sustain"),
    unit("soft"),
    unit("sustainSlow"),
    unit("softSlow"),
  ],
  harmony: [
    channel("root", 0, 11, "pitch class, C = 0"),
    channel("chordQuality", 0, 2, "0 none, 1 major, 2 minor"),
    unit("chordConfidence"),
    channel("chordIndex", 0, null, "accepted chord changes so far"),
    channel("tonalCenter", 0, 11, "pitch class, C = 0"),
    channel("keyMode", 0, 2, "0 none, 1 major, 2 minor"),
    unit("keyConfidence"),
    unit("chromaConfidence"),
    unit("dissonance"),
    unit("tension", TENSION_REST, TENSION_REST_FROM_KEYS),
    channel("pitchSource", 0, 4, "0 none, 1 chroma, 2 chord, 3 notes, 4 chord and notes", 0, 3),
  ],
  form: [unit("energy"), unit("brightness"), unit("density"), unit("dense"), unit("onsetRate"), unit("fullness")],
} as const satisfies Record<string, readonly FeatureChannel[]>;

export type MusicFeatureGroup = keyof typeof MUSIC_FEATURE_GROUPS;
export const MUSIC_FEATURE_GROUP_NAMES = Object.keys(MUSIC_FEATURE_GROUPS) as readonly MusicFeatureGroup[];

/** MidiFeatures' seventh output: every strike by where it lies between the bass and the top note. */
export const MIDI_LANE_CHANNELS: readonly FeatureChannel[] = indexed(MIDI_LANES, (lane) => [
  unit(`lane${String(lane)}Onset`),
  unit(`lane${String(lane)}Velocity`),
]);

/** A group's channel names, in the order the contract lists them. */
export const channelNames = (channels: readonly FeatureChannel[]): readonly string[] => channels.map((entry) => entry.name);
