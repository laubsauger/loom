/**
 * Scene-payload PREVIEWS (T462, §V85): a material, a light or a camera is a THING whose
 * whole job is a look, and until this file each one showed nothing. Every preview here
 * is the node's OWN payload rendered into a tiny stock scene — never a borrowed
 * downstream image, which goes blank exactly when nothing is connected (the argument
 * that settled T373's pointset previews, unchanged).
 *
 * Three stocks:
 *  - MATERIAL → a tilted TORUS under a fixed warm key and cool fill. The universal
 *    material preview; albedo, maps, roughness and specular readable at a glance.
 *  - LIGHT → a BALL in the default grey material, lit by ONLY this light with
 *    zero ambient. A light at zero intensity previews black — true, and the point.
 *  - CAMERA → a stock reference scene (checker ground, axis-coloured box) seen
 *    through the camera's own matrix: fov, position and orientation in one look.
 *
 * T665 — WHY THE MATERIAL STOCK IS NOT THE BALL. A sphere is the worst available form
 * for reading a material: every point curves AWAY from the viewer, so specular and
 * Fresnel only ever behave one way; nothing on it occludes anything else; its
 * silhouette is a disc from every angle; and its UV wraps ONCE, so a map that tiles
 * badly tiles invisibly. A torus answers all four — it has concave sweep on the inner
 * tube, the near tube hides its own inner wall (which is what makes the hole read as a
 * hole rather than as a painted ring), its silhouette says which way it faces, and it
 * wraps in BOTH u and v so a map's repeat and its seams are on screen.
 * This is why TD's MATs and the other material tools preview on a torus, not a ball.
 * The LIGHT stock deliberately stays a ball: a light preview reads falloff and the
 * terminator across a KNOWN form, and a torus's apparent self-occlusion — which this
 * shader does not actually shadow — would confound the light with the shape.
 *
 * Everything is ANALYTIC — the torus, the sphere, the plane, the box all come from the
 * vertex index — so a preview binds no buffers and borrows nothing from the graph except
 * the payload values in its uniforms (and a material's map textures, which ARE its look).
 * The BACKGROUND is painted by the same draw (first six vertices, far depth): §V384,
 * learned from E25's invisible screen — an unlit form on unpainted black is no preview.
 *
 * Uniform field names match the scene Render's `SceneParams` (light triples included),
 * so the packing code in compile.ts reads like the render's and the animate path drives
 * an orbiting light's preview as a value update (§V5).
 */

/**
 * Tessellation, shared by both stocks: a LON×LAT cell grid, two triangles per cell.
 * The ball wraps longitude and leaves latitude open (pole to pole); the torus wraps
 * BOTH, which changes which vertices coincide but not how many cells there are — so
 * the vertex count below is one number for both and compile.ts needs no second export.
 */
const LON_CELLS = 40;
const LAT_CELLS = 27;

/** Six background vertices, then the stock's cells. */
export const SCENE_PREVIEW_BALL_VERTEX_COUNT = 6 + LON_CELLS * LAT_CELLS * 6;

/**
 * R + r = 1.0 exactly, so the torus's farthest point from the origin is the same
 * distance the unit ball's was: the stock camera in compile.ts frames both identically
 * and no camera constant moves for T665.
 */
const TORUS_MAJOR = 0.72;
const TORUS_MINOR = 0.28;

/**
 * The tilt is not decoration — it is what makes the form informative, and it is bounded
 * on BOTH sides. The hole axis is +y, and the stock camera looks straight down -z, so an
 * untilted torus is seen exactly edge-on: a bar, as blind as the ball it replaced. Tilt
 * it too far and it is a flat ring, equally blind. You can see THROUGH the hole only
 * while the view direction sits within atan((R - r) / r) = atan(0.44 / 0.28) ≈ 57.5° of
 * the axis, i.e. only above a ~32.5° tilt — and the angle was then CHOSEN by rendering
 * 30/35/45/55/65 and looking: at 30° the hole is a slit, at 65° the near tube's convex
 * sweep has collapsed and it reads as a flat painted ring. 45° sits in the middle of
 * that window. `scene-preview.gpu.test.ts` pins the consequence rather than the angle:
 * the tile centre is BACKGROUND, which a sphere can never be.
 */
const TORUS_TILT_RADIANS = Math.PI / 4;

export interface ScenePreviewBallOptions {
  /**
   * Which stock form. `torus` is the MATERIAL preview (see the T665 note above);
   * `ball` is the LIGHT preview, whose whole job is a known form under one light.
   */
  readonly stock: "ball" | "torus";
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

  /*
   * The stock's geometry, emitted for the chosen form only — a preview should not carry
   * the other stock's dead code into the module it compiles.
   *
   * Both are position AND normal from the vertex index alone. The ball's normal is a
   * special case that does not generalise: on a UNIT sphere the outward normal happens
   * to equal the position, which is why the old code could get away with assigning one
   * to the other. On a torus it is false — the outward normal is the TUBE's radial
   * direction, which is the same parameterisation with the major radius dropped. It is
   * written analytically here rather than differenced from neighbouring samples,
   * because it IS analytic and a difference would only add tessellation error.
   */
  const tiltCos = Math.cos(TORUS_TILT_RADIANS);
  const tiltSin = Math.sin(TORUS_TILT_RADIANS);
  const stockCode =
    options.stock === "torus"
      ? `fn torusPoint(u: f32, v: f32) -> vec3f {
  let phi = u * 6.2831853;
  let theta = v * 6.2831853;
  let ring = ${TORUS_MAJOR} + ${TORUS_MINOR} * cos(theta);
  return vec3f(ring * sin(phi), ${TORUS_MINOR} * sin(theta), ring * cos(phi));
}

fn torusNormal(u: f32, v: f32) -> vec3f {
  let phi = u * 6.2831853;
  let theta = v * 6.2831853;
  return vec3f(cos(theta) * sin(phi), sin(theta), cos(theta) * cos(phi));
}

/* One rotation about x for both, so the normal stays the surface's own. */
fn torusTilt(p: vec3f) -> vec3f {
  return vec3f(p.x, p.y * ${tiltCos} - p.z * ${tiltSin}, p.y * ${tiltSin} + p.z * ${tiltCos});
}`
      : `fn spherePoint(gx: u32, gy: u32) -> vec3f {
  let u = f32(gx % ${LON_CELLS}u) / ${LON_CELLS}.0;
  let v = f32(gy) / ${LAT_CELLS}.0;
  let theta = v * 3.14159265;
  let phi = u * 6.2831853;
  return vec3f(sin(theta) * sin(phi), cos(theta), sin(theta) * cos(phi));
}`;

  /*
   * BOTH axes wrap on the torus, so the last cell row closes onto the first exactly as
   * the last column already did. The ball leaves latitude open — its poles are single
   * points, not a seam — which is the one line that differs between the two.
   *
   * HONESTY ABOUT THE MODULO (§V500 — an unfalsifiable guard reads as protection and is
   * not one). Both moduli are EXACTNESS, not topology: gy = LAT already gives v = 1 and
   * cos(2π) = cos(0) to within an f32 ulp, so dropping the `% LAT` changes no pixel in
   * any gate below — verified by removing it and watching all six tests stay green. It
   * earns its place by making the seam row BIT-IDENTICAL to row zero rather than merely
   * equal to it, which is the same reason the ball's longitude already carried one; it
   * does not earn a test, and pretending otherwise would be the decoration §V500 warns
   * about.
   */
  const stockVertex =
    options.stock === "torus"
      ? `  let u = f32(gx % ${LON_CELLS}u) / ${LON_CELLS}.0;
  let v = f32(gy % ${LAT_CELLS}u) / ${LAT_CELLS}.0;
  let world = torusTilt(torusPoint(u, v));
  let normal = torusTilt(torusNormal(u, v));`
      : `  let world = spherePoint(gx, gy);
  /* A unit sphere's outward normal IS its position — true HERE and nowhere else. */
  let normal = world;`;

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

${stockCode}

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
${stockVertex}
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = normal;
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
