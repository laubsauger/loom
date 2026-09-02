/**
 * T958 — the DepthPoints component's two kernels.
 *
 * The component boundary takes a depth TEXTURE, not "the ML depth node" — these kernels
 * serve our `depth`, a depth camera, a rendered depth buffer, or a hand-authored
 * gradient alike, which is what makes the component a library unit rather than a
 * wrapper. Two kernels because a point kernel has ONE field input (T477): the CARVE
 * kernel reads the depth map and places points; the PAINT kernel reads the colour map
 * and tints them at the same grid uv. Chaining is the composition answer — no
 * multi-texture kernel capability was needed (reported against the §T958 row's open
 * question).
 *
 * THE TRAP the row names, handled where it bites: monocular ML depth is RELATIVE and
 * usually INVERSE (disparity-like, unitless); a depth camera gives metres. `inverseDepth`
 * declares the encoding and `near`/`far` the metric range the normalised value spans —
 * unprojecting an ML map with metric assumptions yields nonsense that looks like broken
 * maths, so the declaration is a published knob, not a comment.
 */

/**
 * CARVE: depth map → 3D positions. Two modes on one knob:
 *  - unproject 0 — HEIGHTFIELD: the relief carving `pointsFromTexture` already does,
 *    kept as the cheap mode. Texel position places the point, decoded depth raises it.
 *  - unproject 1 — PERSPECTIVE UNPROJECTION, the owner's "proper": a ray is cast
 *    through each pixel (vertical `fov`, aspect from the depth texture's own dims) and
 *    scaled by the decoded metric depth, so the scene SPREADS with distance and
 *    reconstructs real 3D. The cloud is recentred about the origin so a parent can
 *    orbit it without knowing the depth range.
 */
export const DEPTH_CARVE_KERNEL = `struct Params {
  unproject: f32,
  fov: f32,
  inverseDepth: f32,
  near: f32,
  far: f32,
  displace: f32,
}

fn decodeDepth(sample: f32, near: f32, far: f32, inverse: f32) -> f32 {
  /* inverse (ML disparity-like): bright = close; metres via the harmonic mix.
     linear: metres via the plain mix. Both span [near, far]. */
  let s = clamp(sample, 0.0, 1.0);
  let inv = 1.0 / mix(1.0 / far, 1.0 / near, s);
  let lin = mix(near, far, s);
  return select(lin, inv, inverse > 0.5);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let near = max(ctx.params.near, 1.0e-3);
  let far = max(ctx.params.far, near + 1.0e-3);

  /* The generator may carry more capacity than the grid (a published resolution knob
     moves cols/rows under a fixed count): every index past the grid parks far outside
     the frustum and draws nothing. */
  let cells = ctx.dim.cols * ctx.dim.rows;
  if (ctx.index >= cells) {
    q.position = vec3f(0.0, -10000.0, 0.0);
    q.tint = vec4f(0.0);
    return q;
  }

  /* The grid generator laid points across the clip square; that xy IS the depth map's
     uv in fieldAt's own convention — one mapping, shared. */
  let sample = fieldAt(vec3f(p.position.xy, 0.0));
  /* Luma, not .r: a colour depth visualisation (turbo, viridis) still carves. */
  let value = dot(sample.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let metres = decodeDepth(value, near, far, ctx.params.inverseDepth);

  if (ctx.params.unproject < 0.5) {
    /* HEIGHTFIELD: near pops toward the viewer, scaled by displace. */
    let relief = (1.0 - (metres - near) / (far - near)) * ctx.params.displace;
    q.position = vec3f(p.position.xy, relief);
    return q;
  }

  /* UNPROJECTION: ray through the pixel, scaled by metres, recentred about origin. */
  let dims = vec2f(textureDimensions(fieldTexture, 0));
  let aspect = dims.x / max(dims.y, 1.0);
  let ty = tan(ctx.params.fov * 0.00872664626);  /* radians(fov) / 2 */
  let ray = vec3f(p.position.x * ty * aspect, p.position.y * ty, -1.0);
  let mid = (near + far) * 0.5;
  let scaled = ray * metres * ctx.params.displace;
  q.position = vec3f(scaled.xy, scaled.z + mid * ctx.params.displace);
  return q;
}`;

/**
 * PAINT: colour map → per-point tint. Samples at the ORIGINAL grid uv (recomputed from
 * the topology, since the carve kernel has already displaced the positions), so the
 * retexturing stays registered with the depth regardless of mode.
 */
export const DEPTH_PAINT_KERNEL = `struct Params {
  gain: f32,
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let cols = max(ctx.dim.cols, 2u);
  let rows = max(ctx.dim.rows, 2u);
  if (ctx.index >= cols * rows) {
    q.tint = vec4f(0.0);
    return q;
  }
  let u = f32(ctx.dim.i) / f32(cols - 1u);
  let v = f32(ctx.dim.j) / f32(rows - 1u);
  /* fieldAt speaks clip coordinates; the grid generator's layout inverted nothing, so
     the same mapping the carve kernel rode puts the colour texel under its point. */
  let colour = fieldAt(vec3f(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0));
  q.tint = vec4f(colour.rgb * ctx.params.gain, 1.0);
  return q;
}`;
