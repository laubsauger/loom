# E90 — Chord Wheel

Which notes sound, as a picture. The first example that reads **pitch**: every audio
example before it reads how loud and how bright.

## Graph

```
solid_stage(solid) ─► wgsl_wheel(customWgsl) ─► output1(output)

tones_song(tonePattern) ┄┄drives┄┄► wgsl_wheel.c0 … c11, root, quality, lead, leadOn
```

| Node | Type | Doing |
| --- | --- | --- |
| `tones_song` | `tonePattern` | a four-chord progression in D major at 90 BPM, as channels |
| `solid_stage` | `solid` | black; gives the wheel its size |
| `wgsl_wheel` | `customWgsl` | a ring of twelve lamps, one per pitch class |
| `output1` | `output` | the picture |

The dashed line is not an edge. `tones_song` has no ports; sixteen parameters on
`wgsl_wheel` are expressions that read its channels by name, for example
`op('tones_song').chan.chroma7`.

## What you are looking at

Twelve wedges, C at the top and rising clockwise, each in its own hue. A wedge is as bright
as its pitch class sounds. The wedge of the chord's root wears a white rim, the hub takes
the root's hue (warm for a major chord, cool for a minor one), and the white bead on the
outer edge is the lead note.

Under a chord of three notes more than three wedges glow. That is not an error: a note's
partials are other pitch classes (its fifth, its third), and Tone Pattern shapes its classes
that way because a recording does.

## What it proves

**Pitch classes are channels like any other.** `chroma0` … `chroma11` are twelve numbers
from 0 to 1, and the shader that draws the lamps knows nothing about music.

**The chord and the key are claims, with a confidence.** `root` and `chordQuality` step
once a bar here. From a real recording they step when the analysis says the chord has
changed, and read 0 with `chordConfidence` 0 when nothing can honestly be claimed.

**The source is swappable.** `tones_song` is a Tone Pattern: the tonal nodes' test signal,
as Audio Pattern is the audio sources'. It publishes exactly the channels the Chroma, Chord
and Notes nodes publish, under the same names.

## Hear real music instead

1. Add an Audio File In and pick a file (or an Audio In for the microphone).
2. Add a Chroma, a Chord and a Notes node. They read the same capture; they take no wire.
3. On `wgsl_wheel`, point `c0` … `c11` at the Chroma node, `root` and `quality` at the
   Chord node, and `lead` and `leadOn` at the Notes node. The channel names do not change.

A MIDI Notes node publishes the same names from a keyboard.
