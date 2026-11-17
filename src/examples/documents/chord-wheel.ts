import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { CHORD_WHEEL_WGSL } from "../shaders/chord-wheel.wgsl.ts";

/**
 * E90 — Chord Wheel (T1757b). WHICH NOTES SOUND, AS A PICTURE.
 *
 *   tones_song(tonePattern) ┄┄ chroma0 … chroma11, root, chordQuality, pitchClass ┄┄►
 *   solid_stage(solid) ─► wgsl_wheel(customWgsl: twelve lamps) ─► output1(output)
 *
 * The first example that reads PITCH. Every audio example before it reads how loud and how
 * bright; this one reads which of the twelve pitch classes sound, the chord they make and
 * the note on top, and draws them where a musician would point: a ring of twelve lamps, the
 * root's wearing a rim, the lead a bead on the edge.
 *
 * `tones_song` is the tonal nodes' understudy (Tone Pattern, as Audio Pattern is the
 * sources'): a four-chord progression from the frame clock, so the file plays the moment it
 * opens, with no file and no microphone (§V363). It publishes Chroma's, Chord's and Notes'
 * channels under their names. To hear real music instead: add an Audio File In, then a
 * Chroma, a Chord and a Notes node, and point the fifteen expressions on `wgsl_wheel` at
 * them — the channel names do not change.
 *
 * The lamps are driven RAW. Tone Pattern's classes are already smooth (a struck chord
 * decaying), where a real Chroma node eases its own readings; neither needs a Lag here.
 */
const song = (channel: string): string => `op('tones_song').chan.${channel}`;

export const chordWheelDocument = document(
  "e90-chord-wheel",
  "E90 Chord Wheel",
  settings({ randomSeed: 90 }),
  graph(
    [
      node("song", "tonePattern", [-720, 220], { bpm: 90, key: 2, mode: "major", amount: 1 }, { label: "tones_song" }),
      /* The wheel writes every pixel; a customWgsl node takes its size from an input, and a
         black solid is the honest "nothing comes in here". */
      node("stage", "solid", [-720, -60], { color: [0, 0, 0, 1] }, { label: "solid_stage" }),
      node(
        "wheel",
        "customWgsl",
        [-360, -60],
        { source: CHORD_WHEEL_WGSL },
        {
          label: "wgsl_wheel",
          parameters: {
            source: CHORD_WHEEL_WGSL,
            ...Object.fromEntries(Array.from({ length: 12 }, (_, pitchClass) => [`c${String(pitchClass)}`, expressionSlot(song(`chroma${String(pitchClass)}`), 0)])),
            root: expressionSlot(song("root"), 0),
            quality: expressionSlot(song("chordQuality"), 0),
            lead: expressionSlot(song("pitchClass"), 0),
            leadOn: expressionSlot(song("pitchConfidence"), 0),
          },
        },
      ),
      node("out", "output", [0, -60], {}, { label: "output1" }),
    ],
    [edge("e-stage-wheel", ["stage", "out"], ["wheel", "input"]), edge("e-wheel-out", ["wheel", "out"], ["out", "input"])],
  ),
);
