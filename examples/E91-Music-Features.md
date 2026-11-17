# E91 — Music Features

What the music is doing, under names a picture can read. The `MusicFeatures` component
turns a sound into six groups of channels, and this is its contract at a glance: one mark
on the panel for each group.

## Graph

```
pattern_beat(audioPattern) ─► musicfeatures_ear.audio
tones_song(tonePattern) ─► musicfeatures_ear.tonal

musicfeatures_ear(component:musicFeatures@1) ─► select_levels(valueSelect)
                                             ─► select_beats(valueSelect)
                                             ─► select_tempo(valueSelect)
                                             ─► select_notes(valueSelect)
                                             ─► select_harmony(valueSelect)
                                             ─► select_form(valueSelect)

solid_stage(solid) ─► wgsl_panel(customWgsl) ─► output_main(output)

select_levels … select_form ┄┄drive┄┄► wgsl_panel.pc0 … pc4, env0 … env4, kick, root, energy, beatPhase, level
```

| Node | Type | Doing |
| --- | --- | --- |
| `pattern_beat` | `audioPattern` | the sound: kick, snare and hats at 120 BPM |
| `tones_song` | `tonePattern` | the notes: a four-chord progression in D major at 60 BPM |
| `musicfeatures_ear` | `MusicFeatures` | the six groups, from the two sources |
| `select_levels` … `select_form` | `valueSelect` | one tap an output, each passing only what the panel reads |
| `solid_stage` | `solid` | black; gives the panel its size |
| `wgsl_panel` | `customWgsl` | the panel: six marks, one a group |
| `output_main` | `output` | the picture |

The dashed line is not an edge. Fifteen parameters on `wgsl_panel` are expressions that
read a tap's channels by name, for example `op('select_notes').chan.voice0Envelope`.

## What you are looking at

| Mark | Group | Channel |
| --- | --- | --- |
| Five lamps, the bass on the left and the top voice on the right. A lamp's hue is its pitch class (C is red, round the colour wheel); its light is its envelope. | `notes` | `voice0PitchClass` … `voice4PitchClass`, `voice0Envelope` … `voice4Envelope` |
| The bar on the floor, which jumps wide on every kick and falls back. | `beats` | `kick` |
| The strip of twelve cells along the top, C on the left. The lit one is the root. | `harmony` | `root` |
| The backdrop, in the root's hue, as bright as the music's energy. | `form` | `energy` |
| The bead that crosses the bottom line once a beat. | `tempo` | `beatPhase` |
| The bottom line, as bright as the level. | `levels` | `level` |

A chord lasts four seconds. When it changes, the root cell moves, the backdrop changes hue
and the lamps change colour together. Three lamps often share a colour: the component's
voices are the chord's root, third and fifth, an extension when there is one, and the
highest note, and under a plain triad the last three are all the fifth.

The tempo is not read from the pattern. For the first five seconds the bead moves at the
project's tempo; then the component has heard five kicks and `bpm` becomes the tempo it
detected, here the same 120.

## What it proves

**One contract from any source.** `MusicFeatures` (audio) and `MidiFeatures` (a MIDI
keyboard) publish the same channel names in the same six groups. A network built on one
takes the other.

**Every channel on every frame.** Where the source cannot know a value, the channel reads
its rest value and the confidence beside it reads 0. Set Amount to 0 on both patterns: the
lamps go dark, the bar shrinks to its rest, and nothing errors.

**Estimates come with a confidence.** `bpmDetected` reads 0 with `bpmConfidence` 0 until
there is a tempo to claim; `bpm` is never 0, because it falls back to the project's.

## The six groups

| Group | Channels |
| --- | --- |
| `levels` | `inputLevel`, `gate`, `level`, `levelFast`, `region0` … `region4` |
| `beats` | `onset`, `onsetLow`, `kick`, `snare`, `hat`, `kickFast`, `snareFast`, `hatFast`, `drumPresence` |
| `tempo` | `bpm`, `bpmDetected`, `bpmConfidence`, `beats`, `beatPhase` |
| `notes` | for each of `voice0` … `voice4`: `Start`, `Envelope`, `Velocity`, `PitchClass`, `Pitch`, `Onset`; then `notesConfidence`, `noteDensity`, `sustain`, `soft`, `sustainSlow`, `softSlow` |
| `harmony` | `root`, `chordQuality`, `chordConfidence`, `chordIndex`, `tonalCenter`, `keyMode`, `keyConfidence`, `chromaConfidence`, `dissonance`, `tension`, `pitchSource` |
| `form` | `energy`, `brightness`, `density`, `dense`, `onsetRate`, `fullness` |

`MidiFeatures` has a seventh output, `lanes`: `lane0Onset` … `lane4Onset` and
`lane0Velocity` … `lane4Velocity`, every strike by where it lies between the bass and the
top note.

## Hear real music instead

1. Add an Audio File In and pick a file (or an Audio In for the microphone).
2. Wire it into `musicfeatures_ear.audio` in place of `pattern_beat`.
3. Remove the wire into `tonal`. The component then uses its own Chroma, Chord and Notes
   nodes, which read the same capture.

For a keyboard, replace `musicfeatures_ear` with a `MidiFeatures` instance and wire its six
outputs to the same taps. It needs no input.
