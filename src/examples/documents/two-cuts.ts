import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";

/**
 * E53 — Two Cuts (T1037). THE SAME SUBJECT, CUT TWO WAYS, SIDE BY SIDE.
 *
 *   src1 ─┬─► matte1(matte)      ─► keyM1(multiply ◄ src1) ─► leftC1(over ◄ baseL1)
 *         └─► seg1(personMask)   ─► keyV1(multiply ◄ src1) ─► rightC1(over ◄ baseR1)
 *   a soft vertical wipe stitches leftC1 | rightC1 into one frame
 *
 * ## What the picture argues
 *
 * Matting and segmentation answer DIFFERENT questions and fail differently, and this
 * diptych puts the difference on one subject instead of in prose. LEFT, warm: the
 * Matte node — a downloaded model (hash-pinned, §V858-reproducible) producing a SOFT
 * alpha with hair-level detail, ~30 ms in-page on WebGPU. RIGHT, cool: the Person
 * Mask — the OS's own Vision segmentation over the local helper, a HARD class mask
 * with zero weights and zero download, 20–35 ms helper-side, macOS only. Same webcam
 * flip, same frame, two philosophies of "who is the person".
 *
 * ## Both coverages are SPENT (§V856, E52's rule)
 *
 * Each side's wash saturates with ITS OWN cut's coverage — `matte1:coverage` warms
 * the left, `seg1:coverage` cools the right — so "found nobody" is a value on both
 * sides, and a disagreement between the two cuts is VISIBLE as a saturation imbalance
 * before anyone squints at edges.
 *
 * ## Shipped look (§T1024's lesson, stated)
 *
 * The default source is the deterministic understudy, which contains no person: both
 * cuts honestly find nobody, both keys go dark, and what ships is the two-tone
 * animated diptych with the stand-in glowing through at low brightness — a picture,
 * not a black frame, and every moving part is visible to the harness (both hazes are
 * 4D). Flip `src1` to 1 with a webcam (and the helper paired, on a Mac, for the right
 * half) and the same person appears twice, cut two ways.
 */
export const twoCutsDocument = document(
  "e53-two-cuts",
  "E53 Two Cuts",
  settings({ randomSeed: 53 }),
  graph(
    [
      // ---- one subject, switchable (E52's rig) -------------------------------------
      node("bed", "noise", [-2220, -140], {
        type: "perlin4d", seed: 9, period: 0.3, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1.3, amp: 1, offset: 0.1, mono: false, aspectcorrect: true,
        speed: 0.3, t4d: 0.41, s4d: 1,
      }, { label: "bed1" }),
      node("cam", "webcam", [-2220, 140], {}, { label: "cam1" }),
      node("src", "switch", [-1920, 0], { index: 0 }, { label: "src1" }),

      // ---- cut one: the downloaded matte -------------------------------------------
      node("matte", "matte", [-1620, -260], {}, { label: "matte1" }),
      node("keyM", "multiply", [-1320, -200], { opacity: 1 }, { label: "keyM1" }),
      // ---- cut two: the OS's segmentation ------------------------------------------
      node("seg", "personMask", [-1620, 260], { rateLimit: 0.1, invert: false }, { label: "seg1" }),
      node("keyV", "multiply", [-1320, 200], { opacity: 1 }, { label: "keyV1" }),

      // ---- the stand-in shows through, dimmed, on both sides ------------------------
      node("dim", "level", [-1620, 0], { brightness: 0.18 }, { label: "dim1" }),

      // ---- two rooms that answer their own cut (E52's coverage rule, twice) ---------
      node("hazeW", "noise", [-1620, -520], {
        type: "perlin4d", seed: 21, period: 0.8, harmon: 2, spread: 2, gain: 0.4,
        rough: 0.5, exp: 1, amp: 0.7, offset: 0.15, mono: true, aspectcorrect: true,
        speed: 0.12, t4d: 0.37, s4d: 1,
      }, { label: "hazeW1" }),
      node("inkW", "solid", [-1620, -760], { color: [1.0, 0.45, 0.12, 1] }, { label: "inkW1" }),
      node("tintW", "multiply", [-1020, -820], { opacity: 1 }, { label: "tintW1" }),
      /* §V856 SPENT as LIGHT: the warm side literally brightens with ITS cut's coverage
         — an empty room is a dim ember-field, a found person turns the lamp up. */
      node("washW", "level", [-1320, -520], {},
        { label: "washW1", parameters: { brightness: expressionSlot("0.55 + op('matte1').chan.coverage * 3", 0.55) } }),
      node("hazeC", "noise", [-1620, 520], {
        type: "perlin4d", seed: 34, period: 0.8, harmon: 2, spread: 2, gain: 0.4,
        rough: 0.5, exp: 1, amp: 0.7, offset: 0.15, mono: true, aspectcorrect: true,
        speed: 0.12, t4d: 0.63, s4d: 1,
      }, { label: "hazeC1" }),
      node("inkC", "solid", [-1620, 760], { color: [0.1, 0.35, 0.9, 1] }, { label: "inkC1" }),
      node("tintC", "multiply", [-1020, 820], { opacity: 1 }, { label: "tintC1" }),
      node("washC", "level", [-1320, 520], {},
        { label: "washC1", parameters: { brightness: expressionSlot("0.55 + op('seg1').chan.coverage * 3", 0.55) } }),

      node("baseL", "add", [-1020, -400], { opacity: 1 }, { label: "baseL1" }),
      node("baseR", "add", [-1020, 400], { opacity: 1 }, { label: "baseR1" }),
      node("leftC", "over", [-720, -260], { opacity: 1 }, { label: "leftC1" }),
      node("rightC", "over", [-720, 260], { opacity: 1 }, { label: "rightC1" }),

      // ---- the wipe: two mirrored ramps, one soft seam ------------------------------
      node("gateL", "ramp", [-720, -860], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.47, color: [1, 1, 1, 1] },
          { position: 0.53, color: [0, 0, 0, 1] },
        ],
      }, { label: "gateL1", definitionVersion: 2 }),
      node("gateR", "ramp", [-720, 860], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.47, color: [0, 0, 0, 1] },
          { position: 0.53, color: [1, 1, 1, 1] },
        ],
      }, { label: "gateR1", definitionVersion: 2 }),
      node("halfL", "multiply", [-420, -160], { opacity: 1 }, { label: "halfL1" }),
      node("halfR", "multiply", [-420, 160], { opacity: 1 }, { label: "halfR1" }),
      node("sum", "add", [-120, 0], { opacity: 1 }, { label: "sum1" }),
      node("out", "output", [180, 0], {}, { label: "out1" }),
    ],
    [
      edge("e1", ["bed", "out"], ["src", "inputs"], 0),
      edge("e2", ["cam", "out"], ["src", "inputs"], 1),

      edge("e3", ["src", "out"], ["matte", "input"]),
      edge("e4", ["src", "out"], ["keyM", "in1"]),
      edge("e5", ["matte", "out"], ["keyM", "in2"]),
      edge("e6", ["src", "out"], ["seg", "input"]),
      edge("e7", ["src", "out"], ["keyV", "in1"]),
      edge("e8", ["seg", "out"], ["keyV", "in2"]),

      edge("e9", ["src", "out"], ["dim", "input"]),
      edge("e10", ["hazeW", "out"], ["tintW", "in1"]),
      edge("e10b", ["inkW", "out"], ["tintW", "in2"]),
      edge("e10c", ["tintW", "out"], ["washW", "input"]),
      edge("e11", ["hazeC", "out"], ["tintC", "in1"]),
      edge("e11b", ["inkC", "out"], ["tintC", "in2"]),
      edge("e11c", ["tintC", "out"], ["washC", "input"]),
      edge("e12", ["washW", "out"], ["baseL", "in1"]),
      edge("e13", ["dim", "out"], ["baseL", "in2"]),
      edge("e14", ["washC", "out"], ["baseR", "in1"]),
      edge("e15", ["dim", "out"], ["baseR", "in2"]),

      edge("e16", ["keyM", "out"], ["leftC", "in1"]),
      edge("e17", ["baseL", "out"], ["leftC", "in2"]),
      edge("e18", ["keyV", "out"], ["rightC", "in1"]),
      edge("e19", ["baseR", "out"], ["rightC", "in2"]),

      edge("e20", ["leftC", "out"], ["halfL", "in1"]),
      edge("e21", ["gateL", "out"], ["halfL", "in2"]),
      edge("e22", ["rightC", "out"], ["halfR", "in1"]),
      edge("e23", ["gateR", "out"], ["halfR", "in2"]),
      edge("e24", ["halfL", "out"], ["sum", "in1"]),
      edge("e25", ["halfR", "out"], ["sum", "in2"]),
      edge("e26", ["sum", "out"], ["out", "input"]),
    ],
  ),
);
