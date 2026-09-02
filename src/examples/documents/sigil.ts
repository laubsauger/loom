import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E38 — Sigil (T727). A mark assembles itself out of a drifting population, holds, comes
 * apart, and comes back — and it is A PICTURE that decides which motes belong to it.
 *
 *   disc1(circle) ─┐                         cycle1(lfo) ─► shape1(valueMath) ─► hold1(valueLimit)
 *   hole1(circle) ─┴─► ring1(difference) ─┐                                            │ value1
 *   pip1(circle) ─────────────────────────┴─► emblem1(add) ─────────────► gather1(pointKernel)
 *                                                                            ▲ field    │
 *   grid1(pointGrid 384x216) ────────────────────────────────────────────────┘ in       │
 *                                                          ┌───────────────────────────-┘
 *                                       haze1(renderPoints  p.mark <= 0.5) ─┐
 *                                       glyph1(renderPoints p.mark >  0.5) ─┴─► both1(add)
 *   both1 ─┬────────────────────────────► burn1(add) ─► hue1(hsv ┄ drift1) ─► out1
 *          └─► halo1(blur) ─► halolvl1(level) ─┘
 *
 * ## What is new here: an image that decides TARGETS, not tint
 *
 * `textureToAttribute` has carried pictures into point graphs since T124, and E20, E27 and
 * E34 all use one — but always to COLOUR or DISPLACE points that were going to be there
 * anyway. This is the first example where the picture decides WHO BELONGS: `fieldAt` samples
 * the emblem at each mote's own grid cell, and that number scales the spring that gathers
 * it. The mark is drawn OUT OF the population rather than emitted from somewhere else, and
 * the motes it does not claim are the haze around it.
 *
 * ## The picture is built from PRIMITIVES, and that is §V684, not taste
 *
 * The obvious subject for this example is text, and text is unavailable: the harness does
 * not fake the `text` node (§V403 — "black is the honest output of a machine with no font
 * stack"), so a text-bearing document renders BLACK in every offline gate and its §V643
 * baseline would enshrine that black. Two circles differenced into a ring, plus a pip.
 *
 * ## A DISPLACEMENT, not a force — the second build
 *
 * The first version let the spring fall to zero and a wander force accumulate, which does
 * not scatter a glyph, it INFLATES one: members keep their relative positions and drift
 * outward together, so the mark balloons instead of coming apart, and the shared term
 * carries the whole population off the frame edges leaving black corners. The kernel now
 * springs to a BOUNDED target — nothing can leave a ball of SPREAD + CURRENT about its own
 * cell — and the grid runs 2.4 units wide against a 2-unit frame, so there are always motes
 * outside the picture to drift inward and fill its border.
 *
 * ## §V681, twice
 *
 * Both of this file's claims are about time and neither is in a frame. `sigil.gpu.test.ts`
 * asserts that not one slot changes sides across a whole cycle (sampling at the live
 * position instead takes 6528 members to 8302, with 3573 changing hands) and that every
 * member is back on its cell when the plateau comes round (mean |drift| 0.0011 against
 * 0.0962 with the gather removed). The look instrument reads range 0.8953 for the intact
 * file and for BOTH breakages, to four decimal places.
 *
 * ## And §V627, paid rather than discovered
 *
 * This file began with E31's luminance palette on the end of it. At the instrument's
 * 192x108 probe the same points land in 1/44th of the texels, every pixel clears the ramp's
 * last stop, and the measured frame is UNIFORM WHITE — range 0.0000, a straight failure of
 * the contrast floor that reads perfectly well at 1280x720. The layers carry their own
 * colour instead, and the grade is a hue drift that cannot saturate.
 */
/** 384 x 216 cells over a 2.4-unit square — deliberately WIDER than the frame. The mark has to be DENSE enough to read as a drawn shape, not as a
 *  constellation, and that is a point count rather than a size. */
const SIGIL_COLS = 384;

const SIGIL_ROWS = 216;

const SIGIL_POINTS = SIGIL_COLS * SIGIL_ROWS;

const SIGIL_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "drift", type: "vec3f", default: [0, 0, 0] },
  { name: "vel", type: "vec3f", qualifier: "direction", default: [0, 0, 0] },
  { name: "mark", type: "f32", default: [0] },
]);

const SIGIL_KERNEL = `const TAU: f32 = 6.28318530717958647692;

/* The mark's spring, and the damping that lands it. 2*sqrt(GATHER) = 10.2 is critical, so
   10.5 is a hair over — a member arrives at its cell and STOPS, with no ring of overshoot
   travelling back out through the glyph. */
const GATHER: f32 = 26.0;
const DRAG: f32 = 10.5;

/* How far a mote goes when the mark lets go, and how much shared weather rides on top.
   Both are DISPLACEMENTS in clip units, so the scattered state is bounded by their sum. */
const SPREAD: f32 = 0.50;
const CURRENT: f32 = 0.09;

/* Where the picture stops being background. The emblem is drawn with soft edges, so this
   is a THRESHOLD WITH A WIDTH, not a step: a hard cut leaves the glyph's rim aliased into
   the point population itself, which reads as a jagged edge no amount of blur downstream
   can fix. */
const THRESHOLD: f32 = 0.42;
const THRESHOLD_WIDTH: f32 = 0.09;

/* Just over one cell wide, so neighbouring cells' motes interleave. */
const CELL_JITTER: f32 = 0.011;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T401: this is the UPSTREAM GRID's position pair, regenerated every frame, so it is
     this mote's HOME CELL and not its own last frame. drift and vel are not in the grid's
     schema, so they are this node's own state and persist (§V197). */
  let home = p.position;
  let id = ctx.index;

  /* THE PICTURE DECIDES WHO BELONGS, and it is sampled at HOME - not at where the mote
     currently is. That is the whole correctness argument of this file: membership is a
     property of the CELL, so the same motes are the mark's for ever and the glyph that
     re-forms is the glyph that came apart.

     Sample at the live position (home + drift) instead and the mark's population CHANGES
     HANDS: motes that wander in are captured and motes that wander out are dropped.
     Measured on this document - 6528 members become 8302, with 3573 slots changing sides
     across one cycle - while the look instrument's range reads 0.8953 for both, to four
     decimal places. That is §V681 exactly: the damage is in the correspondence and no
     still frame contains it. sigil.gpu.test.ts is what sees it. */
  let picture = fieldAt(home);
  let mark = smoothstep(THRESHOLD - THRESHOLD_WIDTH, THRESHOLD + THRESHOLD_WIDTH, max(picture.r, max(picture.g, picture.b)));
  q.mark = mark;

  /* ASSEMBLY: 0 lets go, 1 holds the mark. It arrives as ctx.value1 - an ordinary DRIVABLE
     parameter on this node (T479) - so the cycle lives in the value graph, where it can be
     seen, retimed and driven by something else, instead of being buried in this text where
     only a recompile could reach it. */
  let assembly = clamp(ctx.value1, 0.0, 1.0);

  var drift = p.drift;
  var vel = p.vel;
  /* ctx.firstRun, not frameIndex == 0 (§V495/T510): a timeline lap KEEPS these buffers and
     the cloud must survive it; a seek and a load clear them and it must not. */
  if (ctx.firstRun == 1u) {
    drift = vec3f(0.0);
    vel = vec3f(0.0);
  }

  /* A FIXED sub-cell offset per mote, and it is not decoration: 320x180 cells land exactly
     four pixels apart on a 1280x720 frame, so without it the assembled mark is a regular
     LATTICE and reads as halftone dither rather than as a drawn shape. Fixed per mote, so
     the stipple is the same every time the glyph re-forms - a jitter re-drawn each frame
     would boil. */
  let jitter = vec3f(pointRand(id, 17u) - 0.5, pointRand(id, 29u) - 0.5, 0.0) * CELL_JITTER;
  let anchor = home + jitter;

  /* WHERE THIS MOTE GOES WHEN THE MARK LETS GO. A bounded DISPLACEMENT, not a force —
     and that distinction is the whole of the second build. A force that accumulates while
     the spring is off does not scatter the glyph, it INFLATES it: members keep their
     relative positions and drift outward together, so the mark balloons instead of coming
     apart, and the shared term carries the whole population off the frame edges leaving
     black corners. Measured, and visible in the frame that made this rewrite necessary.

     A heading that is CONSTANT for this mote and different for every other one, so the
     dispersal reads as a population coming apart rather than as a sheet being blown. */
  let heading = pointRand(id, 5u) * TAU;
  let loose = vec3f(cos(heading), sin(heading), 0.0) * (0.25 + 0.75 * pointRand(id, 9u)) * SPREAD;

  /* One shared, MOVING current on top, so the scattered state has weather in it. It must
     depend on TIME as well as on the cell: a rigid rotation about the origin gives every
     mote an offset that never changes, and the haze reads as frozen grain. ctx.absTime, so
     the current does not restart at a timeline lap (§V436). */
  let t = ctx.absTime;
  let current = vec3f(
    sin(home.y * 2.70 + t * 0.50) - 0.40 * sin(home.x * 1.90 - t * 0.37),
    sin(home.x * 2.30 - t * 0.44) + 0.40 * sin(home.y * 2.10 + t * 0.31),
    0.0
  ) * CURRENT;

  /* THE MECHANISM, in one line: a mote's target is its own cell to the extent that the
     PICTURE claims it and the cycle is holding, and its scattered place otherwise. The
     mark is therefore drawn OUT OF the population rather than emitted from somewhere
     else, and it is bounded by construction — nothing here can leave a ball of radius
     SPREAD + CURRENT around its own cell, whatever the cycle does. */
  /* Named rest and not target: target is a RESERVED KEYWORD in WGSL, and Dawn refuses
     the whole module by name for it. */
  let rest = (loose + current) * (1.0 - mark * assembly);

  vel = vel + ((rest - drift) * GATHER - vel * DRAG) * ctx.delta;
  drift = drift + vel * ctx.delta;

  q.drift = drift;
  q.vel = vel;
  q.position = anchor + drift;
  return q;
}`;

export const sigilDocument = document(
  "e38-sigil",
  "E38 Sigil",
  settings({ randomSeed: 38 }),
  graph(
    [
      // ---- THE PICTURE, from primitives (§V684: `text` renders black offline) ---------
      node("disc", "circle", [-1720, -260], {
        mode: "fill", center: [0.5, 0.5], radius: [0.3, 0.3], softness: 0.035,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "disc1" }),
      node("hole", "circle", [-1720, -60], {
        mode: "fill", center: [0.5, 0.5], radius: [0.185, 0.185], softness: 0.035,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "hole1" }),
      node("ring", "difference", [-1420, -160], { opacity: 1 }, { label: "ring1" }),
      node("pip", "circle", [-1720, 140], {
        mode: "fill", center: [0.5, 0.5], radius: [0.072, 0.072], softness: 0.03,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "pip1" }),
      node("emblem", "add", [-1120, -60], { opacity: 1 }, { label: "emblem1" }),

      // ---- the cycle: one job per node ----------------------------------------------
      node("cycle", "lfo", [-1720, 420], { shape: "sine", frequency: 0.08, amplitude: 0.5, offset: 0.5, phase: 0.306 }, { label: "cycle1" }),
      /* A sine spends almost no time at its extremes, so on its own the glyph would never
         HOLD - it would pass through legible on its way somewhere. Gain then clamp is the
         standard shape for that: 2.1x flattens the top and the bottom into real dwells. */
      node("shape", "valueMath", [-1420, 420], { operation: "multiply", operand: 1.6 }, { label: "shape1" }),
      node("hold", "valueLimit", [-1120, 420], { minimum: 0, maximum: 1 }, { label: "hold1" }),

      // ---- the population -------------------------------------------------------------
      node("grid", "pointGrid", [-1420, 180], { cols: SIGIL_COLS, rows: SIGIL_ROWS, count: SIGIL_POINTS, sizeX: 2.4, sizeY: 2.4 }, { label: "grid1" }),
      node("gather", "pointKernel", [-820, 60], {
        capacity: SIGIL_POINTS, seed: 38, group: "",
        attributes: SIGIL_ATTRIBUTES, kernel: SIGIL_KERNEL,
        value2: 0, value3: 0, value4: 0,
      }, { label: "gather1", parameters: { value1: drivenSlot("hold1", 1) } }),

      // ---- ONE cloud, TWO readings (§V471.1) -------------------------------------------
      node("haze", "renderPoints", [-500, 240], {
        count: SIGIL_POINTS, blend: "additive", accumulate: false,
        color: [0.22, 0.38, 0.86, 1], sizePixels: 1.2,
        group: "p.mark <= 0.5",
      }, { label: "haze1" }),
      node("glyph", "renderPoints", [-500, -60], {
        count: SIGIL_POINTS, blend: "additive", accumulate: false,
        color: [1, 0.74, 0.40, 1], sizePixels: 1.7,
        group: "p.mark > 0.5",
      }, { label: "glyph1" }),
      node("both", "add", [-180, 60], { opacity: 1 }, { label: "both1" }),

      // ---- the post, one job per stage --------------------------------------------------
      node("halo", "blur", [140, 260], { size: 26, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haloLvl", "level", [460, 260], {
        blacklevel: 0.03, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1, brightness: 0.9,
      }, { label: "halolvl1" }),
      node("burn", "add", [780, 60], { opacity: 1 }, { label: "burn1" }),
      node("drift", "lfo", [780, 320], { shape: "sine", frequency: 0.041, amplitude: 18, offset: 0, phase: 0 }, { label: "drift1" }),
      node("hue", "hsv", [1100, 60], { saturation: 1.08, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      node("out", "output", [1420, 60], {}, { label: "out1" }),
    ],
    [
      edge("e-disc-ring", ["disc", "out"], ["ring", "in1"]),
      edge("e-hole-ring", ["hole", "out"], ["ring", "in2"]),
      edge("e-ring-emblem", ["ring", "out"], ["emblem", "in1"]),
      edge("e-pip-emblem", ["pip", "out"], ["emblem", "in2"], 0),
      edge("e-cycle-shape", ["cycle", "out"], ["shape", "a"]),
      edge("e-shape-hold", ["shape", "out"], ["hold", "in"]),
      edge("e-grid-gather", ["grid", "out"], ["gather", "in"]),
      edge("e-emblem-gather", ["emblem", "out"], ["gather", "field"]),
      edge("e-gather-haze", ["gather", "out"], ["haze", "points"]),
      edge("e-gather-glyph", ["gather", "out"], ["glyph", "points"]),
      edge("e-haze-both", ["haze", "out"], ["both", "in1"]),
      edge("e-glyph-both", ["glyph", "out"], ["both", "in2"], 0),
      edge("e-both-halo", ["both", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-both-burn", ["both", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),
      edge("e-burn-hue", ["burn", "out"], ["hue", "input"]),
      edge("e-hue-out", ["hue", "out"], ["out", "input"]),
    ],
  ),
);
