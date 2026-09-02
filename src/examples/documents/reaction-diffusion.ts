import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { GRAY_SCOTT_WGSL } from "../shaders/gray-scott.wgsl.ts";

/**
 * E2 — Reaction-Diffusion (T154, rebuilt compositionally by T388).
 *
 *   noiseA(perlin4d) ─► warp(displace) ◄─ noiseB(perlin4d)      TWO ANIMATED NOISES
 *   warp ─► shape(level) ─► pack.in2                            shaped into a chemistry map
 *   state(feedback) ─► rd(customWgsl) ─► pack(reorder) ─► state  THE SIMULATION, substepped
 *   rd ─► tint(lookup) ◄─ palette(ramp)  ─► out(output)          value -> colour
 *          tint.offset ← lfo1                                    T389: an LFO on the ramp
 *
 * ## What changed, and why the old one could not have worked
 *
 * E2 was three nodes: one CustomWGSL blob holding the whole algorithm, a Feedback and an
 * Output. Every complaint about it was structural rather than a matter of taste.
 *
 * "TOO SLOW" was not a parameter anyone set wrong. Until T387 a feedback loop advanced
 * exactly ONCE per displayed frame, and Gray-Scott needs tens of iterations per visible
 * frame to evolve at a watchable rate — there was no number in the product that could buy
 * them. `substeps: 20` on the Feedback node is that number.
 *
 * "NOT THIS INTERESTING BIOCHEMISTRY CELL STRUCTURE" was the uniform feed/kill. One
 * compile-time pair of constants is the same chemistry in every pixel, and the same
 * chemistry everywhere grows the same thing everywhere. Here two animated noise fields warp
 * each other into a map that says WHERE in the (feed, kill) band each pixel sits, so
 * regions run different chemistries and grow into one another. That is the single biggest
 * visual lever in the file.
 *
 * "UGLY COLORS" was reading the raw chemical channels as if they were light. The V
 * concentration is DATA — a number between zero and about a third — and showing it in the
 * green channel is showing a number, not a picture. It goes through a five-stop Ramp and a
 * Lookup instead (E11's pairing), which is what a palette is for.
 *
 * ## Where the WGSL boundary is, and why it is there
 *
 * The same lesson as E12: keep in the kernel only what a node cannot express. That is the
 * nine-tap Laplacian and the two coupled rate equations, per pixel, against its own
 * neighbourhood. The animated fields are Noise nodes, their interaction is a Displace, the
 * shaping is a Level, the packing into the state texture is a Reorder, the colour is a Ramp
 * and a Lookup. A reader can see the algorithm in the graph and change the look without
 * opening a shader.
 *
 * ## The Reorder is the load-bearing node, and the least obvious one
 *
 * The CustomWGSL contract is ONE texture in, one out. The kernel therefore cannot be handed
 * a second map — so the map travels INSIDE the state texture. `pack` takes the kernel's U
 * and V (in1 red and green), writes the chemistry coordinate into blue from the noise chain
 * (in2 luminance), and keeps the kernel's alpha, which is the seeded-start flag. One node,
 * and it is why this shape works at all without changing the node contract.
 *
 * ## The pins are load-bearing, not decorative
 *
 * Feedback's FORMAT and RESOLUTION overrides ground the cycle: every node in it inherits
 * from its input and their inputs are each other, so the inheritance has nowhere to stand
 * (§V50/§V51). rgba16float matters too — Gray-Scott increments are ~1e-3 per step, which
 * rgba8unorm cannot represent at all, and the chemistry coordinate in blue would quantise
 * to 256 chemistries.
 *
 * Reset: the pair clears, the cleared alpha tells the kernel to re-seed, and pause/step are
 * transport concerns that need nothing from the graph.
 */
export const reactionDiffusionDocument = document(
  "reaction-diffusion",
  "E2 Reaction-Diffusion",
  settings({ outputResolution: { width: 512, height: 512 } }),
  graph(
    [
      /*
       * TWO ANIMATED NOISES, and they are doing different jobs. `broad` is the chemistry's
       * large-scale layout — where the coral regions are and where the chaotic ones are.
       * `detail` is finer and faster, and it does not appear in the picture directly: it is
       * the field that WARPS the first one, which is what stops the map from looking like
       * smooth blobs. `speed` is non-zero on a 4D type, which is the only combination that
       * animates (B14) — the fourth dimension advances from the frame clock (§V44).
       */
      node("broad", "noise", [-900, -140], {
        type: "perlin4d",
        seed: 5,
        period: 0.55,
        harmon: 2,
        spread: 2,
        gain: 0.55,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where t4d=0 collapses amplitude — frame 0 (the thumbnail) was flatter than every frame after it
        s4d: 1,
        speed: 0.05,
      }, { label: "broad1" }),
      node("detail", "noise", [-900, 117], {
        type: "perlin4d",
        seed: 19,
        period: 0.13,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.6,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where t4d=0 collapses amplitude — frame 0 (the thumbnail) was flatter than every frame after it
        s4d: 1,
        speed: 0.09,
      }, { label: "detail1" }),
      /*
       * The PROCESSING BETWEEN the noises. Displace reads `detail` as signed uv offsets
       * (offset 0.5 is "a 0..1 field means no motion") and drags `broad` around by them, so
       * the two fields interfere instead of merely being added. This is what gives the map
       * its filamentary boundaries rather than round blobs.
       */
      node("warp", "displace", [-620, -60], {
        weight: [0.22, 0.22],
        offset: [0.5, 0.5],
        sourcex: "red",
        sourcey: "green",
        extend: "mirror",
      }, { label: "warp1" }),
      /*
       * SHAPING. The kernel walks a straight line across the (feed, kill) band as this
       * value goes 0 -> 1, so the DISTRIBUTION of this number is the distribution of
       * chemistries. Perlin clusters hard around the middle; the black/white levels stretch
       * the useful part of it and the contrast pushes regions apart so a boundary between
       * two chemistries is a place, not a gradient.
       */
      node("shape", "level", [-380, -60], {
        blacklevel: 0.28,
        whitelevel: 0.72,
        contrast: 1.6,
        brightness: 1,
        gamma1: 1,
      }, { label: "shape1" }),
      /*
       * T734 — AND NOT A TRAVELLING FRONT, which was built, measured and REJECTED here.
       * E32's second half (§V625) is weather: an LFO-driven ramp multiplied into the map so
       * a region walks down the band and back. It is the obvious idea, it works on E32, and
       * on THIS example it makes the picture worse — the whole comparison is in the md.
       * Short version: multiply walks the chemistry coordinate DOWN, and §V554's corrected
       * band says down is DENSE LABYRINTH, so the front pushes regions into the most
       * screen-filling regime there is. Against advection alone it cost 22% of tile CV to
       * buy 6% of motion, and the slow swing it was for turned out to be identical without
       * it, because the advection already produces one that size (§V709, §V710).
       */
      /*
       * THE STATE. `substeps: 20` is T387: twenty iterations of this loop per displayed
       * frame. At one iteration a frame — everything this product could do before — the
       * pattern takes minutes to develop, which is the "too slow" the owner reported. It
       * costs twenty times the loop's GPU work, and the node's timing row says so.
       */
      node(
        "state",
        "feedback",
        [-120, 120],
        // T350 (§V285): the simulation loop is a NAME, not a wired back-edge.
        { source: "pack1", persistence: 1, clearColor: [0, 0, 0, 0], substeps: 20 },
        {
          resolution: { mode: "fixed", width: 512, height: 512 },
          format: { mode: "fixed", format: "rgba16float" },
        },
      ),
      /*
       * ADVECTION (T734, §V626). To break a pattern, MOVE THE MEDIUM — do not rotate the
       * pattern. Gray-Scott's spot lattice is stable because its substrate is stationary;
       * carrying the state along a slow flow while the chemistry map underneath it stays
       * PUT shears the lattice apart, and a rigid rotation would only turn it and leave it
       * a lattice. `pack1` repaints blue from the map AFTER the reaction, which is what
       * makes this advection THROUGH a static parameter field: the field moves, its
       * parameters do not.
       *
       * `mono: false` is load-bearing — a mono field gives every texel the same offset in
       * x and y, which is a translation, not a flow.
       *
       * COST: this displace sits INSIDE the Feedback's 20 substeps, so it is twenty extra
       * passes per displayed frame, not one.
       *
       * The weight is the DENSITY knob and it has an OPTIMUM, not merely a ceiling: dark
       * fraction rises monotonically with it, but motion PEAKS near 0.00025 and falls above
       * ~0.0005, because past that the flow removes the material that was doing the moving.
       */
      node("swell", "noise", [-380, 380], {
        type: "perlin4d",
        seed: 41,
        period: 0.55,
        harmon: 2,
        spread: 2,
        gain: 0.55,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: false, // two independent channels, or this is a translation rather than a flow
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where t4d=0 collapses amplitude
        s4d: 1,
        speed: 0.035, // slower than either map noise: the flow should outlive the shapes it carries
      }, { label: "swell1", resolution: { mode: "fixed", width: 512, height: 512 } }),
      node("flow", "displace", [-120, 380], {
        weight: [0.00035, 0.00035],
        offset: [0.5, 0.5],
        sourcex: "red",
        sourcey: "green",
        // `hold` and not `mirror`: the state's edge is a boundary condition of the
        // simulation, and mirroring it folds chemistry back in as a phantom neighbour.
        extend: "hold",
      }, { label: "flow1", resolution: { mode: "fixed", width: 512, height: 512 } }),
      node("rd", "customWgsl", [140, 120], { [SHADER_SOURCE_PARAMETER]: GRAY_SCOTT_WGSL }, { label: "rd1" }),
      /*
       * THE PACK. Red and green are the chemicals the kernel just stepped; blue is the
       * chemistry coordinate for the NEXT step, read from the noise chain's luminance;
       * alpha stays the kernel's, because that is the "history exists" flag a reset clears.
       */
      node("pack", "reorder", [400, 120], {
        outr: "in1r",
        outg: "in1g",
        outb: "in2lum",
        outa: "in1a",
      }, { label: "pack1" }),
      /*
       * VALUE -> COLOUR (T389). The V concentration is a number, not light, so it indexes a
       * palette rather than being shown as green. `scale: 2.4` spreads V's roughly 0..0.4
       * range across the whole ramp; `offset` is driven by the LFO, which slides every pixel
       * along the gradient together — the colour breathes without the simulation changing.
       */
      node("palette", "ramp", [140, 380], {
        type: "horizontal",
        interp: "smooth",
        phase: 0,
        period: 1,
        stops: [
          { position: 0, color: [0.02, 0.04, 0.08, 1] },
          { position: 0.35, color: [0.05, 0.28, 0.36, 1] },
          { position: 0.6, color: [0.35, 0.62, 0.4, 1] },
          { position: 0.82, color: [0.95, 0.76, 0.3, 1] },
          { position: 1, color: [1, 0.97, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("cycle", "lfo", [140, 637], { shape: "sine", frequency: 0.05, amplitude: 0.06, offset: 0 }, {
        label: "lfo1",
      }),
      node("tint", "lookup", [400, 393], { channel: "green", row: 0.5, scale: 2.4 }, {
        label: "tint1",
        parameters: {
          // §V107/§V108: the retained static is what a host with no channel attached
          // resolves to, so it has to be a sane picture on its own — here, no shift.
          offset: drivenSlot("lfo1", 0),
        },
      }),
      node("out", "output", [660, 380]),
    ],
    [
      edge("e-broad-warp", ["broad", "out"], ["warp", "source"]),
      edge("e-detail-warp", ["detail", "out"], ["warp", "disp"]),
      edge("e-warp-shape", ["warp", "out"], ["shape", "input"]),
      edge("e-shape-pack", ["shape", "out"], ["pack", "in2"]),
      // T734: the state is advected on its way into the reaction (§V626).
      edge("e-state-flow", ["state", "out"], ["flow", "source"]),
      edge("e-swell-flow", ["swell", "out"], ["flow", "disp"], 0),
      edge("e-flow-rd", ["flow", "out"], ["rd", "input"]),
      edge("e-rd-pack", ["rd", "out"], ["pack", "in1"]),
      edge("e-rd-tint", ["rd", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-out", ["tint", "out"], ["out", "input"]),
    ],
  ),
);
