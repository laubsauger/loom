import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { SPLICE_WGSL } from "../shaders/splice.wgsl.ts";

/**
 * E45 — Pulse (T819). A VJ SET, not a picture: two shots that trade the frame.
 *
 * The owner's redefinition of "evolution" is the design: "we can also blend and swap
 * between different shots in a single scene... it doesnt have to be always a singular
 * thing stuck on screen." So the top level of this document is a STRUCTURE, not an
 * effect chain — two complete shots, each rendered by its own camera into its own
 * render, crossfaded by a value held PER PHRASE:
 *
 *   bar ─► step1 (hold 4 bars) ─► lag1 (the crossfade's ease) ─► mix1.cross
 *
 * The cut lands on a STRUCTURAL BOUNDARY, never a timer — §T548's machinery verbatim,
 * and the difference between a VJ set and a slideshow. The held value is CONTINUOUS
 * 0..1 on purpose: the owner said "blend AND swap", and a phrase held at 0.8 is shot B
 * with shot A ghosting through it — a blend a binary switch cannot say. Phrases near
 * the poles read as clean cuts.
 *
 * SHOT A — CONSTELLATION (Cross 0). The T819 node's own sentence: a swarm derived
 * deterministically per point (pointRand basis + absTime spin — no state, so a scrub
 * reproduces), breathing with the LOW band, linked by Proximity whose RADIUS rides the
 * HIGH band. Connection density IS the music: the web tightens on the beat and
 * dissolves in the quiet. Links draw through the beam path with the node's own
 * distance-fade tint (T478 Map mode) — nearer links brighter, zero new draw code.
 *
 * SHOT B — SCANLINE (Cross 1). The rays, back as their OWN shot (sequential shots do
 * not composite, so they do not dilute — the ruling that reversed the plan's cut): a
 * line of casters marches front-to-back once per BAR (barPhase is the position, so the
 * sweep is timeline-anchored and a scrub lands mid-stride), firing E34's ray march down
 * at an unseen noise terrain. No ground is drawn: impacts and beams alone say the
 * relief, hot where the ground is near, lost steel where the ray ran out.
 *
 * The GLITCH is global, not a shot: E43's splice kernel reused byte-for-byte (§V748 —
 * a second glitch kernel would be a fork with no reason), at an amount driven by the
 * HIGH band through the same rest-subtracted chain (T701), so the tears land on hits.
 * §V57c note: `amount` is clamped, not erroring, when the band peaks past 1 (B155).
 */
const VJ_SWARM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
]);

/* Derived, never integrated: each point's spherical basis comes from pointRand of its
   own index, spun by absTime and wobbled per point — so the swarm is a pure function of
   (index, time, value1) and every frame is reproducible in isolation (§V44). value1 is

   the LOW band after rest subtraction: the whole constellation inhales on the kick. */
const VJ_SWARM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = f32(ctx.index);
  let a = pointRand(ctx.index, 1u) * 6.2831853;
  let b = acos(2.0 * pointRand(ctx.index, 2u) - 1.0);
  let w = 0.35 + 0.65 * pointRand(ctx.index, 3u);
  let breath = 1.0 + 0.24 * clamp(ctx.value1, 0.0, 1.5);
  let r = (0.72 + 0.38 * pointRand(ctx.index, 4u)) * breath;
  let theta = a + ctx.absTime * (0.10 + 0.05 * w);
  let wob = 0.06 * sin(ctx.absTime * (0.35 + 0.4 * w) + i);
  q.position = vec3f(
    (r + wob) * sin(b) * cos(theta),
    (r + wob) * cos(b) * 0.86,
    (r + wob) * sin(b) * sin(theta),
  );
  /* T828 — DOWNTIME: value2 is the enveloped high band, and it gates EXISTENCE, not
     just size. In the arrangement's breakdown bar the dots fall to a quarter of
     themselves — the trace that remains — so quiet is a state of the picture, not
     just of the numbers. */
  let presence = 0.25 + 0.75 * clamp(ctx.value2 * 1.6, 0.0, 1.0);
  let warmth = pointRand(ctx.index, 5u);
  q.tint = vec4f(0.62 + 0.30 * warmth, 0.72, 1.0 - 0.25 * warmth, 1.0) * presence;
  return q;
}`;

const VJ_SCAN_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);

/* value1 is barPhase: the scanline's z IS the bar position, so the sweep crosses the
   field exactly once per bar and a scrub lands mid-stride (timeline-anchored, §V436). */
const VJ_SCAN_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, 1.75, (ctx.value1 * 2.0 - 1.0) * 1.5);
  return q;
}`;

const VJ_HIT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
]);

/* E34's verdict-as-geometry idiom (§V588 keeps the flag out): the slant length says
   hit or miss, no `hit` attribute spent. Impacts MOVE to the hit; beams keep their

   origin and let `endpoint: "hitPosition"` span the throw. */
const VJ_IMPACT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - p.position);
  let landed = select(0.0, 1.0, slant < 3.99);
  let near = clamp(1.0 - slant / 4.0, 0.0, 1.0);
  q.position = p.hitPosition + vec3f(0.0, 0.02, 0.0);
  /* T828 — the breakdown leaves EMBERS: value1 (enveloped high) scales the ridge to a
     0.3 floor in the quiet bar, so downtime is a glow, not a blackout. */
  let presence = 0.30 + 0.70 * clamp(ctx.value1 * 1.6, 0.0, 1.0);
  let ret = vec4f(1.0, 0.42 + 0.50 * near, 0.20, 1.0) * (0.4 + 1.8 * near) * presence;
  q.tint = mix(vec4f(0.0), ret, landed);
  return q;
}`;

/* E34's lesson, learned again on this frame's own first look: 180 beams fuse into an
   opaque curtain that hides both shots. Every SIXTH caster draws its throw; the rest
   park zero-length (§V788 — the same collapse the Proximity node uses), so thirty

   bright rays read as rain while every impact still lands. */
const VJ_BEAM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - p.position);
  let near = clamp(1.0 - slant / 4.0, 0.0, 1.0);
  if (ctx.index % 6u != 0u) {
    q.hitPosition = p.position;
    q.tint = vec4f(0.0);
    return q;
  }
  /* T828 — the rain STOPS in the breakdown: value1 (enveloped high) gates the beams
     to zero-length in the quiet bar, the same §V788 park the sparse gate uses. */
  if (ctx.value1 < 0.06) {
    q.hitPosition = p.position;
    q.tint = vec4f(0.0);
    return q;
  }
  q.tint = vec4f(0.55, 0.75, 1.0, 1.0) * (0.30 + 0.85 * near) * clamp(ctx.value1 * 2.0, 0.0, 1.0);
  return q;
}`;

export const pulseDocument = document(
  "e45-pulse",
  "E45 Pulse",
  settings({ randomSeed: 45 }),
  graph(
    [
      // ---- the clock and the drives (T701's rest-subtracted chains) -----------------
      node("beat", "audioPattern", [-2900, 900], { bpm: 122, amount: 1 }, { label: "beat1" }),
      /* T828 (5) — THE CLOCK SEAM: every lane references `clock1`, never `beat1`
         directly, so the whole set's tempo source is ONE node to exchange. A
         `valueSwitch` rather than a bare null because §T825 is the concrete reason it
         exists: a real track publishes no bar/barPhase, so playing to one means an
         audioPattern beside the file at the known BPM (both timeline-anchored) — wire
         that as in2 and flip Index, and the switch is exactly the one-node swap the
         owner asked for. At index 0 it is the pattern, byte-for-byte. */
      node("clock", "valueSwitch", [-2600, 900], { index: 0 }, { label: "clock1" }),
      /* HIGH band: rest 0.3809 out first, then two gains — one for the web's radius,
         one for the glitch. One subtraction, two consumers, so the two cannot disagree
         about what "silence" is. */
      node("hsub", "valueMath", [-2300, 900], { operation: "add", operand: -0.381 }, { label: "hs1" }),
      /* T824's lesson, applied BEFORE it bites here: a raw per-frame band on a visible
         parameter is jitter (E27's owner report, E43's second instance). One §T814
         envelope right after the subtraction — fast attack, slow release — feeds BOTH
         high-band consumers, so the glitch and the web breathe on strikes instead of
         flickering on every analyser frame. */
      node("henv", "valueLag", [-2000, 900], { lag: 0.03, releaseRatio: 10 }, { label: "henv1" }),
      /* T828 round two — THE TEAR IS AN EVENT, NOT A TEXTURE: a threshold before the
         gain means only a strong strike tears at all, and the quiet phrases carry no
         glitch rather than a faint strobe of one. The slam stays a slam (§T749); it
         just stops being ambient. */
      node("gth", "valueMath", [-1400, 820], { operation: "add", operand: -0.03 }, { label: "gth1" }),
      node("hglitch", "valueMath", [-1700, 820], { operation: "multiply", operand: 8 }, { label: "hd1" }),
      node("glim", "valueLimit", [-1100, 820], { minimum: 0, maximum: 1 }, { label: "glim1" }),
      /* T828 — DOWNTIME floor: base radius 0.12 (a trace of a web, not a web) with the
         band's gain raised so full music still reaches ~0.55. Quiet is now a state the
         PICTURE has: in the arrangement's breakdown bar the web thins to filaments. */
      node("hrad", "valueMath", [-1700, 1050], { operation: "multiply", operand: 0.32 }, { label: "hm1" }),
      node("radd", "valueMath", [-1400, 1050], { operation: "add", operand: 0.12 }, { label: "rad1" }),
      /* LOW band → the constellation's breath. Rest 0.7119 (T701), same envelope idiom. */
      node("lsub", "valueMath", [-2300, 1280], { operation: "add", operand: -0.712 }, { label: "ls1" }),
      node("lenv", "valueLag", [-2000, 1280], { lag: 0.05, releaseRatio: 5 }, { label: "lenv1" }),
      node("lbreath", "valueMath", [-1700, 1280], { operation: "multiply", operand: 1.4 }, { label: "ld1" }),
      /* THE STRUCTURE: bar count → a value held four bars → a CUT, mostly. T828: the
         held 0..1 is reshaped (×3, −1, clamp) so the outer thirds land on the POLES —
         a VJ set cuts hard and blends as the exception, and the always-half-blended
         frame was exactly the "busy and unchanging" the owner named. Phrases whose
         pick lands mid-range still blend; that is the exception kept on purpose. */
      node("step", "valueStep", [-2300, 1510], { every: 4, minimum: 0, maximum: 1, seed: 5 }, { label: "step1" }),
      node("smul", "valueMath", [-2000, 1510], { operation: "multiply", operand: 12 }, { label: "sm1" }),
      node("ssub", "valueMath", [-1700, 1510], { operation: "add", operand: -5.5 }, { label: "ss1" }),
      node("slim", "valueLimit", [-1400, 1510], { minimum: 0, maximum: 1 }, { label: "sl1" }),
      node("lag", "valueLag", [-1100, 1510], { lag: 0.4 }, { label: "lag1" }),
      /* T828 addendum — THE COLOUR EVOLVES ON THE SAME STRUCTURE: a second phrase-held
         value (its own seed, so palette and shot select independently) swings the whole
         frame's hue through ±160°. Hue rotation, deliberately NOT a lookup remap:
         §V784's E27 lesson is that scrambling tonal ORDER kills a picture whose depth
         cue is ordering — a hue turn preserves luminance exactly, so the additive glow
         keeps reading while the palette becomes the thing that changes per phrase. The
         snap on the boundary is the point: the cut and the colour land together. */
      node("pstep", "valueStep", [-2300, 1730], { every: 4, minimum: 0, maximum: 1, seed: 9 }, { label: "pstep1" }),
      node("pmul", "valueMath", [-2000, 1730], { operation: "multiply", operand: 320 }, { label: "pm1" }),
      node("padd", "valueMath", [-1700, 1730], { operation: "add", operand: -160 }, { label: "pal1" }),

      // ---- SHOT A: the constellation (Cross 0) --------------------------------------
      node("seedA", "pointSphere", [-2600, -420], { count: 600, radius: 1 }, { label: "seedA1" }),
      node("swarm", "pointKernel", [-2300, -420], {
        capacity: 600, attributes: VJ_SWARM_ATTRIBUTES, kernel: VJ_SWARM_KERNEL,
      }, { label: "swarm1", parameters: { value1: drivenSlot("ld1:low", 0), value2: drivenSlot("henv1:high", 0) } }),
      node("prox", "pointProximity", [-2000, -300], {
        neighbors: 2, falloff: 2,
      }, { label: "prox1", parameters: { radius: drivenSlot("rad1:high", 0.3) } }),
      node("sparkA", "materialUnlit", [-2000, -560], { color: [1, 1, 1, 1] }, { label: "sparkA1" }),
      node("dots", "geometry", [-1700, -480], {
        mode: "instances", shape: "octahedron", scale: 0.018, material: "sparkA1",
      }, {
        label: "dots1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      /* The web: T819's link set through the beam path, tint carrying the node's own
         distance fade — nearer links brighter, absent links zero-length (§V788). */
      node("links", "geometry", [-1700, -240], {
        mode: "beam", endpoint: "tip", scale: 0.003, taper: 0, material: "sparkA1",
      }, {
        label: "links1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      node("orbAx", "lfo", [-2600, -160], { shape: "sine", frequency: 0.013, amplitude: 0.7, offset: 0, phase: 0 }, { label: "orbAx1" }),
      node("orbAz", "lfo", [-2600, 40], { shape: "sine", frequency: 0.013, amplitude: 0.7, offset: 2.9, phase: 0.25 }, { label: "orbAz1" }),
      node("camA", "camera", [-1400, -80], { eye: [0, 0.2, 3.1], lookAt: [0, 0, 0] }, {
        label: "camA1",
        parameters: { "eye.x": drivenSlot("orbAx1", 0), "eye.z": drivenSlot("orbAz1", 2.9) },
      }),
      node("shotA", "render", [-1400, -300], {
        scenes: "dots1 links1", camera: "camA1", lights: "",
      }, { label: "shotA1" }),

      // ---- SHOT B: the scanline (Cross 1) -------------------------------------------
      node("terrainB", "noise", [-2600, 300], {
        type: "perlin4d", seed: 45, period: 0.34, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: false,
        speed: 0.04, t4d: 0.37, s4d: 1,
      }, { label: "terrainB1" }),
      node("fanB", "pointLine", [-2600, 540], { count: 180, sizeX: 3.4 }, { label: "fanB1" }),
      node("aimB", "pointKernel", [-2300, 540], {
        capacity: 180, attributes: VJ_SCAN_ATTRIBUTES, kernel: VJ_SCAN_KERNEL,
      }, { label: "aimB1", parameters: { value1: drivenSlot("clock1:barPhase", 0) } }),
      node("castB", "pointRay", [-2000, 460], {
        steps: 48, maxDistance: 4, direction: [0, -1, 0],
        extent: 2, heightScale: 0.9, heightOffset: -1.2,
      }, { label: "castB1" }),
      node("hitsB", "pointKernel", [-1700, 380], {
        capacity: 180, attributes: VJ_HIT_ATTRIBUTES, kernel: VJ_IMPACT_KERNEL,
      }, { label: "hitsB1", parameters: { value1: drivenSlot("henv1:high", 0) } }),
      node("sightB", "pointKernel", [-1700, 620], {
        capacity: 180, attributes: VJ_HIT_ATTRIBUTES, kernel: VJ_BEAM_KERNEL,
      }, { label: "sightB1", parameters: { value1: drivenSlot("henv1:high", 0) } }),
      node("sparkB", "materialUnlit", [-1700, 180], { color: [1, 1, 1, 1] }, { label: "sparkB1" }),
      node("impactsB", "geometry", [-1400, 380], {
        mode: "instances", shape: "octahedron", scale: 0.05, material: "sparkB1",
      }, {
        label: "impactsB1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      node("raysB", "geometry", [-1400, 620], {
        mode: "beam", endpoint: "hitPosition", scale: 0.008, taper: 0.15, material: "sparkB1",
      }, {
        label: "raysB1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      node("camB", "camera", [-1400, 140], { eye: [0, 1.1, 3.4], lookAt: [0, 0.1, 0] }, { label: "camB1" }),
      node("shotB", "render", [-1100, 460], {
        scenes: "impactsB1 raysB1", camera: "camB1", lights: "",
      }, { label: "shotB1" }),

      // ---- the set: blend, tear, out ------------------------------------------------
      node("mix", "cross", [-800, 60], {}, {
        label: "mix1",
        parameters: { cross: drivenSlot("lag1:bar", 0) },
      }),
      /* T828 addendum: the evolving colour layer — one hue turn per phrase, before the
         tear so the glitch tears the coloured frame. */
      node("paint", "hsv", [-800, 300], { saturation: 1.15, value: 1 }, {
        label: "paint1",
        parameters: { hueoffset: drivenSlot("pal1:bar", 0) },
      }),
      node("splice", "customWgsl", [-500, 300], { source: SPLICE_WGSL }, {
        label: "spliceP1",
        parameters: { amount: drivenSlot("glim1:high", 0) },
      }),
      node("out", "output", [-200, 300], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-clock", ["beat", "out"], ["clock", "in1"]),
      edge("e-clock-hsub", ["clock", "out"], ["hsub", "a"]),
      edge("e-hsub-henv", ["hsub", "out"], ["henv", "in"]),
      edge("e-henv-gth", ["henv", "out"], ["gth", "a"]),
      edge("e-gth-hglitch", ["gth", "out"], ["hglitch", "a"]),
      edge("e-hglitch-glim", ["hglitch", "out"], ["glim", "in"]),
      edge("e-henv-hrad", ["henv", "out"], ["hrad", "a"]),
      edge("e-hrad-radd", ["hrad", "out"], ["radd", "a"]),
      edge("e-clock-lsub", ["clock", "out"], ["lsub", "a"]),
      edge("e-lsub-lenv", ["lsub", "out"], ["lenv", "in"]),
      edge("e-lenv-lbreath", ["lenv", "out"], ["lbreath", "a"]),
      edge("e-clock-step", ["clock", "out"], ["step", "in"]),
      edge("e-step-smul", ["step", "out"], ["smul", "a"]),
      edge("e-smul-ssub", ["smul", "out"], ["ssub", "a"]),
      edge("e-ssub-slim", ["ssub", "out"], ["slim", "in"]),
      edge("e-slim-lag", ["slim", "out"], ["lag", "in"]),
      edge("e-clock-pstep", ["clock", "out"], ["pstep", "in"]),
      edge("e-pstep-pmul", ["pstep", "out"], ["pmul", "a"]),
      edge("e-pmul-padd", ["pmul", "out"], ["padd", "a"]),
      edge("e-seeda-swarm", ["seedA", "out"], ["swarm", "in"]),
      edge("e-swarm-prox", ["swarm", "out"], ["prox", "points"]),
      edge("e-swarm-dots", ["swarm", "out"], ["dots", "points"]),
      edge("e-prox-links", ["prox", "out"], ["links", "points"]),
      edge("e-terrainb-castb", ["terrainB", "out"], ["castB", "field"]),
      edge("e-fanb-aimb", ["fanB", "out"], ["aimB", "in"]),
      edge("e-aimb-castb", ["aimB", "out"], ["castB", "points"]),
      edge("e-castb-hitsb", ["castB", "out"], ["hitsB", "in"]),
      edge("e-castb-sightb", ["castB", "out"], ["sightB", "in"]),
      edge("e-hitsb-impactsb", ["hitsB", "out"], ["impactsB", "points"]),
      edge("e-sightb-raysb", ["sightB", "out"], ["raysB", "points"]),
      edge("e-shota-mix", ["shotA", "out"], ["mix", "in1"]),
      edge("e-shotb-mix", ["shotB", "out"], ["mix", "in2"]),
      edge("e-mix-paint", ["mix", "out"], ["paint", "input"]),
      edge("e-paint-splice", ["paint", "out"], ["splice", "input"]),
      edge("e-splice-out", ["splice", "out"], ["out", "input"]),
    ],
  ),
);
