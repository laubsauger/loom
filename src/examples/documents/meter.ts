import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../build-showcase-beat.ts";

/**
 * E66 — Meter (T1236). THE AUDIO ANALYSIS, SHOWN: one `AudioAnalysis` on a bound file,
 * and every lane it publishes owns one visible thing.
 *
 * ## Why a file, and why this file
 *
 * Every audio example before this one drives from `audioPattern` — the deterministic test
 * signal — with a file behind a switch nobody flips. That demonstrates the graph and never
 * the analysis: a pattern's "kick" is a band envelope the pattern wrote itself. E66 binds
 * a CLIP (`public/media/showcase-beat.m4a`, `build-showcase-beat.ts`), under the timeline
 * lock so a scrub is bit-exact (T1229), and declares its tempo (T1228: 124 BPM, 4/4, beat
 * one at 0.484 s) so `beatPhase`/`barPhase` are facts about the file rather than estimates.
 * The clip is synthesised, and that is what makes the legend in `E66-Meter.md` a set of
 * checkable statements: what plays in which bar is written down in the generator, and
 * `e66-showcase.test.ts` reads the two against each other.
 *
 * ## The legend, lane by lane (§V952: conditioned through `levels`, counts through `hits`)
 *
 *   levels.low       the CORE's radius — the bass and the kick, ranked over 16 s; it breathes
 *                    with the held bass note and re-centres after the silence
 *   levels.level     the HALO's spread (blur size) — how loud the whole mix is
 *   levels.high      the HALO's brightness — the hats' band, which is why the halo dims for
 *                    bars 5–8 and is back for 11–16
 *   levels.centroid  the HALO's hue — warm when the spectrum sits low (hats dropped),
 *                    cool when the hats and the ping pull it up
 *   hits.kickCount   the CORE jumps a third larger on the beat and falls back in 250 ms
 *   hits.snareCount  the RING flashes on 2 and 4
 *   hits.hatCount    SPARKS on every eighth — gone for bars 5–8, and in bars 12–16 the
 *                    downbeat has none (the open hat before it is still ringing)
 *   hits.onsetCount  the BACKDROP blinks on every onset, drums of any kind
 *   clip1.barPhase   the HAND sweeps once round per bar — from the SOURCE, not the
 *                    component: a phase is neither a level to rank nor a count to decay
 *   clip1.beatPhase  the HAND is brightest on the beat and fades towards the next
 *
 * Bars 9–10 are silent: everything the analysis drives goes to rest and the hand keeps
 * turning, which is the difference between a lane that hears and a lane that counts.
 *
 * ## What a host without the clip sees
 *
 * Every retained value is the picture at rest: a mid-size core, a soft halo, no ring, no
 * sparks, the hand at twelve. The example gates render it HEARING the clip
 * (`shipped-clip-audio.ts`), so the baselines, the card and every claim are the picture
 * with the sound in it.
 */

const LEVELS = (key: string): string => `op('lvl1').chan.${key}`;
const HITS = (key: string): string => `op('hit1').chan.${key}`;
const CLIP = (key: string): string => `op('clip1').chan.${key}`;

const TRANSPARENT = [0, 0, 0, 0] as const;

export const meterDocument = document(
  "e66-meter",
  "E66 Meter",
  settings({ randomSeed: 66 }),
  graph(
    [
      // ── the source and the analysis ──────────────────────────────────────────
      node("clip", "audioFileIn", [-1500, 620], {
        file: SHOWCASE_BEAT_FILE,
        playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
        trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
        tempoMode: "declared", bpm: SHOWCASE_BEAT.bpm, beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
        // 0.484 s, the one silent lead-in beat — `SHOWCASE_BEAT_OFFSET_SECONDS`, at the knob's step.
        beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000,
      }, { label: "clip1" }),
      node("analysis", "component:audioAnalysis@1", [-1200, 620], {
        envelope: 0.08, window: 16, settle: 0.15, hitDecay: 250,
      }, { label: "analysis1" }),
      /* The two bags, read by label. A Select at `*` passes each bag through unchanged and
         gives it a NAME an expression can reach (T1302b). This was a Limit at 0..1, which is
         the identity only on lanes that live there: the hits bag also carries the tempo
         claim, and it clipped `bpm` 124 to 1 and `beat`/`bar` to at most 1. */
      node("lvl", "valueSelect", [-900, 540], { channels: "*" }, { label: "lvl1" }),
      node("hit", "valueSelect", [-900, 720], { channels: "*" }, { label: "hit1" }),

      // ── the backdrop: onsets ─────────────────────────────────────────────────
      node("bg", "solid", [-600, 1000], { color: [0.03, 0.035, 0.06, 1] }, { label: "bg1" }),
      node("flash", "level", [-320, 1000], {
        blacklevel: 0, whitelevel: 1, invert: 0, gamma1: 1, contrast: 1, opacity: 1,
      }, { label: "flash1", parameters: { brightness: expressionSlot(`1 + 3 * ${HITS("onsetCount")}`, 1) } }),

      // ── the core: low band and the kick ──────────────────────────────────────
      node("core", "circle", [-600, 300], {
        mode: "fill", center: [0.5, 0.5], softness: 0.01, aspectcorrect: true,
        fillcolor: [1, 0.62, 0.3, 1], bgcolor: [...TRANSPARENT],
      }, {
        label: "core1",
        parameters: {
          "radius.x": expressionSlot(`0.05 + 0.16 * ${LEVELS("low")}`, 0.12),
          "radius.y": expressionSlot(`0.05 + 0.16 * ${LEVELS("low")}`, 0.12),
        },
      }),
      node("kick", "transform", [-320, 300], {
        t: [0, 0], r: 0, p: [0, 0], xord: "srt", extend: "zero", aspectcorrect: true,
      }, {
        label: "kick1",
        parameters: {
          "s.x": expressionSlot(`1 + 0.35 * ${HITS("kickCount")}`, 1),
          "s.y": expressionSlot(`1 + 0.35 * ${HITS("kickCount")}`, 1),
        },
      }),

      // ── the halo: level, high band, centroid ─────────────────────────────────
      node("halo", "blur", [-40, 300], { filter: "gaussian", extend: "hold" }, {
        label: "halo1",
        parameters: { size: expressionSlot(`4 + 56 * ${LEVELS("level")}`, 24) },
      }),
      node("glow", "level", [240, 300], {
        blacklevel: 0, whitelevel: 1, invert: 0, gamma1: 1, contrast: 1, opacity: 1,
      }, { label: "glow1", parameters: { brightness: expressionSlot(`0.2 + 1.4 * ${LEVELS("high")}`, 0.9) } }),
      node("tint", "hsv", [520, 300], { saturation: 1, value: 1 }, {
        label: "tint1",
        parameters: { hueoffset: expressionSlot(`-60 + 160 * ${LEVELS("centroid")}`, 20) },
      }),

      // ── the ring: the snare ──────────────────────────────────────────────────
      node("ringo", "circle", [-600, 60], {
        mode: "fill", center: [0.5, 0.5], radius: [0.31, 0.31], softness: 0.006, aspectcorrect: true,
        fillcolor: [1, 1, 1, 1], bgcolor: [...TRANSPARENT],
      }, { label: "ringo1" }),
      node("hole", "circle", [-600, -160], {
        mode: "fill", center: [0.5, 0.5], radius: [0.285, 0.285], softness: 0.006, aspectcorrect: true,
        fillcolor: [0, 0, 0, 0], bgcolor: [1, 1, 1, 1],
      }, { label: "hole1" }),
      node("ring", "multiply", [-320, 60], { opacity: 1 }, { label: "ring1" }),
      node("snap", "level", [-40, 60], {
        blacklevel: 0, whitelevel: 1, invert: 0, gamma1: 1, contrast: 1, opacity: 1,
      }, { label: "snap1", parameters: { brightness: expressionSlot(HITS("snareCount"), 0) } }),

      // ── the sparks: the hats ─────────────────────────────────────────────────
      node("grain", "noise", [-600, -400], {
        type: "perlin4d", seed: 66, period: 0.012, harmon: 1, spread: 2, gain: 0.5, rough: 0.5,
        exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true, t4d: 0.37, s4d: 1, speed: 1.5,
      }, { label: "grain1" }),
      node("spark", "threshold", [-320, -400], { threshold: 0.66, softness: 0.03, channel: "luminance", compare: "greater" }, { label: "spark1" }),
      node("hats", "level", [-40, -400], {
        blacklevel: 0, whitelevel: 1, invert: 0, gamma1: 1, contrast: 1, opacity: 1,
      }, { label: "hats1", parameters: { brightness: expressionSlot(`0.9 * ${HITS("hatCount")}`, 0) } }),

      // ── the hand: bar phase and beat phase, from the source ──────────────────
      node("hand", "rectangle", [-600, 760], {
        mode: "fill", center: [0.5, 0.365], size: [0.003, 0.135], softness: 0.002, aspectcorrect: true,
        fillcolor: [0.85, 0.95, 1, 1], bgcolor: [...TRANSPARENT],
      }, { label: "hand1" }),
      node("sweep", "transform", [-320, 760], {
        t: [0, 0], s: [1, 1], p: [0, 0], xord: "srt", extend: "zero", aspectcorrect: true,
      }, { label: "sweep1", parameters: { r: expressionSlot(`360 * ${CLIP("barPhase")}`, 0) } }),
      node("tick", "level", [-40, 760], {
        blacklevel: 0, whitelevel: 1, invert: 0, gamma1: 1, contrast: 1, opacity: 1,
      }, { label: "tick1", parameters: { brightness: expressionSlot(`0.35 + 1.4 * (1 - ${CLIP("beatPhase")})`, 1) } }),

      // ── the sum ──────────────────────────────────────────────────────────────
      node("mix", "add", [820, 300], { opacity: 1 }, { label: "mix1" }),
      node("out", "output", [1100, 300], { toneMap: "none" }, { label: "output1" }),
    ],
    [
      edge("e-clip-analysis", ["clip", "out"], ["analysis", "audio"]),
      edge("e-analysis-lvl", ["analysis", "levels"], ["lvl", "in"]),
      edge("e-analysis-hit", ["analysis", "hits"], ["hit", "in"]),

      edge("e-bg-flash", ["bg", "out"], ["flash", "input"]),
      edge("e-core-kick", ["core", "out"], ["kick", "input"]),
      edge("e-kick-halo", ["kick", "out"], ["halo", "input"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "input"]),
      edge("e-glow-tint", ["glow", "out"], ["tint", "input"]),
      edge("e-ringo-ring", ["ringo", "out"], ["ring", "in1"]),
      edge("e-hole-ring", ["hole", "out"], ["ring", "in2"]),
      edge("e-ring-snap", ["ring", "out"], ["snap", "input"]),
      edge("e-grain-spark", ["grain", "out"], ["spark", "input"]),
      edge("e-spark-hats", ["spark", "out"], ["hats", "input"]),
      edge("e-hand-sweep", ["hand", "out"], ["sweep", "input"]),
      edge("e-sweep-tick", ["sweep", "out"], ["tick", "input"]),

      edge("e-hats-mix", ["hats", "out"], ["mix", "in1"]),
      edge("e-snap-mix", ["snap", "out"], ["mix", "in2"], 0),
      edge("e-tick-mix", ["tick", "out"], ["mix", "in2"], 1),
      edge("e-tint-mix", ["tint", "out"], ["mix", "in2"], 2),
      edge("e-kick-mix", ["kick", "out"], ["mix", "in2"], 3),
      edge("e-flash-mix", ["flash", "out"], ["mix", "in2"], 4),
      edge("e-mix-out", ["mix", "out"], ["out", "input"]),
    ],
  ),
);
