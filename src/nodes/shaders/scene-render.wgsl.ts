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
  /**
   * T704: PROJECTORS, in reference order — each an additive LIGHT whose beam carries
   * its cookie (§V644: light contribution, never an albedo tint). Slot p owns the
   * `projector{p}…` uniform rows and its optional cookie/depth textures, numbered
   * after the AO map. Unlit materials ignore projectors exactly as they ignore
   * lights. Empty or absent emits byte-identical text (§V309).
   */
  readonly projectors?: ReadonlyArray<SceneProjectorOption>;
}

/** T704: what is STRUCTURAL about one referenced projector — its bindings. */
export interface SceneProjectorOption {
  /** A cookie texture is wired; unwired projects plain white (a focus light). */
  readonly cookie: boolean;
  /** A depth map is bound and compared — surfaces the projector cannot see get nothing. */
  readonly occlusion: boolean;
}

/**
 * T704 — the projector uniform rows, bindings and fragment term, shared verbatim by
 * both generators (§V349: the surface and the instances cannot drift apart).
 *
 * The read side is the T481 shadow read PLUS THE W-DIVIDE: a projector's matrix is a
 * perspective frustum, so `pc.xyz / pc.w` is the step the ortho shadow read never
 * needed, and the depth it compares is the fragment-z the perspective depth sweep
 * stores (`input.position.z`, already divided by the rasterizer). Falloff is
 * inverse-square about the THROW DISTANCE — brightness is nominal AT the look-at —
 * and it is a value switch (`Color.w`), not a shader variant, so toggling it animates.
 */
function projectorBlocks(
  projectors: ReadonlyArray<SceneProjectorOption>,
  baseBinding: number,
): { fields: string; bindings: string; term: string; bindingCount: number } {
  let binding = baseBinding;
  const fields = projectors
    .map(
      (_, p) => `  projector${p}Matrix: mat4x4f,
  projector${p}Pos: vec4f,    // xyz = lens position, w = brightness (nominal at look-at)
  projector${p}Color: vec4f,  // rgb = tint, w = falloff switch (0 off, 1 inverse-square)
  projector${p}Meta: vec4f,   // x = throw distance |lookAt - eye|, yzw reserved
`,
    )
    .join("");
  const bindings = projectors
    .map((proj, p) => {
      const cookie = proj.cookie ? `@group(0) @binding(${binding++}) var projectorCookie${p}: texture_2d<f32>;\n` : "";
      const depth = proj.occlusion ? `@group(0) @binding(${binding++}) var projectorDepth${p}: texture_2d<f32>;\n` : "";
      return cookie + depth;
    })
    .join("");
  const term = projectors
    .map((proj, p) => {
      const cookieExpr = proj.cookie
        ? `textureLoad(projectorCookie${p}, vec2i(clamp(puv, vec2f(0.0), vec2f(1.0)) * (vec2f(textureDimensions(projectorCookie${p}, 0)) - vec2f(1.0))), 0).rgb`
        : "vec3f(1.0)";
      const occlusionBlock = proj.occlusion
        ? `      let ddims = vec2f(textureDimensions(projectorDepth${p}, 0));
      let stored = textureLoad(projectorDepth${p}, vec2i(puv * (ddims - vec2f(1.0))), 0).r;
      /* The T624 slope-scaled bias, reused: fragment-z on both sides of the compare. */
      let bias = 0.0015 + 0.012 * (1.0 - plambert);
      if (pndc.z - bias > stored) { beam = 0.0; }
`
        : "";
      return `  {
    let pc = params.projector${p}Matrix * vec4f(input.world, 1.0);
    /* Behind the lens (w <= 0) is outside the beam — the divide would mirror it in. */
    if (pc.w > 1e-4) {
      let pndc = pc.xyz / pc.w;
      let puv = vec2f(pndc.x * 0.5 + 0.5, 0.5 - pndc.y * 0.5);
      if (puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0 && pndc.z >= 0.0 && pndc.z <= 1.0) {
        let poffset = params.projector${p}Pos.xyz - input.world;
        let pdist = max(length(poffset), 1e-4);
        /* Two-sided, like every light here (T301's rule). */
        let plambert = abs(dot(normal, poffset / pdist));
        var beam = 1.0;
${occlusionBlock}        let nominal = max(params.projector${p}Meta.x, 1e-4);
        let pfalloff = select(1.0, (nominal * nominal) / (pdist * pdist), params.projector${p}Color.w > 0.5);
        let cookie = ${cookieExpr};
        lit += albedo.rgb * cookie * params.projector${p}Color.rgb * params.projector${p}Pos.w * pfalloff * plambert * beam;
      }
    }
  }
`;
    })
    .join("");
  return { fields, bindings, term, bindingCount: binding - baseBinding };
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

/**
 * T659 — the BACKDROP, which until now could only ever be a flat colour.
 *
 * The gap the owner found by looking: `sampleEnvironment` appears in exactly two places
 * — the reflection vector and the five irradiance taps — and NO pass ever renders it.
 * So a wired environment was taking as LIGHT ONLY, and the visible sky behind a scene
 * was the backdrop colour, always. "Is the sky band taking, or are we using a skybox?"
 * had the answer "neither": it was taking, and it was never drawn.
 *
 * `environment: false` returns the T444 backdrop VERBATIM, which is why every scene that
 * does not opt in is byte-identical (§V461's other end, measured by hashing pass WGSL
 * across the catalogue rather than asserted).
 *
 * With it on, the same equirect fetch the reflection uses is read along a camera ray
 * through each pixel — one function, so the sky and its own reflection cannot drift
 * apart (§V349). The ray is built from a basis handed in as uniforms, `right` and `up`
 * PRE-SCALED by the frustum's half-extents, so the fragment shader does one add and one
 * normalize and the trigonometry lives on the CPU where the camera already is.
 *
 * Depth is untouched: it still writes 0.999 and every geometry draws over it, exactly as
 * the colour backdrop did. This is a background, not an object.
 *
 * ORTHOGRAPHIC cameras get a CONSTANT direction, and that is correct rather than
 * degenerate: parallel rays see one point of an environment at infinity. Stated because
 * a flat sky under an ortho camera otherwise reads as a bug (§V403).
 */
export function backdropWgsl(options: { readonly environment?: boolean } = {}): string {
  if (options.environment !== true) {
    return `struct Backdrop { color: vec4f };
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return backdrop.color; }`;
  }
  return `struct Backdrop {
  color: vec4f,       // rgb unused when the environment draws; a = the backdrop's alpha
  right: vec4f,       // camera right × tan(fovY/2) × aspect (zero under an ortho camera)
  up: vec4f,          // camera up × tan(fovY/2)             (zero under an ortho camera)
  forward: vec4f,     // unit view direction; w = environment intensity
};
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@group(0) @binding(1) var environmentMap: texture_2d<f32>;
${ENV_SAMPLE_WGSL}
struct BackdropOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
};
@vertex
fn vs(@builtin(vertex_index) v: u32) -> BackdropOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  var out: BackdropOut;
  out.position = vec4f(corners[v], 0.999, 1.0);
  out.ndc = corners[v];
  return out;
}
@fragment
fn fs(input: BackdropOut) -> @location(0) vec4f {
  let direction = normalize(
    backdrop.forward.xyz + input.ndc.x * backdrop.right.xyz + input.ndc.y * backdrop.up.xyz,
  );
  return vec4f(sampleEnvironment(direction) * backdrop.forward.w, backdrop.color.a);
}`;
}

/**
 * T725 — the surface MESH chunk (grid connectivity, central-difference normals, uv,
 * tint), extracted verbatim so the lit generator and the glass generator share one
 * source (§V349). The lit template's emitted text is byte-identical to before the
 * extraction — the golden scene hashes are the proof.
 */
function surfaceMeshWgsl(pointColor: boolean): string {
  return `struct VertexOut {
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
}`;
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
  /* T704: projectors are LIGHTS, so an unlit material takes none (mirrors the light
     blocks, which unlit never reaches). Bound after the AO map. */
  const projectors = projectorBlocks(
    options.model === "unlit" ? [] : options.projectors ?? [],
    aoBinding + (ambientOcclusion ? 1 : 0),
  );
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
      ? `  return vec4f(albedo.rgb * cover, albedo.a * cover);`
      : `${aoLookup}  let ambient = params.ambientColor.rgb * params.ambientColor.a${aoTerm};
  var lit = albedo.rgb * ambient;
${
  !needsViewDir
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}${projectors.term}${envTerm}  return vec4f(lit * cover, albedo.a * cover);`;

  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,      // rgb colour, a = intensity
  baseColor: vec4f,
  specular: vec4f,          // rgb specular colour, w = shininess
  material: vec4f,          // x = metallic, y = roughness, zw reserved
  grid: vec4f,              // cols, rows, wrapU, wrapV
${lightField}${shadowFields}${envField}${projectors.fields}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${mapBindings}${shadowBindings}${envDeclarations}${aoDeclarations}${projectors.bindings}
${surfaceMeshWgsl(pointColor)}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let magnitude = length(input.normal);
  let normal = select(vec3f(0.0, 0.0, 1.0), input.normal / max(magnitude, 1e-6), magnitude > 1e-6);
  /* T917: the soft profile lives on the point primitives; a SURFACE has no across axis,
     so its coverage is the constant 1 and the shared shading tail multiplies by nothing. */
  let cover = 1.0;
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
/**
 * T725 — the instance PRIMITIVES chunk (quad/box/octahedron from the vertex index,
 * analytic normals), extracted verbatim so the lit generator and the glass generator
 * share one source (§V349). Byte-identical to the pre-extraction inline text.
 */
const INSTANCE_SHAPES_WGSL = `fn quadCorner(v: u32) -> vec2f {
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
}`;

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
  /**
   * T721: an f32 attribute — or one channel of a float vector — multiplies the instance
   * SCALE per point, exactly as `pointColor` multiplies the base colour. Absent, not one
   * byte of this shader changes (§V309).
   */
  pointScale?: { type: string; channel?: string };
  /** T481: casting light indices — see SceneShadingOptions.shadows. */
  shadows?: ReadonlyArray<number>;
  /** T482: equirect environment wired — see SceneShadingOptions.environment. */
  environment?: boolean;
  /** T624: an occlusion map is bound — see SceneShadingOptions.ambientOcclusion. */
  ambientOcclusion?: boolean;
  /** T704: referenced projectors — see SceneShadingOptions.projectors. */
  projectors?: ReadonlyArray<SceneProjectorOption>;
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
  /**
   * T647: POINTS mode — a camera-facing billboard per point through this same
   * machinery (same lights, same environment, same group gate — §V349: a third path
   * would have been born broken). The quad expands along camera right/up handed in as
   * uniforms, its normal faces the camera (−forward), and it casts NO shadow: a
   * screen-aligned card has no light-facing geometry, so its shadow would be a lie —
   * the scene loop skips points geometries in the depth pass and says so there.
   */
  billboard?: boolean;
  /**
   * T680: BEAM mode — one quad per point, spanning `positions[i]` → `endpoints[i]`,
   * widened along the one axis the camera can see. Same lights, same environment, same
   * group gate, same depth buffer as the other two (§V349, again): the vertex stage is
   * the only thing that differs, and it differs by where the quad's LONG axis comes
   * from — the camera in billboard mode, the DATA here.
   *
   * It casts no shadow for the same reason a billboard does not (§V610): the ribbon
   * turns to face the viewer, so the silhouette a light would see is not the silhouette
   * anything has. The scene loop skips it in the depth pass and says so there.
   */
  beam?: boolean;
  /**
   * T723: a vec4f attribute holding a unit QUATERNION turns each instance. Instances
   * only — a billboard faces the camera by construction and a beam takes its axis from
   * its endpoints, so neither has a free frame to orient, and the geometry node refuses
   * both by name rather than binding a buffer nothing could read.
   *
   * The binding lands AFTER the group binds, at the very end of the numbering, because
   * T680 and T721 took the last two holes below the shadow maps. Absent, not one byte of
   * this shader changes (§V309).
   */
  pointOrient?: boolean;
}): string {
  const pointColor = options.pointColor === true;
  const billboard = options.billboard === true;
  const beam = options.beam === true;
  const pointOrient = options.pointOrient === true;
  /* T721: binding 4 is the other half of the hole T680 documented below — 3 took the
     beam's endpoints, 4 takes the per-point size, and the shadow maps still start at 5,
     so nothing existing moves. `scaleAt` is 1.0 when nothing is mapped, which is why an
     unmapped geometry's WGSL is unchanged to the byte. */
  const pointScale = options.pointScale;
  const scaleDeclaration =
    pointScale === undefined
      ? ""
      : `@group(0) @binding(4) var<storage, read> pointScales: array<${pointScale.type}>;\n`;
  const scaleAt =
    pointScale === undefined
      ? "params.instance.x"
      : `(params.instance.x * pointScales[instance]${pointScale.channel === undefined ? "" : `.${pointScale.channel}`})`;
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
  /* T704: projector textures after the AO map — see the surface generator. */
  const projectors = projectorBlocks(
    options.model === "unlit" ? [] : options.projectors ?? [],
    aoBinding + (ambientOcclusion ? 1 : 0),
  );
  /* T642: the group binds come last in the numbering, after every optional texture. */
  const groupBinding = aoBinding + (ambientOcclusion ? 1 : 0) + projectors.bindingCount;
  const group = groupBlocks(
    options.group,
    groupBinding,
    `    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 2.0, 1.0);
    gated.normal = vec3f(0.0, 0.0, 1.0);
    gated.world = vec3f(0.0);
    gated.tint = vec4f(0.0);
    return gated;`,
  );
  /* T723: after the group binds, which are themselves last — the two holes below the
     shadow maps went to T680's endpoints and T721's sizes. */
  const orientDeclaration = pointOrient
    ? `@group(0) @binding(${groupBinding + (options.group?.binds.length ?? 0)}) var<storage, read> pointOrients: array<vec4f>;\n`
    : "";
  /**
   * Rotating a vector by a UNIT quaternion, Rodrigues form: two cross products, no
   * matrix and no trig. Right-handed and ACTIVE — q = (0, 0, sin45, cos45) is a +90°
   * turn about +Z and carries +X to +Y, which is the domain fact `scene-orient.gpu.test`
   * pins rather than re-deriving here (§V683: a gate that recomputes the author's own
   * arithmetic agrees with an inverted sign as happily as with a correct one).
   */
  const quaternionHelper = pointOrient
    ? `
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`
    : "";
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
      ? `  return vec4f(albedo.rgb * cover, albedo.a * cover);`
      : `${aoLookup}  let ambient = params.ambientColor.rgb * params.ambientColor.a${aoTerm};
  var lit = albedo.rgb * ambient;
${
  !needsViewDir
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}${projectors.term}${envTerm}  return vec4f(lit * cover, albedo.a * cover);`;

  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,
  baseColor: vec4f,
  specular: vec4f,
  material: vec4f,
  instance: vec4f,          // x = scale (beam: HALF-WIDTH), y = shape (0 quad, 1 box, 2 octahedron), z = beam taper, w = soft profile (T917)
${billboard ? "  billboardRight: vec4f,\n  billboardUp: vec4f,\n" : ""}${lightField}${shadowFields}${envField}${projectors.fields}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${
    /* T680: bindings 3 and 4 have always been free here — the shadow maps start at 5 and
       everything optional is numbered after them — so the beam's second position buffer
       lands in a hole rather than shifting a single existing slot. T721 took the other
       one for the per-point size. */
    beam ? "@group(0) @binding(3) var<storage, read> endpoints: array<vec3f>;\n" : ""
  }${scaleDeclaration}${shadowBindings}${envDeclarations}${aoDeclarations}${projectors.bindings}${group.bindings}${orientDeclaration}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) tint: vec4f,
  /* T917: the primitive's own local coordinate — x is the ACROSS axis (−1..1, beam side /
     billboard corner), y the ALONG one. What the soft profile falls off over; solid
     shapes carry zero and are untouched. */
  @location(3) profile: vec2f,
};
${group.declarations}

${INSTANCE_SHAPES_WGSL}
${quaternionHelper}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${group.gate}${
    beam
      ? `  /* T680: corner.y picks the END (−1 = origin, +1 = endpoint), corner.x the SIDE.
     The width axis is the one direction perpendicular to the beam that the camera can
     actually see — cross(axis, toEye) — so the ribbon turns with the viewer about its
     own length and never goes edge-on and vanishes. */
  let corner = quadCorner(min(vertex, 5u));
  let a = positions[instance];
  let b = endpoints[instance];
  let axis = b - a;
  let along = mix(a, b, corner.y * 0.5 + 0.5);
  let across = cross(axis, params.eye.xyz - along);
  let acrossLen = length(across);
  /* Exactly end-on, or a zero-length beam: divide by nothing and fall back to a fixed
     axis. A zero-length beam still collapses to zero AREA — both ends land on the same
     point — which is the honest reading of a ray that never travelled. */
  let side = select(across / max(acrossLen, 1e-6), vec3f(1.0, 0.0, 0.0), acrossLen < 1e-6);
  /* z = TAPER: the share of the width the beam keeps at its ORIGIN. At 1 this is a
     parallel-sided ribbon; below it the near end pinches, which is both what a divergent
     beam does and the only thing that stops N beams sharing one origin from fusing into a
     solid wedge there. */
  let widthAt = mix(params.instance.z, 1.0, corner.y * 0.5 + 0.5);
  let world = along + side * corner.x * ${scaleAt} * widthAt;
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  /* Perpendicular to the width AND to the length, which for this width axis is the
     component of the view vector across the beam: the ribbon faces the camera. */
  out.normal = normalize(cross(side, axis));
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  out.profile = corner;
  return out;`
      : billboard
      ? `  let corner = quadCorner(min(vertex, 5u));
  let world = positions[instance]
    + (params.billboardRight.xyz * corner.x + params.billboardUp.xyz * corner.y) * ${scaleAt};
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  /* r × u = −forward for an orthonormal camera basis: the card faces the camera. */
  out.normal = normalize(cross(params.billboardRight.xyz, params.billboardUp.xyz));
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  out.profile = corner;
  return out;`
      : `  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
${
          pointOrient
            ? `  /* T723: the primitive turns, AND SO DOES ITS NORMAL. Rotating only the positions
     is the fault this generator would otherwise ship: a box turned ninety degrees would
     be shaded for the way up it no longer has — every face taking the light meant for
     another one. Invisible on a flat-lit scene, glaring under a key light, and not a
     thing a still frame of an unlit example can see. */
  let turn = pointOrients[instance];
  let local = qrot(turn, shapeVertex(shape, v) * ${scaleAt});
  let world = local + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = qrot(turn, shapeNormal(shape, v));`
            : `  let local = shapeVertex(shape, v) * ${scaleAt};
  let world = local + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = shapeNormal(shape, v);`
        }
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  out.profile = vec2f(0.0);
  return out;`
  }
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let albedo = params.baseColor * input.tint;
  /* T917: SOFT PROFILE — §T845's AA-disc formula on the ribbon's cross axis. soft = 0 is
     coverage 1 everywhere: today's hard quad, bit-identical. Above 0 the edge falls off
     over that share of the half-width, and the COLOUR carries the coverage (premultiplied)
     so an additive draw sums light and never fringes. */
  let soft = params.instance.w;
  let cover = select(1.0, clamp((1.0 - abs(input.profile.x)) / max(soft, 1e-4), 0.0, 1.0), soft > 0.0);
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
  /**
   * T704: store FRAGMENT-Z (`input.position.z` — clip z ÷ w, done by the rasterizer)
   * instead of the interpolated clip z. For the ortho shadow matrices w is 1 and the
   * two are identical; a PROJECTOR's frustum is perspective, where undivided clip z is
   * not a depth at all. The read side does the matching divide (`pc.xyz / pc.w`).
   */
  readonly perspective?: boolean;
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
  return vec4f(${options.perspective === true ? "input.position.z" : "input.depth"}, 0.0, 0.0, 1.0);
}`;
}

/** The instance primitives from the light's view — shapes identical to the lit draw. */
export function shadowInstancesWgsl(
  options: DepthPassOptions & {
    group?: SceneGroupOption;
    pointScale?: { type: string; channel?: string };
    /**
     * T723 — AND A MAPPED ORIENTATION HAS TO REACH THE SWEEP FOR THE SAME REASON T721's
     * size did, with more force. A wrongly-sized shadow is a shadow of the right shape;
     * a wrongly-ORIENTED one is the silhouette of a thing that is not in the picture,
     * which reads as a lighting fault and is really a missing binding.
     */
    pointOrient?: boolean;
  } = {},
): string {
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
  /* T721 — a MAPPED SCALE HAS TO REACH THE DEPTH SWEEP OR THE SHADOW LIES. Instances
     are the one per-point mode that casts (§V610 excuses the two billboard modes), so a
     per-point size that only the lit draw knew about would paint a shadow the size of
     the AUTHORED scale under a primitive drawn at another one — a mismatch that reads
     as a lighting bug and is really a missing binding. It goes AFTER the group binds so
     an unmapped geometry's depth shader is unchanged to the byte (§V309). */
  const pointScale = options.pointScale;
  const scaleDeclaration =
    pointScale === undefined
      ? ""
      : `@group(0) @binding(${2 + (options.group?.binds.length ?? 0)}) var<storage, read> pointScales: array<${pointScale.type}>;\n`;
  const scaleAt =
    pointScale === undefined
      ? "params.instance.x"
      : `(params.instance.x * pointScales[instance]${pointScale.channel === undefined ? "" : `.${pointScale.channel}`})`;
  /* T723: after the group binds AND after T721's sizes, so a geometry that orients
     nothing keeps a byte-identical depth shader — and so does one that only sizes. */
  const pointOrient = options.pointOrient === true;
  const orientDeclaration = pointOrient
    ? `@group(0) @binding(${2 + (options.group?.binds.length ?? 0) + (pointScale === undefined ? 0 : 1)}) var<storage, read> pointOrients: array<vec4f>;\n`
    : "";
  /** The same Rodrigues rotation the lit draw uses, and it must stay the same one. */
  const quaternionHelper = pointOrient
    ? `
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`
    : "";
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
${group.bindings}${scaleDeclaration}${orientDeclaration}
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
${group.declarations}${quaternionHelper}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${group.gate}  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let world = ${pointOrient ? "qrot(pointOrients[instance], shapeVertex(shape, v) * " + scaleAt + ")" : "shapeVertex(shape, v) * " + scaleAt} + positions[instance];
  let clip = params.lightViewProjection * vec4f(world, 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = ${depthExpr};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(${options.perspective === true ? "input.position.z" : "input.depth"}, 0.0, 0.0, 1.0);
}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T725 — SCREEN-SPACE TRANSMISSION: the glass pyramid and the glass draw.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * vgpu's own transmission example, read at the source (vercel-labs/vgpu,
 * apps/docs/examples/transmission): render the opaques, blur the frame into a
 * pyramid, and let the glass draw bend rays back into it — Snell refraction to pick
 * the sample point, roughness to pick the pyramid LEVEL (frosted glass is a coarser
 * read of the scene, never a per-fragment blur), a spectral IOR loop for chromatic
 * dispersion, Beer-Lambert absorption along the internal path, and a Schlick Fresnel
 * mix toward the environment reflection at grazing angles.
 *
 * Two deliberate departures from the reference, both stated:
 *  - NO SAMPLERS. The reference assembles a real mip texture and reads it with
 *    hardware trilinear; our pyramid is five separate scratch targets, read with
 *    textureLoad and MANUAL bilinear + a level mix (§V57's house idiom — draw passes
 *    bind no samplers anywhere in this codebase, and this feature does not get to be
 *    the reason they start).
 *  - THICKNESS MODE ONLY (v1). The reference's "double" refraction analytically
 *    traces its CUBE's exit face — meaningless for an arbitrary grid surface. Its own
 *    GUI ships the thickness-based "simple" mode; that is what every geometry gets
 *    here, and an exact box-exit trace for instances is the stated follow-up.
 */

/** Pyramid depth: level k is the frame at scale 1/2^k. Five reaches 1/16 resolution. */
export const GLASS_PYRAMID_LEVELS = 5;
/** Spectral samples in the dispersion loop — the reference uses 11; 7 reads the same. */
export const GLASS_SPECTRAL_SAMPLES = 7;

/** Level 0: the rendered opaques, copied so the glass draw never reads its own target. */
/**
 * T939 — the SSAA resolve: each output pixel averages its 2x2 supersampled block. Box on
 * purpose: the samples ARE the coverage, and any wider kernel would blur detail the
 * supersampling paid to keep.
 */
export const SSAA_RESOLVE_WGSL = `@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let base = vec2i(position.xy) * 2;
  let a = textureLoad(sourceTex, base, 0);
  let b = textureLoad(sourceTex, base + vec2i(1, 0), 0);
  let c = textureLoad(sourceTex, base + vec2i(0, 1), 0);
  let d = textureLoad(sourceTex, base + vec2i(1, 1), 0);
  return (a + b + c + d) * 0.25;
}`;

export const GLASS_BLIT_WGSL = `@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(sourceTex, vec2i(position.xy), 0);
}`;

/**
 * Downsample-with-blur, horizontal: each half-res texel reads a [1,3,3,1]/8 horizontal
 * kernel centred between its two source columns, averaging the two source rows it
 * straddles — decimation and the horizontal half of the Gaussian in one pass.
 */
export const GLASS_DOWN_WGSL = `@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let base = vec2i(position.xy) * 2;
  var weights = array<f32, 4>(1.0, 3.0, 3.0, 1.0);
  var sum = vec4f(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let x = clamp(base.x + i - 1, 0, dims.x - 1);
    let a = textureLoad(sourceTex, vec2i(x, clamp(base.y, 0, dims.y - 1)), 0);
    let b = textureLoad(sourceTex, vec2i(x, clamp(base.y + 1, 0, dims.y - 1)), 0);
    sum += (a + b) * 0.5 * weights[i];
  }
  return sum / 8.0;
}`;

/** The vertical half: a [1,4,6,4,1]/16 kernel at the level's own resolution. */
export const GLASS_VBLUR_WGSL = `@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let p = vec2i(position.xy);
  var weights = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  var sum = vec4f(0.0);
  for (var i = 0; i < 5; i = i + 1) {
    let y = clamp(p.y + i - 2, 0, dims.y - 1);
    sum += textureLoad(sourceTex, vec2i(p.x, y), 0) * weights[i];
  }
  return sum / 16.0;
}`;

export interface GlassShaderOptions {
  /** An equirect environment is wired on the render — the reflection samples it. */
  readonly environment?: boolean;
}

/** Manual bilinear per level + a level mix: textureLoad trilinear, exact at lod 0. */
function glassPyramidWgsl(): string {
  const perLevel = Array.from({ length: GLASS_PYRAMID_LEVELS }, (_, level) =>
    `fn samplePyr${level}(uv: vec2f) -> vec3f {
  let dims = vec2f(textureDimensions(pyr${level}, 0));
  let coord = clamp(uv, vec2f(0.0), vec2f(1.0)) * dims - vec2f(0.5);
  let base = floor(coord);
  let f = coord - base;
  let i0 = vec2i(clamp(base, vec2f(0.0), dims - vec2f(1.0)));
  let i1 = vec2i(clamp(base + vec2f(1.0), vec2f(0.0), dims - vec2f(1.0)));
  let c00 = textureLoad(pyr${level}, i0, 0).rgb;
  let c10 = textureLoad(pyr${level}, vec2i(i1.x, i0.y), 0).rgb;
  let c01 = textureLoad(pyr${level}, vec2i(i0.x, i1.y), 0).rgb;
  let c11 = textureLoad(pyr${level}, i1, 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
`).join("\n");
  const top = GLASS_PYRAMID_LEVELS - 1;
  const branches = Array.from({ length: top - 1 }, (_, level) =>
    `  if (l < ${(level + 1).toFixed(1)}) { return mix(samplePyr${level}(uv), samplePyr${level + 1}(uv), l - ${level.toFixed(1)}); }\n`,
  ).join("");
  return `${perLevel}
fn samplePyramid(uv: vec2f, lod: f32) -> vec3f {
  let l = clamp(lod, 0.0, ${top.toFixed(1)});
${branches}  return mix(samplePyr${top - 1}(uv), samplePyr${top}(uv), l - ${(top - 1).toFixed(1)});
}
`;
}

/**
 * The glass FRAGMENT, shared by the surface and the instances generator (§V349).
 *
 * Uniform contract (both generators declare these):
 *   glassA = [ior, roughness, thickness, dispersion]
 *   glassB = [absorption.rgb, envIntensity]
 *   fallback = [background.rgb, unused] — what a ray that leaves the frame sees when
 *     no environment is wired.
 *
 * Identity gate (§V147): at ior = 1 `refract` returns the incident ray unchanged, so
 * the extended sample point stays ON the eye ray and projects to this very fragment —
 * a polished, non-absorbing, ior-1 pane is byte-identical to the pixels behind it.
 */
function glassFragmentWgsl(options: GlassShaderOptions): string {
  const reflectionExpr =
    options.environment === true
      ? "sampleEnvironment(reflected) * params.glassB.w"
      : "params.fallback.rgb";
  return `fn spectralWeight(t: f32) -> vec3f {
  return vec3f(
    exp(-pow((t - 0.05) / 0.45, 2.0)),
    exp(-pow((t - 0.50) / 0.38, 2.0)),
    exp(-pow((t - 0.95) / 0.45, 2.0)),
  );
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let magnitude = length(input.normal);
  let geometric = select(vec3f(0.0, 0.0, 1.0), input.normal / max(magnitude, 1e-6), magnitude > 1e-6);
  let view = normalize(params.eye.xyz - input.world);
  /* Two-sided (T301): the face the camera sees is the entry face. */
  let normal = select(-geometric, geometric, dot(geometric, view) > 0.0);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);

  let reflected = reflect(incident, normal);
  let reflection = ${reflectionExpr};
  let lod = pow(params.glassA.y, 0.8) * ${(GLASS_PYRAMID_LEVELS - 1).toFixed(1)} * 0.55;

  var spectrum = vec3f(0.0);
  var total = vec3f(0.0);
  for (var i = 0; i < ${GLASS_SPECTRAL_SAMPLES}; i = i + 1) {
    let t = (f32(i) + 0.5) / ${GLASS_SPECTRAL_SAMPLES}.0;
    let ior = max(1.0, params.glassA.x + (t - 0.5) * params.glassA.w);
    let inside = refract(incident, normal, 1.0 / ior);
    /* Total internal reflection or a degenerate normal: the ray never enters the
       scene — it sees the reflection, which is what TIR literally is. */
    var sampleColor = reflection;
    if (dot(inside, inside) > 1e-6) {
      /* Thickness mode: travel the assumed internal path, then well past the exit so
         the projected point reads the scene BEHIND the body, not its own surface. */
      let exitPoint = input.world + inside * (params.glassA.z + 4.0);
      let clip = params.viewProjection * vec4f(exitPoint, 1.0);
      if (clip.w > 1e-4) {
        let ndc = clip.xy / clip.w;
        let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        /* The reference's border blend: a ray that leaves the frame fades to the
           reflection instead of smearing the clamped edge texel. */
        let edge = smoothstep(vec2f(0.0), vec2f(0.06), uv) * smoothstep(vec2f(0.0), vec2f(0.06), vec2f(1.0) - uv);
        sampleColor = mix(reflection, samplePyramid(uv, lod), edge.x * edge.y);
      }
    }
    let weight = select(vec3f(1.0), spectralWeight(t), params.glassA.w > 1e-5);
    spectrum += sampleColor * weight;
    total += weight;
  }
  var transmitted = spectrum / max(total, vec3f(1e-4));

  /* Beer-Lambert: the glass's colour, by removal only (§V644 — nothing multiplies in). */
  transmitted *= exp(-params.glassB.rgb * params.glassA.z);

  let f0 = pow((params.glassA.x - 1.0) / (params.glassA.x + 1.0), 2.0);
  let fresnel = f0 + (1.0 - f0) * pow(1.0 - facing, 5.0);
  return vec4f(mix(transmitted, reflection, fresnel), 1.0);
}`;
}

function glassBindingsWgsl(options: GlassShaderOptions): string {
  const levels = Array.from(
    { length: GLASS_PYRAMID_LEVELS },
    (_, level) => `@group(0) @binding(${2 + level}) var pyr${level}: texture_2d<f32>;\n`,
  ).join("");
  const env =
    options.environment === true
      ? `@group(0) @binding(${2 + GLASS_PYRAMID_LEVELS}) var environmentMap: texture_2d<f32>;\n${ENV_SAMPLE_WGSL}`
      : "";
  return `${levels}${env}`;
}

/** The glass draw for SURFACE geometry — the lit generator's own mesh, new optics. */
export function glassSurfaceWgsl(options: GlassShaderOptions = {}): string {
  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  glassA: vec4f,            // ior, roughness, thickness, dispersion
  glassB: vec4f,            // absorption rgb, w = environment intensity
  fallback: vec4f,          // background rgb — the off-frame / no-env answer
  grid: vec4f,              // cols, rows, wrapU, wrapV
};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${glassBindingsWgsl(options)}${surfaceMeshWgsl(false)}

${glassPyramidWgsl()}
${glassFragmentWgsl(options)}`;
}

/** The glass draw for INSTANCES geometry — plain primitives (no group/billboard/beam). */
export function glassInstancesWgsl(options: GlassShaderOptions = {}): string {
  return `struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  glassA: vec4f,            // ior, roughness, thickness, dispersion
  glassB: vec4f,            // absorption rgb, w = environment intensity
  fallback: vec4f,          // background rgb — the off-frame / no-env answer
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${glassBindingsWgsl(options)}struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
};

${INSTANCE_SHAPES_WGSL}

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let world = shapeVertex(shape, v) * params.instance.x + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = shapeNormal(shape, v);
  out.world = world;
  return out;
}

${glassPyramidWgsl()}
${glassFragmentWgsl(options)}`;
}
