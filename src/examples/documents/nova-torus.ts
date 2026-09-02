import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E35 — Nova-Torus (T660). The owner's second file, shipped as Corona's sibling.
 *
 * 41 of these 43 nodes are the owner's own (the audio-swap trio replaces one dead
 * blob: URL): the same eight gain-and-bias pairs, three renderPoints readings, bloom,
 * palette, feedback and hue drift §V471 already describes — so the docblocks here
 * teach only what DIFFERS from Corona, which is the whole reason it has a slot:
 * a torus whose TUBE thickness is the audio's way in, a noise-mottled palette read,
 * a starred tube profile, and a fast 0.5 Hz hue modulator against Corona's 29-second
 * cycle. Seed 11 in the kernel hash against Corona's 7.
 *
 * What was corrected before shipping, each with precedent: the persistence overshoot
 * (§B115, Corona's own bug, Corona's own fix), the dead tip pair (wired, §V624), the
 * half-degree hue wobble (T574), the inert 2D-noise speed (T518), and the blob URL
 * (T504's swap). The owner's look decisions — including the ×20 high-band brightness,
 * which is legal on a floor-ranged parameter and reads as the gold flash it is —
 * ship as saved.
 */
export const novaTorusDocument = document(
  "nova-torus",
  "E35 Nova-Torus",
  settings({ randomSeed: 1, previewFps: 20 }),
  graph(
    [
      node("add1", "add", [1145, -96], { opacity: 1 }, { label: "add1" }),
      node("blur1", "blur", [780, -280], { extend: "hold", filter: "gaussian", size: 34 }, { label: "blur1" }),
      node("feedback1", "feedback", [1880, 220], { clearColor: [0, 0, 0, 1], reset: false, source: "null2", substeps: 1 }, { label: "feedback1", parameters: { persistence: drivenSlot("valuemath14:level", 0) } }),
      node("hsv1", "hsv", [2320, -100], { saturation: 1.24, value: 1 }, { label: "hsv1", parameters: { hueoffset: drivenSlot("lfo1", 0) } }),
      node("level1", "level", [560, 200], { blacklevel: 0, contrast: 1, gamma1: 1, invert: 0, opacity: 1, whitelevel: 1 }, { label: "level1", parameters: { brightness: drivenSlot("valuemath8:low", 0) } }),
      node("level2", "level", [560, 460], { blacklevel: 0, contrast: 1, gamma1: 1, invert: 0, opacity: 1, whitelevel: 1 }, { label: "level2", parameters: { brightness: drivenSlot("valuemath10:high", 0) } }),
      node("level3", "level", [1000, -280], { blacklevel: 0.01, contrast: 1, gamma1: 1, invert: 0, opacity: 1, whitelevel: 1 }, { label: "level3", parameters: { brightness: drivenSlot("valuemath4:low", 0) } }),
      node("lookup1", "lookup", [1440, 112], { channel: "luminance", offset: 0, row: 0.5 }, { label: "lookup1", parameters: { scale: drivenSlot("valuemath12:highMid", 0) } }),
      node("multiply1", "multiply", [1340, -100], { opacity: 1 }, { label: "multiply1" }),
      /**
       * The `noise → multiply` stage Corona has no equivalent of: a gentle mottle
       * (amp 0.22 about offset 1) over the graded bloom before the palette reads it.
       * `perlin4d` rather than the saved perlin2d, deliberately: a 2D noise has no time
       * axis, so the saved `speed: 0.12` was inert (T518) and the file claimed motion
       * it could not perform. Measured honestly: the moving mask changes ~0.2% of the
       * frame's pixels — texture, not signal — and the docblock says so rather than
       * overselling it.
       */
      node("noise1", "noise", [1220, 380], { amp: 0.22, aspectcorrect: true, exp: 1, gain: 0.5, harmon: 2, mono: true, offset: 1, p: [0, 0, 0], period: 3.2, r: 0, rough: 0.5, s: [1, 1, 1], s4d: 1, seed: 1, speed: 0.12, spread: 2, t: [0, 0, 0], t4d: 0.37, type: "perlin4d", xord: "srt" }, { label: "noise1" }),
      node("null1", "null", [560, -100], {}, { label: "null1" }),
      node("null2", "null", [2540, -100], {}, { label: "null2" }),
      node("output1", "output", [2760, -100], { toneMap: "none" }, { label: "output1" }),
      /**
       * THE DIFFERENCE THAT EARNS THE SLOT. Corona drives a sphere's whole radius; here
       * the major radius stands at 1 and the audio drives the MINOR one — `radius2`,
       * lowMid, 0.18..0.52 — so what breathes is the TUBE'S THICKNESS, a different
       * mechanism rather than a different palette. The kernel then stars and ribbons
       * that tube (prof = 1 + 0.38·star + 0.15·field), which is why the ring reads as
       * braided cable rather than as a donut.
       */
      node("pointgenerator1", "pointGenerator", [-782, 44], { cols: 256, count: 65536, radius: 1, rows: 256, shape: "torus", sizeX: 2, sizeY: 2, sizeZ: 2 }, { label: "pointgenerator1", parameters: { radius2: drivenSlot("valuemath2:lowMid", 0.3) } }),
      node("pointkernel1", "pointKernel", [-153, 35], { attributes: "", capacity: 65536, group: "", kernel: "\nfn lm_hash(p: vec3f) -> f32 {\n  var q = fract(p * 0.1031);\n  q = q + vec3f(dot(q, q.zyx + 31.32));\n  return fract((q.x + q.y) * q.z);\n}\nfn lm_noise(x: vec3f) -> f32 {\n  let i = floor(x); let f = fract(x);\n  let u = f * f * (3.0 - 2.0 * f);\n  let a = mix(lm_hash(i + vec3f(0.0,0.0,0.0)), lm_hash(i + vec3f(1.0,0.0,0.0)), u.x);\n  let b = mix(lm_hash(i + vec3f(0.0,1.0,0.0)), lm_hash(i + vec3f(1.0,1.0,0.0)), u.x);\n  let c = mix(lm_hash(i + vec3f(0.0,0.0,1.0)), lm_hash(i + vec3f(1.0,0.0,1.0)), u.x);\n  let d = mix(lm_hash(i + vec3f(0.0,1.0,1.0)), lm_hash(i + vec3f(1.0,1.0,1.0)), u.x);\n  return mix(mix(a,b,u.y), mix(c,d,u.y), u.z) * 2.0 - 1.0;\n}\nfn lm_fbm(x: vec3f, oct: i32) -> f32 {\n  var v = 0.0; var a = 0.5; var q = x;\n  for (var k: i32 = 0; k < oct; k = k + 1) {\n    v = v + a * lm_noise(q);\n    q = q * 2.03 + vec3f(17.3, 9.1, 4.7);\n    a = a * 0.55;\n  }\n  return v;\n}\nfn lm_ridged(x: vec3f, oct: i32) -> f32 {\n  var v = 0.0; var a = 0.5; var q = x;\n  for (var k: i32 = 0; k < oct; k = k + 1) {\n    let n = 1.0 - abs(lm_noise(q));\n    v = v + a * n * n;\n    q = q * 2.07 + vec3f(11.1, 3.3, 7.7);\n    a = a * 0.52;\n  }\n  return v - 0.62;\n}\nfn lm_rotY(v: vec3f, a: f32) -> vec3f {\n  let c = cos(a); let s = sin(a);\n  return vec3f(v.x*c - v.z*s, v.y, v.x*s + v.z*c);\n}\nfn lm_rotX(v: vec3f, a: f32) -> vec3f {\n  let c = cos(a); let s = sin(a);\n  return vec3f(v.x, v.y*c - v.z*s, v.y*s + v.z*c);\n}\n\n\nfn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  // absolute clock: ctx.time is timeline-relative and snaps at the loop point.\n  // T683: ctx.absTime is SECONDS (the manifest says so). The saved file multiplied\n  // by 0.001 - a milliseconds assumption - which ran this whole kernel clock at\n  // 1/1000th speed: the tumble, the band sweep and the morphs below were all\n  // authored, and all frozen. The turntable the owner asked for was already here.\n  let t = ctx.absTime;\n\n  let R0 = 1.0; let RMIN = 0.18; let RSPAN = 0.34;\n  let pin = p.position;\n  let d = max(1.0e-4, length(pin.xz));\n  let r = length(vec2f(d - R0, pin.y));\n  let fromAudio = clamp((r - RMIN) / RSPAN, 0.0, 1.0);\n  let warp = clamp(fromAudio + 0.30 + 0.26 * sin(t * 0.087), 0.0, 1.35);\n\n  let u  = atan2(pin.z, pin.x);\n  let v0 = atan2(pin.y, d - R0);\n\n  // ---- three morph weights, smooth and normalised (no steps, no snapping) --\n  let m = t * 0.055;\n  var w0 = 0.5 + 0.5 * sin(m);\n  var w1 = 0.5 + 0.5 * sin(m * 0.73 + 2.1);\n  var w2 = 0.5 + 0.5 * sin(m * 0.51 + 4.2);\n  w0 = w0 * w0; w1 = w1 * w1; w2 = w2 * w2;      // sharpen so one mode leads\n  let ws = w0 + w1 + w2 + 1.0e-4;\n  w0 = w0 / ws; w1 = w1 / ws; w2 = w2 / ws;\n\n  // ---- twist as PERIODIC harmonics of u: closes seamlessly, morphs smoothly\n  let A1 = 0.60 + 0.90 * sin(t * 0.037);\n  let A2 = 0.80 * sin(t * 0.023 + 1.7);\n  let A3 = 0.50 * sin(t * 0.019 + 3.3);\n  var v = v0\n        + A1 * sin(u)\n        + A2 * sin(2.0 * u + t * 0.06)\n        + A3 * sin(3.0 * u - 0.4)\n        + (0.5 + 1.1 * warp) * sin(u + t * 0.12);\n  v = v + t * 0.50;\n\n  let sc = vec3f(cos(u) * 1.4, sin(u) * 1.4, v * 0.45);\n  let wv = vec3f(\n    lm_fbm(sc + vec3f(0.0, 0.0, t * 0.12), 4),\n    lm_fbm(sc + vec3f(4.1, 2.7, t * 0.10), 4),\n    lm_fbm(sc + vec3f(8.3, 6.1, t * 0.14), 4)\n  );\n  let lobes   = lm_fbm(sc * 1.6 + wv * 1.5, 5);\n  let creases = lm_ridged(sc * (2.2 + 2.4 * warp) + wv * 1.1 - vec3f(t * 0.2, 0.0, 0.0), 5);\n  let field   = mix(lobes, creases * 1.15, clamp(warp, 0.0, 1.0));\n\n  // ---- three genuinely different cross-section profiles ---------------------\n  // harmonic counts stay integer; only the CROSSFADE moves, so nothing tears\n  let sMix = 0.5 + 0.5 * sin(t * 0.020);\n  let star = mix(sin(4.0 * v), sin(7.0 * v), sMix);\n  let rMix = 0.5 + 0.5 * sin(t * 0.031 + 1.2);\n  let ripple = mix(sin(3.0 * u - t * 1.1), sin(7.0 * u - t * 0.7), rMix);\n\n  let prof0 = 1.0 + 0.30 * field;                      // smooth organic coil\n  let prof1 = 1.0 + 0.38 * star + 0.15 * field;        // star / ribbon tube\n  let prof2 = 1.0 + 0.95 * max(0.0, creases);    // spiny coral\n  let prof  = w0 * prof0 + w1 * prof1 + w2 * prof2;\n\n  let squash = mix(1.0, 0.58, w1);                     // flatten toward a ribbon\n\n  let rr = r * prof * (1.0 + 0.40 * warp * field + 0.16 * ripple);\n  let RR = R0 + 0.10 * sin(3.0 * u + t * 0.7)\n              + 0.14 * sin(2.0 * u - t * 0.60)\n              + 0.18 * lm_fbm(vec3f(cos(u) * 2.0, sin(u) * 2.0, t * 0.15), 3);\n\n  let cu = cos(u); let su = sin(u);\n  let cv = cos(v); let sv = sin(v);\n  var p3 = vec3f(cu * (RR + rr * cv), rr * sv * squash, su * (RR + rr * cv));\n  p3.y = p3.y + 0.22 * sin(2.0 * u + t * 0.45);\n\n  p3 = p3 * 0.70;\n  p3 = lm_rotY(p3, t * 0.09);\n  p3 = lm_rotX(p3, -0.58);\n\n  let dcam = 4.2; let zc = max(0.05, dcam - p3.z);\n  let ff = 3.6; let aspect = 16.0 / 9.0;\n  q.position = vec3f((p3.x * ff / zc) / aspect, p3.y * ff / zc, 0.5);\n\n  // travelling colour band + camera depth, read by the layer predicates\n  let band = 0.5 + 0.5 * sin(3.0 * u - t * 0.90 + 0.8 * field + 1.6 * sin(v * 0.5));\n  q.velocity = vec3f(band, creases, clamp(p3.z * 1.4 + 0.5, 0.0, 1.0));\n  return q;\n}\n", seed: 11, value1: 0, value2: 0, value3: 0, value4: 0 }, { label: "pointkernel1" }),
      node("ramp1", "ramp", [1220, 160], { interp: "smooth", period: 1, phase: 0, stops: [{ color: [0, 0, 0, 1], position: 0 }, { color: [0.01, 0.02, 0.07, 1], position: 0.1 }, { color: [0.06, 0.13, 0.42, 1], position: 0.3 }, { color: [0.48, 0.09, 0.64, 1], position: 0.52 }, { color: [0.98, 0.26, 0.22, 1], position: 0.72 }, { color: [1, 0.74, 0.3, 1], position: 0.89 }, { color: [1, 0.98, 0.93, 1], position: 1 }], type: "horizontal" }, { definitionVersion: 2, label: "ramp1" }),
      node("renderpoints1", "renderPoints", [240, -100], { accumulate: false, blend: "additive", color: [0.17, 0.27, 0.54, 1], count: 65536, group: "" }, { label: "renderpoints1", parameters: { sizePixels: drivenSlot("valuemath6:level", 0) } }),
      node("renderpoints2", "renderPoints", [240, 200], { accumulate: false, blend: "additive", color: [1, 0.42, 0.1, 1], count: 65536, group: "p.velocity.y > 0.06", sizePixels: 1.3 }, { label: "renderpoints2" }),
      /**
       * The cyan sparkle group — and its size is DRIVEN now (§V624). The owner's file
       * carried `valuemath15 ×9 → valuemath16 +1` wired to nothing; Corona's identical
       * tipG/tip pair drives ITS third renderPoints' size on the cyan tips, so the dead
       * pair here read as unfinished intent, not decoration. Wired and measured: the
       * sparkle layer's weight follows the high band, 1.5% of the frame moving with it
       * at a mid-pattern frame. A parameter that drives nothing is a lie in a document.
       */
      node("renderpoints3", "renderPoints", [240, 460], { accumulate: false, blend: "additive", color: [0.22, 0.88, 1, 1], count: 65536, group: "p.velocity.x > 0.66 && p.velocity.y < 0.04" }, { label: "renderpoints3", parameters: { sizePixels: drivenSlot("valuemath16:high", 1.5) } }),
      node("screen1", "screen", [1660, -100], { opacity: 1 }, { label: "screen1" }),
      node("screen2", "screen", [1880, -100], { opacity: 1 }, { label: "screen2" }),
      node("screen3", "screen", [2100, -100], { opacity: 1 }, { label: "screen3" }),
      node("audiofilein1", "audioFileIn", [-420, 700], { cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true, playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1 }, { label: "audiofilein1" }),
      /**
       * The FAST modulator — 0.5 Hz against Corona's 0.035, the deliberate tempo
       * difference (§V471.8 is Corona's idea; this file does something else on
       * purpose). The amplitude is the corrected half: the owner saved 0.5 on a
       * DEGREES parameter (T574's half-degree bug again — invisible), so the sweep is
       * ±18° now, a visible two-second hue shimmer over the magenta body.
       */
      node("lfo1", "lfo", [-420, 880], { amplitude: 18, frequency: 0.5, offset: 0, phase: 0, shape: "sine" }, { label: "lfo1" }),
      /**
       * T504/T508, Corona's exact treatment: the file opens PLAYING against a
       * deterministic pattern, and your own track is one drop away — both sources are
       * wired permanently, the Switch's index picks, and nothing downstream changes
       * because everything downstream reads `source1`. The owner's original carried a
       * session-local blob: URL that is dead outside the browser it was saved in; the
       * File parameter ships empty, its T493 transport kept.
       */
      node("music1", "audioPattern", [-420, 440], { amount: 1, bpm: 112 }, { label: "music1" }),
      node("source1", "valueSwitch", [-160, 570], { index: 0 }, { label: "source1" }),
      node("valuelag1", "valueLag", [-140, 798], { lag: 0.09 }, { label: "valuelag1" }),
      node("valuemath1", "valueMath", [140, 700], { operand: 1.0129, operation: "multiply" }, { label: "valuemath1" }),
      node("valuemath2", "valueMath", [340, 700], { operand: -0.3241, operation: "add" }, { label: "valuemath2" }),
      node("valuemath3", "valueMath", [140, 896], { operand: 5.0173, operation: "multiply" }, { label: "valuemath3" }),
      node("valuemath4", "valueMath", [340, 896], { operand: -2.5418, operation: "add" }, { label: "valuemath4" }),
      node("valuemath5", "valueMath", [140, 1092], { operand: 2.2, operation: "multiply" }, { label: "valuemath5" }),
      node("valuemath6", "valueMath", [340, 1092], { operand: 1.2, operation: "add" }, { label: "valuemath6" }),
      node("valuemath7", "valueMath", [140, 1288], { operand: 7.3587, operation: "multiply" }, { label: "valuemath7" }),
      node("valuemath8", "valueMath", [340, 1288], { operand: -4.7247, operation: "add" }, { label: "valuemath8" }),
      node("valuemath9", "valueMath", [140, 1484], { operand: 23.2749, operation: "multiply" }, { label: "valuemath9" }),
      node("valuemath10", "valueMath", [340, 1484], { operand: -7.5588, operation: "add" }, { label: "valuemath10" }),
      node("valuemath11", "valueMath", [140, 1680], { operand: 3.3773, operation: "multiply" }, { label: "valuemath11" }),
      node("valuemath12", "valueMath", [340, 1680], { operand: -0.2697, operation: "add" }, { label: "valuemath12" }),
      /**
       * §B115, CAUGHT BEFORE SHIPPING THIS TIME. The owner's gain here was 0.95 —
       * persistence 0.62..1.57 against feedback's bounded 0..1, the same numbers
       * Corona shipped with and the owner found within minutes. Corona's retune
       * (b3b0e36) applies wholesale: 0.30 tops the trail at 0.92, where a trail still
       * ends — a better look, not a compromise for a warning.
       */
      node("valuemath13", "valueMath", [140, 1876], { operand: 0.3, operation: "multiply" }, { label: "valuemath13" }),
      node("valuemath14", "valueMath", [340, 1876], { operand: 0.62, operation: "add" }, { label: "valuemath14" }),
      node("valuemath15", "valueMath", [140, 2072], { operand: 10.4737, operation: "multiply" }, { label: "valuemath15" }),
      node("valuemath16", "valueMath", [340, 2072], { operand: -2.4465, operation: "add" }, { label: "valuemath16" }),
    ],
    [
      edge("e0-music1-source1", ["music1", "out"], ["source1", "in1"]),
      edge("e1-source1-valuelag1", ["source1", "out"], ["valuelag1", "in"]),
      edge("e2-audiofilein1-source1", ["audiofilein1", "out"], ["source1", "in2"]),
      edge("e3-ramp1-lookup1", ["ramp1", "out"], ["lookup1", "lookup"]),
      edge("e4-lookup1-screen1", ["lookup1", "out"], ["screen1", "in1"]),
      edge("e5-level1-screen1", ["level1", "out"], ["screen1", "in2"], 0),
      edge("e6-screen1-screen2", ["screen1", "out"], ["screen2", "in1"]),
      edge("e7-level2-screen2", ["level2", "out"], ["screen2", "in2"], 0),
      edge("e8-feedback1-screen3", ["feedback1", "out"], ["screen3", "in2"], 0),
      edge("e9-screen3-hsv1", ["screen3", "out"], ["hsv1", "input"]),
      edge("e10-hsv1-null2", ["hsv1", "out"], ["null2", "in"]),
      edge("e11-null2-output1", ["null2", "out"], ["output1", "input"]),
      edge("e12-valuelag1-valuemath1", ["valuelag1", "out"], ["valuemath1", "a"]),
      edge("e13-valuemath1-valuemath2", ["valuemath1", "out"], ["valuemath2", "a"]),
      edge("e14-valuelag1-valuemath3", ["valuelag1", "out"], ["valuemath3", "a"]),
      edge("e15-valuemath3-valuemath4", ["valuemath3", "out"], ["valuemath4", "a"]),
      edge("e16-valuelag1-valuemath5", ["valuelag1", "out"], ["valuemath5", "a"]),
      edge("e17-valuemath5-valuemath6", ["valuemath5", "out"], ["valuemath6", "a"]),
      edge("e18-valuelag1-valuemath7", ["valuelag1", "out"], ["valuemath7", "a"]),
      edge("e19-valuemath7-valuemath8", ["valuemath7", "out"], ["valuemath8", "a"]),
      edge("e20-valuelag1-valuemath9", ["valuelag1", "out"], ["valuemath9", "a"]),
      edge("e21-valuemath9-valuemath10", ["valuemath9", "out"], ["valuemath10", "a"]),
      edge("e22-valuelag1-valuemath11", ["valuelag1", "out"], ["valuemath11", "a"]),
      edge("e23-valuemath11-valuemath12", ["valuemath11", "out"], ["valuemath12", "a"]),
      edge("e24-valuelag1-valuemath13", ["valuelag1", "out"], ["valuemath13", "a"]),
      edge("e25-valuemath13-valuemath14", ["valuemath13", "out"], ["valuemath14", "a"]),
      edge("e26-valuelag1-valuemath15", ["valuelag1", "out"], ["valuemath15", "a"]),
      edge("e27-valuemath15-valuemath16", ["valuemath15", "out"], ["valuemath16", "a"]),
      edge("e28-add1-multiply1", ["add1", "out"], ["multiply1", "in1"]),
      edge("e29-noise1-multiply1", ["noise1", "out"], ["multiply1", "in2"], 0),
      edge("e30-multiply1-lookup1", ["multiply1", "out"], ["lookup1", "source"]),
      edge("e31-screen2-screen3", ["screen2", "out"], ["screen3", "in1"]),
      edge("e32-pointgenerator1-pointkernel1", ["pointgenerator1", "out"], ["pointkernel1", "in"]),
      edge("e33-pointkernel1-renderpoints1", ["pointkernel1", "out"], ["renderpoints1", "points"]),
      edge("e34-pointkernel1-renderpoints2", ["pointkernel1", "out"], ["renderpoints2", "points"]),
      edge("e35-pointkernel1-renderpoints3", ["pointkernel1", "out"], ["renderpoints3", "points"]),
      edge("e36-renderpoints1-null1", ["renderpoints1", "out"], ["null1", "in"]),
      edge("e37-renderpoints2-level1", ["renderpoints2", "out"], ["level1", "input"]),
      edge("e38-renderpoints3-level2", ["renderpoints3", "out"], ["level2", "input"]),
      edge("e39-null1-blur1", ["null1", "out"], ["blur1", "input"]),
      edge("e40-blur1-level3", ["blur1", "out"], ["level3", "input"]),
      edge("e41-null1-add1", ["null1", "out"], ["add1", "in1"]),
      edge("e42-level3-add1", ["level3", "out"], ["add1", "in2"], 0),    ],
  ),
);
