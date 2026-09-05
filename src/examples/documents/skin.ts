import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E63 — Skin (T1169). THE CONNECTIVITY CLAIM, PUT ON SCREEN THREE TIMES.
 *
 *   field1(noise) ─► hide1(pointsFromTexture) ─┬─► standA(pointKernel) ─► dots1(geometry: points)
 *                                              ├─► standB(pointKernel) ─► open1(geometry: surface)
 *                                              └─► standC(pointKernel) ─► seam1(pointTopology) ─► closed1(geometry: surface)
 *
 * ## Why this file exists at all
 *
 * The owner asked for a SKIN operator — "still missing skin and extrude point operators
 * to actually get from a texture to a surface" — and skin already shipped. `pointTopology`
 * authors the connectivity claim on a pointset edge, and `geometry` in `mode: "surface"`
 * spans whatever grid the edge claims. Texture to surface has worked since T302.
 *
 * The census says why he could not find it: surface mode appears in SEVEN examples and
 * `pointTopology` in exactly ONE (E20 Gooeyball, where it is one node in a five-node point
 * chain about deformation). The piece that makes the chain legible was demonstrated once,
 * so the man who commissioned the project asked for a node he already owns. This file is
 * the answer, and its subject is therefore the CLAIM, not the picture.
 *
 * ## The three panels are one pointset and three claims
 *
 * `hide1` reads the noise on a 96x96 lattice — one point per cell, its brightness pushing
 * it out of the plane — and that ONE pointset feeds three kernels that differ only in
 * where they stand. Each kernel rolls the sheet into a tube: `u` runs the circumference,
 * `v` runs the height, and the sampled height becomes RADIUS. Identical geometry three
 * times over. What differs is what each consumer is told about it:
 *
 *   LEFT     `mode: "points"` — the claim is ignored. Every point is a camera-facing
 *            billboard, and you can see the far wall of the tube through the near one,
 *            because nothing spans anything.
 *   CENTRE   `mode: "surface"` on the grid the GENERATOR published. `pointsFromTexture`
 *            emits one point per lattice cell, so it already knows the adjacency and says
 *            so on the edge — a surface here needs no extra node at all. The seam is open:
 *            the tube is a rolled sheet with two free edges, and the gap between column 95
 *            and column 0 shows straight through to the inside — 997 pixels of backdrop,
 *            in an eight-pixel band, measured.
 *   RIGHT    the same points through `seam1`, one `pointTopology` node whose only job is
 *            `wrapU: true`. That adds the SEAM CELL — the quads spanning column 95 back to
 *            column 0 — and the sheet becomes a closed tube. The points never move; only
 *            the claim changes.
 *
 * The reading left to right is the whole lesson: a pointset carries a grid, declaring it
 * is what turns dots into a surface, and closing the seam is a choice somebody makes.
 *
 * ## Where the topology node is, and where it deliberately is not
 *
 * `standB` goes STRAIGHT into `open1`. Putting a redundant `pointTopology` there — grid,
 * wrapU false, exactly what the edge already says — would have made the two surface panels
 * differ by one flag and read tidier, and it would have taught the wrong thing: that a
 * surface needs a claim node. It does not. The lattice is free from any generator that
 * emits one point per cell; the SEAM is the part you have to author, and the graph should
 * say which is which (§V146 in spirit — a node that changes nothing is a knob that does
 * nothing wearing a bigger hat).
 *
 * ## The surface is honest here because the field is smooth
 *
 * E27 Relief argues the other side of this: it draws its heightfield as POINTS, because a
 * displaced surface is brutally sensitive to the ratio between mesh and field — coarser
 * and a narrow feature falls between two vertices and spikes, finer and every vertex in a
 * texel shares a height and the surface steps. Both failures are real and neither happens
 * here, for one reason: the field is band-limited noise whose features are many cells
 * wide, so neighbouring points sample nearly the same height and the skin stays a skin.
 * A `checker` in `field1` would shred it, and that is not a bug in surface mode.
 *
 * ## Motion
 *
 * Two lanes, both structural. The noise is 4D and moving, so the relief crawls under the
 * skin — the tubes are never the same shape twice. And the rim light's DIRECTION turns
 * (two LFOs in quadrature on `rim1`), which is what makes a relief read as relief: a
 * raking light is the only thing that shows a bump. It is directional rather than a point
 * light on purpose, so all three panels are lit identically and the comparison is not
 * contaminated by which tube is nearer the lamp.
 */

/** Around the tube, and the number is chosen FOR THE SEAM: one missing cell in 96 is a gap
 *  about eight pixels wide through the centre panel at 1280, and one missing cell in 256 is
 *  not a gap anybody sees. The lattice is sized so the thing this file is about is visible. */
const SKIN_COLS = 96;

/** Up the tube. Roughly square cells at this radius and height. */
const SKIN_ROWS = 96;

/**
 * One kernel, three nodes. The sheet `pointsFromTexture` laid out flat is rolled into a
 * tube: the lattice INDEX decides where a point goes and the sampled height decides how
 * far out it sits. `offsetX` is the only field that differs between the three copies.
 *
 * `u` runs i/COLS rather than i/(COLS-1) — column 0 and a hypothetical column COLS
 * coincide, which is exactly the adjacency `wrapU`'s seam cell asserts downstream. `v`
 * runs edge to edge on (ROWS-1) because the tube is NOT closed along its axis: the top and
 * bottom rims are free edges and are meant to be.
 */
const SKIN_TUBE_KERNEL = `struct Params {
  offsetX: f32,   // where this copy of the tube stands, in world x
  radius: f32,    // rest radius, before the relief
  height: f32,    // rim to rim
  relief: f32,    // how far the sampled height pushes the skin out
  turn: f32,      // bearing of column 0, degrees — the seam faces the camera at 0
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* ctx.dim IS the incoming edge's grid (T472): cols, rows and this slot's cell, read off
     the topology pointsFromTexture published. Turn the Columns knob upstream and this
     follows, which a hard-coded 96u could not do. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let theta = (u + ctx.params.turn / 360.0) * 6.28318530718;
  /* The height sampled from the texture arrives on z (pointsFromTexture grid mode centres
     it on zero), and here it is RADIUS: the picture pushes the skin out of the tube. */
  let r = ctx.params.radius + p.position.z * ctx.params.relief;
  q.position = vec3f(
    ctx.params.offsetX + r * sin(theta),
    (0.5 - v) * ctx.params.height,
    r * cos(theta),
  );
  return q;
}`;

/** Shared by all three stands, so the only difference between them is where they are. */
const TUBE = { radius: 0.5, height: 2.35, relief: 0.62, turn: 0 } as const;

const STAND_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);

export const skinDocument = document(
  "e63-skin",
  "E63 Skin",
  settings({ randomSeed: 63 }),
  graph(
    [
      /* The field. 4D so `speed` moves it (B14), and low-harmonic so the features are many
         lattice cells wide — see the docblock on why that is the surface's precondition. */
      node(
        "field",
        "noise",
        [-2020, 0],
        {
          type: "perlin4d",
          period: 0.24,
          harmon: 3,
          spread: 2.1,
          gain: 0.55,
          rough: 0.5,
          exp: 1.4,
          amp: 1,
          offset: 0.05,
          mono: true,
          aspectcorrect: true,
          seed: 63,
          s4d: 1,
          t4d: 0.63,
          speed: 0.22,
        },
        { label: "field1" },
      ),
      /* §T1169's ONE REAL TRAP, and it is a property of the DATA, not of the node.
         `wrapU` asserts that column 95 is adjacent to column 0; it does not make the field
         periodic. Reading a plain noise on a flat lattice puts two unrelated heights at
         those two columns, so the seam cell bridges a cliff and renders as a dark crevice
         that looks exactly like the hole it was supposed to close. Folding the field about
         its own centre makes u = 0 and u = 1 read the SAME texel, so the two edges agree
         and the seam closes invisibly. One node, and the symmetry it puts in the backdrop
         is the picture telling you it is there. */
      node("fold", "mirror", [-1720, 0], {
        mirrorx: true, mirrory: false, pivot: [0.5, 0.5], keephigh: false, rotate: 0, extend: "hold",
      }, { label: "fold1" }),
      /* One point per lattice cell, and the reason the whole chain works: the generator
         KNOWS the adjacency, so it publishes `grid:96x96` on the edge. Threshold 0 because
         an opaque field parks nothing. */
      node(
        "hide",
        "pointsFromTexture",
        [-1420, 0],
        { mode: "grid", cols: SKIN_COLS, rows: SKIN_ROWS, sizeX: 2, sizeY: 2, depth: 1, threshold: 0 },
        { label: "hide1" },
      ),

      node(
        "standA",
        "pointKernel",
        [-1120, -320],
        {
          capacity: SKIN_COLS * SKIN_ROWS,
          seed: 63,
          attributes: STAND_ATTRIBUTES,
          kernel: SKIN_TUBE_KERNEL,
          offsetX: -1.42,
          ...TUBE,
        },
        { label: "standA1" },
      ),
      node(
        "standB",
        "pointKernel",
        [-1120, 0],
        {
          capacity: SKIN_COLS * SKIN_ROWS,
          seed: 63,
          attributes: STAND_ATTRIBUTES,
          kernel: SKIN_TUBE_KERNEL,
          offsetX: 0,
          ...TUBE,
        },
        { label: "standB1" },
      ),
      node(
        "standC",
        "pointKernel",
        [-1120, 320],
        {
          capacity: SKIN_COLS * SKIN_ROWS,
          seed: 63,
          attributes: STAND_ATTRIBUTES,
          kernel: SKIN_TUBE_KERNEL,
          offsetX: 1.42,
          ...TUBE,
        },
        { label: "standC1" },
      ),

      /* THE NODE THE OWNER WENT LOOKING FOR. It writes nothing, owns no buffer and emits no
         pass: it republishes standC's pairs with one flag changed, and the seam cell that
         flag asserts is the difference between the centre panel and the right one. */
      node(
        "seam",
        "pointTopology",
        [-820, 320],
        { connectivity: "grid", cols: SKIN_COLS, rows: SKIN_ROWS, wrapU: true, wrapV: false },
        { label: "seam1" },
      ),

      /* One material for all three draws, so nothing but the claim differs. No texture maps
         on it, deliberately: a points draw has no uv and would refuse one (§V288). */
      node(
        "hidemat",
        "materialPhong",
        [-820, -520],
        { color: [0.52, 0.4, 0.35, 1], specular: [1, 0.82, 0.6, 1], shininess: 30, roughness: 0.65 },
        { label: "hidemat1" },
      ),

      node("dots", "geometry", [-520, -320], {
        mode: "points", material: "hidemat1", scale: 0.008, soft: 0, spherical: true, blend: "opaque",
      }, { label: "dots1" }),
      node("open", "geometry", [-520, 0], { mode: "surface", material: "hidemat1" }, { label: "open1" }),
      node("closed", "geometry", [-520, 320], { mode: "surface", material: "hidemat1" }, { label: "closed1" }),

      node("cam", "camera", [-520, -700], { eye: [0, 0.32, 4.1], lookAt: [0, 0.01, 0], fov: 46 }, { label: "cam1" }),
      /* Warm key, held still. */
      node("key", "light", [-220, -700], {
        kind: "directional", color: [1, 0.72, 0.42, 1], intensity: 1.0, direction: [-0.45, -0.5, -0.72],
      }, { label: "key1" }),
      /* The RAKE, and it turns. A relief is invisible under a light that faces it, so the
         two LFOs in quadrature swing the rim around the tubes and every bump takes its turn
         being edge-lit. `rakez` carries an OFFSET as well as an amplitude, which keeps z in
         [-0.2, 0.9]: the light orbits but stays mostly BEHIND, so it rakes rather than
         flooding the fronts. Directional, so all three panels get exactly the same light and
         the comparison is not contaminated by which tube is nearer a lamp. */
      node("rakex", "lfo", [-220, -1060], { shape: "sine", frequency: 0.07, amplitude: 0.95, offset: 0, phase: 0 }, { label: "rakex1" }),
      node("rakez", "lfo", [-220, -880], { shape: "sine", frequency: 0.07, amplitude: 0.55, offset: 0.35, phase: 0.25 }, { label: "rakez1" }),
      node("rim", "light", [-220, -520], {
        kind: "directional", color: [0.22, 0.55, 1, 1], intensity: 1.1,
      }, {
        label: "rim1",
        parameters: {
          "direction.x": drivenSlot("rakex1", 0.38),
          "direction.y": -0.2,
          "direction.z": drivenSlot("rakez1", 0.45),
        },
      }),

      /* AMBIENT OCCLUSION WAS TRIED AND REFUSED, and the numbers are the reason (§V146):
         at radius 0.22 it changed 1.02 % of the pixels by AT MOST ONE DISPLAY STEP — a
         tube is convex and has no crease deep enough for it to find — and cost 0.39 ms of
         2.52 at 720p and about 1.4 ms at 1080p. MSAA stays: the seam is eight pixels wide
         and it is the subject. */
      node("shot", "render", [-220, 0], {
        scenes: "dots1 open1 closed1", camera: "cam1", lights: "key1 rim1",
        ambientColor: [0.38, 0.46, 0.68, 1], ambientIntensity: 0.055,
        background: [0, 0, 0, 0], antialias: "msaa",
      }, { label: "shot1" }),

      /* The source, behind everything: the reader sees the FIELD and the three things made
         of it in one frame, and can trace a bright patch of the backdrop onto a bulge in
         the skin. It is dimmed by the PALETTE — every stop is dark — rather than by a
         Level, so there is no multiplier here whose value could be inherited from another
         file and quietly zero the plate (§V920). */
      node("swatch", "ramp", [-820, 700], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.02, 0.028, 0.06, 1] },
          { position: 0.5, color: [0.055, 0.08, 0.155, 1] },
          { position: 0.82, color: [0.2, 0.17, 0.23, 1] },
          { position: 1, color: [0.44, 0.31, 0.24, 1] },
        ],
      }, { label: "swatch1", definitionVersion: 2 }),
      node("bed", "lookup", [-520, 700], { channel: "red", row: 0.5, scale: 1, offset: 0 }, { label: "bed1" }),
      node("plate", "over", [80, 0], {}, { label: "plate1" }),
      node("out", "output", [380, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-field-fold", ["field", "out"], ["fold", "input"]),
      edge("e-fold-hide", ["fold", "out"], ["hide", "texture"]),
      edge("e-hide-a", ["hide", "out"], ["standA", "in"]),
      edge("e-hide-b", ["hide", "out"], ["standB", "in"]),
      edge("e-hide-c", ["hide", "out"], ["standC", "in"]),
      edge("e-a-dots", ["standA", "out"], ["dots", "points"]),
      edge("e-b-open", ["standB", "out"], ["open", "points"]),
      edge("e-c-seam", ["standC", "out"], ["seam", "points"]),
      edge("e-seam-closed", ["seam", "out"], ["closed", "points"]),
      edge("e-shot-plate", ["shot", "out"], ["plate", "in1"]),
      edge("e-fold-bed", ["fold", "out"], ["bed", "source"]),
      edge("e-swatch-bed", ["swatch", "out"], ["bed", "lookup"]),
      edge("e-bed-plate", ["bed", "out"], ["plate", "in2"], 0),
      edge("e-plate-out", ["plate", "out"], ["out", "input"]),
    ],
  ),
);
