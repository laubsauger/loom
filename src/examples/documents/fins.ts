import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../build-showcase-beat.ts";
import { FINS_GLASS_WGSL, FINS_GRADE_WGSL } from "../shaders/fins.wgsl.ts";

/**
 * E67 — Fins (T1265). The owner's hand-built piece (`fins-11.loom.json`), shipped, with the
 * lights answering the beat.
 *
 * ## What is the owner's, unchanged
 *
 * Two customWgsl nodes and the output, exactly as built: `glassRT`, an analytic ray tracer
 * for a stack of nine bevelled glass slabs, with refracted beams, thin film and a procedural
 * room; then `finalGrade`, a light-handed grade; then `finalImage` with the filmic tone map.
 * Both shader sources are verbatim (`fins.wgsl.ts`), and every parameter keeps the value
 * the owner left it at. The camera orbit on `eyeX`/`eyeZ` is the owner's own expression.
 *
 * ## What changed to ship it, and why
 *
 *   - THE ROOM'S INPUT. The hand-built file wired a `movieFileIn` holding a latlong photo
 *     through a `blob:` URL, which is dead the moment the tab closes. It never reached the
 *     picture anyway: `envMix` was never set, so it sits at its declared default of 0, and
 *     the shader only samples the input above 0.001. The unconnected black `envSeed` solid
 *     in the same file now feeds that input, which leaves the picture unchanged and gives a
 *     dead node a job. To use a map, wire a latlong image in and raise `envMix`.
 *   - THE RESOLUTION. `glassRT` inherits its input's size, and the photo node was pinned to
 *     2048x1024. So the hand-built piece traced at 2:1 and the output squashed that into
 *     1280x720, about 11% narrower than it was traced. The owner chose native 16:9 at
 *     1920x1080 for recording: the solid takes the project size, and the trace follows.
 *     That is the only difference from the hand-built frame. The vertical field of view
 *     is the shader's, so the slabs keep their height in frame and gain their true width.
 *   - The unused starter library and the empty, stale group frames were not carried over.
 *
 * ## The lights on the beat (optional, and off means the hand-built look)
 *
 * `clip1` binds the shipped synthesised beat (`media/showcase-beat.m4a`, the same clip E66
 * reads) under the timeline lock with a declared tempo, so a recording is frame-exact and
 * repeatable. `analysis1` is the starter `AudioAnalysis`. Its `hits` bag (each count is 1
 * on the frame it fires and decays over `hitDecay` ms) goes through ONE multiply, `react1`,
 * and `react1.operand` is the reactivity knob. Every driven parameter is written as the
 * owner's value times (1 + gain × lane), or plus gain × lane, so a lane at 0 returns the
 * owner's value exactly:
 *
 *   kickCount   the white strip sources in the room (the streaks the edges catch) and all
 *               three beam brightnesses flare on the kick
 *   snareCount  the light wandering INSIDE the glass blooms on 2 and 4
 *   hatCount    the coloured gel panels lift a little on every eighth
 *
 * Only light parameters are driven. Geometry, camera and motion never hear the music, so a
 * beat frame and a rest frame show the same slabs in the same place. With `react1.operand`
 * at 0, or a silent passage, or a host that cannot hear the clip, every lane is 0 and the
 * frame is the owner's. `e67-fins-claims.gpu.test.ts` asserts both halves from pixels.
 *
 * The recorder writes video only. To put the sound under it, mux the clip in afterwards;
 * both run on the same timeline.
 */

const HIT = (key: string): string => `op('react1').chan.${key}`;

export const finsDocument = document(
  "e67-fins",
  "E67 Fins",
  settings({ randomSeed: 1, previewFps: 20, outputResolution: { width: 1920, height: 1080 } }),
  graph(
    [
      // ── the hand-built chain ─────────────────────────────────────────────────
      node("seed", "solid", [-343, -135], { color: [0, 0, 0, 1] }, { label: "envSeed" }),
      node("glass", "customWgsl", [-52, -128], {
        source: FINS_GLASS_WGSL,
        aa: 1, absorb: 2.6, amount: 1, beamSpan: 40, bevel: 0.009, bevelAmt: 1, bg: 0, chroma: 1,
        detailDepth: 0.5, dispersion: 0.055, edgeLift: 0.9, envDetail: 5, envLevel: 1,
        excite: 1.6, exciteRadius: 0.42, eyeY: 0.16, fan: 0.22, fill: 0.004, film: 0.75,
        filmThick: 0.62, filmVary: 0.55, fov: 40, glowRadius: 0.6, glowSpeed: 1, ior: 1.52,
        laser2Aim: 0.2, laser2Hue: 0.55, laser2Radius: 0.021, laser3Aim: 0.35, laser3Hue: 0.33,
        laser3Radius: 0.014, laserAim: 0.45, laserCycle: 26, laserDuty: 5, laserHue: 0.02,
        laserInside: 4.5, laserRadius: 0.016, laserReach: 0.5, lean: 0.05, length: 0.66,
        motion: 1, panelSize: 0.62, panelSoft: 0.3, reflFade: 0.55, scratch: 0.35,
        scratchScale: 90, selfSpin: 0.05, slabs: 9, spacing: 0.44, spin: 0.3, spinAlt: 1,
        spinOffset: 0.16, spinRate: 26, spinRoll: 0, spinStagger: 0.085, spinTumble: 0,
        stackAngle: 0.68, surgeCycle: 52, surgeFloor: 0.18, sway: 0.03, thickness: 0.055,
        tint: [1, 1, 1, 1], wave: 0.05, waveLen: 3.7, width: 0.2, yawBase: 1.15,
        /* Never set in the hand-built file, so they rendered at the shader's `@default`s.
           Stored at exactly those values (§V920), so a later default edit cannot move this. */
        envMix: 0, envPunch: 0.6, envRotate: 0, envSpin: 0.006, beamBend: 1,
      }, {
        label: "glassRT",
        parameters: {
          /* T1268 — THE CAMERA CIRCLES THE STACK, once every four minutes. The hand-built
             orbit swung ±0.30 rad over 503 s and read as a still; the owner picked a full
             circle from stills against two swings. A turn is periodic, so there is no seam to
             hide. It starts at the hand-built angle of 0.20 rad, so t = 0 is the composition
             the owner approved at T1265, and the retained values are that frame. */
          eyeX: expressionSlot("2.78*sin(0.20+abstime*6.2831853/240)", 0.5523),
          eyeZ: expressionSlot("2.78*cos(0.20+abstime*6.2831853/240)", 2.7246),
          // The lights. Each one returns the owner's value when its lane is 0.
          stripLevel: expressionSlot(`4 * (1 + 0.8 * ${HIT("kickCount")})`, 4),
          laser: expressionSlot(`2.6 * (1 + 2 * ${HIT("kickCount")})`, 2.6),
          laser2: expressionSlot(`2 * (1 + 2 * ${HIT("kickCount")})`, 2),
          laser3: expressionSlot(`2.1 * (1 + 2 * ${HIT("kickCount")})`, 2.1),
          glow: expressionSlot(`0.3 + 1.2 * ${HIT("snareCount")}`, 0.3),
          gelLevel: expressionSlot(`0.55 * (1 + 0.35 * ${HIT("hatCount")})`, 0.55),
        },
      }),
      node("grade", "customWgsl", [300, -150], {
        source: FINS_GRADE_WGSL,
        amount: 1, ceiling: 3, exposure: 1, saturation: 1.28, tint: [1, 1, 1, 1], toe: 0.002, vignette: 0.12,
      }, { label: "finalGrade" }),
      node("out", "output", [600, -150], { toneMap: "filmic" }, { label: "finalImage" }),

      // ── the beat ─────────────────────────────────────────────────────────────
      node("clip", "audioFileIn", [-900, 300], {
        file: SHOWCASE_BEAT_FILE,
        playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
        trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
        tempoMode: "declared", bpm: SHOWCASE_BEAT.bpm, beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
        beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000,
      }, { label: "clip1" }),
      node("analysis", "component:audioAnalysis@1", [-600, 300], {
        envelope: 0.08, window: 16, settle: 0.15, hitDecay: 300,
      }, { label: "analysis1" }),
      /* THE REACTIVITY KNOB. A multiply maps every lane of the bag, so one operand scales all
         three lights: 1 as shipped, 0 is the hand-built piece, above 1 hits harder. */
      node("react", "valueMath", [-300, 300], { operation: "multiply", operand: 1 }, { label: "react1" }),
    ],
    [
      edge("e-seed-glass", ["seed", "out"], ["glass", "input"]),
      edge("e-glass-grade", ["glass", "out"], ["grade", "input"]),
      edge("e-grade-out", ["grade", "out"], ["out", "input"]),
      edge("e-clip-analysis", ["clip", "out"], ["analysis", "audio"]),
      edge("e-analysis-react", ["analysis", "hits"], ["react", "a"]),
    ],
  ),
);
