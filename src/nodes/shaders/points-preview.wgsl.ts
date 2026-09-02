/**
 * The pointset PREVIEW splat (T373, §V85).
 *
 * A generator whose whole job is shape showed an empty tile while its consumer showed
 * the shape. This shader is the node's OWN picture: every point becomes a small
 * screen-facing disc, drawn with a fixed default camera into a compiler-synthesized
 * preview target. It deliberately borrows nothing from the downstream renderer — the
 * preview must show what THIS node produced, framed the same way whether or not
 * anything consumes it.
 *
 * The camera arrives as a plain uniform so a viewer camera (T379) can later drive it as
 * a value update, never a structure change (§V5).
 *
 * Billboarding is done in clip space: the corner offset is scaled by `clip.w`, so discs
 * keep a constant on-screen size regardless of depth — right for a preview, where the
 * question is "where are my points", not "how big would a sprite be".
 *
 * T952 — AND THE SIZE IS IN DEVICE PIXELS, NOT IN CLIP SPACE, which is the whole point.
 *
 * `pointSize` used to be one scalar clip-space fraction (0.03), and a clip-space fraction
 * scales WITH the target: a disc was 2.86% of the frame's width at 384 texels and at
 * 2592 alike. That is why zoom never bought detail — the boost granted 384 → 2592 and the
 * splat grew exactly in step, so a 6.75× larger tile carried the SAME PICTURE, LARGER.
 * Measured: a 768 render downsampled onto a 384 one differed by a mean of 0.14/255, and
 * that near-zero was the defect, not the reassurance it reads as. §T891 and §T919 were
 * both reaching for a resolution win this shader was cancelling out.
 *
 * A disc that is a constant number of DEVICE PIXELS inverts it. The tile grows, the disc
 * does not, so each point covers a smaller fraction of the frame, more of them resolve,
 * and the existing ladder finally pays for something. `points are basically infinitely
 * small so it's up to us to decide how large to render` — the owner, and this is where
 * that decision lives.
 *
 * The extent is a vec2 rather than a scalar because NDC is not isotropic: one NDC unit is
 * `width/2` texels across and `height/2` texels down, so a single fraction drew an
 * ELLIPSE in any non-square target — 5.8 × 3.2 texels in a 16:9 tile. Every Dawn gate
 * renders square, so nothing ever saw it; T663 gave synthesized previews the project's
 * aspect and this shader kept squashing them. Per-axis extents make the disc round by
 * construction instead of round only when the project is.
 */

/** Vertices per point: one two-triangle quad. */
export const POINTS_PREVIEW_VERTEX_COUNT = 6;

/**
 * Disc DIAMETER in device pixels — the look decision, in the unit the eye reads.
 *
 * `points are basically infinitely small so it's up to us to decide how large to render`
 * — the owner. This is that decision, and it was swept on Dawn rather than picked
 * (`scratchpad/t952/point-size.gpu.ts`), against the case they reported: E13-Prism's
 * `bar`/`form`, 10,800 points, at the 384 tile a default node gets at zoom 1 on a retina
 * display. `ink` is the fraction of the frame carrying any splat; `saturated` is the
 * fraction clipped to flat colour, which is picture that has stopped carrying shape.
 *
 *     diameter    ink    saturated
 *        11px   27.5%      25.9%   ← the old clip-space 0.03, at this tile
 *         8px   26.6%      25.1%
 *         6px   26.0%      18.9%
 *         4px   25.5%       2.9%   ← here
 *         3px   24.5%       0.3%
 *         2px   18.0%       0.1%
 *
 * 4 is the knee, and both neighbours say why. Going 6 → 4 collapses the clipping 6.5×
 * while ink barely moves (26.0 → 25.5): the SAME points, no longer merged into a mat —
 * which is exactly the complaint. Going 4 → 2 finally moves ink (25.5 → 18.0), and ink
 * falling means points are being LOST rather than separated. 4 device px is also 2 CSS px
 * at dpr 2, still a dot rather than a speck.
 *
 * Note what is NOT here: a term that scales with the point COUNT. With the size in pixels
 * the density does that work by itself — 10,800 points cover more of the frame than 36 —
 * and the sweep above is the evidence, not an assumption: the count is constant down every
 * column, and the clipping still collapses. A count-scaled rule would be a second answer
 * to a question this one already answers.
 */
export const POINTS_PREVIEW_DIAMETER_PX = 4;

/**
 * The sub-pixel floor.
 *
 * Geometry thinner than about a pixel does not fade politely, it shimmers and drops out
 * between frames — the same floor the prism's strands needed, for the same reason. A
 * constant pixel diameter cannot drift under this on its own, so today the clamp never
 * binds; it exists so that a future smaller diameter (or a per-node one) fails visibly
 * loud at the floor rather than quietly disappearing at small tiles.
 */
export const POINTS_PREVIEW_MIN_DIAMETER_PX = 1.5;

/**
 * The `pointSize` uniform: NDC half-extent per axis for a disc of
 * `POINTS_PREVIEW_DIAMETER_PX` device pixels in a target of `size` texels.
 *
 * One NDC unit spans `width/2` texels, so a half-extent of `diameter/width` NDC is
 * `diameter/2` texels — the half of a disc `diameter` texels across. Same in y against
 * `height`, which is what keeps it circular.
 *
 * It is a VALUE, so it rides §V5's uniform path: crossing a ladder step already rebuilds
 * the program (the tile target's descriptor changed), and within a step nothing here
 * moves, so this never costs a rebuild of its own.
 */
export function pointSplatNdcExtent(size: readonly [number, number]): [number, number] {
  const diameter = Math.max(POINTS_PREVIEW_DIAMETER_PX, POINTS_PREVIEW_MIN_DIAMETER_PX);
  const width = Math.max(1, size[0]);
  const height = Math.max(1, size[1]);
  return [diameter / width, diameter / height];
}

export function pointsPreviewWgsl(options?: {
  /**
   * The pointset carries a GPU-side live count (advanced kernel lifecycle): gate each
   * instance against `counts[0]` so dead capacity slots collapse to zero-area quads —
   * the §V219 trick — instead of splatting whatever a dead slot's position holds.
   */
  counted?: boolean;
}): string {
  const counted = options?.counted === true;
  const countBinding = counted
    ? `@group(0) @binding(2) var<storage, read> counts: array<u32>;\n`
    : "";
  const countGate = counted
    ? `  if (instance >= counts[0u]) {
    var dead: VertexOut;
    dead.position = vec4f(2.0, 2.0, 0.0, 1.0);
    dead.uv = vec2f(0.0, 0.0);
    return dead;
  }
`
    : "";
  return `struct PreviewParams {
  viewProjection: mat4x4f,
  /* NDC half-extent per axis (T952) — see \`pointSplatNdcExtent\`. Per-axis, because one
     NDC unit is width/2 texels across and height/2 down: a scalar drew an ellipse. */
  pointSize: vec2f,
};

@group(0) @binding(0) var<uniform> params: PreviewParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${countBinding}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

/* Function-local var: WGSL only permits runtime indexing into var-stored arrays. */
fn quadCorner(v: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return corners[v];
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${countGate}  let corner = quadCorner(vertex % 6u);
  let clip = params.viewProjection * vec4f(positions[instance], 1.0);
  var out: VertexOut;
  /* Clip-space billboard: offset scaled by w keeps the disc a constant screen size —
     and \`pointSize\` is now a per-axis NDC extent standing for a fixed DEVICE-PIXEL
     diameter, so "constant screen size" finally means constant in pixels rather than
     constant as a fraction of whatever the tile happens to be (T952). */
  out.position = vec4f(clip.xy + corner * params.pointSize * clip.w, clip.z, clip.w);
  out.uv = corner;
  return out;
}

const SPLAT_COLOR = vec3f(1.0, 0.62, 0.24);

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  /* Linear falloff to the quad edge: exact, so a test can predict any texel. */
  let alpha = clamp(1.0 - length(input.uv), 0.0, 1.0);
  return vec4f(SPLAT_COLOR, alpha);
}`;
}
