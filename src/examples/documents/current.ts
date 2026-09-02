import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { CURRENT_ATTRIBUTES, CURRENT_COLS, CURRENT_KERNEL, CURRENT_ROWS } from "../shaders/current.wgsl.ts";

/**
 * E42 — Current (T741). The video as an ORIENTED FIELD — T723's first witness, T721
 * riding beside it, on E41's exact source rig.
 *
 * A 48×27 grid of instanced tiles covers the frame, each a small lit facet of the
 * picture. Where the picture holds still, the tiles hold the IDENTITY orientation
 * exactly and the frame is a calm mosaic. Where the subject travels, each tile reads
 * the motion field's local GRADIENT (four fieldAt taps), SPINS its edges into the flow
 * and LEANS its normal along it — and because the tiles are PHONG-LIT under one raking
 * key, the lean reads as SHADING: a swept region catches the key differently from a
 * calm one, which is what makes a quaternion worth witnessing over a flat sprite
 * angle. The two turns COMPOSE (spin ⊗ lean) — the thing T723's own commit says Euler
 * cannot do and a bare direction cannot carry, exercised rather than cited.
 *
 * The claims (current-claims.gpu.test.ts) are §V683 against the buffer: the
 * harness's probeBuffers reads the orient attribute after the final frame and the
 * test compares the written quaternions with the gradient computed in float64 from
 * the analytic orb path — plus §V712 made deliberate (flip the gradient's sign in a
 * mutated clone and every moving tile turns half around while the calm ones and any
 * still-frame instrument read identically), and the calm-means-identity pin.
 */
export const currentDocument = document(
  "e42-current",
  "E42 Current",
  settings({ randomSeed: 42 }),
  graph(
    [
      // ---- the source and its understudy — E41's rig, deliberately verbatim ---------
      node("bed", "noise", [-2220, -420], {
        type: "perlin4d", seed: 11, period: 0.11, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1.4, amp: 1.5, offset: 0.1, mono: true, aspectcorrect: true,
        speed: 0.035, t4d: 0.37, s4d: 1, // T786: off the 4D lattice plane (T535) — t4d=0 collapses perlin4d's amplitude, so frame 0, which is the gallery card, was systematically flatter than every frame after it
      }, { label: "bed1" }),
      node("orb", "circle", [-2220, -140], {
        mode: "fill", center: [0.5, 0.5], radius: [0.085, 0.085], softness: 0.09,
        fillcolor: [1, 0.82, 0.5, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("pathx1", 0.5), "center.y": drivenSlot("pathy1", 0.5) } }),
      node("pathx", "lfo", [-2220, 420], { shape: "sine", frequency: 0.29, amplitude: 0.33, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-2220, 700], { shape: "sine", frequency: 0.203, amplitude: 0.3, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("clip", "movieFileIn", [-2220, 140], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("stand", "add", [-1920, -280], { opacity: 1 }, { label: "stand1" }),
      node("pick", "switch", [-1920, 20], { index: 0 }, { label: "pick1" }),

      // ---- the motion instrument and the pack ---------------------------------------
      node("past", "cache", [-1620, 240], { frames: 8, index: 6, scale: 1 }, { label: "past1" }),
      node("moved", "difference", [-1620, -60], {}, { label: "moved1" }),
      /* §V694: range from whitelevel alone; nothing subtracts. */
      node("gain", "level", [-1320, -60], {
        blacklevel: 0, whitelevel: 0.6, gamma1: 1, contrast: 1, brightness: 1, invert: 0, opacity: 1,
      }, { label: "gain1" }),
      node("pack", "reorder", [-1020, -60], {
        outr: "in1r", outg: "in1g", outb: "in1b", outa: "in2lum",
      }, { label: "pack1" }),

      // ---- the tiles: a fixed grid, spun and leant by the flow ----------------------
      node("grid", "pointGrid", [-1020, 240], {
        cols: CURRENT_COLS, rows: CURRENT_ROWS, count: CURRENT_COLS * CURRENT_ROWS, sizeX: 2, sizeY: 2,
      }, { label: "grid1" }),
      node("flow", "pointKernel", [-720, -60], {
        capacity: CURRENT_COLS * CURRENT_ROWS, seed: 42, group: "",
        attributes: CURRENT_ATTRIBUTES, kernel: CURRENT_KERNEL,
      }, { label: "flow1" }),
      /* PHONG, because the whole point is that the LEAN reads as shading: a specular
         facet under a raking key answers "which way is this tile turned" per pixel. */
      node("facet", "materialPhong", [-720, 240], {
        color: [0.82, 0.82, 0.85, 1], specular: [1, 1, 1, 1], shininess: 64, roughness: 0.3,
      }, { label: "facet1" }),
      node("tiles", "geometry", [-420, -60], {
        mode: "instances", shape: "quad", scale: 0.033, material: "facet1",
      }, {
        label: "tiles1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
          scale: { mode: "map", bindings: { static: { kind: "static", value: 0.033 }, map: { kind: "map", attribute: "tint", channel: "w" } } },
          orient: { mode: "map", bindings: { static: { kind: "static", value: [0, 0, 0, 1] }, map: { kind: "map", attribute: "orient" } } },
        },
      }),
      /* The RAKING KEY — low from the left, so a tile leant into rightward flow turns
         its face toward the light and a leftward one turns away. Direction as light. */
      node("rake", "light", [-420, 240], {
        kind: "directional", direction: [0.8, -0.35, -0.5], color: [1, 0.95, 0.85, 1], intensity: 1.1, shadows: false,
      }, { label: "rake1" }),
      node("view", "camera", [-120, 240], {
        eye: [0, 0, 4], lookAt: [0, 0, 0], fov: 40, near: 0.1, far: 40, ortho: true, orthoHeight: 2,
      }, { label: "view1" }),
      node("shot", "render", [-120, -60], {
        scenes: "tiles1", camera: "view1", lights: "rake1",
        ambientColor: [1, 1, 1, 1], ambientIntensity: 0.34, background: [0.012, 0.012, 0.016, 1],
      }, { label: "shot1" }),
      node("out", "output", [180, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"]),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"]),
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-pick-past", ["pick", "out"], ["past", "input"]),
      edge("e-pick-moved", ["pick", "out"], ["moved", "in1"]),
      edge("e-past-moved", ["past", "out"], ["moved", "in2"]),
      edge("e-moved-gain", ["moved", "out"], ["gain", "input"]),
      edge("e-pick-pack", ["pick", "out"], ["pack", "in1"]),
      edge("e-gain-pack", ["gain", "out"], ["pack", "in2"]),
      edge("e-grid-flow", ["grid", "out"], ["flow", "in"]),
      edge("e-pack-flow", ["pack", "out"], ["flow", "field"]),
      edge("e-flow-tiles", ["flow", "out"], ["tiles", "points"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);
