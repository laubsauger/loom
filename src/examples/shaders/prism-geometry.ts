/**
 * T937/T928 — ONE description of the prism's solid (§V818).
 *
 * The mesh (`form1`, prism.ts) and the traced SDF (`optics1`, prism-trace.wgsl.ts) are
 * two renderings of the SAME shape. T937 made that an exact identity for the ROUNDED
 * body; T928 re-cut it as DIAMOND FACETS — the owner: "a chamfer reads as cut glass; a
 * fillet reads as soft plastic" — and the identity survives because both cuts are pure
 * half-plane constructions:
 *
 *   sd2(p)  = max over 3 FACE planes (N_k at RI) and 3 CORNER chamfer planes
 *             (−N_k at 2·RI − RHO): a hexagon. Inside exact; outside a safe
 *             underestimate near vertices (the T920 march precedent).
 *   sd3(p)  = max( sd2, |z| − HALF, (sd2 + |z| − HALF + EDGE) / √2 ): the extrusion
 *             with a 45° cap-edge chamfer of depth EDGE.
 *
 * Flat planes mean FLAT gradient normals with sharp creases — each facet catches the
 * environment's lamp spot (T945a) as a glint instead of smearing it, which is the whole
 * reason the cut changed. prism-geometry.test.ts walks the mesh generator in float64
 * and requires |sd3| < 1e-6 at every vertex: change either half without the other and
 * that gate refuses.
 */

/** Circumradius of the sharp triangle the contour walks. Inradius RI = RC / 2. */
export const PRISM_RC = 0.76;
export const PRISM_RI = PRISM_RC / 2;
/** Depth of the corner chamfer cut, along the vertex direction. */
export const PRISM_RHO = 0.046;
/** Half-depth of the extrusion (T928: deepened from 0.55). */
export const PRISM_HALF = 0.72;
/** Depth of the 45° cap-edge chamfer. */
export const PRISM_EDGE = 0.12;

const NORMALS: ReadonlyArray<readonly [number, number]> = [
  [Math.sqrt(3) / 2, 0.5],
  [-Math.sqrt(3) / 2, 0.5],
  [0, -1],
];

/** Float64 signed distance to the FACETED cross-section (mirror of the WGSL sd2). */
export function sd2(x: number, y: number): number {
  let d = -Infinity;
  for (const [nx, ny] of NORMALS) {
    d = Math.max(d, x * nx + y * ny - PRISM_RI);
    d = Math.max(d, -(x * nx + y * ny) - (PRISM_RC - PRISM_RHO));
  }
  return d;
}

/** Float64 signed distance to the full chamfered solid (mirror of the WGSL sd3). */
export function sd3(x: number, y: number, z: number): number {
  const flat = sd2(x, y);
  const cap = Math.abs(z) - PRISM_HALF;
  const chamfer = (flat + Math.abs(z) - PRISM_HALF + PRISM_EDGE) / Math.SQRT2;
  return Math.max(flat, cap, chamfer);
}

/** Intersection of two contour planes n·p = o. */
function meet(
  n1: readonly [number, number],
  o1: number,
  n2: readonly [number, number],
  o2: number,
): [number, number] {
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  return [(o1 * n2[1] - o2 * n1[1]) / det, (n1[0] * o2 - n2[0] * o1) / det];
}

/**
 * The INSET faceted contour — the level set sd2 = −pull, walked by arc length: a
 * hexagon of 3 long faces and 3 corner chamfers, all planes inset together (the inset
 * of a convex polygon). Returns the point at fraction u ∈ [0,1) around.
 */
export function insetContour(u: number, pull: number): [number, number] {
  const face = PRISM_RI - pull;
  const cut = PRISM_RC - PRISM_RHO - pull;
  // Walking order: face k, then the corner between face k and face k+1. The corner
  // chamfer plane between them is the one OPPOSITE face k+2: normal −N_{k+2}.
  const verts: Array<[number, number]> = [];
  for (let k = 0; k < 3; k += 1) {
    const nA = NORMALS[k]!;
    const nB = NORMALS[(k + 1) % 3]!;
    const nC: readonly [number, number] = [-NORMALS[(k + 2) % 3]![0], -NORMALS[(k + 2) % 3]![1]];
    /* The chamfer plane cuts this corner only while pull < RHO — the faces inset FASTER
       than the cut (their spacing shrinks 2:1 against it), so past that the hexagon
       degenerates to the sharp triangle and both chamfer vertices collapse onto the
       sharp vertex; without the collapse the meet() pair inverts and the walk leaves
       the surface (measured: 0.0487 off at the cap rim). The SDF needs no such case —
       max() degenerates by itself. */
    const sharp = meet(nA, face, nB, face);
    if (sharp[0] * nC[0] + sharp[1] * nC[1] > cut) {
      verts.push(meet(nA, face, nC, cut));
      verts.push(meet(nC, cut, nB, face));
    } else {
      verts.push(sharp);
      verts.push(sharp);
    }
  }
  const lengths = verts.map((v, i) => {
    const w = verts[(i + 1) % 6]!;
    return Math.hypot(w[0] - v[0], w[1] - v[1]);
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  let s = (u - Math.floor(u)) * total;
  for (let i = 0; i < 6; i += 1) {
    if (s <= lengths[i]! || i === 5) {
      const v = verts[i]!;
      const w = verts[(i + 1) % 6]!;
      const f = lengths[i]! > 0 ? Math.min(s / lengths[i]!, 1) : 0;
      return [v[0] + (w[0] - v[0]) * f, v[1] + (w[1] - v[1]) * f];
    }
    s -= lengths[i]!;
  }
  return verts[0]!;
}

/**
 * The mesh walk, float64 (mirror of PRISM_FORM_KERNEL): position on the surface for
 * grid coordinates (u ∈ [0,1) around, a ∈ [0,1] along). Flat cap disc, one straight
 * 45° chamfer band (the diamond cut), straight barrel, and back.
 */
export function meshPoint(u: number, a: number): [number, number, number] {
  const CAP = 0.1;
  const BAND = 0.26;
  if (a <= CAP) {
    const t = a / CAP;
    const [px, py] = insetContour(u, PRISM_EDGE);
    return [px * t, py * t, PRISM_HALF];
  }
  if (a <= CAP + BAND) {
    const s = (a - CAP) / BAND;
    const pull = PRISM_EDGE * (1 - s);
    const [px, py] = insetContour(u, pull);
    return [px, py, PRISM_HALF - PRISM_EDGE * s];
  }
  if (a <= 1 - CAP - BAND) {
    const t = (a - CAP - BAND) / (1 - 2 * (CAP + BAND));
    const [px, py] = insetContour(u, 0);
    return [px, py, PRISM_HALF - PRISM_EDGE + t * (2 * PRISM_EDGE - 2 * PRISM_HALF)];
  }
  if (a <= 1 - CAP) {
    const s = (1 - CAP - a) / BAND;
    const pull = PRISM_EDGE * (1 - s);
    const [px, py] = insetContour(u, pull);
    return [px, py, -(PRISM_HALF - PRISM_EDGE * s)];
  }
  const t = (1 - a) / CAP;
  const [px, py] = insetContour(u, PRISM_EDGE);
  return [px * t, py * t, -PRISM_HALF];
}
