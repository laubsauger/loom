/**
 * T624 — AMBIENT OCCLUSION, screen-space, as a RENDER capability.
 *
 * Why it lives here and not in a material or a downstream node: occlusion is a
 * property of a SCENE — how much of the sky a point can see given everything else in
 * the picture — so it belongs where the scene is assembled. A material knows only
 * itself; a downstream node would need the depth buffer on a wire, and the render's
 * depth attachment is `depth24plus`, which is not sampleable. §V437's rule applies
 * directly: turning AO on is ONE switch on the Render, and every geometry that render
 * names is occluded by every other, with no per-node opt-in list to keep in sync.
 *
 * The three passes, priced in the open the way T481 priced shadows:
 *
 *   1. DEPTH PREPASS — the scene drawn again from the CAMERA into an r32float scratch,
 *      writing LINEAR view distance normalised by the far plane, so a cleared target
 *      reading 1.0 means "far away, nothing here" and `SHADOW_CLEAR_WGSL` serves as the
 *      far plate byte-identically. The geometry shaders are the SHADOW pass's own, with
 *      `linearDepth` on — one implementation of the grid/primitive vertex math, not two.
 *   2. RESOLVE — this file's `aoResolveWgsl`. View position is reconstructed from that
 *      depth (perspective AND orthographic, no matrix inverse and no camera basis: in
 *      VIEW space the reconstruction needs only the projection's half-extents), the
 *      normal is a screen-space derivative of the reconstructed position, and occlusion
 *      is a golden-angle spiral of taps with the Alchemy-AO estimator.
 *   3. BLUR — `aoBlurWgsl`, a depth-guided box. The spiral is rotated per pixel by an
 *      INTEGER hash (never `sin`: integer ops are bit-exact on every backend, so the
 *      browser and Dawn agree, §V47), which trades banding for a fixed noise pattern;
 *      the blur is what turns that pattern back into a smooth field.
 *
 * The result multiplies the AMBIENT and ENVIRONMENT terms in the lit draw and nothing
 * else — occlusion attenuates the light that arrives from everywhere, not the key light
 * that arrives from one direction. Stated rather than tuned: an AO that darkened direct
 * diffuse would look stronger and be wrong, and the difference shows the moment a light
 * moves.
 */

/** Tap counts behind the Render's `aoQuality` enum. Compile-time: the loop is unrolled by count. */
export const AO_SAMPLE_COUNTS = { low: 8, medium: 16, high: 24 } as const;
export type AoQuality = keyof typeof AO_SAMPLE_COUNTS;

export function aoSampleCount(quality: string): number {
  return AO_SAMPLE_COUNTS[quality as AoQuality] ?? AO_SAMPLE_COUNTS.medium;
}

/** The full-target triangle pair every AO pass draws, and the uv it hands the fragment. */
const FULLSCREEN_VS = `struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) v: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[v];
  var out: VertexOut;
  out.position = vec4f(c, 0.0, 1.0);
  out.uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  return out;
}`;

/**
 * The resolve. `projection` carries what the reconstruction needs and nothing more:
 * x,y = the projection's half-extents (tan(fovY/2)·aspect and tan(fovY/2) for a
 * perspective camera; the ortho half-width and half-height for an orthographic one),
 * z = the far plane the prepass normalised by, w = 1 when the camera is orthographic.
 */
export function aoResolveWgsl(sampleCount: number): string {
  const taps = Math.max(4, Math.floor(sampleCount));
  return `struct AoParams {
  projection: vec4f,        // x,y = half-extents, z = far, w = ortho flag
  settings: vec4f,          // x = radius (world), y = intensity, z = bias, w = power
};

@group(0) @binding(0) var<uniform> params: AoParams;
@group(0) @binding(1) var depthMap: texture_2d<f32>;

${FULLSCREEN_VS}

fn loadDepth(pixel: vec2i, dims: vec2i) -> f32 {
  let p = clamp(pixel, vec2i(0), dims - vec2i(1));
  return textureLoad(depthMap, p, 0).r;
}

/** View-space position from a pixel and its normalised linear depth. */
fn viewPosition(pixel: vec2f, dims: vec2f, depth: f32) -> vec3f {
  let uv = (pixel + vec2f(0.5)) / dims;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let z = depth * params.projection.z;
  if (params.projection.w > 0.5) {
    return vec3f(ndc.x * params.projection.x, ndc.y * params.projection.y, -z);
  }
  return vec3f(ndc.x * params.projection.x * z, ndc.y * params.projection.y * z, -z);
}

/* Integer hash — bit-exact on every backend, unlike a sin-based one (§V47). */
fn hash12(p: vec2u) -> f32 {
  var n = (p.x * 1597334673u) ^ (p.y * 3812015801u);
  n = (n ^ (n >> 16u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  return f32(n ^ (n >> 16u)) * 2.3283064e-10;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let dimsI = vec2i(textureDimensions(depthMap, 0));
  let dims = vec2f(dimsI);
  let pixelI = vec2i(input.position.xy);
  let pixel = vec2f(pixelI);
  let centre = loadDepth(pixelI, dimsI);
  /* The far plate: background pixels are unoccluded, and letting them join the blur as
     "fully lit" is what keeps a silhouette from growing a dark halo. */
  if (centre >= 0.9999) { return vec4f(1.0, 0.0, 0.0, 1.0); }

  let P = viewPosition(pixel, dims, centre);

  /* Normal from the reconstructed surface. The SHORTER of the two one-sided
     differences on each axis is taken, so a silhouette edge (where the far side jumps)
     never bends the normal into the background. */
  let dR = viewPosition(pixel + vec2f(1.0, 0.0), dims, loadDepth(pixelI + vec2i(1, 0), dimsI)) - P;
  let dL = P - viewPosition(pixel - vec2f(1.0, 0.0), dims, loadDepth(pixelI - vec2i(1, 0), dimsI));
  let dD = viewPosition(pixel + vec2f(0.0, 1.0), dims, loadDepth(pixelI + vec2i(0, 1), dimsI)) - P;
  let dU = P - viewPosition(pixel - vec2f(0.0, 1.0), dims, loadDepth(pixelI - vec2i(0, 1), dimsI));
  let dx = select(dL, dR, abs(dR.z) < abs(dL.z));
  let dy = select(dU, dD, abs(dD.z) < abs(dU.z));
  var N = cross(dx, dy);
  let nLength = length(N);
  if (nLength < 1e-8) { return vec4f(1.0, 0.0, 0.0, 1.0); }
  N = N / nLength;
  /* Every visible surface faces the camera, and the camera looks down −z: fixing the
     sign here costs one branch and removes the whole winding question. */
  if (N.z < 0.0) { N = -N; }

  let radius = max(params.settings.x, 1e-4);
  let viewZ = -P.z;
  let ndcPerWorld = select(1.0 / (params.projection.y * max(viewZ, 1e-4)), 1.0 / params.projection.y, params.projection.w > 0.5);
  /* Bounded on purpose: an unclamped screen radius makes the cost of a close-up
     surface unbounded, and a sub-pixel one samples nothing but itself. */
  let radiusPx = clamp(radius * ndcPerWorld * dims.y * 0.5, 2.0, 96.0);

  let rotation = hash12(vec2u(max(pixelI, vec2i(0)))) * 6.2831853;
  var occlusion = 0.0;
  for (var i = 0u; i < ${taps}u; i = i + 1u) {
    let fi = (f32(i) + 0.5) / ${taps}.0;
    let angle = rotation + f32(i) * 2.39996323;
    let offset = vec2f(cos(angle), sin(angle)) * sqrt(fi) * radiusPx;
    let tapI = pixelI + vec2i(round(offset));
    let tapDepth = loadDepth(tapI, dimsI);
    if (tapDepth >= 0.9999) { continue; }
    let S = viewPosition(vec2f(tapI), dims, tapDepth);
    let v = S - P;
    let distance = length(v);
    if (distance < 1e-5) { continue; }
    /* Alchemy AO: how far the tap rises above this point's tangent plane, faded by
       distance so a far wall behind the surface does not occlude it. */
    let rise = dot(N, v) / distance;
    let falloff = 1.0 / (1.0 + (distance * distance) / (radius * radius));
    occlusion = occlusion + max(0.0, rise - params.settings.z) * falloff;
  }

  /* The 2.0 is the Alchemy estimator's normalisation, and it is what makes INTENSITY 1
     mean roughly the physical answer rather than a quarter of it: a right-angle crease
     hides about half the hemisphere, and without this factor the same crease measured
     0.14 occluded on Dawn instead of ~0.3. A constant, not a knob — the knob above it
     is the artistic one. */
  let visibility = clamp(1.0 - params.settings.y * 2.0 * occlusion / ${taps}.0, 0.0, 1.0);
  return vec4f(pow(visibility, max(params.settings.w, 0.01)), 0.0, 0.0, 1.0);
}`;
}

/**
 * The blur. Depth-GUIDED: a tap whose linear depth differs from the centre's by more
 * than the tolerance is dropped, so occlusion never bleeds across a silhouette — the
 * one artefact that makes screen-space AO read as a smudge rather than as contact.
 */
export function aoBlurWgsl(radius: number): string {
  const r = Math.max(1, Math.floor(radius));
  return `struct AoBlurParams {
  settings: vec4f,          // x = depth tolerance (normalised units), yzw reserved
};

@group(0) @binding(0) var<uniform> params: AoBlurParams;
@group(0) @binding(1) var occlusionMap: texture_2d<f32>;
@group(0) @binding(2) var depthMap: texture_2d<f32>;

${FULLSCREEN_VS}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(occlusionMap, 0));
  let pixel = vec2i(input.position.xy);
  let centreDepth = textureLoad(depthMap, clamp(pixel, vec2i(0), dims - vec2i(1)), 0).r;
  var total = 0.0;
  var weight = 0.0;
  for (var y = -${r}; y <= ${r}; y = y + 1) {
    for (var x = -${r}; x <= ${r}; x = x + 1) {
      let tap = clamp(pixel + vec2i(x, y), vec2i(0), dims - vec2i(1));
      let tapDepth = textureLoad(depthMap, tap, 0).r;
      if (abs(tapDepth - centreDepth) > params.settings.x) { continue; }
      total = total + textureLoad(occlusionMap, tap, 0).r;
      weight = weight + 1.0;
    }
  }
  let value = select(1.0, total / weight, weight > 0.0);
  return vec4f(value, 0.0, 0.0, 1.0);
}`;
}
