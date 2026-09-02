import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E46 Lantern — the SDF lit-scene shader (T850, reworked on the owner's note).
 *
 * The owner asked for "SDF stuff for cool light glow effects", then for objects the light
 * INTERACTS with — shadows, and lanterns that do not clip through the things they light.
 * Both come off ONE distance field (`docs/shader-example-references.md`, the sdf-tricks
 * article: "glow and soft shadows come off the same distance field"). Nothing here is a
 * post-process; every effect is the field read a different way:
 *
 *   - the scene:      `scene(p)` = the nearest of a few static obstacles (circles, boxes).
 *   - SOFT SHADOWS:   march a ray from the lit point toward each lantern; the closest the
 *                     ray passes to an obstacle, over the distance travelled, IS the
 *                     penumbra (`min(K·h/t)`). A hit before the light means full shadow.
 *   - the light:      attenuates with distance and is gated by that shadow, so a lantern
 *                     paints the floor and every obstacle casts a soft shadow away from it.
 *   - surface:        an obstacle is shaded by the field's GRADIENT (its 2D normal), so the
 *                     side facing a lantern is bright and the far side falls to ambient.
 *   - OCCLUSION:      a lantern's bright core is drawn only where the pixel is NOT inside an
 *                     obstacle, so a lantern behind one is hidden by it — it cannot clip
 *                     through the thing it is lighting.
 *
 * Deterministic (§V44/§V45): `frameU.absTime` is the only clock, so the lanterns' drift —
 * and the shadows sweeping with it — replay frame for frame and survive a timeline lap.
 */
export const LANTERN_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  amount: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const AA: f32 = 0.007;
const TAU: f32 = 6.2831853;

fn sdCircle(p: vec2f, r: f32) -> f32 {
  return length(p) - r;
}

fn sdBox(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

/* The static obstacles — the things the light interacts with. The four large ones sit in the
   lanterns' orbit range so shadows sweep across them; the four small CORNER ones sit outside
   it (the owner's note), catching the far reach of a beam and throwing a long shadow into a
   corner nothing else touches. */
fn scene(p: vec2f) -> f32 {
  /* Four large obstacles around the PERIMETER of the lanterns' central orbits — close enough
     that the light rakes across them and throws a moving shadow, far enough that an orbit
     never has to cross one's core (which is what let the motion stay smooth). */
  var d = sdCircle(p - vec2f(-0.95, 0.20), 0.18);
  d = min(d, sdBox(p - vec2f(1.00, -0.10), vec2f(0.15, 0.26)));
  d = min(d, sdBox(p - vec2f(0.10, 0.56), vec2f(0.26, 0.10)));
  d = min(d, sdCircle(p - vec2f(-0.22, -0.56), 0.16));
  /* Corners (the owner's note) — pulled in from the very edge, small, so a beam catches them
     and rakes a shadow toward the corner. */
  d = min(d, sdCircle(p - vec2f(1.35, 0.70), 0.10));
  d = min(d, sdCircle(p - vec2f(-1.38, 0.72), 0.08));
  d = min(d, sdBox(p - vec2f(1.33, -0.70), vec2f(0.11, 0.09)));
  d = min(d, sdCircle(p - vec2f(-1.34, -0.70), 0.09));
  return d;
}

/* The field's gradient — an obstacle's 2D surface normal, for lighting its facing side. */
fn sceneNormal(p: vec2f) -> vec2f {
  let e = vec2f(0.004, 0.0);
  return normalize(vec2f(
    scene(p + e.xy) - scene(p - e.xy),
    scene(p + e.yx) - scene(p - e.yx),
  ));
}

/* Soft shadow along the field (the sdf-tricks penumbra): the ray never reaches the light if
   it enters an obstacle, and grazing one darkens in proportion to how close it came. */
fn softShadow(origin: vec2f, dir: vec2f, maxT: f32) -> f32 {
  var t = 0.02;
  var res = 1.0;
  /* 72 fine steps with a small floor so the penumbra is a smooth gradient, not a staircase —
     the SDF is analytic, so any jaggedness in a shadow is the MARCH being too coarse, never
     the shape's geometry (the owner's poly-count worry, answered by sampling, not by mesh). */
  for (var i = 0; i < 72; i = i + 1) {
    if (t >= maxT) { break; }
    let h = scene(origin + dir * t);
    if (h < 0.0006) { return 0.0; }
    res = min(res, 11.0 * h / t);
    t = t + clamp(h, 0.006, 0.06);
  }
  return clamp(res, 0.0, 1.0);
}

/* The undisturbed sweep — a CIRCULAR orbit per lantern, so the angular speed is constant and
   therefore the linear speed is too (a lissajous races through its middle and dawdles at its
   ends; the owner saw that as jumping). Different centres, radii and phases spread the three
   across the room without ever changing pace. */
fn lanternBase(i: u32, t: f32) -> vec2f {
  if (i == 0u) { return vec2f(-0.28, -0.18) + vec2f(cos(t * 0.33), sin(t * 0.33)) * 0.44; }
  if (i == 1u) { return vec2f(-0.05, 0.20) + vec2f(cos(t * 0.27 + 2.1), sin(t * 0.27 + 2.1)) * 0.46; }
  return vec2f(0.22, -0.16) + vec2f(cos(t * 0.41 + 4.0), sin(t * 0.41 + 4.0)) * 0.40;
}

/* A SMOOTH repulsion from one obstacle: a potential that grows as the lantern nears and is
   zero past its reach, C1-continuous by smoothstep. Summed over obstacles it has no medial-
   axis flip — the gradient-push it replaced snapped exactly there, which read as teleporting. */
fn pushFrom(pos: vec2f, centre: vec2f, reach: f32) -> vec2f {
  let to = pos - centre;
  let d = max(length(to), 1e-4);
  let s = smoothstep(reach, 0.0, d);
  return (to / d) * s * reach * 0.62;
}

/* AVOIDANCE (the owner's note): the orbit BENDS smoothly around each obstacle instead of
   clipping through it. The bend is a continuous displacement of the base position, so the
   lantern glides — it never hops. */
fn lanternPos(i: u32, t: f32) -> vec2f {
  let base = lanternBase(i, t);
  var push = vec2f(0.0);
  push = push + pushFrom(base, vec2f(-0.95, 0.20), 0.50);
  push = push + pushFrom(base, vec2f(1.00, -0.10), 0.62);
  push = push + pushFrom(base, vec2f(0.10, 0.56), 0.58);
  push = push + pushFrom(base, vec2f(-0.22, -0.56), 0.46);
  return base + push;
}

fn lanternColour(i: u32) -> vec3f {
  if (i == 0u) { return vec3f(1.0, 0.62, 0.24); }
  if (i == 1u) { return vec3f(0.24, 0.7, 1.0); }
  return vec3f(0.95, 0.32, 0.78);
}

const OBSTACLE_ALBEDO = vec3f(0.56, 0.58, 0.68);
const FLOOR_ALBEDO = vec3f(0.5, 0.55, 0.72);

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let p = (uv - vec2f(0.5)) * vec2f(aspect, 1.0) * 2.0;
  let t = frameU.absTime;

  /* A near-black ground from the input, so the lit scene sits in a room, not a void. */
  let dims = vec2f(textureDimensions(inputTexture, 0));
  let ground = textureLoad(inputTexture, vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0))), 0).rgb;

  let objD = scene(p);
  let inside = objD < 0.0;
  let n = sceneNormal(p);

  /* Gain, breathing on amount: the light dims and swells but the scene never goes black. */
  let gain = 0.16 + 0.9 * clamp(params.amount, 0.0, 1.0);

  var light = vec3f(0.0);
  var cores = vec3f(0.0);
  for (var i = 0u; i < 3u; i = i + 1u) {
    let lp = lanternPos(i, t);
    let colour = lanternColour(i);
    let toLight = lp - p;
    let dist = length(toLight);
    let dir = toLight / max(dist, 1e-4);

    /* Distance falloff — light, not a blur — gated by the soft shadow the obstacles cast.
       The march starts a hair off the surface so a lit face does not shadow itself. */
    let atten = gain / (1.0 + dist * dist * 12.0);
    let sh = softShadow(p + n * 0.02, dir, max(dist - 0.06, 0.0));
    /* Floor takes the light flat; an obstacle takes it by its facing (the field's normal). */
    let facing = select(1.0, clamp(dot(n, dir), 0.0, 1.0) * 0.9 + 0.12, inside);
    light = light + colour * atten * sh * facing;

    /* The lantern's own core: a bright disc at the source, accumulated to draw ONLY on the
       floor below, so an obstacle in front hides it (no clip-through). */
    let cd = sdCircle(p - lp, 0.045);
    cores = cores + colour * clamp(0.5 - cd / AA, 0.0, 1.0);
  }

  /* Tonemap the accumulated light so where two beams cross they do not simply blow to white
     (the owner's "overpowering each other"): per channel x/(1+x) rolls the highlights off
     and keeps a crossing readable as a colour mix instead of a flat wash. The cores are added
     AFTER, so a lantern's own source stays a bright point. */
  light = light / (1.0 + 0.85 * light);

  var col: vec3f;
  if (inside) {
    /* The obstacle: opaque, lit, so it occludes the floor and the lanterns behind it. */
    col = OBSTACLE_ALBEDO * (0.02 + light);
  } else {
    /* The floor: a very faint ground, the lanterns' light with its shadows, and the cores —
       which appear here and not over an obstacle (the occlusion the owner asked for). A soft
       contact-darkening at obstacle edges seats them on the floor. Unlit floor falls to near
       black, so the beams read as light in a dark room rather than a wash. */
    let contact = smoothstep(0.0, 0.05, objD);
    col = ground * 0.05 * contact + FLOOR_ALBEDO * light * contact + cores;
  }

  return vec4f(col, 1.0);
}`;
