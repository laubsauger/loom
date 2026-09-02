/**
 * T937 — ONE description of the prism's solid (§V818).
 *
 * The mesh (`form1`, prism.ts) and the traced SDF (`optics1`, prism-trace.wgsl.ts) are
 * two renderings of the SAME shape: a rounded equilateral triangle (inradius RI, corner
 * radius RHO) extruded to ±HALF with a constant-radius EDGE round where the caps meet
 * the barrel. Before T937 they could not be one shape: the mesh's cap round was a SCALE
 * pullback — a radial fraction, so its world depth varied along the contour (0.046 at a
 * face's middle, 0.09 at a corner) — while an SDF's rounding is a constant world radius.
 * T937 moved the mesh to a NORMAL-OFFSET bevel of radius EDGE, which is exactly the
 * rounded-extrusion SDF's edge:
 *
 *   sd3(p) = roundedExtrusion(sd2(p.xy), |p.z|, HALF, EDGE)
 *          = min(max(q.x, q.y), 0) + |max(q, 0)| − EDGE,
 *            q = (sd2(p.xy) + EDGE, |p.z| − (HALF − EDGE))
 *
 * with sd2 the rounded-triangle distance the T920 trace already marches. The identity is
 * GATED, not asserted: prism-geometry.test.ts walks the mesh generator in float64 and
 * requires |sd3| < 1e-6 at every vertex. Change either half without the other and that
 * gate is what refuses.
 *
 * Everything here is exported twice on purpose: as numbers for the two kernel templates,
 * and as float64 mirrors for the gates.
 */

/** Circumradius of the sharp triangle the contour walks. Inradius RI = RC / 2. */
export const PRISM_RC = 0.76;
export const PRISM_RI = PRISM_RC / 2;
/** Corner radius of the rounded triangle — the T920 bevel the trace marches. */
export const PRISM_RHO = 0.046;
/** Half-depth of the extrusion (T928: deepened from 0.55). */
export const PRISM_HALF = 0.72;
/** World radius of the cap-edge round — the quarter-round where cap meets barrel. */
export const PRISM_EDGE = 0.12;

/** Float64 signed distance to the rounded-triangle cross-section (mirror of the WGSL). */
export function sd2(x: number, y: number): number {
  const r = PRISM_RI - PRISM_RHO;
  // Vertices of the SHRUNK sharp triangle (each at distance 2r from the opposite face).
  const verts: Array<[number, number]> = [0, 1, 2].map((k) => {
    const phi = Math.PI / 2 + (k * 2 * Math.PI) / 3;
    return [2 * r * Math.cos(phi), 2 * r * Math.sin(phi)];
  });
  const normals: Array<[number, number]> = [
    [Math.sqrt(3) / 2, 0.5],
    [-Math.sqrt(3) / 2, 0.5],
    [0, -1],
  ];
  // Inside: greatest plane distance. Outside: nearest point on the three SEGMENTS.
  let inside = -Infinity;
  for (const [nx, ny] of normals) inside = Math.max(inside, x * nx + y * ny - r);
  if (inside <= 0) return inside - PRISM_RHO;
  let best = Infinity;
  for (let k = 0; k < 3; k += 1) {
    const [ax, ay] = verts[k]!;
    const [bx, by] = verts[(k + 1) % 3]!;
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - (ax + ex * t), y - (ay + ey * t)));
  }
  return best - PRISM_RHO;
}

/** Float64 signed distance to the full solid (mirror of the WGSL sd3). */
export function sd3(x: number, y: number, z: number): number {
  const qx = sd2(x, y) + PRISM_EDGE;
  const qy = Math.abs(z) - (PRISM_HALF - PRISM_EDGE);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.min(Math.max(qx, qy), 0) + outside - PRISM_EDGE;
}

/**
 * The INSET CONTOUR — the level set sd2 = −pull, walked by arc length. For pull ≤ RHO it
 * is the same rounded triangle with its corner radius reduced; past RHO the corners have
 * gone sharp and the planes themselves move in. A naive normal-offset of the outer
 * contour is WRONG here (measured: 0.0188 off) — the cap-edge pull (0.12) exceeds the
 * corner radius (0.046), so the offset curve self-intersects at the corners; the level
 * set is the shape the SDF's own rounding actually sweeps.
 */
function insetContour(u: number, pull: number): [number, number] {
  const rc = Math.max(PRISM_RHO - pull, 0);
  const D = PRISM_RC - 2 * PRISM_RHO - 2 * Math.max(pull - PRISM_RHO, 0);
  const seg = Math.sqrt(3) * D;
  const arc = (rc * 2 * Math.PI) / 3;
  const unit = seg + arc;
  const s = u * 3 * unit;
  const k = Math.floor(Math.min(s / unit, 2.999999));
  const local = s - k * unit;
  const phi = Math.PI / 2 + (k * 2 * Math.PI) / 3;
  const cx = Math.cos(phi) * D;
  const cy = Math.sin(phi) * D;
  if (local < arc && rc > 0) {
    const psi = phi - Math.PI / 3 + local / rc;
    return [cx + Math.cos(psi) * rc, cy + Math.sin(psi) * rc];
  }
  const t = seg > 0 ? Math.max(0, (local - arc) / seg) : 0;
  const ox = Math.cos(phi + Math.PI / 3);
  const oy = Math.sin(phi + Math.PI / 3);
  const phi2 = phi + (2 * Math.PI) / 3;
  const ax = cx + ox * rc;
  const ay = cy + oy * rc;
  const bx = Math.cos(phi2) * D + ox * rc;
  const by = Math.sin(phi2) * D + oy * rc;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

/**
 * The mesh walk, float64 (mirror of PRISM_FORM_KERNEL): position on the surface for grid
 * coordinates (u ∈ [0,1) around, a ∈ [0,1] along). Flat cap disc, quarter-round cap edge
 * (radius EDGE, swept on the inset level sets), straight barrel, and back.
 */
export function meshPoint(u: number, a: number): [number, number, number] {
  const CAP = 0.1;
  const ROUND = 0.26;
  if (a <= CAP) {
    const t = a / CAP;
    const [px, py] = insetContour(u, PRISM_EDGE);
    return [px * t, py * t, PRISM_HALF];
  }
  if (a <= CAP + ROUND) {
    const th = ((a - CAP) / ROUND) * (Math.PI / 2);
    const pull = PRISM_EDGE * (1 - Math.sin(th));
    const [px, py] = insetContour(u, pull);
    return [px, py, PRISM_HALF - PRISM_EDGE * (1 - Math.cos(th))];
  }
  if (a <= 1 - CAP - ROUND) {
    const t = (a - CAP - ROUND) / (1 - 2 * (CAP + ROUND));
    const z = PRISM_HALF - PRISM_EDGE + t * (2 * PRISM_EDGE - 2 * PRISM_HALF);
    const [px, py] = insetContour(u, 0);
    return [px, py, z];
  }
  if (a <= 1 - CAP) {
    const th = ((1 - CAP - a) / ROUND) * (Math.PI / 2);
    const pull = PRISM_EDGE * (1 - Math.sin(th));
    const [px, py] = insetContour(u, pull);
    return [px, py, -(PRISM_HALF - PRISM_EDGE * (1 - Math.cos(th)))];
  }
  const t = (1 - a) / CAP;
  const [px, py] = insetContour(u, PRISM_EDGE);
  return [px * t, py * t, -PRISM_HALF];
}
