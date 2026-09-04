import { settings, node, edge, graph, document, drivenSlot, expressionSlot } from "./builders.ts";
import { REACTOR_HAZE_WGSL, REACTOR_WGSL } from "../shaders/reactor.wgsl.ts";

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
 * COST, Dawn/Metal, the whole graph including both bloom widths, ms per frame, min of
 * repeated runs (another session shared the GPU part of the evening; single runs drifted
 * up to +40%):
 *   1280×720, defaults, one pass (first ship)       13.1
 *   1280×720, after the owner's three rounds, one pass   14.3
 *   1920×1080, one pass                             31     (haze off: 16 — the geometry alone is AT the 60 fps budget)
 *   1280×720, split (T1150: front haze at half res) 13.5
 *   1920×1080, split                                25     (40 fps)
 * So 1080p60 is not reachable for this design on this machine even with the split; 1080p
 * at ~40 is. The file ships at 1280×720 and the .md says how to switch.
 *
 * MOTION (§V913 — the row and the minute, same instrument, 192×108 linear luma, 120-frame
 * gaps). First ship: row 0.0154, minute 0.0178. After the three rounds: row 0.0254, minute
 * 0.0269. After the owner's second session (fewer cells, the shutters, the camera tour, the
 * escalation): row 0.0274, minute 0.0628 over 29 gaps, min 0.0274, max 0.1274, last gap
 * f3420→f3600 0.0379 — the minute now reads 2.3× the row, because the camera's tour and
 * the shutters happen AFTER the row's window, which is exactly the instrument's blind spot
 * §V913 names. `range` moved 0.335 → 0.550 → 0.744. Every step moved ON PURPOSE.
 *
 * THE CREATIVE PASS (the owner: "cooler … different colours, morphing … play with the shapes
 * … bars really fixed … cover more range in the intensity, really see the ball collapsing,
 * light going out"). Struts VERIFIED at the close station by eye: lit rounded members with
 * the core's light through the body, no black outline; width varies by cell. THE COLLAPSE:
 * while the outer shell is shut the core's radiance dies to a third and cools toward the rim
 * colour, shut plates are contained light (seams glow, the skin leaks a twelfth), releases
 * lengthened (outer ×70, inner ×28) so a collapse LANDS: shut 23.5% of the minute, longest
 * shut run 133 frames (2.2 s; was 11.9% / 67). Wider intensity: coreGain 4.2·level + 0.5
 * (0.73..2.67), escalation 11·level − 0.4 (0.56..5.3). MORPHING: the lattice direction is
 * warped by three slow travelling sines before the cells are read, cell identity pinned to
 * the grid so plates and facets never flicker while their shapes move. Motion, both windows:
 * row 0.0405, whole minute 0.1208 (min 0.0376, max 0.2486, last gap 0.0653) — 3× the row;
 * range 0.744 → 0.854. Every step on purpose. Cost: 18.1 ms at 1280×720 (min of three,
 * two other node processes alive; was 13.8): the seams, the varied struts and the warp's
 * three sines per lookup. The per-cell morph that doubled the Worley hash bill (23 ms) was
 * refused for the direction warp.
 *
 * DUTY (§V903/§V914 — 3600 frames of the pattern through the lanes):
 *   coreGain    = 4.2·level    + 0.5   (env1) → 0.733..2.671, mean 1.14, above retained 75%, hold 0
 *   laserGain   = 4.7·low      − 3.0   (env1) → 0.307..1.583, mean 0.63, retained 0.6 ≈ mean, hold 0
 *   facet       = 1.5·highMid  − 0.05  (env1) → 0.393..1.018, mean 0.71, above retained 74%, hold 0
 *   frameWidth  = 0.41·low     − 0.2   (env2) → 0.101..0.200, mean 0.12, above retained 34%, hold 1
 *   shellGap    = 0.17·highMid + 0.118 (env2) → 0.170..0.239, mean 0.20, above retained 73%, hold 1
 *   swell       = 0.23·level   + 0.96  (env3) → 0.980..1.079, mean 1.00, above retained 28%, hold 1
 *   gain1.brightness = 6·level + 0.1   (env3) → the escalation; retained 1.3 inside the range
 *   shieldOuter = lag(min(clamp(−28.6·slope(env3) − 2.43), arm)) → 0..0.992, mean 0.16, shut
 *                 (>0.5) 11.9% of the minute, longest shut run 67 frames (1.1 s); the
 *                 180-frame hold is the arm at 0 — open, the rest state (§V914)
 *   shieldInner = the same on a 0.16 s rise / 12× release → 0..0.773, shut 9.7%, longest 65
 * No lane is ever clamped to a constant, none can fall below its bias, and every retained
 * value sits inside its driven range. `laserGain`'s retained value was 1 in the first draft
 * — brighter than 99% of what the music delivered — and is 0.6 now, the driven mean.
 *
 * THE DEAD BLOOM (the owner found it in the graph, after three rounds of tuning it): `cut1`
 * shipped with `brightness: 0`, a multiplier, so every preview from the cut onward was black
 * and both bloom widths added zero. Measured before the fix: the reactor's linear peak 2.0,
 * mean 0.046; at `blacklevel` 0.5 the remap keeps 0.67% of the pixels. Fixed with a clamp
 * after the remap (Level goes NEGATIVE below the black point, and a blurred negative field
 * added back is a dark halo) and a claim that zeroing both widths must darken the disc.
 *
 * WHAT WAS REFUSED, with the picture as the judge (§V885):
 *   - a fixed 8-sample haze WITHOUT dither aliased the shell gate into crystalline shards;
 *     per-pixel white dither at the same count was speckle; interleaved-gradient dither
 *     (round one) read as a dot screen in stills. Samples per unit with a half-step white
 *     jitter ships — and the half-res front pass (T1150) is what finally settled the grain,
 *     because a bilinear read of a quarter as many samples is a blur, not a dither.
 *   - the first draft's medium was as dense inside the ball as outside and veiled the shells.
 *   - round one's blue: a per-crossing transmission tint that was right once and, stacked
 *     across six crossings, filtered the orange core to white (checked at one shell, where
 *     the same tint had been invisible, and at four); it ships at a fifth of the strength.
 *   - colour evolution as `lfo → grade1.hueoffset` (E35's idiom) turned the background
 *     olive with the ball and opened the file at −180°; the hue turns inside the shader.
 */
export const reactorDocument = document(
  "e55-reactor",
  "E55 Reactor",
  settings({ randomSeed: 55, previewFps: 30 }),
  graph(
    [
      /* A near-black bed the shader reads at 2% — the input binding stays live and the
         background carries a whisper of texture instead of a flat fill. */
      node("bed", "noise", [-1200, 0], {
        type: "perlin2d", period: 0.6, amp: 0.1, offset: 0.04,
      }, { label: "bed1" }),

      /* T1150 — THE FRONT HAZE AT HALF RESOLUTION. The medium outside the ball was the
         whole frame's cost (15 ms of 31 at 1080p), and a volumetric is low-frequency, so
         this pass draws only the straight ray's haze up to the first thing it hits, at
         `scale 0.5` of its input through the node's own resolution override (the seam the
         compiler already had — no new node). `reactor1` reads it back bilinearly, which is
         the softening the owner asked for and what settles round one's grain. Every knob it
         needs MIRRORS `reactor1`'s by expression (`op().par` reads the RESOLVED value, driven
         lanes included — §V148), so the two passes cannot disagree about the shells; its
         colour is applied by `reactor1`, so it carries no palette at all. */
      node("haze", "customWgsl", [-900, 0], {
        source: REACTOR_HAZE_WGSL,
      }, {
        label: "haze1",
        resolution: { mode: "scale", factor: 0.5 },
        parameters: {
          layers: expressionSlot("op('reactor1').par.layers", 3),
          divisions: expressionSlot("op('reactor1').par.divisions", 4),
          shieldOuter: expressionSlot("op('reactor1').par.shieldOuter", 0),
          shieldInner: expressionSlot("op('reactor1').par.shieldInner", 0),
          stations: expressionSlot("op('reactor1').par.stations", 1),
          travel: expressionSlot("op('reactor1').par.travel", 54),
          frameWidth: expressionSlot("op('reactor1').par.frameWidth", 0.12),
          blocked: expressionSlot("op('reactor1').par.blocked", 0.08),
          shellGap: expressionSlot("op('reactor1').par.shellGap", 0.2),
          swell: expressionSlot("op('reactor1').par.swell", 1),
          coreGain: expressionSlot("op('reactor1').par.coreGain", 1),
          laserGain: expressionSlot("op('reactor1').par.laserGain", 0.6),
          laserCount: expressionSlot("op('reactor1').par.laserCount", 3),
          haze: expressionSlot("op('reactor1').par.haze", 0.35),
          spin: expressionSlot("op('reactor1').par.spin", 1),
          morph: expressionSlot("op('reactor1').par.morph", 0.6),
          orbit: expressionSlot("op('reactor1').par.orbit", 1),
          distance: expressionSlot("op('reactor1').par.distance", 3.2),
        },
      }),

      node("reactor", "customWgsl", [-600, 0], {
        source: REACTOR_WGSL,
        layers: 3,
        divisions: 4,
        blocked: 0.08,
        ior: 1.45,
        dispersion: 0.35,
        glassColor: [0.4, 0.75, 1, 1],
        coreColor: [1, 0.55, 0.2, 1],
        edgeColor: [0.25, 0.62, 1, 1],
        laserCount: 3,
        haze: 0.35,
        spin: 1,
        morph: 0.6,
        turbulence: 0.8,
        frameColor: [0.35, 0.3, 0.28, 1],
        shellHueStep: 25,
        orbit: 1,
        distance: 3.2,
        stations: 1,
        travel: 54,
        exposure: 1.9,
        /* Colour evolution (round three): one hue angle turns core, glass and beams
           together, inside the shader, so the sky stays deep and the core/glass contrast
           is invariant — 40°/min is one revolution per nine minutes: moved when you look
           back, never visibly cycling. A `hueoffset` LFO on `grade1` was tried first and
           refused: it turned the background olive with the ball. */
        hueDrift: 40,
      }, {
        label: "reactor1",
        // The geometry pass draws at the PROJECT resolution; without this it would inherit
        // the half-res haze it reads.
        resolution: { mode: "project" },
        parameters: {
          coreGain: drivenSlot("levelb1:level", 1),
          laserGain: drivenSlot("lowb1:low", 0.6),
          facet: drivenSlot("highb1:highMid", 0.7),
          swell: drivenSlot("swellb1:level", 1),
          frameWidth: drivenSlot("barb1:low", 0.12),
          shellGap: drivenSlot("gapb1:highMid", 0.2),
          shieldOuter: drivenSlot("shieldo1:level", 0),
          shieldInner: drivenSlot("shieldi1:level", 0),
        },
      }),

      /* The bloom, E35's idiom in TWO widths: cut the highlights, blur them, add them back —
         and blur the blur again for a wide skirt, so the core does not merely peak but FALLS
         OFF (the owner's "blinded at the core" note is about the roll-off, not the dot).

         ⚑ THIS BRANCH SHIPPED DEAD for three rounds (the owner found it: "nothing ever
         reaches the cuts"). `cut1` carried `brightness: 0` — copied from E35, where that
         key is DRIVEN and the static 0 is never read — and Level's brightness MULTIPLIES,
         so every preview from here on was black and `add1` was the base render plus zero.
         Round one's "more intense bloom" and the second width changed nothing. Measured
         before the fix: the reactor's linear peak is 2.0 (mean 0.046); at `blacklevel`
         0.5 the remap keeps 0.67% of the pixels — the core and the hottest shafts.

         And Level is a REMAP, not a clip: below the black point the signal goes NEGATIVE,
         and an additive composite of a blurred negative field is a dark halo. `clamp1`
         floors it at zero before the blur, which is what a bloom's bright pass is. The
         claim that would have caught the dead branch — cutting it must change the frame —
         is in the claims now. */
      node("cut", "level", [-300, 200], {
        blacklevel: 0.45, whitelevel: 1, brightness: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "cut1" }),
      node("clamp", "limit", [0, 200], { mode: "clamp", low: 0, high: 8 }, { label: "clamp1" }),
      node("blur", "blur", [300, 200], { filter: "gaussian", size: 42, extend: "hold" }, { label: "blur1" }),
      node("gain", "level", [600, 200], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "gain1", parameters: { brightness: drivenSlot("blowb1:level", 1.3) } }),
      node("blur2", "blur", [600, 400], { filter: "gaussian", size: 42, extend: "hold" }, { label: "blur2" }),
      node("gain2", "level", [900, 400], {
        blacklevel: 0, whitelevel: 1, brightness: 0.9, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "gain2" }),
      node("add", "add", [900, 0], { opacity: 1 }, { label: "add1" }),
      node("add2", "add", [1200, 0], { opacity: 1 }, { label: "add2" }),
      node("grade", "hsv", [1500, 0], { hueoffset: 0, saturation: 1.1, value: 1 }, { label: "grade1" }),
      node("out", "output", [1800, 0], { toneMap: "filmic" }, { label: "out1" }),

      /* The drive, in the catalogue's fixed shape. */
      node("music", "audioPattern", [-1500, 600], { amount: 1, bpm: 112 }, { label: "music1" }),
      node("track", "audioFileIn", [-1500, 800], {
        cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true,
        playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1,
      }, { label: "track1" }),
      node("source", "valueSwitch", [-1200, 700], { index: 0 }, { label: "source1" }),
      node("env", "valueLag", [-900, 700], { lag: 0.08 }, { label: "env1" }),
      /* Two slower envelopes for the FORM (the owner's round two: the audio drove light and
         not shape). The bars and the gaps ride a 0.35 s lag; the outer shell's swell rides
         0.7 s, the slowest and largest response, so the shells answer at different speeds
         and read as separate bodies rather than pulsing in unison. */
      node("env2", "valueLag", [-900, 900], { lag: 0.35 }, { label: "env2" }),
      node("env3", "valueLag", [-900, 1100], { lag: 0.7 }, { label: "env3" }),

      /* The three affine pairs, each calibrated on the shipped pattern through `env1` (lag
         0.08): level 0.056..0.517 → coreGain 0.905..2.198; low 0.704..0.975 → laserGain
         0.307..1.583; highMid 0.295..0.712 → facet 0.393..1.018. Every pair maps ALL the
         channels, and the slot picks one by name (`levelb1:level`), so retuning a lane is
         two numbers in one pair and nothing else. */
      node("levelx", "valueMath", [-600, 600], { operand: 4.2, operation: "multiply" }, { label: "levelx1" }),
      node("levelb", "valueMath", [-300, 600], { operand: 0.5, operation: "add" }, { label: "levelb1" }),
      node("lowx", "valueMath", [-600, 800], { operand: 4.7, operation: "multiply" }, { label: "lowx1" }),
      node("lowb", "valueMath", [-300, 800], { operand: -3.0, operation: "add" }, { label: "lowb1" }),
      node("highx", "valueMath", [-600, 1000], { operand: 1.5, operation: "multiply" }, { label: "highx1" }),
      node("highb", "valueMath", [-300, 1000], { operand: -0.05, operation: "add" }, { label: "highb1" }),
      node("barx", "valueMath", [-600, 1200], { operand: 0.41, operation: "multiply" }, { label: "barx1" }),
      node("barb", "valueMath", [-300, 1200], { operand: -0.2, operation: "add" }, { label: "barb1" }),
      node("gapx", "valueMath", [-600, 1400], { operand: 0.17, operation: "multiply" }, { label: "gapx1" }),
      node("gapb", "valueMath", [-300, 1400], { operand: 0.118, operation: "add" }, { label: "gapb1" }),
      node("swellx", "valueMath", [-600, 1600], { operand: 0.23, operation: "multiply" }, { label: "swellx1" }),
      node("swellb", "valueMath", [-300, 1600], { operand: 0.96, operation: "add" }, { label: "swellb1" }),
      /* THE SHUTTERS (the owner's headline: "react much more aggressively to drops … contrast
         between full radiation and something shielded inside … shielded inside the second
         level"). A drop is a TRANSITION, not a quiet level — quiet would hold the shields
         shut, which is the wrong picture — so the detector is the envelope's SLOPE: `drop1`
         differentiates `env1`, `dropx1` flips and scales the fall so a drop lands at 1,
         `dropc1` clamps to 0..1, and two lags with a fast rise and a slow release close the
         outer shell first and the inner shells later, and open them in the same order. In
         silence the slope is 0 and the shields are OPEN (§V914 — the rest state is the
         radiating one, and it is what every thumbnail captures). */
      node("drop", "valueSlope", [-900, 1300], {}, { label: "drop1" }),
      /* Calibrated on the shipped pattern AFTER the arm point (f150..1800): env3's fall
         (−slope) is 0.055 at the median (a beat's decay), 0.104 at p97 and peaks at 0.127 on
         the pattern's pulled-back bars — so 0.085..0.12 maps onto 0..1: beats never fire it,
         a pulled-back bar shuts it fully. `dropx1`/`dropb1` ARE the sensitivity: a real track
         has its own numbers, and these two are where to retune them. */
      node("dropx", "valueMath", [-600, 1800], { operand: -28.6, operation: "multiply" }, { label: "dropx1" }),
      node("dropb", "valueMath", [-300, 1800], { operand: -2.43, operation: "add" }, { label: "dropb1" }),
      node("dropc", "valueLimit", [0, 1800], { minimum: 0, maximum: 1 }, { label: "dropc1" }),
      /* ARMED AFTER TWO SECONDS. The pattern opens on a hit whose decay is, to the detector,
         a drop — so the first thing the file did was slam shut, and the card frame (60) was
         three-quarters shielded, which is the §V914 mistake in geometry: a rest state the
         music never returns to. `arm1` holds the shield at min(drop, ramp) where the ramp is
         a timer from 3 s to 4 s, so the shutters cannot fire on the opening transient — nor inside the look row's f60–180 window. */
      node("armt", "timer", [-900, 1500], { delay: 3, speed: 1 }, { label: "armt1" }),
      node("armc", "valueLimit", [-600, 2200], { minimum: 0, maximum: 1 }, { label: "armc1" }),
      node("arm", "valueMath", [300, 2100], { operand: 1, operation: "minimum" }, { label: "arm1" }),
      node("shieldo", "valueLag", [600, 1700], { lag: 0.04, releaseRatio: 70 }, { label: "shieldo1" }),
      node("shieldi", "valueLag", [600, 1900], { lag: 0.16, releaseRatio: 28 }, { label: "shieldi1" }),
      /* THE ESCALATION (the owner: "more bloom on the centre that can escalate and sometimes
         blow up"): the tight bloom's gain rides the slowest envelope with an aggressive
         range, so a sustained loud passage blows the core out and a quiet one lets it
         settle back; the retained 1.3 sits inside the driven range (§V914). */
      node("blowx", "valueMath", [-600, 2000], { operand: 11, operation: "multiply" }, { label: "blowx1" }),
      node("blowb", "valueMath", [-300, 2000], { operand: -0.4, operation: "add" }, { label: "blowb1" }),
    ],
    [
      edge("e-bed-haze", ["bed", "out"], ["haze", "input"]),
      edge("e-haze-reactor", ["haze", "out"], ["reactor", "input"]),
      edge("e-reactor-add", ["reactor", "out"], ["add", "in1"]),
      edge("e-reactor-cut", ["reactor", "out"], ["cut", "input"]),
      edge("e-cut-clamp", ["cut", "out"], ["clamp", "input"]),
      edge("e-clamp-blur", ["clamp", "out"], ["blur", "input"]),
      edge("e-blur-gain", ["blur", "out"], ["gain", "input"]),
      edge("e-gain-add", ["gain", "out"], ["add", "in2"], 0),
      edge("e-blur-blur2", ["blur", "out"], ["blur2", "input"]),
      edge("e-blur2-gain2", ["blur2", "out"], ["gain2", "input"]),
      edge("e-add-add2", ["add", "out"], ["add2", "in1"]),
      edge("e-gain2-add2", ["gain2", "out"], ["add2", "in2"], 0),
      edge("e-add2-grade", ["add2", "out"], ["grade", "input"]),
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
      edge("e-source-env2", ["source", "out"], ["env2", "in"]),
      edge("e-source-env3", ["source", "out"], ["env3", "in"]),
      edge("e-env2-barx", ["env2", "out"], ["barx", "a"]),
      edge("e-barx-barb", ["barx", "out"], ["barb", "a"]),
      edge("e-env2-gapx", ["env2", "out"], ["gapx", "a"]),
      edge("e-gapx-gapb", ["gapx", "out"], ["gapb", "a"]),
      edge("e-env3-swellx", ["env3", "out"], ["swellx", "a"]),
      edge("e-swellx-swellb", ["swellx", "out"], ["swellb", "a"]),
      edge("e-env3-drop", ["env3", "out"], ["drop", "in"]),
      edge("e-drop-dropx", ["drop", "out"], ["dropx", "a"]),
      edge("e-dropx-dropb", ["dropx", "out"], ["dropb", "a"]),
      edge("e-dropb-dropc", ["dropb", "out"], ["dropc", "in"]),
      edge("e-env3-blowx", ["env3", "out"], ["blowx", "a"]),
      edge("e-blowx-blowb", ["blowx", "out"], ["blowb", "a"]),
      edge("e-armt-armc", ["armt", "out"], ["armc", "in"]),
      edge("e-dropc-arm", ["dropc", "out"], ["arm", "a"]),
      edge("e-armc-arm", ["armc", "out"], ["arm", "b"]),
      edge("e-arm-shieldo", ["arm", "out"], ["shieldo", "in"]),
      edge("e-arm-shieldi", ["arm", "out"], ["shieldi", "in"]),
    ],
  ),
);
