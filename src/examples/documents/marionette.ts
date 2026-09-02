import { settings, node, edge, graph, document } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/apply-patch.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E48 — Marionette (T956). POSE, SHOWCASED — the README's claim, finally in a picture.
 *
 *   cam1(webcam) ─► pose1(pose) ── index 1 ─┐
 *   dancer1(customWgsl, 17x1)  ── index 0 ──┴─► pick1(switch) ─┬─► bones1(customWgsl)
 *                                                              └─► joints1(pointsFromTexture, VALUE)
 *   joints1 ─► marks1(geometry points) ─► shot1(render) ─┐
 *   bones1 ──────────────────────────────► glow1(add) ◄──┘ ─► echo loop ─► out1
 *
 * ## What the picture is
 *
 * A figure of light: seventeen joints as soft points, a skeleton of glowing bones, and
 * an echo trail that turns motion into ribbons. The shipped performer is SYNTHETIC — a
 * procedural walk cycle emitted as the SAME 17x1 keypoint texture MoveNet produces (one
 * texel per joint: r,g the position across the frame, b the confidence) — so every gate
 * and the gallery card see a dancer, deterministically. Flip `pick1` to 1 and the same
 * two consumers read `pose1` tracking whoever is at the webcam.
 *
 * ## The keypoint texture IS the contract (T386's design, exercised end to end)
 *
 * Neither consumer knows which source is live, because both read the texture contract
 * rather than the model: `joints1` is `pointsFromTexture` in VALUE mode — texel i's
 * CONTENTS are point i, "the model says where the wrist is, not the texture's layout" —
 * and `bones1` textureLoads the same seventeen texels and draws the skeleton's eighteen
 * segments analytically. Confidence gates both: a joint below threshold is PARKED by
 * `joints1` (E34's idiom) and its bones fade in `bones1`, so a person walking out of
 * shot dissolves instead of collapsing to the origin.
 *
 * ## §T715, again, deliberately
 *
 * Without the model, `pose1` publishes zero-confidence keypoints: nothing drawn on the
 * ML branch, never a failure — and the switch's default means the document opens on the
 * synthetic dancer regardless. Webcam permission is only requested when `cam1`
 * activates, never on load (E27/E47's precedent).
 */

/** MoveNet's joint order, the walk cycle and the bone list all share these indices:
 *  0 nose, 1/2 eyes, 3/4 ears, 5/6 shoulders, 7/8 elbows, 9/10 wrists,
 *  11/12 hips, 13/14 knees, 15/16 ankles. */
const DANCER_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  stride: f32,
  bob: f32,
  tempo: f32,
}

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

/* One texel per joint (17x1): the exact contract MoveNet's result carries — r,g the
   frame position, b the confidence. A procedural walk cycle: pelvis bobs, legs swing in
   anti-phase with knee bend on the swing leg, arms counter-swing, head rides quietly.
   FREE-RUNNING on absTime (a timeline loop must not snap the walk, T489). */
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let joint = u32(clamp(uv.x, 0.0, 0.999) * 17.0);
  let t = frameU.absTime * params.tempo;
  let phase = t * 6.2831853;

  /* The body's trunk. x drifts gently so the echo trail has a path to remember. */
  let sway = sin(phase * 0.25) * 0.06;
  let pelvis = vec2f(0.5 + sway, 0.62 + sin(phase * 2.0) * params.bob);
  let chest = pelvis + vec2f(sin(phase) * 0.01, -0.17);
  let head = chest + vec2f(sin(phase) * 0.008, -0.09);

  /* Legs: anti-phase swing about the hips; the knee leads the ankle. */
  let swingL = sin(phase) * params.stride;
  let swingR = sin(phase + 3.14159265) * params.stride;
  let liftL = max(cos(phase), 0.0) * 0.05;
  let liftR = max(cos(phase + 3.14159265), 0.0) * 0.05;
  let hipL = pelvis + vec2f(-0.045, 0.0);
  let hipR = pelvis + vec2f(0.045, 0.0);
  let kneeL = hipL + vec2f(swingL * 0.6, 0.12 - liftL * 0.5);
  let kneeR = hipR + vec2f(swingR * 0.6, 0.12 - liftR * 0.5);
  let ankleL = kneeL + vec2f(swingL * 0.5, 0.13 - liftL);
  let ankleR = kneeR + vec2f(swingR * 0.5, 0.13 - liftR);

  /* Arms: counter-swing (left arm with right leg). */
  let shoulderL = chest + vec2f(-0.075, 0.01);
  let shoulderR = chest + vec2f(0.075, 0.01);
  let elbowL = shoulderL + vec2f(swingR * 0.45, 0.09);
  let elbowR = shoulderR + vec2f(swingL * 0.45, 0.09);
  let wristL = elbowL + vec2f(swingR * 0.45, 0.08);
  let wristR = elbowR + vec2f(swingL * 0.45, 0.08);

  /* The face rides the head. */
  let nose = head + vec2f(0.0, 0.005);
  let eyeL = head + vec2f(-0.012, -0.01);
  let eyeR = head + vec2f(0.012, -0.01);
  let earL = head + vec2f(-0.025, 0.0);
  let earR = head + vec2f(0.025, 0.0);

  var p = nose;
  if (joint == 1u) { p = eyeL; }
  if (joint == 2u) { p = eyeR; }
  if (joint == 3u) { p = earL; }
  if (joint == 4u) { p = earR; }
  if (joint == 5u) { p = shoulderL; }
  if (joint == 6u) { p = shoulderR; }
  if (joint == 7u) { p = elbowL; }
  if (joint == 8u) { p = elbowR; }
  if (joint == 9u) { p = wristL; }
  if (joint == 10u) { p = wristR; }
  if (joint == 11u) { p = hipL; }
  if (joint == 12u) { p = hipR; }
  if (joint == 13u) { p = kneeL; }
  if (joint == 14u) { p = kneeR; }
  if (joint == 15u) { p = ankleL; }
  if (joint == 16u) { p = ankleR; }
  return vec4f(p, 1.0, 1.0);
}`;

/** The skeleton, drawn from the SAME texture either source produces. */
const BONES_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  width: f32,
  gain: f32,
}

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn keypoint(index: u32) -> vec4f {
  return textureLoad(inputTexture, vec2i(i32(index), 0), 0);
}

fn boneGlow(uv: vec2f, a: u32, b: u32) -> f32 {
  let ka = keypoint(a);
  let kb = keypoint(b);
  /* A bone exists only when BOTH joints are confident — a person leaving shot fades
     limb by limb instead of the skeleton snapping to garbage. */
  let sure = min(ka.b, kb.b);
  if (sure < 0.3) { return 0.0; }
  let pa = ka.rg;
  let pb = kb.rg;
  let ab = pb - pa;
  let h = clamp(dot(uv - pa, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  let d = length(uv - pa - ab * h);
  return exp(-(d * d) / (params.width * params.width)) * sure;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  /* MoveNet's canonical eighteen bones, hardcoded — the skeleton IS this list. */
  var glow = 0.0;
  glow += boneGlow(uv, 0u, 1u);  glow += boneGlow(uv, 0u, 2u);
  glow += boneGlow(uv, 1u, 3u);  glow += boneGlow(uv, 2u, 4u);
  glow += boneGlow(uv, 0u, 5u);  glow += boneGlow(uv, 0u, 6u);
  glow += boneGlow(uv, 5u, 6u);
  glow += boneGlow(uv, 5u, 7u);  glow += boneGlow(uv, 7u, 9u);
  glow += boneGlow(uv, 6u, 8u);  glow += boneGlow(uv, 8u, 10u);
  glow += boneGlow(uv, 5u, 11u); glow += boneGlow(uv, 6u, 12u);
  glow += boneGlow(uv, 11u, 12u);
  glow += boneGlow(uv, 11u, 13u); glow += boneGlow(uv, 13u, 15u);
  glow += boneGlow(uv, 12u, 14u); glow += boneGlow(uv, 14u, 16u);
  let colour = vec3f(0.45, 0.8, 1.0) * glow * params.gain;
  /* Alpha carries the figure's own coverage: the OVER composite below uses it to lay
     the fresh frame on top of its echo — without this the loop is a 16x accumulator
     (1/(1-persistence)) and the swing sweeps fill into solid wedges (measured). */
  return vec4f(colour, clamp(glow * params.gain, 0.0, 1.0));
}`;

export const marionetteDocument = document(
  "e48-marionette",
  "E48 Marionette",
  settings({ randomSeed: 48 }),
  graph(
    [
      // ---- two performers, one contract -------------------------------------------
      node("dancer", "customWgsl", [-2220, -160], {
        [SHADER_SOURCE_PARAMETER]: DANCER_WGSL,
        stride: 0.09,
        bob: 0.012,
        tempo: 0.55,
      }, { label: "dancer1" }),
      /* The dancer's seed exists only to size the 17x1 keypoint canvas (customWgsl
         inherits its input's resolution); its pixels are never read. */
      node("seed", "ramp", [-2520, -160], { type: "horizontal", interp: "linear", phase: 0, period: 1, stops: [
        { position: 0, color: [0, 0, 0, 1] },
        { position: 1, color: [0, 0, 0, 1] },
      ] }, { label: "seed1", definitionVersion: 2, resolution: { mode: "fixed", width: 17, height: 1 } }),
      node("cam", "webcam", [-2220, 120], {}, { label: "cam1" }),
      node("pose", "pose", [-1920, 120], {}, { label: "pose1" }),
      node("pick", "switch", [-1620, -20], { index: 0 }, { label: "pick1" }),

      // ---- the two consumers of the one contract ----------------------------------
      node("joints", "pointsFromTexture", [-1320, -160], {
        mode: "value", cols: 17, rows: 1, threshold: 0.3, sizeX: 2, sizeY: 2, depth: 0,
      }, { label: "joints1" }),
      node("marks", "geometry", [-1020, -160], {
        mode: "points", scale: 0.017, soft: 1, spherical: true, blend: "additive",
        material: "spark1", tint: [1, 0.85, 0.6, 1],
      }, { label: "marks1" }),
      node("spark", "materialUnlit", [-1020, -380], { color: [1, 1, 1, 1] }, { label: "spark1" }),
      node("eye", "camera", [-1020, 60], {
        eye: [0, 0, 2.6], lookAt: [0, 0, 0], fov: 45, near: 0.1, far: 20, ortho: false,
      }, { label: "eye1" }),
      node("shot", "render", [-720, -160], {
        scenes: "marks1", camera: "eye1", lights: "",
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0,
        background: [0, 0, 0, 1],
        antialias: "msaa",
      }, { label: "shot1" }),
      node("bones", "customWgsl", [-1320, 120], {
        [SHADER_SOURCE_PARAMETER]: BONES_WGSL,
        width: 0.0045,
        gain: 0.7,
        /* customWgsl inherits its INPUT's resolution — which here is the 17x1 keypoint
           strip. The skeleton needs the frame. */
      }, { label: "bones1", resolution: { mode: "fixed", width: 1280, height: 720 } }),

      // ---- the composite and its memory --------------------------------------------
      node("glow", "add", [-420, -20], { opacity: 1 }, { label: "glow1" }),
      node("out", "output", [-120, -20], {}, { label: "out1" }),
    ],
    [
      edge("e-seed-dancer", ["seed", "out"], ["dancer", "input"]),
      edge("e-cam-pose", ["cam", "out"], ["pose", "input"]),
      edge("e-dancer-pick", ["dancer", "out"], ["pick", "inputs"], 0),
      edge("e-pose-pick", ["pose", "out"], ["pick", "inputs"], 1),
      edge("e-pick-joints", ["pick", "out"], ["joints", "texture"]),
      edge("e-pick-bones", ["pick", "out"], ["bones", "input"]),
      edge("e-joints-marks", ["joints", "out"], ["marks", "points"]),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-bones-glow", ["bones", "out"], ["glow", "in2"]),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);
