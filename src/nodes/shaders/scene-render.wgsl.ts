/**
 * The scene Render shader (T377/T428): the surface mesh machinery of T301 with the
 * SHADING GENERATED per material model — the V349 fix. The legacy renderers keep their
 * byte-identical shaders; this generator serves the `render` node only.
 *
 * Mesh side (unchanged from render-surface.wgsl.ts, credited): the vertex index IS the
 * grid connectivity, normals are central differences over grid neighbours, wrapped
 * axes address modularly so the seam cell closes the ring. What T377 adds: `uv` (the
 * grid coordinate — free, and what material maps sample by), `eye` (for the view
 * vector), and a LIGHT ARRAY sized to the scene's actual referenced count — structural
 * in COUNT (adding a light recompiles), pure values in CONTENT (moving one animates),
 * which is the no-artificial-cap shape without a storage buffer: a uniform array
 * carries thousands of lights before the block limit, and B33's silent storage-budget
 * cliff never enters the picture.
 */

export interface SceneShadingOptions {
  readonly model: "unlit" | "lambert" | "phong";
  /** Lights the shader is compiled for. 0 is legal: ambient floor only. */
  readonly lightCount: number;
  readonly maps?: { readonly albedo?: boolean; readonly roughness?: boolean };
  /** T478: a vec4f attribute multiplies the base colour per point (the mapped tint). */
  readonly pointColor?: boolean;
}

export function sceneSurfaceWgsl(options: SceneShadingOptions): string {
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const pointColor = options.pointColor === true;
  const albedoMap = options.maps?.albedo === true;
  const roughnessMap = options.maps?.roughness === true;

  /* Lights as GENERATED SCALAR MEMBERS — three vec4 rows per light (meta / colour /
     vector) with the index in the NAME. The count is structural anyway (a new light
     recompiles), and named members keep the uniform writer on the plainest possible
     path: vgpu writes by name, and a named vec4 is the one shape every reflector
     agrees on. */
  const lightField = Array.from({ length: lightCount }, (_, index) =>
    `  light${index}Meta: vec4f,\n  light${index}Color: vec4f,\n  light${index}Vector: vec4f,\n`,
  ).join("");

  /* Maps read with textureLoad (the T262 bridge's precedent): draw passes carry no
     sampler slot, and a texel fetch keeps unfilterable formats working on Tier B. */
  const mapBindings = [
    albedoMap ? `@group(0) @binding(3) var albedoMap: texture_2d<f32>;\n` : "",
    roughnessMap ? `@group(0) @binding(${albedoMap ? 4 : 3}) var roughnessMap: texture_2d<f32>;\n` : "",
  ].join("");

  const mapLoad = (name: string): string =>
    `textureLoad(${name}, vec2i(clamp(input.uv, vec2f(0.0), vec2f(1.0)) * (vec2f(textureDimensions(${name})) - vec2f(1.0))), 0)`;

  const albedoExpr = `${albedoMap ? `params.baseColor * ${mapLoad("albedoMap")}` : "params.baseColor"}${pointColor ? " * input.tint" : ""}`;
  const roughnessExpr = roughnessMap
    ? `clamp(params.material.y * ${mapLoad("roughnessMap")}.r, 0.04, 1.0)`
    : "params.material.y";

  const lightBlock = (index: number): string => `  {
    let lightMeta = params.light${index}Meta;
    let lightColor = params.light${index}Color;
    let lightVector = params.light${index}Vector;
    var toLight: vec3f;
    var attenuation = 1.0;
    if (lightMeta.x < 0.5) {
      toLight = normalize(-lightVector.xyz);
    } else {
      let offset = lightVector.xyz - input.world;
      let distance = max(length(offset), 1e-4);
      toLight = offset / distance;
      attenuation = 1.0 / (1.0 + distance * distance);
    }
    /* Two-sided lambert: a surface has no wrong side (T301's rule, kept). */
    let lambert = abs(dot(normal, toLight));
    let radiance = lightColor.rgb * lightMeta.y * attenuation;
    lit += albedo.rgb * radiance * lambert;
${
  options.model === "phong"
    ? `    let halfway = normalize(toLight + viewDir);
    let gloss = max(2.0, params.specular.w * (1.0 - roughness));
    let highlight = pow(abs(dot(normal, halfway)), gloss);
    lit += params.specular.rgb * radiance * highlight;
`
    : ""
}  }
`;

  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, albedo.a);`
      : `  let ambient = params.ambientColor.rgb * params.ambientColor.a;
  var lit = albedo.rgb * ambient;
${
  lightCount === 0
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}  return vec4f(lit, albedo.a);`;

  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,      // rgb colour, a = intensity
  baseColor: vec4f,
  specular: vec4f,          // rgb specular colour, w = shininess
  material: vec4f,          // x = metallic, y = roughness, zw reserved
  grid: vec4f,              // cols, rows, wrapU, wrapV
${lightField}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${mapBindings}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
};

fn cellCorner(v: u32) -> vec2u {
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  return corners[v];
}

fn gridPosition(gx: u32, gy: u32) -> vec3f {
  let cols = u32(params.grid.x);
  let rows = u32(params.grid.y);
  let px = select(gx, gx % cols, params.grid.z > 0.5);
  let py = select(gy, gy % rows, params.grid.w > 0.5);
  return positions[py * cols + px];
}

fn nextIndex(i: u32, extent: u32, wrapped: bool) -> u32 {
  return select(min(i + 1u, extent - 1u), (i + 1u) % extent, wrapped);
}
fn previousIndex(i: u32, extent: u32, wrapped: bool) -> u32 {
  return select(max(i, 1u) - 1u, (i + extent - 1u) % extent, wrapped);
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let cols = u32(params.grid.x);
  let rows = u32(params.grid.y);
  let wrapU = params.grid.z > 0.5;
  let wrapV = params.grid.w > 0.5;
  let cellsU = select(cols - 1u, cols, wrapU);
  let quad = vertex / 6u;
  let corner = cellCorner(vertex % 6u);
  let gx = (quad % cellsU) + corner.x;
  let gy = (quad / cellsU) + corner.y;

  let world = gridPosition(gx, gy);
  let du = gridPosition(nextIndex(gx, cols, wrapU), gy) -
    gridPosition(previousIndex(gx, cols, wrapU), gy);
  let dv = gridPosition(gx, nextIndex(gy, rows, wrapV)) -
    gridPosition(gx, previousIndex(gy, rows, wrapV));

  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = cross(du, dv);
  out.world = world;
  /* The grid coordinate IS the uv — free, and what material maps sample by. */
  out.uv = vec2f(f32(gx) / max(params.grid.x - 1.0, 1.0), f32(gy) / max(params.grid.y - 1.0, 1.0));
  /* Same modular indexing as the position read, so the seam vertex wears column 0's tint. */
  out.tint = ${pointColor
    ? "pointColors[select(gy, gy % rows, wrapV) * cols + select(gx, gx % cols, wrapU)]"
    : "vec4f(1.0)"};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let magnitude = length(input.normal);
  let normal = select(vec3f(0.0, 0.0, 1.0), input.normal / max(magnitude, 1e-6), magnitude > 1e-6);
  let albedo = ${albedoExpr};
${options.model === "unlit" ? "" : `  let roughness = ${roughnessExpr};\n  _ = roughness;\n`}${shading}
}`;
}

/**
 * T428(b): the INSTANCES variant — the T299 primitive mesh (quad/box/octahedron from
 * the vertex index, per-instance translate from the SoA position buffer, analytic
 * shape normals) shaded through the same generated material/light block the surface
 * uses. The legacy renderInstances shader stays byte-identical; this serves the scene
 * Render only. Maps are refused upstream for instances (no uv yet), so this generator
 * takes no map options.
 */
export function sceneInstancesWgsl(options: {
  model: "unlit" | "lambert" | "phong";
  lightCount: number;
  /** T478: a vec4f attribute multiplies the base colour per point (the geometry's mapped tint). */
  pointColor?: boolean;
}): string {
  const pointColor = options.pointColor === true;
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const lightField = Array.from({ length: lightCount }, (_, index) =>
    `  light${index}Meta: vec4f,\n  light${index}Color: vec4f,\n  light${index}Vector: vec4f,\n`,
  ).join("");
  const lightBlock = (index: number): string => `  {
    let lightMeta = params.light${index}Meta;
    let lightColor = params.light${index}Color;
    let lightVector = params.light${index}Vector;
    var toLight: vec3f;
    var attenuation = 1.0;
    if (lightMeta.x < 0.5) {
      toLight = normalize(-lightVector.xyz);
    } else {
      let offset = lightVector.xyz - input.world;
      let distance = max(length(offset), 1e-4);
      toLight = offset / distance;
      attenuation = 1.0 / (1.0 + distance * distance);
    }
    let lambert = abs(dot(normal, toLight));
    let radiance = lightColor.rgb * lightMeta.y * attenuation;
    lit += albedo.rgb * radiance * lambert;
${
  options.model === "phong"
    ? `    let halfway = normalize(toLight + viewDir);
    let gloss = max(2.0, params.specular.w * (1.0 - params.material.y));
    let highlight = pow(abs(dot(normal, halfway)), gloss);
    lit += params.specular.rgb * radiance * highlight;
`
    : ""
}  }
`;
  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, albedo.a);`
      : `  let ambient = params.ambientColor.rgb * params.ambientColor.a;
  var lit = albedo.rgb * ambient;
${
  lightCount === 0
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}  return vec4f(lit, albedo.a);`;

  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,
  baseColor: vec4f,
  specular: vec4f,
  material: vec4f,
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
${lightField}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) tint: vec4f,
};

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

fn boxVertex(v: u32) -> vec3f {
  let face = v / 6u;
  let corner = quadCorner(v % 6u);
  let flip = f32(face % 2u) * 2.0 - 1.0;
  let axis = face / 2u;
  if (axis == 0u) { return vec3f(flip, corner.x * flip, corner.y); }
  if (axis == 1u) { return vec3f(corner.x, flip, corner.y * flip); }
  return vec3f(corner.x * flip, corner.y, flip);
}

fn boxNormal(v: u32) -> vec3f {
  let face = v / 6u;
  let flip = f32(face % 2u) * 2.0 - 1.0;
  let axis = face / 2u;
  if (axis == 0u) { return vec3f(flip, 0.0, 0.0); }
  if (axis == 1u) { return vec3f(0.0, flip, 0.0); }
  return vec3f(0.0, 0.0, flip);
}

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

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let local = shapeVertex(shape, v) * params.instance.x;
  let world = local + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = shapeNormal(shape, v);
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let albedo = params.baseColor * input.tint;
${shading}
}`;
}

