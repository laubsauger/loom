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
}

export function sceneSurfaceWgsl(options: SceneShadingOptions): string {
  const lightCount = Math.max(0, Math.floor(options.lightCount));
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

  const albedoExpr = albedoMap ? `params.baseColor * ${mapLoad("albedoMap")}` : "params.baseColor";
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
${mapBindings}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
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
