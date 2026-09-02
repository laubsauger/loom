import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * §V688 — the constants the polar field is built from, derived rather than typed in.
 * `circle` in distance mode emits `k * (rNorm - 1)` with `k = min(0.5/aspect, 0.5)`, so a
 * Level with `blacklevel: -k, whitelevel: 0` recovers normalised radius EXACTLY; and the
 * circular Ramp's atan2 is computed in uv space, so sampling it through a transform scaled
 * by 1/aspect is what turns it into the angle in pixel space.
 */
const ROSETTE_ASPECT = 1280 / 720;

const ROSETTE_POLAR_K = Math.min(0.5 / ROSETTE_ASPECT, 0.5);

const ROSETTE_INV_ASPECT = 720 / 1280;

/**
 * E39 — Rosette (T729).
 *
 *   stand1(noise 4d) ─┐ order 0
 *                     ├─► pick1(switch) ─────────────────► warp1.source
 *   clip1(movieFileIn)┘ order 1                                 ▲
 *                                                               │
 *   ang1(ramp circular, phase ┄ spin1, period ┄ petal1) ─► angfix1(transform) ─┐
 *                                                                              ├─► field1(reorder) ─► warp1.map
 *   rad1(circle, distance) ─► depth1(level, gamma ┄ deep1) ─────────────────────┘
 *
 *   warp1(remap) ─► paint1(lookup ◄─ palette1) ─┬─► burn1(add) ─► trim1 ─► out1
 *                                               └─► halo1(blur) ─► haze1(level) ─┘
 *
 * ## A POLAR WARP IS NOT A NODE — it is six nodes we already had (§V688)
 *
 * The brief for this example called log-polar "probably the single most versatile missing
 * primitive". It is not missing. Remap takes a uv FIELD and samples the source at it, so
 * any warp at all is a question of who builds the field — and the catalogue can build this
 * one: a circular Ramp is theta, a Circle in distance mode is rho, Reorder packs one into
 * red and the other into green, and Remap applies it. Nothing here is a special case of
 * "polar"; the same four nodes build any coordinate map you can draw.
 *
 * Three details are load-bearing, and each was measured rather than reasoned (§V688):
 *
 * ASPECT. `ramp(circular)` computes its atan2 in UV space, so on 16:9 the rays come out
 * elliptically spaced. `angfix1` samples the ramp through a transform scaled by 1/aspect,
 * which is exactly atan2(dv, du * aspect) — the angle in PIXEL space. Delete it and the
 * rosette squashes into an ellipse.
 *
 * RADIUS COMES FROM CIRCLE, NOT FROM `ramp(radial)`. The radial ramp is
 * `clamp(length(uv - 0.5) * 2, 0, 1)`, so everything outside the inscribed circle — all
 * four corners, about a fifth of a 16:9 frame — pins to one flat value and renders as dead
 * blocks. Circle's distance mode is unclamped and already aspect-aware, and
 * `level(blacklevel = -k, whitelevel = 0)` with `k = min(0.5/aspect, 0.5)` recovers
 * normalised radius exactly, because the node emits `k * (rNorm - 1)`.
 *
 * EXTEND IS `mirror`, NOT `repeat`. Rho runs past 1 at the corners and has to come back
 * somehow. Repeat FRACTS it, which is a discontinuity, and it showed as a stair-stepped
 * arc wherever the map crossed 1.0. Mirror folds instead of jumping, so the rings reflect
 * and there is no seam to see. The float working format is what lets rho exceed 1 at all.
 *
 * ## Not a tunnel, deliberately
 *
 * E1 already puts a transform inside a feedback loop and E29 already zooms one past 1.0 to
 * fall down a corridor. A third tunnel would teach nothing. This is the other thing the
 * polar map is for: repetition AROUND the circle rather than travel INTO it, which is why
 * the driven parameter is the ramp's `period` — the count of times the source wraps the
 * axis — and not a scale.
 *
 * ## The bloom threshold is GAMMA, never a black level (§V694)
 *
 * `haze1` was a Level with `blacklevel: 0.68` — the obvious way to write "bloom only the
 * highlights", and a trap. A positive black level is a SUBTRACTION, `rgba16float` does not
 * clamp, and every pixel below 0.68 (nearly all of them) went negative as far as -2.1, so
 * `burn1` subtracted the bloom everywhere it was not blooming. At the liveness probe size
 * `paint1` spanned 0.545 and `burn1` came out at 0.115 — an ADD that reduced range, which
 * is the algebraic tell (§V698). `gamma1` below one crushes midtones and keeps highlights
 * without ever crossing zero, and the same picture then measures 0.970.
 *
 * `halo1` is 16px and not 34 for a separate reason (§V699): blur size is in PIXELS and the
 * contrast floor measures at 192x108, so a 2.7% glow at 1280 is an 18%-of-width wash there.
 *
 * ## The palette had to be balanced by LIGHT, not by numbers (§V695)
 *
 * Ramp stops are declared in display space and decode to linear, which costs a dark cool
 * colour most of its luminance while a bright warm one barely moves: the first version of
 * `palette1` looked balanced as authored numbers and played back as red over black,
 * because [0.05, 0.36, 0.55] lands at linear [0.004, 0.106, 0.267] and simply reads as
 * black. The cool half is lifted until it carries comparable light.
 */
export const rosetteDocument = document(
  "rosette",
  "E39 Rosette",
  settings(),
  graph(
    [
      // ── the performer, and the seat kept warm for your own footage ──────────
      node("stand", "noise", [-1620, -200], {
        type: "perlin4d",
        seed: 5,
        period: 0.16,
        harmon: 4,
        spread: 2.1,
        gain: 0.58,
        rough: 0.5,
        exp: 1.2,
        amp: 2.6,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        speed: 0.19,
        t4d: 0.4,
        s4d: 1,
      }, { label: "stand1" }),
      node("clip", "movieFileIn", [-1620, 100], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("pick", "switch", [-1360, 150], { index: 0 }, { label: "pick1" }),

      // ── theta: a circular ramp, un-skewed by a transform in the ramp's own space ──
      node("ang", "ramp", [-1360, -420], {
        type: "circular",
        interp: "linear",
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 1, color: [1, 1, 1, 1] },
        ],
      }, { label: "ang1", definitionVersion: 2, parameters: { phase: drivenSlot("spin1", 0), period: drivenSlot("petal1:low", 6), } }),
      node("angfix", "transform", [-1100, -420], {
        t: [0, 0],
        r: 0,
        s: [ROSETTE_INV_ASPECT, 1],
        p: [0, 0],
        xord: "srt",
        extend: "hold",
        aspectcorrect: false,
      }, { label: "angfix1" }),

      // ── rho: an unclamped radius, curved by gamma ──────────────────────────
      node("rad", "circle", [-1360, -180], {
        mode: "distance",
        center: [0.5, 0.5],
        radius: [0.5, 0.5],
        softness: 0.005,
        fillcolor: [1, 1, 1, 1],
        bgcolor: [0, 0, 0, 0],
        aspectcorrect: true,
      }, { label: "rad1" }),
      node("depth", "level", [-1100, -180], {
        blacklevel: -ROSETTE_POLAR_K,
        whitelevel: 0,
        contrast: 1,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "depth1", parameters: { gamma1: drivenSlot("deep1:lowMid", 1.6), } }),

      // ── the uv field, and the warp ────────────────────────────────────────
      node("field", "reorder", [-840, -300], {
        outr: "in1r",
        outg: "in2r",
        outb: "zero",
        outa: "one",
      }, { label: "field1" }),
      node("warp", "remap", [-580, -80], {
        sourcex: "red",
        sourcey: "green",
        flipu: false,
        flipv: false,
        extend: "mirror",
      }, { label: "warp1" }),

      // ── the grade ─────────────────────────────────────────────────────────
      node("palette", "ramp", [-840, 300], {
        type: "horizontal",
        interp: "linear",
        phase: 0,
        period: 1,
        stops: [
          { position: 0, color: [0.01, 0.02, 0.06, 1] },
          { position: 0.2, color: [0.05, 0.16, 0.42, 1] },
          { position: 0.4, color: [0.1, 0.55, 0.78, 1] },
          { position: 0.58, color: [0.45, 0.35, 0.85, 1] },
          { position: 0.76, color: [0.92, 0.32, 0.48, 1] },
          { position: 0.9, color: [1, 0.72, 0.32, 1] },
          { position: 1, color: [1, 0.98, 0.92, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("paint", "lookup", [-320, -80], {
        channel: "luminance",
        row: 0.5,
        offset: 0,
      }, { label: "paint1", parameters: { scale: drivenSlot("hue1:highMid", 1), } }),

      // ── bloom ─────────────────────────────────────────────────────────────
      node("halo", "blur", [-60, 200], { size: 16, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haze", "level", [200, 200], {
        blacklevel: 0,
        whitelevel: 1,
        gamma1: 0.4,
        contrast: 1,
        brightness: 1.1,
        invert: 0,
        opacity: 1,
      }, { label: "haze1" }),
      node("burn", "add", [200, -80], { opacity: 1 }, { label: "burn1" }),
      node("trim", "level", [460, -80], {
        blacklevel: 0.015,
        whitelevel: 1.05,
        gamma1: 1,
        contrast: 1.15,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "trim1" }),
      node("out", "output", [720, -80], {}, { label: "out1" }),

      // ── the score ─────────────────────────────────────────────────────────
      node("beat", "audioPattern", [-1620, 600], { bpm: 118, amount: 1, beatsPerBar: 4 }, { label: "beat1" }),
      node("smooth", "valueLag", [-1360, 600], { lag: 0.09 }, { label: "smooth1" }),
      node("spin", "lfo", [-1620, 340], { shape: "saw", frequency: 0.037, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "spin1" }),

      node("petalg", "valueMath", [-1100, 620], { operation: "multiply", operand: 5.5 }, { label: "petalg1" }),
      node("petalb", "valueMath", [-840, 620], { operation: "add", operand: 4.2 }, { label: "petalb1" }),
      node("petal", "valueLimit", [-580, 620], { minimum: 3, maximum: 11 }, { label: "petal1" }),

      node("deepg", "valueMath", [-1100, 880], { operation: "multiply", operand: 2.4 }, { label: "deepg1" }),
      node("deepb", "valueMath", [-840, 880], { operation: "add", operand: 0.9 }, { label: "deepb1" }),
      node("deep", "valueLimit", [-580, 880], { minimum: 0.6, maximum: 4.5 }, { label: "deep1" }),

      node("hueg", "valueMath", [-1100, 1140], { operation: "multiply", operand: 0.9 }, { label: "hueg1" }),
      node("hueb", "valueMath", [-840, 1140], { operation: "add", operand: 0.72 }, { label: "hueb1" }),
      node("hue", "valueLimit", [-580, 1140], { minimum: 0.45, maximum: 1.9 }, { label: "hue1" }),
    ],
    [
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-ang-angfix", ["ang", "out"], ["angfix", "input"]),
      edge("e-rad-depth", ["rad", "out"], ["depth", "input"]),
      edge("e-angfix-field", ["angfix", "out"], ["field", "in1"]),
      edge("e-depth-field", ["depth", "out"], ["field", "in2"]),
      edge("e-pick-warp", ["pick", "out"], ["warp", "source"]),
      edge("e-field-warp", ["field", "out"], ["warp", "map"]),
      edge("e-warp-paint", ["warp", "out"], ["paint", "source"]),
      edge("e-palette-paint", ["palette", "out"], ["paint", "lookup"]),
      edge("e-paint-halo", ["paint", "out"], ["halo", "input"]),
      edge("e-halo-haze", ["halo", "out"], ["haze", "input"]),
      edge("e-paint-burn", ["paint", "out"], ["burn", "in1"], 0),
      edge("e-haze-burn", ["haze", "out"], ["burn", "in2"], 1),
      edge("e-burn-trim", ["burn", "out"], ["trim", "input"]),
      edge("e-trim-out", ["trim", "out"], ["out", "input"]),
      edge("e-beat-smooth", ["beat", "out"], ["smooth", "in"]),
      edge("e-smooth-petalg", ["smooth", "out"], ["petalg", "a"]),
      edge("e-petalg-petalb", ["petalg", "out"], ["petalb", "a"]),
      edge("e-petalb-petal", ["petalb", "out"], ["petal", "in"]),
      edge("e-smooth-deepg", ["smooth", "out"], ["deepg", "a"]),
      edge("e-deepg-deepb", ["deepg", "out"], ["deepb", "a"]),
      edge("e-deepb-deep", ["deepb", "out"], ["deep", "in"]),
      edge("e-smooth-hueg", ["smooth", "out"], ["hueg", "a"]),
      edge("e-hueg-hueb", ["hueg", "out"], ["hueb", "a"]),
      edge("e-hueb-hue", ["hueb", "out"], ["hue", "in"]),
    ],
  ),
);
