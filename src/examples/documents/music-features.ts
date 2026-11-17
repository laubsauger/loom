import { settings, named, namedInstance, edge, graph, document, expressionSlot } from "./builders.ts";
import { MUSIC_FEATURES_WGSL } from "../shaders/music-features.wgsl.ts";
import { MUSIC_FEATURE_GROUP_NAMES, MUSIC_VOICES, type MusicFeatureGroup } from "../music-features-contract.ts";

/**
 * E91: Music Features (T1805b). WHAT THE MUSIC IS DOING, UNDER NAMES A PICTURE CAN READ.
 *
 *   pattern_beat(audioPattern) ─► audio ┐
 *                                       musicfeatures_ear(MusicFeatures) ─► select_levels … select_form
 *   tones_song(tonePattern)   ─► tonal ┘
 *   solid_stage(solid) ─► wgsl_panel(customWgsl) ─► output_main(output)
 *
 * The MusicFeatures component turns a sound into six groups of channels: levels, beats,
 * tempo, notes, harmony, form. This is its contract at a glance, one mark a group: five
 * lamps for the five voices (hue by pitch class, light by envelope), a bar that jumps with
 * the kick, a strip of twelve with the root lit, the backdrop as bright as the music's
 * energy, a bead that crosses once a beat, and a line as bright as the level.
 *
 * The sources are the two understudies, so the file plays the moment it opens, with no
 * file and no microphone (§V363), and renders offline the same every time. Audio Pattern
 * is the sound; Tone Pattern goes into `tonal`, the optional input that replaces the
 * component's own Chroma, Chord and Notes. For real music, wire an Audio In or an Audio
 * File In into `audio` and unwire `tonal`. MidiFeatures publishes the same names from a
 * keyboard, so it takes the instance's place with no other change.
 *
 * The beat is at 120 and the progression at 60: a chord lasts two bars of the beat, 4 s,
 * longer than the 3.5 s the component holds a chord change off at its default Smoothing.
 *
 * Each tap selects only what the panel reads. The names are the contract's
 * (`music-features-contract.ts`).
 */
const VOICES = Array.from({ length: MUSIC_VOICES }, (_, voice) => voice);
const TAPPED: Readonly<Record<MusicFeatureGroup, string>> = {
  levels: "level",
  beats: "kick",
  tempo: "beatPhase",
  notes: "voice[0-4]PitchClass voice[0-4]Envelope",
  harmony: "root",
  form: "energy",
};
const tap = (group: MusicFeatureGroup, channel: string): string => `op('select_${group}').chan.${channel}`;

export const musicFeaturesDocument = document(
  "e91-music-features",
  "E91 Music Features",
  settings({ randomSeed: 91 }),
  graph(
    [
      named("beat", "audioPattern", [-1080, 120], { bpm: 120, amount: 1 }),
      named("song", "tonePattern", [-1080, 380], { bpm: 60, key: 2, mode: "major", amount: 1 }),
      namedInstance("ear", "MusicFeatures", "component:musicFeatures@1", [-720, 240]),
      ...MUSIC_FEATURE_GROUP_NAMES.map((group, index) => named(group, "valueSelect", [-360, -235 + index * 190], { channels: TAPPED[group] })),
      /* The panel writes every pixel; a customWgsl node takes its size from an input, and a
         black solid is the honest "nothing comes in here". */
      named("stage", "solid", [-360, -520], { color: [0, 0, 0, 1] }),
      named("panel", "customWgsl", [0, -520], { source: MUSIC_FEATURES_WGSL }, {
        parameters: {
          source: MUSIC_FEATURES_WGSL,
          ...Object.fromEntries(VOICES.map((voice) => [`pc${String(voice)}`, expressionSlot(tap("notes", `voice${String(voice)}PitchClass`), 0)])),
          ...Object.fromEntries(VOICES.map((voice) => [`env${String(voice)}`, expressionSlot(tap("notes", `voice${String(voice)}Envelope`), 0)])),
          kick: expressionSlot(tap("beats", "kick"), 0),
          root: expressionSlot(tap("harmony", "root"), 0),
          energy: expressionSlot(tap("form", "energy"), 0),
          beatPhase: expressionSlot(tap("tempo", "beatPhase"), 0),
          level: expressionSlot(tap("levels", "level"), 0),
        },
      }),
      named("main", "output", [360, -520]),
    ],
    [
      edge("e-beat-ear", ["pattern_beat", "out"], ["musicfeatures_ear", "audio"]),
      edge("e-song-ear", ["tones_song", "out"], ["musicfeatures_ear", "tonal"]),
      ...MUSIC_FEATURE_GROUP_NAMES.map((group) => edge(`e-ear-${group}`, ["musicfeatures_ear", group], [`select_${group}`, "in"])),
      edge("e-stage-panel", ["solid_stage", "out"], ["wgsl_panel", "input"]),
      edge("e-panel-main", ["wgsl_panel", "out"], ["output_main", "input"]),
    ],
  ),
);
