import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { SPLICE_WGSL } from "../shaders/splice.wgsl.ts";

/**
 * E43 — Splice (T749). The custom shader AS THE STAR — the VJ glitch rack.
 *
 * Every shipped customWgsl is simulation plumbing (Gray-Scott, fluid velocity, E32's
 * eight); none has ever been the EFFECT — the owner's "interesting shader setups",
 * per-pixel, on a picture, on the beat. This is that: video through a beat-quantised
 * slicing shader (bands jump, blocks tear, RGB splits along the tear), folded by a
 * slowly rotating MIRROR (its first example, in its own role — the kaleidoscope fold
 * the node was born for), slammed by a CROP letterbox riding the onsets (crop blanks —
 * that is its literal job), with a scaled echo COMPOSITED over the top on the kick.
 *
 *   bed1/orb1 (the moving understudy) ─► stand1 ─┐ order 0
 *   clip1(movieFileIn) ────────────────────────── ┴─► pick1(switch)
 *   pick1 ─► splice1(customWgsl: the glitch) ─► fold1(mirror ┄ spin1) ─┬─► slam1(crop ┄ onset)
 *   beat1(audioPattern) ┄ gsub1·gd1·genv1 ┄► splice1.amount            │        │
 *          ┄ esub1·ed1·lenv1 ┄► punch1.opacity                         └► echo1(transform, ×1.28)
 *                                                                                │
 *                                                    punch1(composite: echo over slam) ─► out1
 *
 * ## The identity discipline, extended to USER code (§V147)
 *
 * `amount = 0` is a BYTE-IDENTICAL passthrough: every read in the shader is a
 * textureLoad at the pixel's own integer coordinate once the offsets collapse — no
 * sampler, no filtering, nothing to forgive. Every stock node in this project proves
 * its no-op; user shader code never had to until now, and splice-claims pins it. The
 * audio chains subtract each band's T701 REST value before driving, so silence IS
 * zero and the rack at rest shows the picture untouched.
 *
 * ## Quantised, not animated (§V681)
 *
 * The glitch re-deals only when the deal clock ticks (3/s, on the ABSOLUTE clock —
 * §V436, a timeline lap must not re-deal). Between ticks the displacement map is
 * frozen; across them it slams. Glitch that wobbles per-frame is noise, glitch that
 * holds and slams is rhythm, and only a cross-frame claim can tell them apart.
 */
export const spliceDocument = document(
  "e43-splice",
  "E43 Splice",
  settings({ randomSeed: 43 }),
  graph(
    [
      // ---- the source and its understudy (E41's rig) --------------------------------
      node("bed", "noise", [-2220, -420], {
        type: "perlin4d", seed: 11, period: 0.11, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1.6, amp: 0.36, offset: -0.32, mono: true, aspectcorrect: true,
        speed: 0.035, t4d: 0.37, s4d: 1, // T786: off the 4D lattice plane (T535) — t4d=0 collapses perlin4d's amplitude, so frame 0, which is the gallery card, was systematically flatter than every frame after it
      }, { label: "bed1" }),
      node("orb", "circle", [-2220, -140], {
        mode: "fill", center: [0.5, 0.5], radius: [0.13, 0.13], softness: 0.045,
        fillcolor: [1, 0.42, 0.12, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("pathx1", 0.5), "center.y": drivenSlot("pathy1", 0.5) } }),
      node("pathx", "lfo", [-2220, 420], { shape: "sine", frequency: 0.29, amplitude: 0.33, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-2220, 700], { shape: "sine", frequency: 0.203, amplitude: 0.3, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("clip", "movieFileIn", [-2220, 140], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("stand", "add", [-1920, -280], { opacity: 1 }, { label: "stand1" }),
      node("pick", "switch", [-1920, 20], { index: 0 }, { label: "pick1" }),

      // ---- the beat, and the rest-subtracted drives (T701) --------------------------
      node("beat", "audioPattern", [-1920, 420], { bpm: 122, amount: 1 }, { label: "beat1" }),
      /* HIGH band → the glitch. Rest 0.3809 subtracted first (T701), so silence drives
         EXACTLY zero and the §V147 identity is the rack's own resting state. */
      node("gsub", "valueMath", [-1620, 420], { operation: "add", operand: -0.381 }, { label: "gsub1" }),
      node("gmul", "valueMath", [-1320, 420], { operation: "multiply", operand: 5.5 }, { label: "gd1" }),
      /* T824 — envelope the tear MAGNITUDE. The deal timing is the shader's own
         floor(absTime·DEALS) clock, so the §T749 hold-and-slam is untouched; this only
         stops the per-frame band wobble the shader's own §V681 warns is noise. Fast
         attack, slow release — a hit blooms and decays like a hit, not a jitter. At
         silence the rest-subtracted band is 0 and the lag of 0 is 0, so §V147 holds. */
      node("genv", "valueLag", [-1020, 420], { lag: 0.02, releaseRatio: 6 }, { label: "genv1" }),
      /* LOW band → the echo. Rest 0.7119 (T701). */
      node("esub", "valueMath", [-1620, 660], { operation: "add", operand: -0.712 }, { label: "esub1" }),
      node("emul", "valueMath", [-1320, 660], { operation: "multiply", operand: 1.7 }, { label: "ed1" }),
      /* T824 — envelope the echo opacity so it blooms on the kick and decays, instead
         of flickering per frame. Slower than the glitch: the echo is a sustain. */
      node("lenv", "valueLag", [-1020, 660], { lag: 0.05, releaseRatio: 5 }, { label: "lenv1" }),
      /* ONSETS → the letterbox slam, through a lag so the bar decays like a hit. */
      node("slag", "valueLag", [-1620, 900], { lag: 0.14 }, { label: "slag1" }),
      node("smul", "valueMath", [-1320, 900], { operation: "multiply", operand: 0.24 }, { label: "sl1" }),
      /* The fold axis drifts — a locked mirror reads as a screenshot (E13's lesson). */
      node("spin", "lfo", [-1320, 1140], { shape: "sine", frequency: 0.019, amplitude: 22, offset: 8, phase: 0 }, { label: "spin1" }),

      // ---- the rack -----------------------------------------------------------------
      node("splice", "customWgsl", [-1620, -60], { source: SPLICE_WGSL }, {
        label: "splice1",
        parameters: { amount: drivenSlot("genv1:high", 0) },
      }),
      node("fold", "mirror", [-1320, -60], {
        mirrorx: true, mirrory: false, pivot: [0.5, 0.5], keephigh: false, extend: "mirror",
      }, { label: "fold1", parameters: { rotate: drivenSlot("spin1", 12) } }),
      node("slam", "crop", [-1020, -60], { left: 0, right: 1, top: 1 }, {
        label: "slam1",
        parameters: { bottom: drivenSlot("sl1:onset", 0) },
      }),
      node("echo", "transform", [-1020, 240], {
        t: [0, 0], r: 0, s: [1.18, 1.18], p: [0.5, 0.5], xord: "srt", extend: "zero", aspectcorrect: false,
      }, { label: "echo1" }),
      node("punch", "composite", [-720, -60], { operation: "over" }, {
        label: "punch1",
        parameters: { opacity: drivenSlot("lenv1:low", 0) },
      }),
      node("out", "output", [-420, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"]),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"]),
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-beat-gsub", ["beat", "out"], ["gsub", "a"]),
      edge("e-gsub-gmul", ["gsub", "out"], ["gmul", "a"]),
      edge("e-gmul-genv", ["gmul", "out"], ["genv", "in"]),
      edge("e-beat-esub", ["beat", "out"], ["esub", "a"]),
      edge("e-esub-emul", ["esub", "out"], ["emul", "a"]),
      edge("e-emul-lenv", ["emul", "out"], ["lenv", "in"]),
      edge("e-beat-slag", ["beat", "out"], ["slag", "in"]),
      edge("e-slag-smul", ["slag", "out"], ["smul", "a"]),
      edge("e-pick-splice", ["pick", "out"], ["splice", "input"]),
      edge("e-splice-fold", ["splice", "out"], ["fold", "input"]),
      edge("e-fold-slam", ["fold", "out"], ["slam", "input"]),
      edge("e-fold-echo", ["fold", "out"], ["echo", "input"]),
      edge("e-echo-punch", ["echo", "out"], ["punch", "in1"]),
      edge("e-slam-punch", ["slam", "out"], ["punch", "in2"]),
      edge("e-punch-out", ["punch", "out"], ["out", "input"]),
    ],
  ),
);
