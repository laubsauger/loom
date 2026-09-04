import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { REACTOR_WGSL } from "../shaders/reactor.wgsl.ts";

/**
 * E55 — Reactor (T1141). LIT FROM INSIDE.
 *
 * The owner's ask, verbatim in intent: an alien outer-worlds disco ball that does not take
 * light from outside but EMITS it — a nuclear core whose light gets out through several
 * nested, organic-framed, glass-faced spheres, bending and bouncing on the way; volumetric,
 * laser-ish, audio-reactive to a degree, and parametric enough to tune divisions, layers
 * and the rest from the top.
 *
 *   bed1(noise) ─► reactor1(customWgsl: the nested-shell raymarcher) ─► add1 ─► grade1(hsv) ─► out1
 *                                  │                                     ▲
 *                                  └─► cut1(level) ─► blur1 ─► gain1(level) ┘   (the bloom)
 *
 *   music1(audioPattern) ─► source1(valueSwitch) ─► env1(valueLag) ─► levelx1 ─► levelb1 ┄level┄► reactor1.coreGain
 *   track1(audioFileIn)  ─┘                                         ├► lowx1   ─► lowb1   ┄low┄►   reactor1.laserGain
 *                                                                   └► highx1  ─► highb1  ┄highMid┄► reactor1.facet
 *
 * ## Why one shader and not the scene pipeline
 *
 * The registry was read before this was shaped (the orchestrator's T1141 note): the scene
 * pipeline's `materialGlass` is one screen-space read of what the opaque pass already drew,
 * so glass behind glass does not refract, and its lights are directional or point with no
 * medium for a beam to be seen in. Faking a light-emitting nested ball out of additive beams
 * and bloom would be pretending. `reactor1` is E46 Lantern's lane taken into 3D: analytic
 * sphere crossings for the shells (no sphere-tracing artefacts on the glass), a Worley
 * partition of the direction for the organic frame, Fresnel-split facets for the disco
 * reading, and two volume integrals — the emissive core and the shell-gated haze that turns
 * the core's light into shafts. The shader's docblock walks the ray stage by stage.
 *
 * ## The knobs ARE the shader's `struct Params` (T880)
 *
 * There is no project-level publish surface (§T1143 records the gap, found here and by
 * §T1125 the same night), so the top level IS `reactor1`'s own page: every art-direction
 * decision — `layers`, `divisions`, `frameWidth`, `shellGap`, the glass (`ior`, `dispersion`,
 * `facet`), the light (`coreGain`, `coreColor`, `edgeColor`, `laserGain`, `laserCount`,
 * `haze`), the motion (`spin`, `turbulence`, `orbit`), and `frameColor`, `distance`,
 * `exposure` — is a field the node reflects into a named, typed, drivable control, with the
 * shader's own trailing comment as its description (T1053).
 *
 * ## Liveliness is structural, not tuned (T1138's lesson)
 *
 * The camera orbits, every shell counter-rotates at its own rate, the core churns, and the
 * filaments sweep — all on `frameU.absTime`, none of it an envelope with a rest state. The
 * music only SCALES gains that are already moving: level into the core's radiance, the kick
 * into the filaments, the high-mids into the facet glitter. In silence the ball still turns
 * and glows at its retained values; with the track it breathes and flashes.
 *
 * ## Audio, the catalogue's fixed shape (E31/E35/E51)
 *
 * `music1` is the synthetic pattern — no microphone, no asset, replayable by construction —
 * and `track1` is your own file one drop away, with `source1` choosing between them so the
 * two never merge onto one port. `env1` smooths; each `valueMath` pair is an affine map from
 * a band's real range (measured on the shipped pattern, see the pair docblocks) onto the
 * range the knob wants, so silence sits at a picture and a hit lands where it should.
 *
 * ## MEASURED, on the shipped file (the numbers the T1141 row asked for)
 *
 * COST, Dawn/Metal, 1280×720, the whole graph including the bloom, ms per frame:
 *   defaults (3 shells, 7 divisions)            13.1
 *   top of range (4 shells, 14 divisions, 6 filaments)  16.6
 *   bare core (0 shells)                         6.2
 * The exterior haze is the cost: samples per world unit (14 → 10 after the first cut), each
 * sample gating through every shell. That is where a slower device should be trimmed first.
 *
 * MOTION (§V913 — the row and the minute, same instrument, 192×108 linear luma, 120-frame
 * gaps): the recorded f60→f180 row reads 0.0154; the whole minute averages 0.0178 over 29
 * gaps, min 0.0127, max 0.0238, and the last gap f3420→f3600 reads 0.0172. Nothing settles,
 * because nothing here is an envelope.
 *
 * DUTY (§V903 — 3600 frames of the pattern through the three lanes):
 *   coreGain  = 2.8·level  + 0.75 → 0.905..2.198, mean 1.18, above retained 86%, longest hold 0
 *   laserGain = 4.7·low    − 3.0  → 0.307..1.583, mean 0.63, retained 0.6 sits at the mean
 *   facet     = 1.5·highMid − 0.05 → 0.393..1.018, mean 0.71, above retained 74%, longest hold 0
 * No lane is ever clamped to a constant and none can fall below its bias. `laserGain`'s
 * retained value was 1 in the first draft — brighter than 99% of what the music delivered,
 * so silence would have outshone the track; it is 0.6 now, the driven mean.
 *
 * WHAT WAS REFUSED, with the picture as the judge (§V885): a fixed 8-sample haze WITHOUT
 * dither aliased the shell gate into crystalline shards outside the ball — striking, and a
 * sampling artefact; with per-pixel dither at the same count it was speckle. Samples per
 * unit length with a half-step jitter is what ships: fine static grain, no shards. And the
 * first draft's medium was as dense inside the ball as outside, which veiled the shells the
 * whole design exists to show; the medium is now thin inside and the beams live outside.
 */
export const reactorDocument = document(
  "e55-reactor",
  "E55 Reactor",
  settings({ randomSeed: 55, previewFps: 30 }),
  graph(
    [
      /* A near-black bed the shader reads at 2% — the input binding stays live and the
         background carries a whisper of texture instead of a flat fill. */
      node("bed", "noise", [-900, 0], {
        type: "perlin2d", period: 0.6, amp: 0.1, offset: 0.04,
      }, { label: "bed1" }),

      node("reactor", "customWgsl", [-600, 0], {
        source: REACTOR_WGSL,
        layers: 3,
        divisions: 7,
        frameWidth: 0.22,
        shellGap: 0.16,
        ior: 1.45,
        dispersion: 0.35,
        coreColor: [1, 0.55, 0.2, 1],
        edgeColor: [0.2, 0.5, 1, 1],
        laserCount: 3,
        haze: 0.35,
        spin: 1,
        turbulence: 0.8,
        frameColor: [0.35, 0.3, 0.28, 1],
        orbit: 1,
        distance: 3.2,
        exposure: 1.9,
      }, {
        label: "reactor1",
        parameters: {
          coreGain: drivenSlot("levelb1:level", 1),
          laserGain: drivenSlot("lowb1:low", 0.6),
          facet: drivenSlot("highb1:highMid", 0.7),
        },
      }),

      /* The bloom, E35's idiom: cut the highlights, blur them wide, add them back. */
      node("cut", "level", [-300, 200], {
        blacklevel: 0.55, whitelevel: 1, brightness: 0, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "cut1" }),
      node("blur", "blur", [0, 200], { filter: "gaussian", size: 42, extend: "hold" }, { label: "blur1" }),
      node("gain", "level", [300, 200], {
        blacklevel: 0, whitelevel: 1, brightness: 1.4, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "gain1" }),
      node("add", "add", [600, 0], { opacity: 1 }, { label: "add1" }),
      node("grade", "hsv", [900, 0], { hueoffset: 0, saturation: 1.1, value: 1 }, { label: "grade1" }),
      node("out", "output", [1200, 0], { toneMap: "filmic" }, { label: "out1" }),

      /* The drive, in the catalogue's fixed shape. */
      node("music", "audioPattern", [-1500, 600], { amount: 1, bpm: 112 }, { label: "music1" }),
      node("track", "audioFileIn", [-1500, 800], {
        cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true,
        playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1,
      }, { label: "track1" }),
      node("source", "valueSwitch", [-1200, 700], { index: 0 }, { label: "source1" }),
      node("env", "valueLag", [-900, 700], { lag: 0.08 }, { label: "env1" }),

      /* The three affine pairs, each calibrated on the shipped pattern through `env1` (lag
         0.08): level 0.056..0.517 → coreGain 0.905..2.198; low 0.704..0.975 → laserGain
         0.307..1.583; highMid 0.295..0.712 → facet 0.393..1.018. Every pair maps ALL the
         channels, and the slot picks one by name (`levelb1:level`), so retuning a lane is
         two numbers in one pair and nothing else. */
      node("levelx", "valueMath", [-600, 600], { operand: 2.8, operation: "multiply" }, { label: "levelx1" }),
      node("levelb", "valueMath", [-300, 600], { operand: 0.75, operation: "add" }, { label: "levelb1" }),
      node("lowx", "valueMath", [-600, 800], { operand: 4.7, operation: "multiply" }, { label: "lowx1" }),
      node("lowb", "valueMath", [-300, 800], { operand: -3.0, operation: "add" }, { label: "lowb1" }),
      node("highx", "valueMath", [-600, 1000], { operand: 1.5, operation: "multiply" }, { label: "highx1" }),
      node("highb", "valueMath", [-300, 1000], { operand: -0.05, operation: "add" }, { label: "highb1" }),
    ],
    [
      edge("e-bed-reactor", ["bed", "out"], ["reactor", "input"]),
      edge("e-reactor-add", ["reactor", "out"], ["add", "in1"]),
      edge("e-reactor-cut", ["reactor", "out"], ["cut", "input"]),
      edge("e-cut-blur", ["cut", "out"], ["blur", "input"]),
      edge("e-blur-gain", ["blur", "out"], ["gain", "input"]),
      edge("e-gain-add", ["gain", "out"], ["add", "in2"], 0),
      edge("e-add-grade", ["add", "out"], ["grade", "input"]),
      edge("e-grade-out", ["grade", "out"], ["out", "input"]),

      edge("e-music-source", ["music", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-env", ["source", "out"], ["env", "in"]),
      edge("e-env-levelx", ["env", "out"], ["levelx", "a"]),
      edge("e-levelx-levelb", ["levelx", "out"], ["levelb", "a"]),
      edge("e-env-lowx", ["env", "out"], ["lowx", "a"]),
      edge("e-lowx-lowb", ["lowx", "out"], ["lowb", "a"]),
      edge("e-env-highx", ["env", "out"], ["highx", "a"]),
      edge("e-highx-highb", ["highx", "out"], ["highb", "a"]),
    ],
  ),
);
