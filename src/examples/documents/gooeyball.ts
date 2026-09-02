import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E20 — Gooeyball (T417). The owner's ask, in their words: a ball "deformed from the
 * inside without breaking the surface". The 2D→3D crossing made literal: an animated
 * 2D noise becomes a per-point attribute (textureToAttribute), a T401 processor pushes
 * every point along the surface NORMAL by that sample, and a `geometry` object in
 * SURFACE mode — its material named by reference, drawn by `render` (T446/T447) — shades
 * the grid as a closed ball whose seam the wrap flag heals. (The legacy `renderSurface`
 * node still exists and still builds the same surface; this example went through the
 * scene pipeline when the ports→references redirect landed, and B83 is the doc that kept
 * naming the node it no longer uses.)
 *
 * WHY THE SURFACE SURVIVES — the doc's teaching, stated here for the tests:
 *  - displacement is ALONG THE NORMAL, and on a sphere the normal is free:
 *    normalize(position) IS the outward normal, no neighbours needed. A radial push
 *    moves a point toward or away from the centre and never sideways past its grid
 *    neighbours, so cells stretch but never fold or self-intersect.
 *  - the noise is CONTINUOUS in uv and in time, so neighbouring points sample nearly
 *    the same displacement and the surface stays a surface — white noise here would
 *    shred the ball into spikes.
 *  - the seam is a TOPOLOGY claim, not geometry: the ball kernel maps u = i/COLS so
 *    column 0 and a hypothetical column COLS coincide, and `pointTopology`'s wrapU adds
 *    the seam CELL that stitches the last column to the first (T302). Remove the wrap
 *    and the ball shows a slit; the points never move. Note the divisor is the KERNEL
 *    AUTHOR's — `ctx.dim` hands over cols and rows, never a normalised u, because the
 *    right divisor here (COLS, targeting a claim made DOWNSTREAM) is not the one the
 *    incoming edge's own unwrapped flags would imply (T472).
 *
 * The chain is FIVE point nodes — grid → ball → sample → goo → claim → body — and
 * every link is T401's processor mechanism or an edge-payload edit. `sample` is
 * authored by the bridge and read by `goo` as an upstream-bound attribute; topology
 * flows generator → kernels → claim by passthrough — and now flows INTO the ball kernel
 * too, as `ctx.dim` (T472, B85: the 64 that used to be typed into the WGSL).
 */
const GOOEY_COLS = 64;

const GOOEY_ROWS = 64;

const GOOEY_BALL_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The grid is an INDEX SHEET; the sphere comes from the index, not the plane.
     ctx.dim IS the sheet (T472): cols, rows and this slot's cell, read off the topology
     the grid publishes on the edge — turn grid1's Columns knob and this follows, which
     is exactly what a hard-coded 64u could not do (B85).
     u runs i/COLS (not cols-1): column 0 and "column COLS" coincide, which is what the
     wrapU seam cell downstream stitches together. v runs pole to pole. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let theta = u * 6.28318530718;
  let phi = v * 3.14159265359;
  q.position = 0.85 * vec3f(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
  return q;
}`;

const GOOEY_GOO_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* ALONG THE NORMAL, and on a sphere the normal is free: normalize(position) is the
     outward direction, no neighbour reads. Radial pushes stretch cells but never fold
     them — that is why the ball deforms from inside and never tears. */
  let normal = normalize(p.position);
  /* p.sample is the bridge's pair, upstream-bound (T401): the noise value sampled at
     THIS point's sphere position, fresh every frame. Centred so the ball breathes both
     inward and outward around its rest radius. */
  let amount = (p.sample.r - 0.5) * 0.5;
  q.position = p.position + normal * amount;
  q.sample = p.sample;
  return q;
}`;

export const gooeyballDocument = document(
  "e20-gooeyball",
  "E20 Gooeyball",
  settings({ randomSeed: 37 }),
  graph(
    [
      node(
        "wobble",
        "noise",
        [-1480, -220],
        {
          type: "perlin4d",
          period: 0.45,
          harmon: 3,
          spread: 2,
          gain: 0.5,
          rough: 0.5,
          exp: 1,
          amp: 1,
          offset: 0,
          mono: true,
          aspectcorrect: true,
          seed: 37,
          s4d: 1,
          t4d: 0.37, // T535: off the lattice plane — see E2's note
          /* Animated, and a 4D type so `speed` actually does something (B14): the goo
             crawls over the ball instead of freezing into one dent. */
          speed: 0.3,
        },
        { label: "noise1" },
      ),
      node("sheet", "pointGrid", [-1480, 0], { cols: GOOEY_COLS, rows: GOOEY_ROWS }, { label: "grid1" }),
      node(
        "ball",
        "pointKernel",
        [-1180, 0],
        {
          capacity: GOOEY_COLS * GOOEY_ROWS,
          seed: 37,
          attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
          kernel: GOOEY_BALL_KERNEL,
        },
        { label: "ball1" },
      ),
      node("bridge", "textureToAttribute", [-880, 0], { count: GOOEY_COLS * GOOEY_ROWS }, { label: "sample1" }),
      node(
        "goo",
        "pointKernel",
        [-580, 0],
        {
          capacity: GOOEY_COLS * GOOEY_ROWS,
          seed: 37,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
          ]),
          kernel: GOOEY_GOO_KERNEL,
        },
        { label: "goo1" },
      ),
      node(
        "claim",
        "pointTopology",
        [-280, 0],
        { connectivity: "grid", cols: GOOEY_COLS, rows: GOOEY_ROWS, wrapU: true, wrapV: false },
        { label: "topology1" },
      ),
      /*
       * T429: the SKIN. The owner's complaint — "lame and kinda single colored" — and
       * its fix in one clause: the SAME noise that displaces the ball also paints it.
       * The field goes through a palette (lookup) into the material's ALBEDO map, and
       * raw into its ROUGHNESS map, so bulges are coloured differently from hollows
       * and shine differently too. One field, three uses.
       */
      node("palette", "ramp", [-880, -420], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.12, 0.07, 0.25, 1] },
          { position: 0.4, color: [0.5, 0.12, 0.38, 1] },
          { position: 0.7, color: [0.95, 0.45, 0.2, 1] },
          { position: 1, color: [1, 0.9, 0.6, 1] },
        ],
      }, { label: "goopalette1", definitionVersion: 2 }),
      node("paint", "lookup", [-580, -420], { channel: "red", row: 0.5, scale: 1, offset: 0 }, { label: "paint1" }),
      node("gooskin", "materialPhong", [-280, -420], {
        color: [1, 1, 1, 1], specular: [1, 0.9, 0.7, 1], shininess: 64, roughness: 0.45,
      }, { label: "gooskin1" }),
      node("body", "geometry", [20, -200], { mode: "surface", material: "gooskin1" }, { label: "body1" }),
      node("cam", "camera", [20, -420], { eye: [0, 0.5, 2.6], lookAt: [0, 0, 0], fov: 55 }, { label: "cam1" }),
      /*
       * TWO lights, one of them MOVING — the first shipped example with an animated
       * light: the warm key holds still, the cool fill ORBITS (its x/z driven by two
       * LFOs in quadrature), and because a light is VALUES, the orbit never rebuilds
       * anything (§V5).
       */
      node("key", "light", [340, -580], {
        kind: "directional", color: [1, 0.9, 0.75, 1], intensity: 0.9, direction: [-0.5, -0.7, -0.5],
      }, { label: "key1" }),
      node("orbitx", "lfo", [340, -760], { shape: "sine", frequency: 0.11, amplitude: 2.2, offset: 0, phase: 0 }, { label: "orbitx1" }),
      node("orbitz", "lfo", [340, -940], { shape: "sine", frequency: 0.11, amplitude: 2.2, offset: 0, phase: 0.25 }, { label: "orbitz1" }),
      node("fill", "light", [340, -400], {
        kind: "point", color: [0.35, 0.65, 1, 1], intensity: 1.6,
      }, {
        label: "fill1",
        parameters: {
          "position.x": drivenSlot("orbitx1", 2),
          "position.y": 0.8,
          "position.z": drivenSlot("orbitz1", 0.5),
        },
      }),
      node("skin", "render", [340, -200], {
        scenes: "body1", camera: "cam1", lights: "key1 fill1",
        ambientColor: [0.4, 0.45, 0.6, 1], ambientIntensity: 0.22,
      }, { label: "shot1" }),
      node("out", "output", [620, -200], {}, { label: "out1" }),
    ],
    [
      edge("e-sheet-ball", ["sheet", "out"], ["ball", "in"]),
      edge("e-ball-bridge", ["ball", "out"], ["bridge", "points"]),
      edge("e-wobble-bridge", ["wobble", "out"], ["bridge", "texture"]),
      edge("e-bridge-goo", ["bridge", "out"], ["goo", "in"]),
      edge("e-goo-claim", ["goo", "out"], ["claim", "points"]),
      edge("e-claim-body", ["claim", "out"], ["body", "points"]),
      edge("e-wobble-paint", ["wobble", "out"], ["paint", "source"]),
      edge("e-palette-paint", ["palette", "out"], ["paint", "lookup"]),
      edge("e-paint-albedo", ["paint", "out"], ["gooskin", "albedo"]),
      edge("e-wobble-rough", ["wobble", "out"], ["gooskin", "roughness"]),
      edge("e-skin-out", ["skin", "out"], ["out", "input"]),
    ],
  ),
);
