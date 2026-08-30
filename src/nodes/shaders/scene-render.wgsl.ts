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
  /**
   * T481: the LIGHT INDICES that cast, in casting order. Slot s of this list owns
   * `shadow{s}Matrix` (a named mat4 member, V380) and the `shadowMap{s}` texture at
   * binding 5+s. Empty or absent emits byte-identical text (§V309).
   */
  readonly shadows?: ReadonlyArray<number>;
  /**
   * T482: an equirect ENVIRONMENT is wired on the render. Phong (and pbr-through-
   * phong) adds its reflection — sampled along R, scaled by (1−roughness) and the
   * specular tint, per T428's preserved IBL-lite plan. Lambert and unlit ignore it,
   * STATED on the input rather than silently (V349). Absent emits byte-identical text.
   */
  readonly environment?: boolean;
}

export function sceneSurfaceWgsl(options: SceneShadingOptions): string {
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const pointColor = options.pointColor === true;
  const albedoMap = options.maps?.albedo === true;
  const roughnessMap = options.maps?.roughness === true;
  const shadows = options.shadows ?? [];
  const shadowSlotOf = (index: number): number => shadows.indexOf(index);
  const shadowFields = shadows.map((_, slot) => `  shadow${slot}Matrix: mat4x4f,\n`).join("");
  const shadowBindings = shadows
    .map((_, slot) => `@group(0) @binding(${5 + slot}) var shadowMap${slot}: texture_2d<f32>;\n`)
    .join("");
  /* One textureLoad, constant bias, hard edge — PCF is a stated follow-up, not a
     silent absence. Outside the volume (uv or depth out of range) means UNSHADOWED:
     the volume is explicit (V426), and beyond it the light simply shines. */
  const shadowFactor = (index: number): string => {
    const slot = shadowSlotOf(index);
    if (slot < 0) return "";
    return `    var shadow = 1.0;
    {
      let sc = params.shadow${slot}Matrix * vec4f(input.world, 1.0);
      let suv = vec2f(sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5);
      if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0 && sc.z <= 1.0) {
        let sdims = vec2f(textureDimensions(shadowMap${slot}, 0));
        let stored = textureLoad(shadowMap${slot}, vec2i(suv * (sdims - vec2f(1.0))), 0).r;
        if (sc.z - 0.002 > stored) { shadow = 0.0; }
      }
    }
`;
  };
  const environment = options.environment === true && options.model === "phong";
  const envBinding = 5 + shadows.length;
  const envDeclarations = environment
    ? `@group(0) @binding(${envBinding}) var environmentMap: texture_2d<f32>;\n`
    : "";
  const envField = environment ? "  environment: vec4f,   // x = intensity\n" : "";
  /* Equirect, documented exactly: u = atan2(R.x, −R.z)/2π + 0.5, v = acos(R.y)/π. */
  const envTerm = environment
    ? `  let reflectDir = reflect(-viewDir, normal);
  let envUv = vec2f(
    atan2(reflectDir.x, -reflectDir.z) / 6.2831853 + 0.5,
    acos(clamp(reflectDir.y, -1.0, 1.0)) / 3.14159265,
  );
  let envDims = vec2f(textureDimensions(environmentMap, 0));
  let envColor = textureLoad(environmentMap, vec2i(clamp(envUv, vec2f(0.0), vec2f(1.0)) * (envDims - vec2f(1.0))), 0).rgb;
  lit += envColor * params.specular.rgb * (1.0 - roughness) * params.environment.x;
`
    : "";


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
${shadowFactor(index)}    let radiance = lightColor.rgb * lightMeta.y * attenuation${shadowSlotOf(index) >= 0 ? " * shadow" : ""};
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

  const needsViewDir = lightCount > 0 || environment;
  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, albedo.a);`
      : `  let ambient = params.ambientColor.rgb * params.ambientColor.a;
  var lit = albedo.rgb * ambient;
${
  !needsViewDir
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}${envTerm}  return vec4f(lit, albedo.a);`;

  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,      // rgb colour, a = intensity
  baseColor: vec4f,
  specular: vec4f,          // rgb specular colour, w = shininess
  material: vec4f,          // x = metallic, y = roughness, zw reserved
  grid: vec4f,              // cols, rows, wrapU, wrapV
${lightField}${shadowFields}${envField}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${mapBindings}${shadowBindings}${envDeclarations}
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
  /** T481: casting light indices — see SceneShadingOptions.shadows. */
  shadows?: ReadonlyArray<number>;
  /** T482: equirect environment wired — see SceneShadingOptions.environment. */
  environment?: boolean;
}): string {
  const pointColor = options.pointColor === true;
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const shadows = options.shadows ?? [];
  const shadowSlotOf = (index: number): number => shadows.indexOf(index);
  const shadowFields = shadows.map((_, slot) => `  shadow${slot}Matrix: mat4x4f,\n`).join("");
  const shadowBindings = shadows
    .map((_, slot) => `@group(0) @binding(${5 + slot}) var shadowMap${slot}: texture_2d<f32>;\n`)
    .join("");
  const environment = options.environment === true && options.model === "phong";
  const envBinding = 5 + shadows.length;
  const envDeclarations = environment
    ? `@group(0) @binding(${envBinding}) var environmentMap: texture_2d<f32>;\n`
    : "";
  const envField = environment ? "  environment: vec4f,   // x = intensity\n" : "";
  const envTerm = environment
    ? `  let reflectDir = reflect(-viewDir, normal);
  let envUv = vec2f(
    atan2(reflectDir.x, -reflectDir.z) / 6.2831853 + 0.5,
    acos(clamp(reflectDir.y, -1.0, 1.0)) / 3.14159265,
  );
  let envDims = vec2f(textureDimensions(environmentMap, 0));
  let envColor = textureLoad(environmentMap, vec2i(clamp(envUv, vec2f(0.0), vec2f(1.0)) * (envDims - vec2f(1.0))), 0).rgb;
  lit += envColor * params.specular.rgb * (1.0 - params.material.y) * params.environment.x;
`
    : "";
  const shadowFactor = (index: number): string => {
    const slot = shadowSlotOf(index);
    if (slot < 0) return "";
    return `    var shadow = 1.0;
    {
      let sc = params.shadow${slot}Matrix * vec4f(input.world, 1.0);
      let suv = vec2f(sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5);
      if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0 && sc.z <= 1.0) {
        let sdims = vec2f(textureDimensions(shadowMap${slot}, 0));
        let stored = textureLoad(shadowMap${slot}, vec2i(suv * (sdims - vec2f(1.0))), 0).r;
        if (sc.z - 0.002 > stored) { shadow = 0.0; }
      }
    }
`;
  };
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
${shadowFactor(index)}    let radiance = lightColor.rgb * lightMeta.y * attenuation${shadowSlotOf(index) >= 0 ? " * shadow" : ""};
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
  const needsViewDir = lightCount > 0 || environment;
  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, albedo.a);`
      : `  let ambient = params.ambientColor.rgb * params.ambientColor.a;
  var lit = albedo.rgb * ambient;
${
  !needsViewDir
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}${envTerm}  return vec4f(lit, albedo.a);`;

  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,
  baseColor: vec4f,
  specular: vec4f,
  material: vec4f,
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
${lightField}${shadowFields}${envField}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${shadowBindings}${envDeclarations}
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


/**
 * T481: the SHADOW pass shaders — the scene's own analytic vertex generation with the
 * shading stripped, drawing LIGHT-SPACE CLIP DEPTH into an r32float colour target.
 * Not the depth aspect: binding one as a texture would be new resource plumbing, and
 * r32float is renderable everywhere with the float32-filterable compile gate already
 * standing (we read it with textureLoad, so even that gate never fires).
 *
 * The far plate (`SHADOW_CLEAR_WGSL`) paints depth 1.0 across the target first, the
 * same way the render's backdrop paints its background (T444): a cleared shadow map
 * must read "nothing here", and the target's own clear colour is not ours to choose.
 */
export const SHADOW_CLEAR_WGSL = `@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.9999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`;

/** The surface mesh from the light's view — grid arithmetic identical to the lit draw. */
export function shadowSurfaceWgsl(): string {
  return `struct ShadowParams {
  lightViewProjection: mat4x4f,
  grid: vec4f,              // cols, rows, wrapU, wrapV
};

@group(0) @binding(0) var<uniform> params: ShadowParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;

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

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) depth: f32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let cols = u32(params.grid.x);
  let wrapU = params.grid.z > 0.5;
  let cellsU = select(cols - 1u, cols, wrapU);
  let quad = vertex / 6u;
  let corner = cellCorner(vertex % 6u);
  let gx = (quad % cellsU) + corner.x;
  let gy = (quad / cellsU) + corner.y;
  let clip = params.lightViewProjection * vec4f(gridPosition(gx, gy), 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = clip.z;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.depth, 0.0, 0.0, 1.0);
}`;
}

/** The instance primitives from the light's view — shapes identical to the lit draw. */
export function shadowInstancesWgsl(): string {
  return `struct ShadowParams {
  lightViewProjection: mat4x4f,
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
};

@group(0) @binding(0) var<uniform> params: ShadowParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;

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

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) depth: f32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let world = shapeVertex(shape, v) * params.instance.x + positions[instance];
  let clip = params.lightViewProjection * vec4f(world, 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = clip.z;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.depth, 0.0, 0.0, 1.0);
}`;
}
