/**
 * The instance render shader (T299): a procedural primitive per point, vertex-pulled
 * from the SoA position buffer — no vertex buffers, no mesh assets, no new pass kind.
 *
 * §V198's published composition order, in full:
 *
 *   clip = viewProjection × ( T(point) × Rz × Ry × Rx × S(scale) × vertex )
 *
 * i.e. the primitive is SCALED first, ROTATED next (X, then Y, then Z — Houdini's
 * default rotation order), TRANSLATED to its point last, then projected through the
 * §V198 camera (column-major, right-handed, −z forward, [0,1] depth). Pinned by test;
 * changing this order is a spec change, not a refactor.
 *
 * Shape is a UNIFORM (§V5): every shape draws INSTANCE_VERTEX_COUNT vertices and the
 * vertices past the shape's own count clamp to the shape's last vertex, forming
 * zero-area triangles (each count is a multiple of 3, so a clamped triangle has all
 * three vertices identical). Switching quad → box → octahedron re-uploads one integer.
 */
export const INSTANCE_VERTEX_COUNT = 36;

export function renderInstancesWgsl(options?: {
  /**
   * T369: per-point COLOUR — a vec4f attribute drives the whole `color` compound, exactly
   * as it does on renderPoints (T364). LINEAR by declaration (§V313): a point attribute is
   * DATA, and nothing display-decodes a per-point value on its way to a pixel.
   *
   * Unlike the sprite shader, the params struct here can never empty out — `viewProjection`,
   * `rotate`, `scale` and `shape` are not mappable — so the block stays and only `color`
   * leaves it. Mapped, the colour rides VertexOut and the LIGHTING is applied to it
   * unchanged: a per-point colour is still a lit solid, not a flat sprite, which is the
   * whole reason to want it here rather than on renderPoints.
   */
  colorMap?: boolean;
  /** T333: draw-time group over `p.<attribute>` — binds resolved from the typed edge (§V308). */
  group?: { expression: string; binds: ReadonlyArray<{ attribute: string; type: string }> };
}): string {
  const group = options?.group;
  const colorMap = options?.colorMap === true;
  const groupBindings =
    group === undefined
      ? ""
      : group.binds
          .map(
            (bind, index) =>
              `@group(0) @binding(${5 + index}) var<storage, read> group_${bind.attribute}: array<${bind.type}>;\n`,
          )
          .join("");
  const groupFunction =
    group === undefined
      ? ""
      : `
struct GroupPoint {
${group.binds.map((bind) => `  ${bind.attribute}: ${bind.type},`).join("\n")}
};

fn groupMatch(p: GroupPoint) -> bool {
  return (${group.expression});
}
`;
  const groupGate =
    group === undefined
      ? ""
      : `  var gp: GroupPoint;
${group.binds.map((bind) => `  gp.${bind.attribute} = group_${bind.attribute}[instance];`).join("\n")}
  if (!groupMatch(gp)) {
    /* Excluded: every vertex lands on one point — a zero-area primitive (§V219). */
    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 0.0, 1.0);
    gated.normal = vec3f(0.0, 0.0, 1.0);
${colorMap ? "    gated.color = vec4f(0.0);\n" : ""}    return gated;
  }
`;
  const colorBinding = colorMap
    ? "@group(0) @binding(4) var<storage, read> mapColors: array<vec4f>;\n"
    : "";
  const colorExpr = colorMap ? "input.color" : "params.color";
  return `struct InstanceParams {
  viewProjection: mat4x4f,
${colorMap ? "" : "  color: vec4f,\n"}  rotate: vec3f,       // radians; applied X then Y then Z (published order)
  scale: f32,
  shape: u32,          // 0=quad 1=box 2=octahedron
};

@group(0) @binding(0) var<uniform> params: InstanceParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${colorBinding}${groupBindings}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
${colorMap ? "  @location(1) color: vec4f,\n" : ""}};

/* Function-local var: WGSL only permits runtime indexing into var-stored arrays. */
fn quadCorner(v: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return corners[v];
}

fn shapeVertexCount(shape: u32) -> u32 {
  if (shape == 0u) { return 6u; }
  if (shape == 2u) { return 24u; }
  return 36u;
}

/* Unit box: face = v/6 picks an axis and a sign, the quad table fills the face. */
fn boxVertex(v: u32) -> vec3f {
  let face = v / 6u;
  let corner = quadCorner(v % 6u);
  let sign = f32(face % 2u) * 2.0 - 1.0;
  let axis = face / 2u;
  if (axis == 0u) { return vec3f(sign, corner.x * sign, corner.y); }
  if (axis == 1u) { return vec3f(corner.x, sign, corner.y * sign); }
  return vec3f(corner.x * sign, corner.y, sign);
}

fn boxNormal(v: u32) -> vec3f {
  let face = v / 6u;
  let sign = f32(face % 2u) * 2.0 - 1.0;
  let axis = face / 2u;
  if (axis == 0u) { return vec3f(sign, 0.0, 0.0); }
  if (axis == 1u) { return vec3f(0.0, sign, 0.0); }
  return vec3f(0.0, 0.0, sign);
}

/* Octahedron: face = v/3 picks an octant by its sign bits; the axis apexes wind so
   outward faces agree with the face normal normalize(signs). */
fn octaVertex(v: u32) -> vec3f {
  let face = v / 3u;
  let sx = f32(face & 1u) * 2.0 - 1.0;
  let sy = f32((face >> 1u) & 1u) * 2.0 - 1.0;
  let sz = f32((face >> 2u) & 1u) * 2.0 - 1.0;
  let corner = v % 3u;
  if (corner == 0u) { return vec3f(sx, 0.0, 0.0); }
  if (corner == 1u) { return vec3f(0.0, sy, 0.0); }
  return vec3f(0.0, 0.0, sz);
}

fn shapeVertex(shape: u32, v: u32) -> vec3f {
  if (shape == 0u) { return vec3f(quadCorner(v), 0.0); }
  if (shape == 2u) { return octaVertex(v); }
  return boxVertex(v);
}

fn shapeNormal(shape: u32, v: u32) -> vec3f {
  if (shape == 0u) { return vec3f(0.0, 0.0, 1.0); }
  if (shape == 2u) {
    let face = v / 3u;
    let sx = f32(face & 1u) * 2.0 - 1.0;
    let sy = f32((face >> 1u) & 1u) * 2.0 - 1.0;
    let sz = f32((face >> 2u) & 1u) * 2.0 - 1.0;
    return normalize(vec3f(sx, sy, sz));
  }
  return boxNormal(v);
}

${groupFunction}fn rotationMatrix(r: vec3f) -> mat3x3f {
  let cx = cos(r.x); let sx = sin(r.x);
  let cy = cos(r.y); let sy = sin(r.y);
  let cz = cos(r.z); let sz = sin(r.z);
  let rx = mat3x3f(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  let ry = mat3x3f(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  let rz = mat3x3f(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  /* X first, then Y, then Z — column vectors, so the first-applied is rightmost. */
  return rz * ry * rx;
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${groupGate}  let count = shapeVertexCount(params.shape);
  let v = min(vertex, count - 1u);
  let rotation = rotationMatrix(params.rotate);
  let local = rotation * (shapeVertex(params.shape, v) * params.scale);
  let world = local + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = rotation * shapeNormal(params.shape, v);
${colorMap ? "  out.color = mapColors[instance];\n" : ""}  return out;
}

const LIGHT_DIRECTION = vec3f(0.3713906, 0.7427813, 0.5570860); // normalize(2,4,3)
const AMBIENT = 0.25;

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  /* Two-sided lambert: a quad seen from behind still reads as lit geometry. */
  let lambert = abs(dot(normalize(input.normal), LIGHT_DIRECTION));
  let shade = AMBIENT + (1.0 - AMBIENT) * lambert;
  return vec4f(${colorExpr}.rgb * shade, ${colorExpr}.a);
}`;
}

/** The plain spelling — no group, no colour map — kept as the constant its consumers always imported (§V309). */
export const RENDER_INSTANCES_WGSL = renderInstancesWgsl();
