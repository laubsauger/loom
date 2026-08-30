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
 */

/** Vertices per point: one two-triangle quad. */
export const POINTS_PREVIEW_VERTEX_COUNT = 6;

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
  pointSize: f32,
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
  /* Clip-space billboard: offset scaled by w keeps the disc a constant screen size. */
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
