import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { CINDER_ATTRIBUTES, CINDER_CAPACITY, CINDER_KERNEL, CINDER_SPAWN } from "../shaders/cinder.wgsl.ts";

/**
 * E41 — Cinder (T741). PARTICLES FROM VIDEO — the owner's ask, verbatim: "we create
 * particles from a video". A moving subject SHEDS MOTES and a still one sheds none.
 *
 *   bed1(noise 4d, nearly still) ─┐
 *   orb1(circle ┄ pathx1/pathy1) ─┴─► stand1(add) ─┐ order 0
 *   clip1(movieFileIn) ──────────────────────────── ┴─► pick1(switch) ─┬─► past1(cache, 6 back)
 *                                                                      │        │
 *                                                                      ▼        ▼
 *                                          under1(level, dims) ◄── moved1(difference)
 *                                                                          │
 *          pick1 ─► pack1.in1 (rgb = colour)          gain1(level) ◄───────┘
 *          gain1 ─► pack1.in2 (a = motion)  ─► pack1(reorder) ─► cloud1.field, paint1.field
 *
 *   cloud1(pointKernelAdvanced: scouts spawn motes where the picture moves)
 *     ─► paint1(pointKernel: live colour + size from the same packed field)
 *     ─► motes1(geometry, points) ─► shot1(render) ─► lay1(add ◄ under1) ─► out1
 *
 * ## The packed field is the design (T741)
 *
 * A kernel has ONE field input. `pack1` puts the source's COLOUR in rgb and the
 * frame-difference MOTION in alpha (outa: in2lum), so a scout asks "is anything moving
 * here" and a mote asks "what colour is the picture under me" with the same fieldAt.
 * E40 built the difference instrument; this file makes it a SPAWN FIELD.
 *
 * ## The real lifecycle, and the count that answers the owner's sentence (T745)
 *
 * The first landing recycled a fixed population, because the advanced kernel took no
 * inputs and a spawn decision could not read the video — the gap became T744, T744
 * landed, and this file now runs the T322 machinery it always wanted: 96 immortal
 * invisible SCOUTS jump to fresh deterministic sites every frame (pointRand salted by
 * the absolute frame — a seek reproduces, §V44/§V45) and SPAWN where the packed
 * field's motion alpha clears the threshold; children are born at the site, wear the
 * video's LIVE colour under them each frame, are sized by the motion (tint.w, T721's
 * mapped scale channel), and die within a TTL — killed and COMPACTED, so the GPU
 * live count is a meter of how much the picture is moving. That makes the lead claim
 * exact in the strong sense: pin the subject and the count itself returns to the
 * scout floor — zero LIVE POINTS, not merely zero visible pixels
 * (cinder-claims.gpu.test.ts reads the count buffer through probeBuffers, §V729).
 * The schema is spent on id (spawning mints identity, §V73) and tint, so AGE rides
 * position.z — which doubles as depth ordering under the ortho camera — and velocity
 * is procedural: 2·(n−1)+2 with flags = exactly the baseline 8 (§V588 — the arithmetic
 * T1076 retired; the schema is what it is because the picture needs it, not the budget).
 *
 * ## The understudy moves, and the bed holds still (§V411, §V687)
 *
 * E40's exact honesty, reused: the subject of this example is CHANGE, so the synthetic
 * performer is an orb on two free-running LFOs over a nearly-still perlin4d bed —
 * something must hold still for shed-on-motion to mean anything. Point `clip1` at real
 * footage (pick1.index = 1) and the same scouts shed motes off whatever moves in it.
 */
export const cinderDocument = document(
  "e41-cinder",
  "E41 Cinder",
  settings({ randomSeed: 41 }),
  graph(
    [
      // ---- the source and its understudy (E40's rig, reused deliberately) ----------
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

      // ---- the motion instrument (E40's), feeding a PACK instead of a picture -------
      node("past", "cache", [-1620, 240], { frames: 8, index: 6, scale: 1 }, { label: "past1" }),
      node("moved", "difference", [-1620, -60], {}, { label: "moved1" }),
      /* §V694: range is bought with whitelevel alone — no subtractive offset anywhere. */
      node("gain", "level", [-1320, -60], {
        blacklevel: 0, whitelevel: 0.6, gamma1: 1, contrast: 1, brightness: 1, invert: 0, opacity: 1,
      }, { label: "gain1" }),
      node("pack", "reorder", [-1020, -60], {
        outr: "in1r", outg: "in1g", outb: "in1b", outa: "in2lum",
      }, { label: "pack1" }),

      // ---- the population: scouts spawn, motes live, paint colours ------------------
      node("cloud", "pointKernelAdvanced", [-720, -60], {
        capacity: CINDER_CAPACITY, seed: 41, group: "",
        attributes: CINDER_ATTRIBUTES, kernel: CINDER_KERNEL, spawn: CINDER_SPAWN,
      }, { label: "cloud1" }),

      // ---- the draw: unlit billboards, sized and coloured by the paint --------------
      /* Motes are LIGHT (§V617/§V666): unlit, so they cast nothing and take nothing. */
      node("flare", "materialUnlit", [-420, 240], { color: [1, 1, 1, 1] }, { label: "flare1" }),
      node("motes", "geometry", [-120, -60], {
        mode: "instances", shape: "quad", scale: 0.012, material: "flare1", group: "p.tint.w > 0.001",
      }, {
        label: "motes1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
          scale: { mode: "map", bindings: { static: { kind: "static", value: 0.016 }, map: { kind: "map", attribute: "tint", channel: "w" } } },
        },
      }),
      node("view", "camera", [-120, 240], {
        eye: [0, 0, 4], lookAt: [0, 0, 0], fov: 40, near: 0.1, far: 40, ortho: true, orthoHeight: 2,
      }, { label: "view1" }),
      node("shot", "render", [180, -60], {
        scenes: "motes1", camera: "view1", lights: "",
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0, background: [0, 0, 0, 1],
      }, { label: "shot1" }),

      // ---- the source underneath, dimmed, and the motes over it ---------------------
      node("under", "level", [-1620, -420], {
        blacklevel: 0, whitelevel: 1, gamma1: 1, contrast: 1, brightness: 0.05, invert: 0, opacity: 1,
      }, { label: "under1" }),
      /* The ember glow: a wide blur of the motes ADDED back over themselves. No level
         in the chain at all, so §V694 has nothing to bite — the blur only redistributes. */
      node("halo", "blur", [480, -60], { size: 18, filter: "gaussian", extend: "zero" }, { label: "halo1" }),
      node("burn", "add", [780, -60], { opacity: 1 }, { label: "burn1" }),
      node("lay", "add", [1080, -240], { opacity: 1 }, { label: "lay1" }),
      node("out", "output", [1380, -240], {}, { label: "out1" }),
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
      edge("e-pack-cloud", ["pack", "out"], ["cloud", "field"]),
      edge("e-cloud-motes", ["cloud", "out"], ["motes", "points"]),
      edge("e-pick-under", ["pick", "out"], ["under", "input"]),
      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-halo-burn", ["halo", "out"], ["burn", "in2"]),
      edge("e-under-lay", ["under", "out"], ["lay", "in1"]),
      edge("e-burn-lay", ["burn", "out"], ["lay", "in2"]),
      edge("e-lay-out", ["lay", "out"], ["out", "input"]),
    ],
  ),
);
