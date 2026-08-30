/**
 * The surface render shader (T301): a shaded surface over a point grid with ANALYTIC
 * topology — no index buffer, no mesh asset. The vertex index IS the connectivity:
 * quad = v/6 unwraps to a grid cell, the corner table picks its corner, and the cell's
 * grid coordinate addresses the SoA position buffer directly. TD's Connectivity+Dim[]
 * as arithmetic.
 *
 * Camera and shading follow T299 exactly: the §V198 published order
 * (clip = viewProjection × world), two-sided lambert against one fixed light. Normals
 * are central differences over grid neighbours (clamped at the borders, so an edge
 * vertex uses a one-cell forward/backward difference) — analytic, per-frame correct
 * under any deform, and free of a normal-recompute pass.
 */
export const RENDER_SURFACE_WGSL = `struct SurfaceParams {
  viewProjection: mat4x4f,
  color: vec4f,
  cols: u32,
  rows: u32,
};

@group(0) @binding(0) var<uniform> params: SurfaceParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
};

/* Function-local var: WGSL only permits runtime indexing into var-stored arrays. */
fn cellCorner(v: u32) -> vec2u {
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  return corners[v];
}

fn gridPosition(gx: u32, gy: u32) -> vec3f {
  return positions[gy * params.cols + gx];
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let cells = params.cols - 1u;
  let quad = vertex / 6u;
  let corner = cellCorner(vertex % 6u);
  let gx = (quad % cells) + corner.x;
  let gy = (quad / cells) + corner.y;

  let world = gridPosition(gx, gy);

  /* Central difference where both neighbours exist, one-sided at the borders. */
  let du = gridPosition(min(gx + 1u, params.cols - 1u), gy) - gridPosition(max(gx, 1u) - 1u, gy);
  let dv = gridPosition(gx, min(gy + 1u, params.rows - 1u)) - gridPosition(gx, max(gy, 1u) - 1u);

  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = cross(du, dv);
  return out;
}

const LIGHT_DIRECTION = vec3f(0.3713906, 0.7427813, 0.5570860); // normalize(2,4,3)
const AMBIENT = 0.25;

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  /* Two-sided lambert: a surface has no wrong side. Degenerate normals (a collapsed
     border cell) shade as ambient rather than NaN. */
  let magnitude = length(input.normal);
  var lambert = 0.0;
  if (magnitude > 1e-6) {
    lambert = abs(dot(input.normal / magnitude, LIGHT_DIRECTION));
  }
  let shade = AMBIENT + (1.0 - AMBIENT) * lambert;
  return vec4f(params.color.rgb * shade, params.color.a);
}`;
