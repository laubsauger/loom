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
    q.depthN = 0.0;
    return q;
  }

  /* The grid generator laid points across the clip square; that xy IS the depth map's
     uv in fieldAt's own convention — one mapping, shared. */
  let sample = fieldAt(vec3f(p.position.xy, 0.0));
  /* Single-channel maps (the depth node's r32float, T959) read .r; colour depth
     visualisations (turbo, viridis) read luma; grey maps agree under both. */
  let value = select(dot(sample.rgb, vec3f(0.2126, 0.7152, 0.0722)), sample.r, sample.g + sample.b < 1e-6);
  let metres = decodeDepth(value, near, far, ctx.params.inverseDepth);
  /* T973: the decoded depth rides its own attribute to the paint kernel — the heatmap
     is a second READOUT of the axis a 2D projection hides, not a decoration. 0 = near. */
  q.depthN = clamp((metres - near) / (far - near), 0.0, 1.0);

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
  heat: f32,
}

/* T973 — a thermal readout of depth: near burns white-hot through orange, far cools
   through magenta into deep blue. Analytic, so no second texture is needed (a point
   kernel has ONE field input, and it is carrying the colour map). */
fn thermal(t: f32) -> vec3f {
  let n = clamp(1.0 - t, 0.0, 1.0);
  return vec3f(
    smoothstep(0.0, 0.45, n),
    smoothstep(0.5, 0.9, n) * 0.8,
    smoothstep(0.0, 0.2, n) * (1.0 - smoothstep(0.25, 0.6, n)) + smoothstep(0.85, 1.0, n),
  );
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
  /* T973: photographic at heat 0, thermal at 1 — and the middle is the point: the
     source's own colour with depth bleeding through, one knob rather than a mode. */
  let blended = mix(colour.rgb, thermal(p.depthN), clamp(ctx.params.heat, 0.0, 1.0));
  /* §T977 follow-up: the field's ALPHA is honoured as COVERAGE, premultiplied — the
     colour carries the coverage, the scene renderer's own additive convention, and the
     same rule this kernel already applies at its two parked exits (tint = vec4f(0.0)).
     A masked colour map (DepthCut) now actually darkens the motes it cut. CLAMPED,
     because coverage is [0, 1] by meaning: an additive composite upstream SUMS alphas
     (measured - a lit disc over an opaque bed reads a = 2), and honouring that literally
     would double the rgb of every such point. With the clamp, any map that is
     opaque-or-over is bit-identical to the pre-fix output. */
  let cover = clamp(colour.a, 0.0, 1.0);
  q.tint = vec4f(blended * ctx.params.gain * cover, cover);
  return q;
}`;
