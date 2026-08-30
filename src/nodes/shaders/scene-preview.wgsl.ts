/**
 * Scene-payload PREVIEWS (T462, §V85): a material, a light or a camera is a THING whose
 * whole job is a look, and until this file each one showed nothing. Every preview here
 * is the node's OWN payload rendered into a tiny stock scene — never a borrowed
 * downstream image, which goes blank exactly when nothing is connected (the argument
 * that settled T373's pointset previews, unchanged).
 *
 * Three stocks:
 *  - MATERIAL → a shaded ball under a fixed warm key and cool fill. The universal
 *    material preview; albedo, maps, roughness and specular readable at a glance.
 *  - LIGHT → the same ball in the default grey material, lit by ONLY this light with
 *    zero ambient. A light at zero intensity previews black — true, and the point.
 *  - CAMERA → a stock reference scene (checker ground, axis-coloured box) seen
 *    through the camera's own matrix: fov, position and orientation in one look.
 *
 * Everything is ANALYTIC — the sphere, the plane, the box all come from the vertex
 * index — so a preview binds no buffers and borrows nothing from the graph except the
 * payload values in its uniforms (and a material's map textures, which ARE its look).
 * The BACKGROUND is painted by the same draw (first six vertices, far depth): §V384,
 * learned from E25's invisible screen — an unlit ball on unpainted black is no preview.
 *
 * Uniform field names match the scene Render's `SceneParams` (light triples included),
 * so the packing code in compile.ts reads like the render's and the animate path drives
 * an orbiting light's preview as a value update (§V5).
 */

/** Ball tessellation: wrapped longitude ring, open latitude. */
const LON_CELLS = 40;
const LAT_CELLS = 27;

/** Six background vertices, then the sphere cells. */
export const SCENE_PREVIEW_BALL_VERTEX_COUNT = 6 + LON_CELLS * LAT_CELLS * 6;

export interface ScenePreviewBallOptions {
  readonly model: "unlit" | "lambert" | "phong";
  /** 1 for a light preview (the payload's own), 2 for the material stock rig. */
  readonly lightCount: number;
  readonly maps?: { readonly albedo?: boolean; readonly roughness?: boolean };
}

export function scenePreviewBallWgsl(options: ScenePreviewBallOptions): string {
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const albedoMap = options.maps?.albedo === true;
  const roughnessMap = options.maps?.roughness === true;

  const lightField = Array.from({ length: lightCount }, (_, index) =>
    `  light${index}Meta: vec4f,\n  light${index}Color: vec4f,\n  light${index}Vector: vec4f,\n`,
  ).join("");

  /* textureLoad, exactly as the scene render reads maps: draw passes carry no sampler
     slot, and a texel fetch keeps unfilterable formats working on Tier B. */
  const mapBindings = [
    albedoMap ? `@group(0) @binding(1) var albedoMap: texture_2d<f32>;\n` : "",
    roughnessMap ? `@group(0) @binding(${albedoMap ? 2 : 1}) var roughnessMap: texture_2d<f32>;\n` : "",
  ].join("");
  const mapLoad = (name: string): string =>
    `textureLoad(${name}, vec2i(clamp(input.uv, vec2f(0.0), vec2f(1.0)) * (vec2f(textureDimensions(${name})) - vec2f(1.0))), 0)`;
  const albedoExpr = albedoMap ? `params.baseColor * ${mapLoad("albedoMap")}` : "params.baseColor";
  const roughnessExpr = roughnessMap
    ? `clamp(params.material.y * ${mapLoad("roughnessMap")}.r, 0.04, 1.0)`
    : "params.material.y";

  /* The same two-sided light block the scene render generates (T377/T428). */
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
    let gloss = max(2.0, params.specular.w * (1.0 - roughness));
    let highlight = pow(abs(dot(normal, halfway)), gloss);
    lit += params.specular.rgb * radiance * highlight;
`
    : ""
}  }
`;

  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, 1.0);`
      : `  let ambient = params.ambientColor.rgb * params.ambientColor.a;
  var lit = albedo.rgb * ambient;
${
  lightCount === 0
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}  return vec4f(lit, 1.0);`;

  return `struct PreviewParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,      // rgb colour, a = intensity
  baseColor: vec4f,
  specular: vec4f,          // rgb specular colour, w = shininess
  material: vec4f,          // x = metallic, y = roughness, zw reserved
  background: vec4f,
${lightField}};

@group(0) @binding(0) var<uniform> params: PreviewParams;
${mapBindings}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
  @location(3) flag: f32,   // 1 = background vertex
};

fn quadCorner(v: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return corners[v];
}

fn spherePoint(gx: u32, gy: u32) -> vec3f {
  let u = f32(gx % ${LON_CELLS}u) / ${LON_CELLS}.0;
  let v = f32(gy) / ${LAT_CELLS}.0;
  let theta = v * 3.14159265;
  let phi = u * 6.2831853;
  return vec3f(sin(theta) * sin(phi), cos(theta), sin(theta) * cos(phi));
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  var out: VertexOut;
  if (vertex < 6u) {
    /* §V384: the background is painted by the pass itself, at far depth. */
    out.position = vec4f(quadCorner(vertex), 0.9995, 1.0);
    out.normal = vec3f(0.0, 0.0, 1.0);
    out.world = vec3f(0.0);
    out.uv = vec2f(0.0);
    out.flag = 1.0;
    return out;
  }
  let quad = (vertex - 6u) / 6u;
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  let corner = corners[(vertex - 6u) % 6u];
  let gx = (quad % ${LON_CELLS}u) + corner.x;
  let gy = (quad / ${LON_CELLS}u) + corner.y;
  let world = spherePoint(gx, gy);
  out.position = params.viewProjection * vec4f(world, 1.0);
  /* A unit sphere's outward normal IS its position. */
  out.normal = world;
  out.world = world;
  out.uv = vec2f(f32(gx) / ${LON_CELLS}.0, f32(gy) / ${LAT_CELLS}.0);
  out.flag = 0.0;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  if (input.flag > 0.5) {
    return vec4f(params.background.rgb, 1.0);
  }
  let normal = normalize(input.normal);
  let albedo = ${albedoExpr};
${options.model === "unlit" ? "" : `  let roughness = ${roughnessExpr};\n  _ = roughness;\n`}${shading}
}`;
}

/** Six background + six ground-plane + thirty-six box vertices. */
export const CAMERA_PREVIEW_VERTEX_COUNT = 6 + 6 + 36;

/**
 * The camera's stock reference scene: a checkered ground plane and an axis-coloured
 * box, through the camera's OWN matrix. Face colours are flat and exact — the preview
 * answers "where am I and what do I see", not "how is it lit".
 */
export function cameraPreviewWgsl(): string {
  return `struct PreviewParams {
  viewProjection: mat4x4f,
  background: vec4f,
};

@group(0) @binding(0) var<uniform> params: PreviewParams;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) flag: f32,   // 0 = box, 1 = background, 2 = ground
};

fn quadCorner(v: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return corners[v];
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

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  var out: VertexOut;
  if (vertex < 6u) {
    out.position = vec4f(quadCorner(vertex), 0.9995, 1.0);
    out.world = vec3f(0.0);
    out.normal = vec3f(0.0, 0.0, 1.0);
    out.flag = 1.0;
    return out;
  }
  if (vertex < 12u) {
    let corner = quadCorner(vertex - 6u);
    let world = vec3f(corner.x * 4.0, 0.0, corner.y * 4.0);
    out.position = params.viewProjection * vec4f(world, 1.0);
    out.world = world;
    out.normal = vec3f(0.0, 1.0, 0.0);
    out.flag = 2.0;
    return out;
  }
  /* The gnomon box: half-extent 0.45, sitting on the plane. */
  let local = boxVertex(vertex - 12u) * 0.45;
  let world = local + vec3f(0.0, 0.45, 0.0);
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.world = world;
  out.normal = boxNormal(vertex - 12u);
  out.flag = 0.0;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  if (input.flag > 1.5) {
    /* Checker by world cell — flat and exact, readable at any fov. */
    let cell = (floor(input.world.x) + floor(input.world.z)) % 2.0;
    let shade = select(0.16, 0.24, abs(cell) > 0.5);
    return vec4f(shade, shade, shade, 1.0);
  }
  if (input.flag > 0.5) {
    return vec4f(params.background.rgb, 1.0);
  }
  /* Axis-coloured faces: +x warm, y green, z blue — orientation at a glance. */
  let n = input.normal;
  if (abs(n.x) > 0.5) { return vec4f(select(0.45, 0.85, n.x > 0.0), 0.24, 0.2, 1.0); }
  if (abs(n.y) > 0.5) { return vec4f(0.28, select(0.4, 0.78, n.y > 0.0), 0.32, 1.0); }
  return vec4f(0.24, 0.42, select(0.5, 0.9, n.z > 0.0), 1.0);
}`;
}
