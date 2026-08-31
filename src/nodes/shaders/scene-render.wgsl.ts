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
   * phong) adds its reflection — sampled along R, scaled by (1−roughness), the
   * specular tint and (T632) a SCHLICK FRESNEL factor, per T428's preserved IBL-lite
   * plan. Lambert and unlit ignore it, STATED on the input rather than silently
   * (V349). Absent emits byte-identical text.
   */
  readonly environment?: boolean;
  /**
   * T624: an ambient-occlusion map is bound, indexed by SCREEN PIXEL, and multiplies
   * the ambient and environment terms. Not the direct lights: occlusion says how much
   * of the surroundings a point can see, and the key light arrives from one direction
   * whether or not the neighbourhood is enclosed. Absent emits byte-identical text.
   */
  readonly ambientOcclusion?: boolean;
}

/**
 * T632 — the SCHLICK FRESNEL factor on the environment reflection, shared verbatim by
 * both generators so the surface and the instances cannot drift apart.
 *
 * The gap it closes (named by E33-Obol's author): an IBL-lite reflection along R with
 * NO view-dependent term reflects the same amount head-on as at a grazing angle, and a
 * dark surface that reflects its surroundings equally in every direction is a METAL.
 * What separates oil from chrome is that a dielectric reflects ~4% head-on and rises to
 * 1.0 at grazing incidence — so the environment shows only at the silhouette and the
 * body of the object stays dark.
 *
 * F0 is a SCALAR, mix(0.04, 1.0, metallic), and the reflection's COLOUR stays
 * `params.specular.rgb`, which the compiler already sets to mix(white, baseColor,
 * metallic) for a PBR material. The product is the textbook mix(vec3(0.04), albedo,
 * metallic) at both ends of `metallic` — a dielectric's 4% white base, a metal's own
 * albedo — while a Phong material keeps its authored specular tint as the tint of the
 * reflection. Two consequences worth stating: at metallic = 1 the factor is exactly 1
 * at every angle, so METALS ARE BYTE-IDENTICAL to what shipped before this; and for
 * everything else the factor is ≤ 1, so the environment term can only DECREASE and its
 * grazing value is exactly the value the whole surface used to carry.
 *
 * `abs(dot(N, V))` rather than `max(…, 0)`: a surface has no wrong side here (T301's
 * two-sided rule, kept by the lambert and the highlight above), and clamping a back
 * face to zero would flare it to a full-strength reflection instead of a grazing one.
 * The outer `max(…, 0.0)` only guards pow() against a negative base from float slop.
 *
 * Roughness keeps its LINEAR (1 − roughness) scale, deliberately, and it multiplies
 * this factor rather than being folded into it. That factor is the crude stand-in for
 * a prefiltered environment we do not have; leaving it outside means it still caps the
 * grazing reflection at the value that material reflected before, so no rough surface
 * can develop an edge glow it did not already have, and a rough METAL keeps its
 * dimming instead of snapping back to a mirror.
 */
const FRESNEL_WGSL = `  let envF0 = mix(0.04, 1.0, params.material.x);
  let envFresnel = envF0 + (1.0 - envF0) * pow(max(1.0 - abs(dot(normal, viewDir)), 0.0), 5.0);
`;

/**
 * T636 — the DIFFUSE half of the environment, shared verbatim by both generators.
 *
 * The gap the Fresnel work exposed: the IBL-lite had only the SPECULAR half, so when
 * T632 correctly removed the head-on reflection from a dielectric there was nothing
 * physical left to fill its shadows, and `environmentIntensity` had to stand in by
 * hand — E33 needed a 7× re-exposure that was a tuning constant doing a missing
 * term's job.
 *
 * The term is an irradiance lookup along N — five taps averaged over a wide cone,
 * because the equirect has no prefiltered mips to sample and five texel fetches are
 * the IBL-lite answer, an approximation stated as one — times the surface's DIFFUSE
 * reflectance (`albedo`, never the specular tint), times `(1 − F) · (1 − metallic)`:
 * energy the surface did not reflect specularly is what is available to the diffuse
 * half, and a metal has none. That factor is also what finally makes `metallic` mean
 * something for the diffuse term rather than only the specular one.
 *
 * Two properties, both deliberate and both gated:
 *  - AT GRAZING THE TERM IS ZERO. (1 − F) → 0 exactly where the specular ceiling
 *    (§V571) is doing its work, so the silhouette carries only what it carried
 *    before — this term can add no edge glow, ever.
 *  - A METAL GAINS NOTHING, at any angle: (1 − metallic) is a hard zero at
 *    metallic = 1, so every metal stays byte-identical to what shipped.
 *
 * It DOES brighten dielectric bodies facing the environment — that is its entire
 * job, it is what the hand-tuned intensity was standing in for, and it is why the
 * blast radius was measured by hashing every example's pass WGSL rather than
 * asserted (exactly the scenes that wire an environment change, nothing else).
 *
 * The sampling normal faces the viewer (`sign(dot(N, V))`) — the two-sided rule
 * (T301) applied to irradiance: a back face is lit by the hemisphere it shows the
 * camera, not by the one behind it. Roughness is deliberately absent: Lambertian
 * irradiance does not sharpen with polish, and tying it in would re-dim rough
 * dielectrics that this term exists to fill.
 */
const IRRADIANCE_WGSL = `  let envN = normal * select(-1.0, 1.0, dot(normal, viewDir) >= 0.0);
  let envUp = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(envN.y) > 0.9);
  let envTx = normalize(cross(envUp, envN));
  let envTy = cross(envN, envTx);
  let irradiance = (sampleEnvironment(envN)
    + sampleEnvironment(normalize(envN + envTx))
    + sampleEnvironment(normalize(envN - envTx))
    + sampleEnvironment(normalize(envN + envTy))
    + sampleEnvironment(normalize(envN - envTy))) / 5.0;
`;

/** The equirect fetch, shared by the reflection and the five irradiance taps (T636). */
const ENV_SAMPLE_WGSL = `fn sampleEnvironment(direction: vec3f) -> vec3f {
  let uv = vec2f(
    atan2(direction.x, -direction.z) / 6.2831853 + 0.5,
    acos(clamp(direction.y, -1.0, 1.0)) / 3.14159265,
  );
  let dims = vec2f(textureDimensions(environmentMap, 0));
  return textureLoad(environmentMap, vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0))), 0).rgb;
}
`;

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
        /* T624 look pass: a CONSTANT bias acnes at the terminator, and every curved
           object has one. Depth per shadow texel grows as 1/|N·L|, so the bias has to
           grow with it — measured on E33, where 0.002 flat put a dotted crescent across
           the lit half of a medallion and this removes it without visible peter-panning
           (the slope term only reaches its maximum where the light is already grazing
           and the surface is dark anyway). */
        let bias = 0.0015 + 0.012 * (1.0 - lambert);
        if (sc.z - bias > stored) { shadow = 0.0; }
      }
    }
`;
  };
  const environment = options.environment === true && options.model === "phong";
  const envBinding = 5 + shadows.length;
  const envDeclarations = environment
    ? `@group(0) @binding(${envBinding}) var environmentMap: texture_2d<f32>;\n${ENV_SAMPLE_WGSL}`
    : "";
  const envField = environment ? "  environment: vec4f,   // x = intensity\n" : "";
  /* Equirect, documented exactly: u = atan2(R.x, −R.z)/2π + 0.5, v = acos(R.y)/π. */
  /* T624: bound after the environment, so a scene without AO emits the same bindings
     it always did and a scene with it needs no renumbering of the shadow slots. */
  const ambientOcclusion = options.ambientOcclusion === true && options.model !== "unlit";
  const aoBinding = envBinding + (environment ? 1 : 0);
  const aoDeclarations = ambientOcclusion
    ? `@group(0) @binding(${aoBinding}) var occlusionMap: texture_2d<f32>;\n`
    : "";
  const aoTerm = ambientOcclusion ? " * occlusion" : "";
  const envTerm = environment
    ? `  let envColor = sampleEnvironment(reflect(-viewDir, normal));
${FRESNEL_WGSL}  lit += envColor * params.specular.rgb * envFresnel * (1.0 - roughness) * params.environment.x${aoTerm};
${IRRADIANCE_WGSL}  lit += irradiance * albedo.rgb * (1.0 - envFresnel) * (1.0 - params.material.x) * params.environment.x${aoTerm};
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
  const aoLookup = ambientOcclusion
    ? `  let occlusion = textureLoad(occlusionMap, vec2i(input.position.xy), 0).r;\n`
    : "";
  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, albedo.a);`
      : `${aoLookup}  let ambient = params.ambientColor.rgb * params.ambientColor.a${aoTerm};
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
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${mapBindings}${shadowBindings}${envDeclarations}${aoDeclarations}
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
/** T642: the group option both instance generators take — the draw and its shadow. */
export interface SceneGroupOption {
  expression: string;
  binds: ReadonlyArray<{ attribute: string; type: string }>;
}

/** The per-instance gate, emitted identically into the lit draw and the depth pass. */
function groupBlocks(
  group: SceneGroupOption | undefined,
  baseBinding: number,
  gatedReturn: string,
): { bindings: string; declarations: string; gate: string } {
  if (group === undefined) return { bindings: "", declarations: "", gate: "" };
  const bindings = group.binds
    .map(
      (bind, index) =>
        `@group(0) @binding(${baseBinding + index}) var<storage, read> group_${bind.attribute}: array<${bind.type}>;\n`,
    )
    .join("");
  const declarations = `
struct GroupPoint {
${group.binds.map((bind) => `  ${bind.attribute}: ${bind.type},`).join("\n")}
};

fn groupMatch(p: GroupPoint) -> bool {
  return (${group.expression});
}
`;
  const gate = `  var gp: GroupPoint;
${group.binds.map((bind) => `  gp.${bind.attribute} = group_${bind.attribute}[instance];`).join("\n")}
  if (!groupMatch(gp)) {
    /* Excluded: every vertex lands on one clip-space point — zero area, no cost (§V219). */
${gatedReturn}
  }
`;
  return { bindings, declarations, gate };
}

export function sceneInstancesWgsl(options: {
  model: "unlit" | "lambert" | "phong";
  lightCount: number;
  /** T478: a vec4f attribute multiplies the base colour per point (the geometry's mapped tint). */
  pointColor?: boolean;
  /** T481: casting light indices — see SceneShadingOptions.shadows. */
  shadows?: ReadonlyArray<number>;
  /** T482: equirect environment wired — see SceneShadingOptions.environment. */
  environment?: boolean;
  /** T624: an occlusion map is bound — see SceneShadingOptions.ambientOcclusion. */
  ambientOcclusion?: boolean;
  /**
   * T642: §V471's selection idiom through the shared camera and depth buffer. The SAME
   * {expression, binds} `resolveGroupPredicate` hands renderPoints (§V349: one
   * resolver, one concept), executed as renderPoints executes it: a per-instance
   * vertex gate that collapses every excluded instance's vertices onto one point —
   * zero area, no discard, no indirect rewrite, no fragment work (§V219). Excluded
   * instances therefore cost `shapeVertexCount` trivial vertex invocations and
   * nothing else, which is why a predicate needed no T481/T624-style pricing (§V605).
   * Each referenced attribute is one storage buffer against the BASELINE 8 per stage.
   */
  group?: SceneGroupOption;
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
    ? `@group(0) @binding(${envBinding}) var environmentMap: texture_2d<f32>;\n${ENV_SAMPLE_WGSL}`
    : "";
  const envField = environment ? "  environment: vec4f,   // x = intensity\n" : "";
  /* T624 — see the surface generator: bound after the environment, ambient and
     environment only, byte-identical when absent. */
  const ambientOcclusion = options.ambientOcclusion === true && options.model !== "unlit";
  const aoBinding = envBinding + (environment ? 1 : 0);
  const aoDeclarations = ambientOcclusion
    ? `@group(0) @binding(${aoBinding}) var occlusionMap: texture_2d<f32>;\n`
    : "";
  const aoTerm = ambientOcclusion ? " * occlusion" : "";
  /* T642: the group binds come last in the numbering, after every optional texture. */
  const group = groupBlocks(
    options.group,
    aoBinding + (ambientOcclusion ? 1 : 0),
    `    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 2.0, 1.0);
    gated.normal = vec3f(0.0, 0.0, 1.0);
    gated.world = vec3f(0.0);
    gated.tint = vec4f(0.0);
    return gated;`,
  );
  const envTerm = environment
    ? `  let envColor = sampleEnvironment(reflect(-viewDir, normal));
${FRESNEL_WGSL}  lit += envColor * params.specular.rgb * envFresnel * (1.0 - params.material.y) * params.environment.x${aoTerm};
${IRRADIANCE_WGSL}  lit += irradiance * albedo.rgb * (1.0 - envFresnel) * (1.0 - params.material.x) * params.environment.x${aoTerm};
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
        /* T624 look pass: a CONSTANT bias acnes at the terminator, and every curved
           object has one. Depth per shadow texel grows as 1/|N·L|, so the bias has to
           grow with it — measured on E33, where 0.002 flat put a dotted crescent across
           the lit half of a medallion and this removes it without visible peter-panning
           (the slope term only reaches its maximum where the light is already grazing
           and the surface is dark anyway). */
        let bias = 0.0015 + 0.012 * (1.0 - lambert);
        if (sc.z - bias > stored) { shadow = 0.0; }
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
  const aoLookup = ambientOcclusion
    ? `  let occlusion = textureLoad(occlusionMap, vec2i(input.position.xy), 0).r;\n`
    : "";
  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb, albedo.a);`
      : `${aoLookup}  let ambient = params.ambientColor.rgb * params.ambientColor.a${aoTerm};
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
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${shadowBindings}${envDeclarations}${aoDeclarations}${group.bindings}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) tint: vec4f,
};
${group.declarations}

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
${group.gate}  let shape = u32(params.instance.y);
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

/**
 * T624: the same depth-only draw serves the AO prepass. `linearDepth` swaps the stored
 * value from LIGHT-SPACE CLIP DEPTH to LINEAR VIEW DISTANCE over the far plane — one
 * extra uniform row and one changed expression, so the grid/primitive vertex arithmetic
 * has exactly one implementation rather than a shadow copy and an AO copy that drift.
 * `dot(depthRow, vec4f(world, 1))` is affine in world position, so interpolating it
 * across a triangle is exact. Absent, the emitted text is byte-identical (§V309).
 */
export interface DepthPassOptions {
  readonly linearDepth?: boolean;
}

/** The surface mesh from the light's view — grid arithmetic identical to the lit draw. */
export function shadowSurfaceWgsl(options: DepthPassOptions = {}): string {
  const linear = options.linearDepth === true;
  const depthExpr = linear
    ? `dot(params.depthRow, vec4f(gridPosition(gx, gy), 1.0)) / max(params.depthRange.x, 1e-6)`
    : `clip.z`;
  const linearFields = linear
    ? `  depthRow: vec4f,         // dot(depthRow, vec4f(world,1)) = linear view distance
  depthRange: vec4f,       // x = far plane
`
    : "";
  return `struct ShadowParams {
  lightViewProjection: mat4x4f,
  grid: vec4f,              // cols, rows, wrapU, wrapV
${linearFields}};

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
  out.depth = ${depthExpr};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.depth, 0.0, 0.0, 1.0);
}`;
}

/** The instance primitives from the light's view — shapes identical to the lit draw. */
export function shadowInstancesWgsl(options: DepthPassOptions & { group?: SceneGroupOption } = {}): string {
  const linear = options.linearDepth === true;
  /* T642: an excluded instance must not cast a GHOST SHADOW — the depth pass gates on
     the same predicate, from the same shared block, or an invisible instance would
     still darken the ground beneath where it is not. Binding 2: after params(0) and
     positions(1), and this pass binds nothing else. */
  const group = groupBlocks(
    options.group,
    2,
    `    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 2.0, 1.0);
    gated.depth = 1.0;
    return gated;`,
  );
  const depthExpr = linear
    ? `dot(params.depthRow, vec4f(world, 1.0)) / max(params.depthRange.x, 1e-6)`
    : `clip.z`;
  const linearFields = linear
    ? `  depthRow: vec4f,         // dot(depthRow, vec4f(world,1)) = linear view distance
  depthRange: vec4f,       // x = far plane
`
    : "";
  return `struct ShadowParams {
  lightViewProjection: mat4x4f,
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
${linearFields}};

@group(0) @binding(0) var<uniform> params: ShadowParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${group.bindings}
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
${group.declarations}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${group.gate}  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let world = shapeVertex(shape, v) * params.instance.x + positions[instance];
  let clip = params.lightViewProjection * vec4f(world, 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = ${depthExpr};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.depth, 0.0, 0.0, 1.0);
}`;
}
