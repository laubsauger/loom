import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * Shaders for the point family (T121, T122).
 *
 * The kernel node's compute WGSL is GENERATED per instance by `src/points/codegen.ts`;
 * only the render side lives here. Sprites are billboarded quads expanded in the vertex
 * stage — six vertices per instance, corner picked by vertex_index, size converted from
 * pixels to clip space through the shared frame block's resolution (§V44: everything
 * per-frame arrives through that block, nothing else).
 */

export const DEFAULT_POINT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // Deterministic drift: same seed, same point, same frame, same motion (§V74).
  let jitterX = pointRand(p.id, 1u) - 0.5;
  let jitterY = pointRand(p.id, 2u) - 0.5;
  q.velocity = q.velocity + vec3f(jitterX, jitterY - 0.05, 0.0) * ctx.delta;
  q.position = q.position + q.velocity * ctx.delta;
  // Wrap in clip space so the system never drifts off screen.
  if (q.position.y < -1.1) { q.position.y = 1.1; }
  if (q.position.x < -1.1) { q.position.x = 1.1; }
  if (q.position.x > 1.1) { q.position.x = -1.1; }
  return q;
}`;

export const SPRITE_RENDER_WGSL = `${SHARED_UNIFORMS_WGSL}
struct SpriteParams {
  color: vec4f,
  sizePixels: f32,
};

@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: SpriteParams;
@group(0) @binding(2) var<storage, read> positions: array<vec3f>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  /* Two triangles of a unit quad, expanded around the point's clip position. */
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let center = positions[instance];
  let sizeClip = vec2f(params.sizePixels, params.sizePixels) / frameU.resolution * 2.0;
  var out: VertexOut;
  out.position = vec4f(center.xy + corner * sizeClip * 0.5, 0.0, 1.0);
  out.corner = corner;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  /* Soft disc: alpha falls off toward the quad edge. */
  let distance = length(input.corner);
  if (distance > 1.0) {
    discard;
  }
  let falloff = 1.0 - distance * distance;
  return vec4f(params.color.rgb, params.color.a * falloff);
}`;
