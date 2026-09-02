import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E47 — Hologram (T956). THE DEPTH → POINT CLOUD COMPONENT, SHOWCASED.
 *
 *   bed1(noise) ─┬─► src1(add) ─┬────────────────────────► holo1.field      (colour)
 *   orb1(circle)─┘              ├─► flat1(hsv, sat 0) ─► soften1(blur) ─► pick1(switch)
 *                               └─► depth1(depth) ────────── index 1 ──────┘   │
 *                                                              pick1 ─► holo1.field_2 (depth)
 *   holo1(component:depthPoints@1) ─► dots1(points, soft additive) ─► shot1 ─► out1
 *   orbit1(lfo) ┄drives┄► eye1.eye.x
 *
 * ## What the picture is
 *
 * E44 Sounding carved a heightfield — a relief on a plane. This is the other half the
 * owner asked for by name (§T958 "proper"): the DepthPoints COMPONENT unprojects a depth
 * map through a ray per pixel, so the cloud spreads with distance and hangs in space as
 * a translucent volume of soft additive motes — a hologram of the source, orbited by a
 * slow camera whose parallax is what makes the depth legible (E44/E34's lesson).
 *
 * ## The component is the subject, and the example uses it AS a component
 *
 * `holo1` is an INSTANCE of the DepthPoints library component — the first example to
 * instantiate one — with its published page turned from here: fov 55, near/far as a
 * shallow stage, displace tuned to fill the frame, resolution 144. The chain inside
 * (grid → carve → paint) is the component's own business; this document only feeds two
 * textures and styles the pointset that comes back, which is the whole argument for the
 * component boundary.
 *
 * ## Two depth sources on one switch — the source-agnosticism, demonstrated live
 *
 * The shipped default (`pick1.index = 0`) is an UNDERSTUDY: the source's own luma,
 * desaturated and blurred — bright is close, exactly the inverse encoding the component's
 * `inverseDepth` knob declares. It is deterministic, so every gate and the gallery card
 * see a real carved volume, and the orb visibly POPS toward the viewer because it is the
 * brightest thing in the frame. Flip to index 1 and the SAME component reads `depth1`,
 * the monocular ML model — which follows §T715's rule: without the model it publishes
 * flat mid-grey and the cloud is a visible flat sheet in the orbit, never a failure. One
 * switch, two utterly different depth sources, one component: the boundary earns its
 * name in the graph rather than in a doc comment.
 *
 * ## The orbit
 *
 * `eye.x` swings ±0.9 at 0.03 Hz (a 33-second round trip) at z 3.4 — E44's measured
 * ±16° figure for the same parallax problem. The motes are soft and additive, so the
 * cloud reads as light density, not billboards, and the swing carries the depth even
 * while the understudy holds still.
 */
export const hologramDocument = document(
  "e47-hologram",
  "E47 Hologram",
  settings({ randomSeed: 47 }),
  graph(
    [
      // ---- the performer (E44's understudy rig, smaller) ---------------------------
      node("bed", "noise", [-2220, -300], {
        type: "perlin4d", seed: 11, period: 0.2, harmon: 3, spread: 2, gain: 0.3,
        rough: 0.5, exp: 1.6, amp: 1.0, offset: 0.12, mono: true, aspectcorrect: true,
        speed: 0.03, t4d: 0.41, s4d: 1,
      }, { label: "bed1" }),
      node("orb", "circle", [-2220, -20], {
        mode: "fill", center: [0.5, 0.5], radius: [0.15, 0.15], softness: 0.09,
        fillcolor: [1, 0.62, 0.3, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("swayx1", 0.5), "center.y": drivenSlot("swayy1", 0.5) } }),
      node("swayx", "lfo", [-2220, 260], { shape: "sine", frequency: 0.29, amplitude: 0.28, offset: 0.5, phase: 0 }, { label: "swayx1" }),
      node("swayy", "lfo", [-2220, 540], { shape: "sine", frequency: 0.19, amplitude: 0.22, offset: 0.5, phase: 0.25 }, { label: "swayy1" }),
      node("src", "add", [-1920, -160], { opacity: 1 }, { label: "src1" }),
      /* T972 — the SOURCE switch: flip to 1 and the cloud is WHOEVER IS AT THE CAMERA.
         The shipped default stays the deterministic synthetic performer (a webcam
         cannot gate headlessly, §T715's family), and permission is only ever requested
         when the webcam node actually activates — never on load (E27's precedent). With
         the understudy depth this degrades beautifully: webcam + no model still carves
         a moving cloud of your face from its own luma. */
      node("cam", "webcam", [-1920, 140], {}, { label: "cam1" }),
      node("srcpick", "switch", [-1620, -280], { index: 0 }, { label: "srcpick1" }),

      // ---- two depth sources, one switch -------------------------------------------
      /* The understudy: the source's own luma as inverse depth (bright = close), blurred
         so the carve reads a surface rather than film grain. Deterministic — the card
         and every gate see a real volume. */
      node("flat", "hsv", [-1620, 40], { hueoffset: 0, saturation: 0, value: 1 }, { label: "flat1" }),
      node("soften", "blur", [-1320, 40], { size: 14, filter: "gaussian", extend: "hold" }, { label: "soften1" }),
      /* The ML path (§T715): loads and renders without the model — flat mid-grey, a
         visibly flat sheet in the orbit, never a failure. Flip pick1 to 1 to use it. */
      node("depth", "depth", [-1620, 280], { model: "accurate" }, { label: "depth1" }),
      node("pick", "switch", [-1020, 100], { index: 0 }, { label: "pick1" }),

      // ---- the component, instanced -------------------------------------------------
      node("holo", "component:depthPoints@1", [-720, -60], {
        // The published page (T958), turned from the outside: a shallow stage the orbit
        // can circle, dense enough to read as a volume.
        resolution: 160,
        unproject: 1,
        fov: 55,
        inverseDepth: 1,
        near: 0.7,
        far: 2.6,
        displace: 1.0,
        gain: 0.55,
        /* T973: mid-blend — the face in its own colour with depth bleeding through. */
        heat: 0.45,
      }, { label: "holo1" }),

      // ---- styling and the stage ----------------------------------------------------
      /* The hologram's cast: a cool cyan carrier the warm orb burns through. */
      node("glowm", "materialUnlit", [-420, -300], { color: [0.55, 0.85, 1, 1] }, { label: "glowm1" }),
      node("dots", "geometry", [-420, -60], {
        mode: "points", scale: 0.0068, soft: 1, spherical: false, blend: "additive",
        material: "glowm1", tint: [1, 1, 1, 1],
      }, { label: "dots1", parameters: {
        /* The component's per-point colour, mapped — without this every mote draws the
           static white and the retexturing is invisible. */
        tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
      } }),
      node("eye", "camera", [-420, 180], {
        eye: [0, 0.85, 3.2], lookAt: [0, -0.1, 0], fov: 40, near: 0.1, far: 40, ortho: false,
      }, { label: "eye1", parameters: { "eye.x": drivenSlot("orbit1", 0) } }),
      node("orbit", "lfo", [-420, 420], { shape: "sine", frequency: 0.03, amplitude: 0.9, offset: 0, phase: 0 }, { label: "orbit1" }),
      node("shot", "render", [-120, -60], {
        scenes: "dots1", camera: "eye1", lights: "",
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0,
        background: [0.008, 0.01, 0.016, 1],
        /* T939: thin bright motes on black — supersampling shades them. */
        antialias: "ssaa",
      }, { label: "shot1" }),
      node("out", "output", [180, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-src", ["bed", "out"], ["src", "in1"]),
      edge("e-orb-src", ["orb", "out"], ["src", "in2"]),
      edge("e-src-srcpick", ["src", "out"], ["srcpick", "inputs"], 0),
      edge("e-cam-srcpick", ["cam", "out"], ["srcpick", "inputs"], 1),
      edge("e-srcpick-flat", ["srcpick", "out"], ["flat", "input"]),
      edge("e-flat-soften", ["flat", "out"], ["soften", "input"]),
      edge("e-soften-pick", ["soften", "out"], ["pick", "inputs"], 0),
      edge("e-srcpick-depth", ["srcpick", "out"], ["depth", "input"]),
      edge("e-depth-pick", ["depth", "out"], ["pick", "inputs"], 1),
      /* The component's two texture ports (boundary-derived): `field` is the PAINT
         kernel's colour, `field_2` the CARVE kernel's depth — verified against the
         flattened plan's texture bindings, not assumed from the names. */
      edge("e-srcpick-holo", ["srcpick", "out"], ["holo", "field"]),
      edge("e-pick-holo", ["pick", "out"], ["holo", "field_2"]),
      edge("e-holo-dots", ["holo", "out"], ["dots", "points"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);
