import { SHADER_SOURCE_PARAMETER } from "../domain/commands/apply-patch.ts";
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  ProjectDocument,
  ProjectSettings,
} from "../domain/types/graph.ts";
import type { ParameterSlot, ParameterValue } from "../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../domain/types/schemas.ts";
import { FLUID_VELOCITY_WGSL } from "./shaders/fluid-velocity.wgsl.ts";
import { GRAY_SCOTT_WGSL } from "./shaders/gray-scott.wgsl.ts";

/**
 * The six example projects, as documents (§C "example projects", T153-T156).
 *
 * These are NOT the examples. The examples are the `.loom.json` files in `examples/`, and
 * §V88 is explicit that a hand-built in-memory graph cannot stand in for one: an example
 * that only exists as code proves the compiler works and proves nothing at all about the
 * file format. What lives here is the SOURCE the files are generated from, so the shipped
 * bytes are byte-identical to what `buildProjectFile` — the app's own save path — writes,
 * instead of hand-written JSON the app would silently rewrite differently on first save.
 *
 * `build-examples.ts` writes them; `sync.test.ts` fails if a shipped file and its source
 * here have drifted; `runner.test.ts` — the actual CI gate — never imports this module at
 * all. It reads the directory.
 *
 * Every parameter key below is taken from the node's manifest under
 * `src/nodes/definitions/`. A key that does not exist there is a compiler WARNING, not an
 * error, so the runner asserts zero diagnostics of any severity rather than zero errors:
 * a typo'd parameter renders silently wrong, which is exactly the class of mistake an
 * executable spec is for.
 */

/** Stamped into `createdAt`/`updatedAt` so a regenerated file is byte-stable. */
export const EXAMPLE_TIMESTAMP = "2026-08-29T00:00:00.000Z";

/** Shared caps. Well inside `HARD_LIMITS`, so the loader clamps nothing (§V24). */
const LIMITS: ProjectSettings["limits"] = {
  maxResolution: 4096,
  maxDispatch: 65_535,
  maxBufferBytes: 268_435_456,
  memoryBudgetBytes: 1_073_741_824,
};

function settings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    outputResolution: { width: 1280, height: 720 },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 30,
    limits: LIMITS,
    ...overrides,
  };
}

function node(
  id: string,
  type: string,
  position: readonly [number, number],
  parameters: Record<string, ParameterValue> = {},
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: position[0], y: position[1] },
    ...extra,
    // T348: MERGED, never last-writer-wins — an example that passes base parameters
    // AND a slot in `extra.parameters` (E10's rotate.y) must keep both. The plain
    // spread silently dropped every base parameter, which renders as a node quietly
    // on its defaults: plausible-wrong, the worst kind.
    parameters: { ...parameters, ...(extra.parameters ?? {}) },
  };
}

function edge(
  id: string,
  from: readonly [string, string],
  to: readonly [string, string],
  /**
   * §V131/T225: which slot this edge takes on a VARIADIC port. Absent sorts last and ties
   * break by id, which is fine for the single-edge ports every other example uses and is
   * NOT fine for a Switch — there the index is the picture, and leaving it to id order
   * means the branch that plays on open is decided by a spelling.
   */
  order?: number,
): GraphEdge {
  return {
    id,
    source: { nodeId: from[0] as string, portId: from[1] as string },
    target: { nodeId: to[0] as string, portId: to[1] as string },
    ...(order === undefined ? {} : { order }),
  };
}

/**
 * A `driven` slot (§V107): the channel is in effect, `retained` is what §V108 keeps and
 * what every host without that channel attached resolves to — the compiler in the example
 * gate included, which is why a retained value has to be a sane picture on its own.
 */
function drivenSlot(channel: string, retained: number): ParameterSlot {
  return {
    mode: "driven",
    bindings: {
      static: { kind: "static", value: retained },
      driven: { kind: "driven", channel },
    },
  };
}

/** An `expression` slot (§V71): our own grammar, arithmetic over the frame's variables. */
function expressionSlot(source: string, retained: number): ParameterSlot {
  return {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: retained },
      expression: { kind: "expression", source },
    },
  };
}

function graph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
    groups: {},
  };
}

function document(
  slug: string,
  name: string,
  projectSettings: ProjectSettings,
  projectGraph: GraphDocument,
): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: `example-${slug}`,
    name,
    graph: projectGraph,
    settings: projectSettings,
    assets: [],
    createdAt: EXAMPLE_TIMESTAMP,
    updatedAt: EXAMPLE_TIMESTAMP,
  };
}

/**
 * E1 — Feedback Echo (T153).
 *
 *   lfo ×2 ─► circle.center                                THE PEN (T518)
 *   circle ─────────────────────────► over.in1 ─► over ─┬─► output
 *                                                       │
 *            feedback ─► transform ─► blur ─► level ────┘ (over.in2)
 *                 ▲                                     │
 *                 └─────────────── feedback.in ─────────┘
 *
 * The cycle over → feedback → transform → blur → level → over is legal because exactly one
 * of its edges leaves `feedback.out`, which the Feedback manifest declares temporal (§V4).
 * The compiler splits that edge, backs the output with a ping-pong pair and appends the
 * swap after every current-frame consumer (§V22).
 *
 * The fade lives on the Feedback node itself (`persistence` 0.997, `clearColor` transparent
 * black) rather than in an extra Level: that is what `persistence` is for. Level is still
 * in the loop doing real work — `blacklevel` crushes the dimmest survivors to zero so a
 * trail actually terminates instead of asymptoting toward a permanent smear.
 *
 * ## T518 — a feedback loop is only as alive as what it is fed
 *
 * The source used to be a circle at a fixed centre, and a fixed source through a fixed
 * loop reaches a STEADY STATE: measured on Dawn, the shipped file was byte-identical from
 * frame 90 onward while 90% of its pixels sat at pure black. Nothing was broken and there
 * was nothing to watch. Two free-running LFOs on `center` turn the disc into a pen and the
 * loop into the thing that draws its path — which is what a feedback echo is FOR, and it
 * costs two nodes and no new mechanism.
 */
export const feedbackEchoDocument = document(
  "feedback-echo",
  "E1 Feedback Echo",
  settings(),
  graph(
    [
      node(
        "source",
        "circle",
        [-360, -120],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.055, 0.055],
          softness: 0.02,
          fillcolor: [1, 0.72, 0.28, 1],
          bgcolor: [0, 0, 0, 0],
        },
        {
          /**
           * T518 — THE SOURCE MOVES, and that is what makes this a piece rather than a
           * node demo. A feedback loop fed by a STATIC disc reaches a steady state and
           * then never changes again: measured on Dawn, the shipped file was byte-stable
           * from frame 90 onward (mean |Δ| between frames 90 and 240 was exactly 0.00)
           * while 90% of the frame sat at pure black. Every assertion in the file passed.
           *
           * Two LFOs on the centre turn the disc into a pen. The frequencies are
           * INCOMMENSURATE (0.31 against 0.23) so the Lissajous never closes and the
           * ribbon is different every lap; two equal — or simply related — rates would
           * retrace one closed curve and the piece would repeat.
           */
          parameters: {
            "center.x": drivenSlot("pathx1", 0.5),
            "center.y": drivenSlot("pathy1", 0.5),
          },
        },
      ),
      /**
       * FREE-RUNNING, so the path is continuous across a timeline lap (§V453, B98). The
       * LFO reads the absolute clock by design; nothing here declares otherwise.
       */
      node(
        "pathx",
        "lfo",
        [-620, -160],
        { shape: "sine", frequency: 0.31, amplitude: 0.3, offset: 0.5, phase: 0 },
        { label: "pathx1" },
      ),
      node(
        "pathy",
        "lfo",
        [-620, 40],
        { shape: "sine", frequency: 0.23, amplitude: 0.24, offset: 0.5, phase: 0.25 },
        { label: "pathy1" },
      ),
      node("over", "over", [40, -60], { opacity: 1 }, { label: "over1" }),
      node("echo", "feedback", [40, 152], {
        // T350 (§V285): the loop is a NAME — no wired back-edge, edges stay a DAG.
        source: "over1",
        /**
         * 0.997 is a MEASUREMENT, not a taste: the trail decays to 1/e in 1/(1-p) = 333
         * frames = 5.5 s at 60fps, and the disc's slower LFO has a 4.3 s period. So the
         * ribbon is just long enough to hold a whole figure and no longer. At the old
         * 0.94 the trail lived 17 frames — during which the disc moved about one percent
         * of the frame, which is why it read as a smudge rather than a path.
         */
        persistence: 0.997,
        clearColor: [0, 0, 0, 0],
      }),
      node("drift", "transform", [-160, 220], {
        // Gentle now that the SOURCE supplies the motion: over 333 surviving frames this
        // is 83 degrees of roll and a 28% shrink, which curls the old ribbon inward
        // instead of shredding it. At the old 3.5 deg/frame the tail spun a full turn in
        // a second and a half and the loop was the only thing you could see.
        t: [0, -0.0008],
        r: 0.25,
        s: [0.999, 0.999],
        p: [0, 0],
        xord: "srt",
        extend: "zero",
        aspectcorrect: true,
      }),
      node("soften", "blur", [-360, 240], { size: 1.4, filter: "gaussian", extend: "zero" }),
      node("decay", "level", [-360, 60], { blacklevel: 0.0015, whitelevel: 1, opacity: 1 }),
      node("out", "output", [260, -60]),
    ],
    [
      edge("e-source-over", ["source", "out"], ["over", "in1"]),
      edge("e-feedback-drift", ["echo", "out"], ["drift", "input"]),
      edge("e-drift-soften", ["drift", "out"], ["soften", "input"]),
      edge("e-soften-decay", ["soften", "out"], ["decay", "input"]),
      edge("e-decay-over", ["decay", "out"], ["over", "in2"]),
      edge("e-over-out", ["over", "out"], ["out", "input"]),
    ],
  ),
);

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
      edge("e-state-rd", ["state", "out"], ["rd", "input"]),
      edge("e-rd-pack", ["rd", "out"], ["pack", "in1"]),
      edge("e-rd-tint", ["rd", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-out", ["tint", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E3 — Animated Noise Field (T155).
 *
 *   noise(perlin4d) ─┬─► level ─► displace.source ─► output
 *                    └────────────► displace.disp
 *
 * `type: "perlin4d"` with `speed` non-zero is the TD animation idiom: the fourth dimension
 * advances from `FrameEvaluationInput.timeSeconds` through the shared frame block, so the
 * field evolves without anything in the graph reading a clock (§V44 — a node cannot reach
 * one; it is lint-enforced). A fixed-step offline render and the live preview therefore
 * produce the same frame for the same `frameIndex`.
 *
 * One Noise node, two consumers: §V6 says that renders ONCE and both consumers sample the
 * same texture. The self-displacement is also the cheapest way to make 4D noise stop
 * looking like 4D noise — the field warps itself, which no single Noise node can do.
 */
export const animatedNoiseFieldDocument = document(
  "animated-noise-field",
  "E3 Animated Noise Field",
  settings(),
  graph(
    [
      node("field", "noise", [-360, 0], {
        type: "perlin4d",
        seed: 3,
        period: 0.22,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where t4d=0 collapses amplitude — frame 0 (the thumbnail) was flatter than every frame after it
        s4d: 1,
        speed: 0.35,
      }),
      node("shape", "level", [-100, -80], { blacklevel: 0.15, whitelevel: 0.85, contrast: 1.35 }),
      node("warp", "displace", [160, 0], {
        weight: [0.06, 0.06],
        offset: [0.5, 0.5],
        sourcex: "red",
        sourcey: "green",
        extend: "mirror",
      }),
      node("out", "output", [420, 0]),
    ],
    [
      edge("e-field-shape", ["field", "out"], ["shape", "input"]),
      edge("e-shape-warp", ["shape", "out"], ["warp", "source"]),
      edge("e-field-warp", ["field", "out"], ["warp", "disp"]),
      edge("e-warp-out", ["warp", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E4 — Bloom (T156).
 *
 *   noise(4D) ─► level(hot) ─► limit(floor) ─┬─► threshold ─► blur ─► lookup ─► add.in1
 *                                              └────────────────────────────────► add.in2
 *                                        ramp(palette) ─► lookup.lookup     add ─► output
 *
 * The project working format is rgba8unorm — deliberately, because that is what makes the
 * per-node override mean something (§V51). `level` pushes highlights past 1.0 and every
 * node from there to the composite carries
 * `format: { mode: "fixed", format: "rgba16float" }`, so the over-range values survive the
 * threshold and the blur instead of being clipped at the first target. Delete those
 * overrides and the bloom does not dim, it DISAPPEARS: the threshold sits at 1.1, and a
 * value clipped to 1.0 cannot clear it.
 *
 * Two branches converging on one Add, with `floor` fanning out to both, is also the §V6
 * case again — the expensive half of the chain is computed once.
 *
 * ## T518 — what was wrong, measured rather than judged
 *
 * The owner's report was "bloom is really not doing anything for me and is also not
 * animated", and there were three separate faults behind it.
 *
 * 1. The source was `perlin2d`. `speed` advances a noise field's FOURTH dimension, so a 2D
 *    type has no time axis at all and no parameter in the product could have animated it.
 * 2. `exp: 2.2` on a field whose |n| is below 1 CRUSHES it toward the midpoint — the whole
 *    image lived between 0.468 and 0.552 in linear — so a threshold at 0.9 passed almost
 *    nothing and the bloom had nothing to bloom.
 * 3. Once the level's window was tightened enough to make real over-range cores, the
 *    composite went DARKER than its own inputs, because a Level's black point turns
 *    everything below it into a large negative number and rgba16float keeps what rgba8unorm
 *    would have clamped. See `floor` below; it is the least obvious node in the file and
 *    the one without which there is no picture.
 */
export const bloomDocument = document(
  "bloom",
  "E4 Bloom",
  settings({ workingFormat: "rgba8unorm" }),
  graph(
    [
      /**
       * T518 — THE SOURCE HAD TO CHANGE, not gain a speed.
       *
       * This was `perlin2d`, and a 2D noise has NO TIME AXIS: `speed` advances the field's
       * fourth dimension, so on a 2D type there is no number anywhere in the product that
       * could have made this example move. That is why it measured mean |Δ| = 0.00 between
       * every pair of frames while every assertion in the file stayed green.
       *
       * `t4d: 0.37` rather than 0, and it is not decoration. Zero puts the field on a
       * LATTICE PLANE of the 4D noise, where the gradient contributions from the w
       * neighbours cancel and the amplitude collapses; the first candidate for this file
       * measured mean 24 at frame 0 against 54 at frame 300 for that reason alone, and the
       * level window below was very nearly tuned against an unrepresentative frame 0. Off
       * the plane the distribution is stationary (mean ~22 at every capture) — which also
       * matters because a gallery thumbnail is usually frame 0.
       */
      node("source", "noise", [-760, 0], {
        type: "perlin4d",
        seed: 11,
        // Small features: bloom is legible when a SMALL bright thing wears a LARGE halo,
        // and at the old 0.16 the cores came out the same size as their own glow.
        period: 0.12,
        harmon: 4,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        // 1, not 2.2. `shaped = sign(n) * |n|^exp` and |n| < 1, so an exponent above one
        // CRUSHES the field toward its midpoint: at 2.2 the whole image lived between
        // 0.468 and 0.552 in linear, which is the real reason a threshold at 0.9 passed
        // almost nothing. Measured, not reasoned: at exp 1 the field spans 0.34 to 0.70.
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37,
        s4d: 1,
        speed: 0.12,
      }),
      /**
       * THE HDR CURVE, and every number in it is read off the field's own distribution.
       *
       * The measured percentiles of `source` are p50 0.503, p90 0.584, p99 0.651, p999
       * 0.694. A black point of 0.605 therefore keeps roughly the top two percent, and a
       * white point of 0.65 gives them a gain of 22 — so the survivors land between 1.0
       * and about 2.0, which is exactly the over-range this example exists to protect.
       * The old pair (0.35 / 0.72) was a gain of 2.7 applied to a field that only spanned
       * 0.09, and it produced a flat mid-grey cloud with nothing to bloom.
       */
      node(
        "hot",
        "level",
        [-500, 0],
        { blacklevel: 0.605, whitelevel: 0.65, contrast: 1 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      /**
       * THE CLAMP, and it is the node this example was missing. It looks like plumbing and
       * it is the whole difference between a bloom and nothing.
       *
       * A Level's black point is a SUBTRACTION: everything below it maps to a NEGATIVE
       * number. In an 8-bit target those clamp to zero for free, which is why the old file
       * never met this. The moment you override to rgba16float to protect the HIGHLIGHTS
       * you inherit the LOWS as well, and here the floor of the field lands at
       * (0.34 - 0.605) / 0.045 = -5.9. `add` is `front + back`, so composing the glow over
       * a field of -5.9 SUBTRACTS the glow into oblivion — measured on Dawn, the composite
       * came out DARKER than either of its inputs (p90 0.004 against the glow's own 0.771)
       * and the bloom was invisible except as a hairline rim.
       *
       * §V51's format override has a second consequence, and this node is it.
       */
      node(
        "floor",
        "limit",
        [-500, 260],
        { mode: "clamp", low: 0, high: 4, steps: 4 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      /**
       * THE THRESHOLD SITS WHERE THE 8-BIT TARGET WOULD HAVE CLIPPED — 1.1, with the
       * softness reaching down to 0.975. That is the sentence the old 0.9 could not say.
       * What passes here is precisely what an rgba8unorm target could not have
       * represented, so deleting the format overrides does not merely dim the bloom, it
       * deletes it: a clipped 1.0 does not clear 1.1.
       */
      node(
        "bright",
        "threshold",
        [-240, -160],
        { threshold: 1.1, softness: 0.22, channel: "luminance", compare: "greater" },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "glow",
        "blur",
        [20, -160],
        // 40 is near the Gaussian's fully-sampled limit of 42; past that the kernel is
        // undersampled and the halo picks up rings.
        { size: 40, filter: "gaussian", extend: "hold" },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      /**
       * BLOOM COLOUR — the halo's chromatic falloff, which is the thing that makes a bloom
       * look like light rather than like a blurred copy.
       *
       * The stops are crowded into the BOTTOM of the range on purpose. A blurred mask peaks
       * around 0.23 and spends most of its area far below that, so a palette spread evenly
       * over 0..1 would map the entire visible halo into its first, near-black segment.
       * Positions 0.02 / 0.06 / 0.12 / 0.22 / 0.4 put violet, red, orange and amber where
       * the pixels actually are.
       */
      node(
        "palette",
        "ramp",
        [20, 120],
        {
          type: "horizontal",
          interp: "smooth",
          phase: 0,
          period: 1,
          stops: [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 0.02, color: [0.3, 0.04, 0.36, 1] },
            { position: 0.06, color: [0.9, 0.16, 0.26, 1] },
            { position: 0.12, color: [1, 0.5, 0.14, 1] },
            { position: 0.22, color: [1, 0.88, 0.55, 1] },
            { position: 0.4, color: [1, 1, 0.96, 1] },
          ],
        },
        { definitionVersion: 2 },
      ),
      node(
        "tint",
        "lookup",
        [280, -160],
        { channel: "luminance", row: 0.5, offset: 0, scale: 1 },
        // The halo is a wide, gentle gradient and 8 bits band it visibly. This node holds
        // no over-range values; it is overridden for RESOLUTION of tone, not for headroom,
        // and that is a different reason from `hot`'s.
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "combine",
        "add",
        [540, 0],
        { opacity: 1 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node("out", "output", [800, 0]),
    ],
    [
      edge("e-source-hot", ["source", "out"], ["hot", "input"]),
      edge("e-hot-floor", ["hot", "out"], ["floor", "input"]),
      edge("e-floor-bright", ["floor", "out"], ["bright", "input"]),
      edge("e-bright-glow", ["bright", "out"], ["glow", "input"]),
      edge("e-glow-tint", ["glow", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-combine", ["tint", "out"], ["combine", "in1"]),
      edge("e-floor-combine", ["floor", "out"], ["combine", "in2"]),
      edge("e-combine-out", ["combine", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E5 — Kaleidoscope (T156).
 *
 *   ramp(circular) ─► transform(mirror) ─► tile(mirror x+y) ─► transform(repeat) ─► output
 *          phase ← abstime          r ← abstime        offset ← lfo ×2      r ← abstime
 *
 * Three extend modes in one chain — `mirror` on the fold, the Tile node's own mirroring,
 * `repeat` on the spin — which is what makes a kaleidoscope a kaleidoscope rather than a
 * rotated image with black corners. Getting `extend` wrong is invisible in the middle of
 * the frame and obvious at the edges, so the edges ARE the test.
 *
 * ## T518 — it was static, and it was also invisible
 *
 * Every transform parameter used to be a literal, so nothing in the file moved; the owner
 * asked for "translate rotation or something" and that instinct is right, because a
 * kaleidoscope's whole appeal is the slow drift of a source through fixed mirror lines.
 * Both rotations and the tile offset now move, on the ABSOLUTE clock (§V453) and at rates
 * that do not divide into each other.
 *
 * The second fault was worse and had gone unreported: the source was a `circle` in
 * `distance` mode, which publishes the signed distance in RED and leaves green and blue at
 * zero. `fillcolor` and `bgcolor` were never reaching the picture. The shipped frame was a
 * single-hue red field whose brightest pixel measured 43 out of 255 — and the paired `.md`
 * described "warm on deep blue", which the file had never rendered.
 *
 * The source carries a fixed 2048x2048 resolution override (§V50) and every node after it
 * inherits, so the whole chain runs at 2048x2048 while the project is set to 1280x720. A
 * chain of pure-sampling nodes is cheap enough to run above the project resolution, and
 * doing so is what keeps the mirrored seams from aliasing.
 *
 * The tile count is EVEN (2x2, not the old 3x3) and that is a correctness fix rather than
 * a taste one: a mirrored tiling alternates flipped and unflipped cells, so it is periodic
 * across the frame boundary only at even counts. At 3x3 the `repeat` extend on `spin`
 * wrapped an unmirrored edge onto a mirrored one and drew a hard diagonal seam that swept
 * across the frame — present in every rotated capture, absent from every unrotated one.
 *
 * Note where the override stops: it does not, currently. The Output node declares no
 * `resolutionPolicy`, so its target falls back to its input's size and the presented target
 * is 2048x2048 too, not the project's 1280x720. That is the compiler's current default
 * rather than something this example asks for — `concepts.test.ts` therefore pins the
 * CHAIN's resolution and deliberately says nothing about the sink's.
 */
export const kaleidoscopeDocument = document(
  "kaleidoscope",
  "E5 Kaleidoscope",
  settings(),
  graph(
    [
      /**
       * T518 — THE SOURCE IS A COLOUR WHEEL, and the old one could not have been.
       *
       * This was a `circle` in `distance` mode, and `distance` publishes the signed
       * distance in RED and leaves green and blue at zero. So `fillcolor` and `bgcolor`
       * were never reaching the picture at all: the shipped frame was a single-hue red
       * field whose brightest pixel measured 43/255, and the paired `.md` described it as
       * "warm on deep blue", which it had never been.
       *
       * A `circular` ramp is the right source for a kaleidoscope for a reason that is not
       * taste: its coordinate is the ANGLE about the centre, so it is periodic, and with
       * `period` 0.5 the palette wraps twice around the circle — the pattern arrives with
       * rotational symmetry already in it, before the fold and the tile add theirs.
       *
       * The stops are CYCLIC — the last colour equals the first — because `phase` scrolls
       * a ramp by `fract((coord + phase) / period)`. With any other last stop the scroll
       * would jump every time it wrapped.
       */
      node(
        "source",
        "ramp",
        [-760, 0],
        {
          type: "circular",
          interp: "smooth",
          period: 0.5,
          phase: 0,
          stops: [
            { position: 0, color: [0.02, 0.02, 0.09, 1] },
            { position: 0.2, color: [0.22, 0.06, 0.42, 1] },
            { position: 0.4, color: [0.85, 0.18, 0.32, 1] },
            { position: 0.6, color: [1, 0.63, 0.22, 1] },
            { position: 0.8, color: [0.32, 0.78, 0.72, 1] },
            { position: 1, color: [0.02, 0.02, 0.09, 1] },
          ],
        },
        {
          definitionVersion: 2,
          resolution: { mode: "fixed", width: 2048, height: 2048 },
          // ABSOLUTE clock (§V453, T497): `abstime` keeps counting across a timeline lap,
          // so the wheel turns through the loop point instead of snapping back to phase 0.
          // `% 1` because the ramp's own period is 1 and the stops are cyclic.
          parameters: { phase: expressionSlot("abstime * 0.06 % 1", 0) },
        },
      ),
      node(
        "fold",
        "transform",
        [-500, 0],
        {
          t: [0.12, 0],
          r: 30,
          s: [0.5, 0.5],
          p: [0, 0],
          xord: "srt",
          extend: "mirror",
          aspectcorrect: true,
        },
        // The translate is what makes this rotation VISIBLE: a circular ramp centred on
        // the frame is rotationally symmetric, so spinning it about its own centre would
        // be a no-op that every structural test would pass (§V361). Off-centre, it turns.
        // T583: the `% 360` guard is gone — T537 freed expression values from the
        // parameter's stored range, so the angle can just grow (E13's removal rendered
        // byte-identical before its first wrap; only float rounding after).
        { parameters: { r: expressionSlot("abstime * 5", 30) } },
      ),
      /**
       * TWO, NOT THREE, and the reason is measurable rather than aesthetic.
       *
       * A mirrored tiling alternates flipped and unflipped cells, so the tiled image is
       * periodic across the frame boundary only when the count is EVEN. At 3x3 the right
       * edge met the left edge unmirrored, and `spin`'s `repeat` extend then showed that
       * discontinuity as a hard diagonal seam sweeping across the frame — visible in every
       * rotated capture and in none of the unrotated ones, which is exactly the kind of
       * thing an edge-mode example must not ship.
       */
      node(
        "facets",
        "tile",
        [-240, 0],
        {
          repeat: [2, 2],
          offset: [0.15, 0.05],
          mirrorx: true,
          mirrory: true,
        },
        {
          parameters: {
            "offset.x": drivenSlot("driftx1", 0.15),
            "offset.y": drivenSlot("drifty1", 0.05),
          },
        },
      ),
      // Free-running (§V453). 0.023 against 0.031 does not close, so the grid never
      // returns to an arrangement it has already shown.
      node(
        "driftx",
        "lfo",
        [-240, 260],
        { shape: "sine", frequency: 0.023, amplitude: 0.25, offset: 0.15, phase: 0 },
        { label: "driftx1" },
      ),
      node(
        "drifty",
        "lfo",
        [-240, 470],
        { shape: "sine", frequency: 0.031, amplitude: 0.25, offset: 0.05, phase: 0.25 },
        { label: "drifty1" },
      ),
      node(
        "spin",
        "transform",
        [20, 0],
        {
          t: [0, 0],
          r: -15,
          s: [1, 1],
          p: [0, 0],
          xord: "rst",
          extend: "repeat",
          aspectcorrect: true,
        },
        // Counter-rotating, and slower than the fold: two rotations at the same rate are
        // one rotation, and the beat between 5 and 2.5 degrees a second is the drift the
        // owner asked for. T583: the old `360 - x % 360` contortion existed only to stay
        // inside the stored range; T537 freed that, so this is just the negative rate.
        { parameters: { r: expressionSlot("-abstime * 2.5", -15) } },
      ),
      node("out", "output", [280, 0]),
    ],
    [
      edge("e-source-fold", ["source", "out"], ["fold", "input"]),
      edge("e-fold-facets", ["fold", "out"], ["facets", "input"]),
      edge("e-facets-spin", ["facets", "out"], ["spin", "input"]),
      edge("e-spin-out", ["spin", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E6 — Displacement Stack (T156).
 *
 *   checker ────────────────────────────────► displace.source ─► output
 *   noise(4D) ─► level ─► transform ─► displace.disp
 *                          r ← abstime
 *
 * T518: the field was `simplex2d`, which has no time axis, so the plate was frozen — mean
 * |Δ| of exactly 0.00 between frames on Dawn. It is `perlin4d` now, and `place.r` turns as
 * well, so the two motions in the branch are the two jobs the branch has: the field
 * EVOLVES (Level shapes what it produces) and it is also PLACED (Transform decides where
 * it lands). Watching them separately is the argument for the stack being a stack.
 *
 * The displacement branch is a STACK, not a single Noise: shaping the field (Level) and
 * placing it (Transform) before it reaches `displace.disp` is how a displacement is
 * actually authored, and it is also where the §V56/§V57 discipline gets tested. Every node
 * in that branch inherits its format from its input, so the branch has ONE space from end
 * to end and nothing along it converts anything. The field arrives at Displace as the
 * numbers Noise produced.
 *
 * `sourcex`/`sourcey` name the channels explicitly and `offset` is [0.5, 0.5] because the
 * Noise output is a 0..1 field, so 0.5 is "no displacement". Those three parameters are the
 * contract between the two branches; leaving them at defaults happens to work here and
 * would not if the field were signed.
 *
 * WHAT THIS EXAMPLE DOES NOT DO, and why: §V56 flags a genuinely non-colour texture as
 * `data`, and the compiler derives that flag from the format — `r32float` is the only
 * format in the catalogue that produces it. The plan binds ONE shared sampler, created with
 * linear filtering, to every texture, and `r32float` is not filterable on WebGPU without
 * the optional `float32-filterable` feature. So a `data`-flagged displacement field would
 * not render on a baseline Tier B device today. The example takes the renderable path and
 * `runner.test.ts` covers the `data` path as a compile-only case beside it, rather than
 * shipping an example that cannot render.
 */
export const displacementStackDocument = document(
  "displacement-stack",
  "E6 Displacement Stack",
  settings(),
  graph(
    [
      node("plate", "checker", [-520, -140], {
        size: [10, 6],
        offset: [0, 0],
        color1: [0.04, 0.06, 0.1, 1],
        color2: [0.85, 0.87, 0.95, 1],
      }),
      /**
       * T518 — `simplex2d` had no time axis, so this file could not move at all: measured
       * mean |Δ| of exactly 0.00 between frames 90 and 240 on Dawn. `perlin4d` at the same
       * period and harmonic count keeps the field's character and gives it a fourth
       * dimension for `speed` to advance. `t4d: 0.37` starts it off the 4D lattice plane,
       * where the amplitude would otherwise collapse for the first frames (see E4).
       */
      node("field", "noise", [-520, 120], {
        type: "perlin4d",
        seed: 5,
        period: 0.3,
        harmon: 2,
        spread: 2,
        gain: 0.55,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37,
        s4d: 1,
        speed: 0.1,
      }),
      /**
       * The window narrowed from 0.2..0.8 to 0.33..0.67 because a 4D perlin's usable range
       * is narrower than a 2D simplex's — at the old numbers the same `weight` produced a
       * visibly weaker warp than the file used to ship. The MIDPOINT is unchanged at 0.5,
       * which is the part that matters: `warp.offset` below is 0.5 and means "no
       * displacement", and that contract survives only while the shaping stays centred.
       */
      node("shape", "level", [-260, 120], {
        blacklevel: 0.33,
        whitelevel: 0.67,
        gamma1: 1.2,
        contrast: 1.1,
      }),
      node(
        "place",
        "transform",
        [0, 120],
        {
          t: [0.05, -0.03],
          r: 12,
          s: [1.4, 1.4],
          p: [0, 0],
          xord: "srt",
          extend: "mirror",
          aspectcorrect: true,
        },
        // The field EVOLVES (noise speed) and is also PLACED differently over time, and
        // those are two different motions doing two different jobs — which is the whole
        // reason `shape` and `place` are separate nodes. ABSOLUTE clock (§V453).
        // T583: `% 360` guard removed — see E5; T537 made it unnecessary.
        { parameters: { r: expressionSlot("abstime * 4", 12) } },
      ),
      node("warp", "displace", [260, -60], {
        weight: [0.18, 0.13],
        offset: [0.5, 0.5],
        sourcex: "red",
        sourcey: "green",
        extend: "mirror",
      }),
      node("out", "output", [520, -60]),
    ],
    [
      edge("e-plate-warp", ["plate", "out"], ["warp", "source"]),
      edge("e-field-shape", ["field", "out"], ["shape", "input"]),
      edge("e-shape-place", ["shape", "out"], ["place", "input"]),
      edge("e-place-warp", ["place", "out"], ["warp", "disp"]),
      edge("e-warp-out", ["warp", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E7 — LFO Dissolve (T238-T240, T234, T259).
 *
 * The animation stack end to end, and the only example where the thing that moves is a
 * PARAMETER rather than a shader's own clock. An LFO named `lfo1` drives the Cross factor
 * through `driven` mode, so the graph dissolves between a moving noise field and a static
 * checker once a second — nothing in the compiled plan knows about the LFO at all.
 *
 * It is also the smallest document that exercises the piece most likely to rot: the LFO is
 * a node with no ports, alive only because a parameter names it. That is the liveness case
 * (§V173b) which edge-based reachability gets wrong, and building this example is how the
 * bug was found (B20). If someone breaks channel liveness again, this file fails.
 */
const lfoDissolveDocument = document(
  "e7-lfo-dissolve",
  "E7 LFO Dissolve",
  settings({ randomSeed: 11 }),
  graph(
    [
      node("lfo", "lfo", [-640, 220], { shape: "sine", frequency: 0.25, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "lfo1" }),
      node(
        "field",
        "noise",
        [-640, -140],
        {
          type: "perlin4d",
          period: 0.35,
          harmon: 3,
          spread: 2,
          gain: 0.5,
          rough: 0.5,
          exp: 1,
          amp: 1,
          offset: 0,
          mono: true,
          aspectcorrect: true,
          seed: 5,
          s4d: 1,
          t4d: 0.37, // T535: off the 4D lattice plane, where t4d=0 collapses amplitude — frame 0 (the thumbnail) was flatter than every frame after it
          // Non-zero, and a 4D type: `speed` does nothing on a 2D field (B14).
          speed: 0.4,
        },
        { label: "noise1" },
      ),
      node("bars", "checker", [-640, 40], {}, { label: "checker1" }),
      node("mix", "cross", [-260, -60], {}, {
        label: "cross1",
        parameters: {
          cross: {
            mode: "driven",
            bindings: {
              static: { kind: "static", value: 0.5 },
              driven: { kind: "driven", channel: "lfo1" },
            },
          },
        },
      }),
      node("out", "output", [120, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-field-mix", ["field", "out"], ["mix", "in1"]),
      edge("e-bars-mix", ["bars", "out"], ["mix", "in2"]),
      edge("e-mix-out", ["mix", "out"], ["out", "input"]),
    ],
  ),
);


/**
 * E8 — Slit Scan (T321, T237).
 *
 * Per-pixel time: a 48-frame history of a disc travelling on two LFOs, read back through a
 * vertical ramp so every ROW shows a different moment — the classic slit-scan smear,
 * newest at the black end of the ramp, 0.8 seconds ago at the white end.
 *
 * T518 — THE SUBJECT CHANGED, and that was the whole fix. This used to smear a `perlin4d`
 * field, and §V427 says why that could not work: a slit scan reveals the HISTORY of
 * something that has identity, and noise is smooth at every scale, so smearing it produces
 * more smoothness. The shipped frame lived entirely between 0.35 and 0.61 in linear — a
 * pastel wash with no edge in it anywhere — and the owner reported that you could not see
 * what the node did. A disc on a path has identity: its history draws a ribbon whose shape
 * IS its path, and the per-row time quantisation appears as a visible staircase along the
 * ribbon's edge. That staircase is the mechanism, drawn.
 *
 * The live source is composited back over the scan (`now`), which also cures a real
 * first-impression defect: before the ring has archived anything there is no oldest frame
 * for §V229's clamp to hold, so frame 0 rendered COMPLETELY BLACK — and frame 0 is what a
 * gallery thumbnail shows.
 *
 * This is the file that fails if the temporal stack regresses: the ring's
 * copy-on-rotate (V276 — archive at frame entry, never mid-encode), the
 * `texture_2d_array` binding and its per-frame head uniforms, and §V229's clamp while
 * the ring fills (the first two seconds are a growing smear, not a flash of black).
 * The memory is the parameter (§V228): 48 frames at 720p rgba16float ≈ 169 MiB, and
 * the frames knob says so where it is set.
 */
const slitScanDocument = document(
  "e8-slit-scan",
  "E8 Slit Scan",
  settings({ randomSeed: 21 }),
  graph(
    [
      /**
       * T518 — A SLIT SCAN NEEDS A SUBJECT WITH IDENTITY, and noise has none.
       *
       * The source here was a `perlin4d` field, and §V427 is exactly why that could never
       * read: a slit scan SMEARS an image through time, and noise is smooth at every
       * scale, so smearing it produces more smoothness. Measured, the shipped frame lived
       * entirely between 0.35 and 0.61 in linear — a pastel wash with no edge anywhere in
       * it — and the owner's report was that you could not see what the node did.
       *
       * A disc on a path has identity. Every ROW of the output is a different moment, so
       * the disc's history is drawn as a ribbon whose shape IS its path, and the per-row
       * time quantisation shows up as visible stair-steps along the ribbon's edge. That
       * staircase is the node's mechanism made literal, and it is the thing that was
       * missing.
       *
       * The frequencies are chosen against the ring's DEPTH, not by feel: 48 frames at 60
       * fps is 0.8 s of history, and 0.62 Hz puts about half a swing inside that window,
       * which is the longest ribbon that still reads as one gesture.
       */
      node(
        "body",
        "circle",
        [-900, -120],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.15, 0.15],
          softness: 0.1,
          fillcolor: [1, 0.8, 0.42, 1],
          bgcolor: [0.05, 0.045, 0.14, 1],
          aspectcorrect: true,
        },
        {
          label: "body1",
          parameters: {
            "center.x": drivenSlot("swingx1", 0.5),
            "center.y": drivenSlot("swingy1", 0.5),
          },
        },
      ),
      // Free-running (§V453), and incommensurate so the path never repeats exactly.
      node(
        "swingx",
        "lfo",
        [-1160, -240],
        { shape: "sine", frequency: 0.62, amplitude: 0.36, offset: 0.5, phase: 0 },
        { label: "swingx1" },
      ),
      node(
        "swingy",
        "lfo",
        [-1160, -20],
        { shape: "sine", frequency: 0.4, amplitude: 0.3, offset: 0.5, phase: 0.25 },
        { label: "swingy1" },
      ),
      node("gradient", "ramp", [-900, 160], { type: "vertical" }, { label: "ramp1", definitionVersion: 2 }),
      node("scan", "slitScan", [-560, 0], { frames: 48, depth: 1 }, { label: "slitscan1" }),
      /**
       * THE PRESENT, ON TOP OF ITS OWN PAST — and it also fixes a real first-impression
       * defect. At frame 0 the ring holds nothing: §V229's clamp holds the OLDEST RECORDED
       * frame, and before the first archive there is no recorded frame to hold, so the
       * shipped file opened on a completely black picture. A gallery thumbnail is usually
       * frame 0. Adding the live source back over the scan means the disc is there from
       * the first frame, and the composition gains the thing that makes a slit scan
       * legible at a glance: you can see the subject AND the trail it is leaving.
       */
      node("now", "add", [-260, -60], { opacity: 0.55 }, { label: "add1" }),
      node("out", "output", [40, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-body-scan", ["body", "out"], ["scan", "input"]),
      edge("e-gradient-scan", ["gradient", "out"], ["scan", "map"]),
      // ONE generator, TWO consumers (§V6): the disc is rendered once per frame.
      edge("e-body-now", ["body", "out"], ["now", "in1"]),
      edge("e-scan-now", ["scan", "out"], ["now", "in2"]),
      edge("e-now-out", ["now", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E9 — Ember (T322, T323, T339, T510/T579, T511).
 *
 * A FIRE FRONT: twenty-four vents along the floor of the frame, breathing out of phase,
 * and everything above them is an ember that was born, is cooling, and will die. The
 * whole point lifecycle, running as weather.
 *
 * ## What this was, and why it changed (T511)
 *
 * It was E9-Particle-Fountain: one pinned emitter, a ballistic spray of four thousand
 * identical blue dots, gravity and a floor test. The owner's verdict was "a bit silly",
 * and they were right — a fountain is the hello-world of particle systems and this one
 * was shipped as a showcase. Every mechanism it demonstrated is still here, unchanged
 * and still the only shipped file that demonstrates any of them. What changed is that
 * the mechanisms are now pointed at something worth looking at.
 *
 * ## ONE SOURCE, THREE READINGS (§V471.1) — and the split is the LIFECYCLE
 *
 * `bed1`, `body1` and `spark1` are three `renderPoints` over the SAME cloud, differing
 * only in a group predicate, a colour and a size:
 *
 * | | predicate | colour | reads as |
 * | --- | --- | --- | --- |
 * | `bed1` | (none — every ember) | deep red, largest | the dying bed and its glow |
 * | `body1` | `p.velocity.z > 0.30` | orange | the burning column |
 * | `spark1` | `p.velocity.z > 0.72` | white-gold, smallest | the newest sparks only |
 *
 * E31 splits its cloud on how CREASED a point is; this one splits on how OLD it is, and
 * age is a thing that only exists because points are born. The three draws are additive
 * and stacked, so an ember carries all three where it qualifies: a fresh one is a small
 * white core inside an orange middle inside a red halo — a black-body gradient PER
 * PARTICLE, out of selection alone, with no per-point colour attribute anywhere. As it
 * cools it drops out of `spark1`, then out of `body1`, and ends as one dim red dot.
 * Watching a single ember fall down the table is watching it die.
 *
 * ## HEAT RIDES IN `velocity.z`, and the binding budget is why (§V471.2)
 *
 * A lifecycle kernel spends 2·(n−1)+2 storage bindings for n attributes including flags,
 * and baseline WebGPU guarantees 8 per compute stage — so the default schema
 * (position, velocity, id, flags) lands EXACTLY at the limit and one more attribute
 * busts it silently. The simulation is 2D, so `velocity.z` is free, and heat rides
 * there. That is E31's idea (`q.velocity = vec3f(field, creases, drive)`) arrived at
 * from the other direction: not a flourish, an arithmetic constraint with a name.
 *
 * It is also what the group predicates read. The kernel writes the number the draws
 * select on, which is the whole shape of §V471.2.
 *
 * ## A CURL FIELD, because a simulation is not noise (§V427)
 *
 * The draught is the CURL of a moving scalar field, and the curl of anything is
 * divergence-free: it can shear the plume, fold it and shed eddies off it, and it can
 * never squeeze it into a knot. The embers do not follow it — they are accelerated by
 * it against their own drag, so the picture is the field INTEGRATED through inertia,
 * which is the thing three octaves of noise cannot give you. Buoyancy is proportional
 * to heat, so an ember stops rising as it cools and the column leans over and comes
 * apart near the top instead of leaving the frame as a bar.
 *
 * ## THE SEEDING SIGNAL (T510/T579, §V495, §V507)
 *
 * The kernel seeds on `ctx.firstRun == 1u` — "my storage was just created or cleared" —
 * and NOT on `ctx.frameIndex == 0u`, which is the same event only if you never lap. A lap
 * keeps its buffers, so a simulation must survive it; a seek and a document load clear
 * them, and it must not. Measured on Dawn: a seek re-seeds this file to ~7,000 embers and
 * a fresh open seeds the same, which is the half the old design got right and which does
 * not regress.
 *
 * MEASURED AND NOT FIXED, stated here rather than discovered later: the kernel's own guard
 * is now correct and the LIFECYCLE GLUE AROUND IT IS NOT. Four generated passes still
 * infer "my storage is fresh" from `frameIndex == 0` — the kernel's live-count guard
 * (`codegen.ts`), the dead-tail clear, and the two spawn-id passes (`lifecycle.ts`) — so
 * at a lap the guard opens to the full capacity, codegen forces `alive = 1u` on load, and
 * the dead tail is resurrected. Isolated on a 64-point synthetic kernel that reads no
 * clock at all: 12 live before the lap, 64 after, and it never comes back down. The old
 * `frameIndex == 0` seed guard was MASKING that, by killing the resurrected tail on the
 * same frame it appeared. §V495's lesson is one layer deeper than T510 reached, and this
 * example cannot deliver the owner's fix until those four sites take the same signal.
 *
 * A firstRun seed is also a WARM START — eleven thousand embers already spread through
 * the column, heat falling with height — rather than a single lit vent. Two reasons, and
 * neither is decoration: a gallery thumbnail is frame 0 (T535), and a file whose first
 * second is an empty frame filling up is a file whose card is black. The seeded
 * generation is entirely replaced by births within about four seconds; everything after
 * that is the lifecycle.
 *
 * ## STILL PLAYABLE (T367, §V363)
 *
 * `ctx.pointer` is a GUST: a Gaussian shove that scatters embers out of the draught and
 * lets them fall back into it. A cutoff radius reads as a bug and a falloff reads as
 * air, which is the same argument the old file made and the one thing about it that was
 * never in question. The pointer costs the other examples nothing — a kernel that does
 * not name it generates the text it generated before the member existed (§V309).
 *
 * Determinism is unchanged in the sense §V45 means it: nothing reads a wall clock, the
 * RNG is still hash(seed, id, frame), and the fire is a function of the POINTER STREAM
 * as well as the seed, exactly as E12's stirring force is.
 *
 * If spawning, compaction, the counted indirect draw or the hook's newborn-range guard
 * regress, this file is still where it shows: a fire that freezes at frame zero's
 * census, doubles endlessly, or emits identical embers.
 */
/** Allocation bound. Steady state is ~11k (16 vents × ~2 births a frame × a ~210-frame
 *  life), so the headroom is a little over 2× — enough that a synchronised flare across
 *  every vent cannot saturate the emitter and start dropping births. */
const EMBER_CAPACITY = 16384;

const EMBER_KERNEL = `const VENTS: u32 = 16u;
/* The WARM START's size: near steady state, so frame 0 is the fire already burning
   rather than an empty frame filling up. A gallery thumbnail is frame 0 (T535). */
const SEEDED: u32 = 7000u;
const TAU: f32 = 6.28318530717958647692;

/** The DRAUGHT, as a stream function: three moving terms at three scales. What the
    embers actually feel is its CURL, below — and the curl of any scalar field is
    divergence-free by construction, so this can shear the plume, fold it and shed
    eddies off it, and can never squeeze it into a knot. */
fn draught(pos: vec2f, t: f32) -> f32 {
  let broad = sin(pos.x * 3.1 + t * 0.61) * cos(pos.y * 2.3 - t * 0.44);
  let mid = sin((pos.x + pos.y * 1.3) * 5.7 - t * 0.83) * 0.42;
  let fine = cos(pos.x * 8.3 - t * 1.17) * sin(pos.y * 7.1 + t * 0.93) * 0.17;
  return broad + mid + fine;
}

fn curl(pos: vec2f, t: f32) -> vec2f {
  let e = 0.04;
  let dx = draught(pos + vec2f(e, 0.0), t) - draught(pos - vec2f(e, 0.0), t);
  let dy = draught(pos + vec2f(0.0, e), t) - draught(pos - vec2f(0.0, e), t);
  return vec2f(dy, -dx) / (2.0 * e);
}

/** Everything an ember feels except the pointer, as ACCELERATION. One function because
    it is integrated in two places: once per frame below, and once more as the warm
    start's pre-roll — and a warm start computed by different arithmetic from the
    simulation is a warm start that opens on a picture the piece never shows. */
fn forces(pos: vec2f, vel: vec2f, heat: f32, t: f32) -> vec2f {
  /* Scaled by heat: cold ash drifts where hot gas whips. */
  let swirl = curl(pos, t) * (0.30 + 0.70 * heat) * 0.34;
  /* Buoyancy IS heat, which is why the column leans over and comes apart near the top
     rather than leaving the frame as a bar: an ember stops rising when it stops being
     hot. */
  let lift = vec2f(0.0, 1.55 * heat);
  /* At the vents this is a BED, not a spray — a weak inward pull that has faded out by
     a quarter of the way up, so the spreading higher up reads as spreading. */
  let gather = vec2f(-pos.x * 0.9 * (1.0 - smoothstep(-0.87, -0.45, pos.y)), 0.0);
  /* Drag. Embers are ACCELERATED by the draught, never teleported along it, so the
     picture is the field INTEGRATED through inertia — which is the whole of §V427:
     noise is smooth at every scale and a simulation is not. */
  return swirl + lift + gather - vel * 1.55;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* THE SEEDING GUARD — \`ctx.firstRun\`, and the whole of T510/T579 is in that choice.
     (The glue passes around this kernel have NOT been converted — see the note above the
     document. This guard is right; the machinery it sits in is not, yet.)
     It means "my storage was just created or cleared" and NOTHING else. The number it
     replaced, ctx dot frameIndex equals zero, meant that AND "the timeline lapped to the
     in point", and one token carrying two meanings is why the owner's fountain restarted
     at every loop (§V495): a lap KEEPS its buffers, so a simulation must survive it,
     while a seek and a document load CLEAR them and it must not. The absolute frame
     counter is no better from the other side — it counts straight through a seek, so on
     it the fire would never be rebuilt at all. (§V507: this is computed per dispatch from
     fresh allocations plus pending buffer clears, and use-detected — a kernel that does
     not name it emits byte-identical WGSL, §V309.) */
  if (ctx.firstRun == 1u) {
    /* Identity is the SLOT, once and only here. From now on a point IS its id: compaction
       moves survivors down the buffer every frame and nothing may depend on where they
       land (§V73). */
    q.id = ctx.index;
    q.spawnCount = 0u;
    if (ctx.index >= VENTS) {
      if (ctx.index >= SEEDED) {
        q.alive = 0u; /* headroom for births */
        return q;
      }
      /* THE WARM START, and it is not a scatter. Each ember is given the same BIRTH the
         spawn hook gives one, and then the same integration is RUN FORWARD by its own
         age — so frame 0 is a state this simulation genuinely reaches, filaments and
         negative space and all, instead of a cloud of confetti the first second has to
         clear away. A gallery thumbnail is frame 0 (T535), and the first thing anyone
         sees of a file is its card.

         The age is a uniform fraction of the ember's OWN lifetime, which is the age
         distribution a constant birth rate actually produces — so the seeded generation
         is not merely plausible, it is correctly proportioned, and it dies off on
         exactly the schedule a born one does. Within about four seconds nothing seeded
         here is still alive and everything on screen was born. */
      let lean = pointRand(ctx.index, 1u) - 0.5;
      let rise = pointRand(ctx.index, 2u);
      let hot = pointRand(ctx.index, 3u);
      let vent = pointRand(ctx.index, 12u);
      let cool = 0.45 + pointRand(ctx.index, 4u) * 1.15;
      let age = pointRand(ctx.index, 11u) * (3.3 / cool);
      var sp = vec2f(-0.84 + vent * 1.68 + lean * 0.1, -0.87 + rise * 0.05);
      var sv = vec2f(lean * 0.6, 0.26 + rise * 0.5);
      var sh = 0.84 + hot * 0.16;
      /* Bounded so a long-lived ember cannot cost 150 iterations; the step stays well
         inside the drag's stability limit (2/1.55) either way. */
      let steps = min(u32(age * 24.0) + 1u, 96u);
      let sdt = age / f32(steps);
      for (var step = 0u; step < steps; step = step + 1u) {
        sh = sh * exp(-cool * sdt);
        sv = sv + forces(sp, sv, sh, ctx.absTime) * sdt;
        sp = sp + sv * sdt;
      }
      q.position = vec3f(sp, 0.0);
      q.velocity = vec3f(sv, sh);
      return q;
    }
  }

  if (q.id < VENTS) {
    /* A VENT. Pinned, immortal, and the only thing in the file that spawns. Each one
       BREATHES at its own rate and phase off the free-running clock (§V436), so the fire
       flares along its length instead of pulsing as one bar — which is the difference
       between a fire and a row of jets. */
    let seat = f32(q.id) / f32(VENTS - 1u);
    q.position = vec3f(-0.84 + seat * 1.68, -0.87, 0.0);
    q.velocity = vec3f(0.0, 0.0, 0.0);
    let rate = 0.5 + pointRand(q.id, 7u) * 0.95;
    let flare = 0.5 + 0.5 * sin(ctx.absTime * rate + pointRand(q.id, 8u) * TAU);
    q.spawnCount = 1u + u32(flare * 2.99);
    return q;
  }

  /* AN EMBER. Heat rides in \`velocity.z\` — the simulation is 2D so the component is
     free, and a fifth attribute would bust the 8-storage-buffer budget outright. It is
     also what the three draws select on (§V471.2). */
  var heat = q.velocity.z;
  /* Per-ember cooling rate, deterministic per id (§V73): identical lifetimes would make
     the plume a moving edge. Death is at 0.03, so a life is 2.1s to 7.5s — and the SPREAD is what
     puts tongues of still-hot gas high in the frame instead of a level band. */
  heat = heat * exp(-(0.45 + pointRand(q.id, 4u) * 1.15) * ctx.delta);

  let pos = q.position.xy;
  var vel = q.velocity.xy;

  /* T367: the GUST. \`ctx.pointer\` is the same four numbers the value graph's Mouse node
     publishes and every fragment shader reads (§V182) — viewer-normalised, v DOWN
     (§V236) — and the one conversion into this graph's clip space is written HERE,
     because a kernel cannot see how it will be viewed. Gaussian, not a cutoff radius: a
     hard edge reads as a bug and a fading shove reads as air. */
  let cursor = vec2f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0);
  let away = pos - cursor;
  let reach = max(length(away), 0.0001);
  let gust = (away / reach) * (8.0 * exp(-(reach * reach) / 0.055));

  vel = vel + (forces(pos, vel, heat, ctx.absTime) + gust) * ctx.delta;
  q.velocity = vec3f(vel, heat);
  q.position = vec3f(pos + vel * ctx.delta, 0.0);

  if (heat < 0.03 || q.position.y > 1.14 || abs(q.position.x) > 1.4) {
    q.alive = 0u;
  }
  return q;
}`;

const EMBER_SPAWN = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  /* The child arrives as a COPY OF ITS VENT, position included, so everything that makes
     it an individual is drawn here from its own fresh id (§V73/§V74). Delete this hook
     and every ember born in a frame is the same ember, launched from the same point at
     the same speed with the same heat — twenty-four hard lines instead of a fire. */
  let lean = pointRand(q.id, 1u) - 0.5;
  let rise = pointRand(q.id, 2u);
  let hot = pointRand(q.id, 3u);
  q.position = q.position + vec3f(lean * 0.1, rise * 0.05, 0.0);
  q.velocity = vec3f(lean * 0.6, 0.26 + rise * 0.5, 0.84 + hot * 0.16);
  return q;
}`;

const emberDocument = document(
  "e9-ember",
  "E9 Ember",
  settings({ randomSeed: 13 }),
  graph(
    [
      node(
        "sim",
        "pointKernelAdvanced",
        [-900, 0],
        {
          capacity: EMBER_CAPACITY,
          seed: 13,
          attributes: "",
          group: "",
          kernel: EMBER_KERNEL,
          spawn: EMBER_SPAWN,
        },
        { label: "fire1" },
      ),

      // ---- ONE cloud, THREE readings, split on AGE (§V471.1) -------------------------
      /* The SPENT half, and the only one of the three that is COLD. It reads as the
         smoke a fire makes of itself: hot gas emits and cold ash scatters, so the top of
         the frame is what is LEFT of the bottom of it. Large and very dim — the job is
         tone, not shape. The bands overlap between 0.22 and 0.34 rather than butting up
         against each other, because a seam in a group predicate is a visible line. */
      node(
        "bed",
        "renderPoints",
        [-560, -280],
        {
          count: EMBER_CAPACITY,
          sizePixels: 3,
          color: [0.11, 0.17, 0.3, 1],
          blend: "additive",
          accumulate: false,
          group: "p.velocity.z < 0.34",
        },
        { label: "bed1" },
      ),
      /* The kernel wrote heat into velocity.z (§V471.2), so this predicate reads "only
         where the fire is still burning" — a selection on AGE, not on position. */
      node(
        "body",
        "renderPoints",
        [-560, 0],
        {
          count: EMBER_CAPACITY,
          sizePixels: 2,
          color: [1, 0.42, 0.08, 1],
          blend: "additive",
          accumulate: false,
          group: "p.velocity.z > 0.22",
        },
        { label: "body1" },
      ),
      /* The newest few percent only. Smallest and brightest: a spark is a POINT of light,
         and a big bright sprite is a blob. */
      node(
        "spark",
        "renderPoints",
        [-560, 280],
        {
          count: EMBER_CAPACITY,
          sizePixels: 1.4,
          color: [1, 0.95, 0.84, 1],
          blend: "additive",
          accumulate: false,
          group: "p.velocity.z > 0.62",
        },
        { label: "spark1" },
      ),

      node("stack", "add", [-240, -140], {}, { label: "stack1" }),
      node("fuse", "add", [40, 0], {}, { label: "fuse1" }),

      // ---- the post, one job per stage (§V471.4) -------------------------------------
      node("halo", "blur", [320, -280], { size: 30, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node(
        "haloLvl",
        "level",
        [600, -280],
        { blacklevel: 0.01, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1, brightness: 1.4 },
        { label: "halolvl1" },
      ),
      node("burn", "add", [880, 0], {}, { label: "burn1" }),
      /* The trail closes on the FINAL output (§V471.5), so what smears is the picture
         with its glow already on it. `screen` rather than `add` on purpose: the loop is
         where a mistake compounds sixty times a second (§V481), and screen saturates
         where add runs away. Nothing raises contrast inside the loop, and the persistence
         is a constant — an embered streak, not an accumulator. */
      node(
        "loop",
        "feedback",
        [880, 280],
        { source: "ash1", clearColor: [0, 0, 0, 1], reset: false, substeps: 1, persistence: 0.62 },
        { label: "loop1" },
      ),
      node("mix", "screen", [1160, 0], {}, { label: "mix1" }),
      node("ash", "null", [1440, 0], {}, { label: "ash1" }),
      node("out", "output", [1720, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-sim-bed", ["sim", "out"], ["bed", "points"]),
      edge("e-sim-body", ["sim", "out"], ["body", "points"]),
      edge("e-sim-spark", ["sim", "out"], ["spark", "points"]),

      edge("e-bed-stack", ["bed", "out"], ["stack", "in1"]),
      edge("e-body-stack", ["body", "out"], ["stack", "in2"], 0),
      edge("e-stack-fuse", ["stack", "out"], ["fuse", "in1"]),
      edge("e-spark-fuse", ["spark", "out"], ["fuse", "in2"], 0),

      edge("e-fuse-halo", ["fuse", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-fuse-burn", ["fuse", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),

      edge("e-burn-mix", ["burn", "out"], ["mix", "in1"]),
      edge("e-loop-mix", ["loop", "out"], ["mix", "in2"], 0),
      edge("e-mix-ash", ["mix", "out"], ["ash", "in"]),
      edge("e-ash-out", ["ash", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E10 — Instanced Torus (T298, T299, T296).
 *
 * A torus of points wearing a box each: the generator publishes its pairs and analytic
 * topology on the edge (T296), renderInstances binds the position pair BY PAYLOAD and
 * puts a lit primitive on every point through the §V198 camera. An LFO drives
 * `rotate.y` in `driven` mode — the E7 mechanism, on one COMPONENT of a compound
 * parameter (§V113), without a recompile (§V5: rotation is sixteen uniform floats and
 * one integer away from any other frame).
 *
 * What that ROTATES is each box about its own centre, not the ring: §V198 composes
 * `rotate` INSIDE the translate to the point, so the torus stands still while 1152
 * primitives tumble in unison. The doc said "spinning the whole formation" for months
 * and listed the absence of that non-existent behaviour as a regression signature (B43).
 */
const instancedTorusDocument = document(
  "e10-instanced-torus",
  "E10 Instanced Torus",
  settings({ randomSeed: 5 }),
  graph(
    [
      node("lfo", "lfo", [-640, 220], { shape: "saw", frequency: 0.1, amplitude: 360, offset: 0, phase: 0 }, { label: "lfo1" }),
      node(
        "points",
        "pointTorus",
        [-640, 0],
        { count: 1152, cols: 48, rows: 24, radius: 0.85, radius2: 0.33 },
        { label: "torus1" },
      ),
      node(
        "draw",
        "renderInstances",
        [-260, 0],
        {
          count: 1152,
          shape: "box",
          scale: 0.045,
          color: [1, 0.62, 0.25, 1],
          eye: [0, 1.1, 2.6],
          lookAt: [0, 0, 0],
          fov: 55,
        },
        {
          label: "instances1",
          // The slot merges OVER the base values (T348) — both survive.
          parameters: {
            "rotate.y": {
              mode: "driven",
              bindings: {
                static: { kind: "static", value: 0 },
                driven: { kind: "driven", channel: "lfo1" },
              },
            },
          },
        },
      ),
      node("out", "output", [120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-points-draw", ["points", "out"], ["draw", "points"]),
      edge("e-draw-out", ["draw", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E11 — Gradient Remap (T354, T270).
 *
 *   noise1(noise, 4D) ──────► lookup1.source ─┐
 *   ramp1(ramp, 6 cyclic stops) ─► .lookup ───┴─► lookup1(lookup) ─► out1(output)
 *            phase ← abstime                       offset -0.86, scale 2.6
 *
 * Ramp into Lookup is the standard way to recolour an image through a palette, and it is
 * the pairing multi-stop Ramp (T270) was built for: with two colours it is a tinted
 * greyscale and barely worth wiring: the extra stops are what make it a PALETTE. The noise
 * supplies structure, its luminance is read as a POSITION along the gradient, and the
 * colour found there is the output — so every pixel's brightness becomes a hue.
 *
 * ## T518 / T523 — a palette example that showed a third of its palette
 *
 * Two faults, and the second is the interesting one. The field was `perlin2d` at `speed:
 * 0`, so nothing moved (mean |Δ| of exactly 0.00 on Dawn). And the lookup indexed on the
 * field's RAW luminance, which for a fractal noise runs from about 0.34 to 0.70 — so the
 * index never left the middle third of the gradient, and the deep end and the pale end
 * were never rendered at all. An example whose entire subject is a multi-stop palette was
 * hiding most of its own stops, and no assertion could notice: every stop was present in
 * the document, every stop decoded correctly, and the picture was still wrong.
 * `offset`/`scale` are the two parameters that exist for exactly this, and they are now
 * doing it.
 *
 * The two inputs are not interchangeable and the manifest's policies say so: resolution
 * inherits `source` (the image whose shape survives), format inherits `lookup` (the output
 * pixels ARE the palette's pixels, so their space belongs to the palette).
 *
 * This is also multi-stop Ramp's only shipped regression test, and a better one than a
 * unit test: §V196 decodes a display-space colour PER ENTRY, and a list makes a
 * double-decode or a dropped entry N times harder to see because the eye checks one swatch
 * and assumes the rest. Here a mis-decoded stop is a WRONG PALETTE — the whole image goes
 * muddy or the midtones lose their hue, which is legible at a glance.
 */
const gradientRemapDocument = document(
  "e11-gradient-remap",
  "E11 Gradient Remap",
  settings({ randomSeed: 11 }),
  graph(
    [
      node(
        "field",
        "noise",
        [-640, -120],
        {
          // T518: `perlin2d` with `speed: 0` — two independent reasons this file could not
          // move, and it measured mean |Δ| of exactly 0.00 across every pair of frames.
          // `perlin4d` gives `speed` a dimension to advance; `t4d: 0.37` starts the field
          // off the 4D lattice plane where its amplitude would otherwise be suppressed.
          type: "perlin4d",
          // Large, soft features: the palette needs broad areas to show a hue in, and a
          // fine field would dither the stops into visual mud.
          period: 0.9,
          harmon: 4,
          spread: 2,
          gain: 0.55,
          rough: 0.5,
          exp: 1,
          amp: 1,
          offset: 0,
          mono: true,
          aspectcorrect: true,
          seed: 3,
          s4d: 1,
          t4d: 0.37,
          // Slow. The palette scroll below is the fast motion; if the field drifted at the
          // same rate the two would beat against each other and read as noise.
          speed: 0.08,
        },
        { label: "noise1" },
      ),
      node(
        "palette",
        "ramp",
        [-640, 160],
        {
          type: "horizontal",
          interp: "smooth",
          phase: 0,
          period: 1,
          /**
           * Six stops with real hue movement — near-black indigo to violet to magenta to
           * amber to teal and back to indigo. Stored in DISPLAY space (§V56), which is
           * what a colour picker hands over, and decoded per entry on the way to the
           * shader (§V196).
           *
           * The last colour EQUALS the first, and that is structural rather than a
           * preference: `phase` scrolls the ramp by `fract((coord + phase) / period)`, so
           * a palette whose ends disagree jumps every time the scroll wraps. Cyclic, it
           * runs forever.
           */
          stops: [
            { position: 0, color: [0.02, 0.02, 0.09, 1] },
            { position: 0.2, color: [0.22, 0.06, 0.42, 1] },
            { position: 0.4, color: [0.85, 0.18, 0.32, 1] },
            { position: 0.6, color: [1, 0.63, 0.22, 1] },
            { position: 0.8, color: [0.32, 0.78, 0.72, 1] },
            { position: 1, color: [0.02, 0.02, 0.09, 1] },
          ],
        },
        {
          label: "ramp1",
          definitionVersion: 2,
          // ABSOLUTE clock (§V453): the palette walks past the field instead of the field
          // walking past the palette, so every stop visits every part of the picture. It
          // is also the proof that all six decoded — you watch each one arrive.
          parameters: { phase: expressionSlot("abstime * 0.04 % 1", 0) },
        },
      ),
      /**
       * T523 — `offset` AND `scale` ARE THE FIX FOR A PALETTE YOU CANNOT SEE.
       *
       * At the shipped 0 and 1 the index was the field's raw luminance, and a fractal
       * noise does not span 0..1: measured, this field runs from about 0.34 to 0.70 with
       * its median at 0.50. So the lookup only ever read the MIDDLE THIRD of the gradient
       * — the deep indigo end and the pale end never appeared at all, and an example whose
       * entire subject is a multi-stop palette was showing two of its stops and hiding the
       * rest.
       *
       * `index = luminance * scale + offset`. Solving that line through (0.34 -> 0.03) and
       * (0.70 -> 0.97) gives a slope of 2.6 and an intercept of -0.86, and those are the
       * two numbers below. The tails clamp, which is what the ramp's hold-outside-range
       * behaviour is for.
       */
      node(
        "remap",
        "lookup",
        [-260, 0],
        // Luminance is the index: a mono field's brightness IS its position along the
        // palette. `row` picks the middle of the gradient image, which is the whole of it
        // for a horizontal ramp.
        { channel: "luminance", row: 0.5, offset: -0.86, scale: 2.6 },
        { label: "lookup1" },
      ),
      node("out", "output", [120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-field-remap", ["field", "out"], ["remap", "source"]),
      edge("e-palette-remap", ["palette", "out"], ["remap", "lookup"]),
      edge("e-remap-out", ["remap", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E12 — Fluid (T362).
 *
 *   vel1(feedback) ─► stir1(customWgsl) ─► advect1.disp        the VELOCITY loop
 *        ╰┄┄┄┄┄┄┄┄ source: "stir1" ┄┄┄┄┄┄┄┄┄┄╯               (a reference, T350)
 *   dye1(feedback) ─► advect1(displace) ─► diffuse1(blur) ─► inject1.in2
 *   ink1(circle, centre ← mouse1) ─────────────────────────► inject1.in1
 *   inject1(over) ─► out1(output)                             the DYE loop
 *        ╰┄┄┄┄┄┄┄┄ dye1.source: "inject1" ┄┄╯
 *
 * E2 is already a reaction-diffusion, and the difference is the whole reason this file
 * exists: a chemistry BLOOMS — the pattern is generated where it stands — while a fluid
 * FLOWS, because the pattern is CARRIED. So this graph has two states, not one. The
 * velocity field is a state, the dye is a state, and the only thing connecting them is
 * that one is used as the coordinate the other is sampled at.
 *
 * ADVECTION IS A DISPLACE NODE, and that is the point of building it here rather than in
 * one kernel. Backward semi-Lagrangian advection — sample the dye one step upstream — is
 * exactly `uv + shift * weight` with a negative weight, which is Displace's whole shader.
 * Diffusion is a Blur. The fade is the Feedback node's own `persistence`. The only thing
 * that needed WGSL is the velocity field's self-advection plus the stirring force, and
 * that is one node. Written as a single kernel the graph would show nothing at all.
 *
 * THE NEGATIVE WEIGHT IS THE EXAMPLE. `weight: [-1, -1]` with `offset: [0, 0]` reads the
 * velocity as a SIGNED per-step displacement and samples AGAINST it. Flip the sign and
 * the dye still moves, still looks like a fluid, and is running the unstable forward
 * scheme — plausible-wrong, which is why `concepts.test.ts` pins the sign rather than the
 * presence of the node.
 *
 * ONE POINTER, TWO READERS (§V182). The stirring vortex is in the shader, reading
 * `frameU.pointer` from the shared frame block. The ink blob is on the CPU, its `center`
 * driven by the Mouse node. Neither of them is a DOM listener: both are the coordinate the
 * viewer published for this frame, so the ink lands in the eye of the vortex on every
 * frame by construction rather than by tuning.
 *
 * TWO LOOPS, NO CYCLE (T350, §V285). Neither Feedback is wired back into: each NAMES the
 * node it records, `edges` stays a DAG, and the compiler synthesizes the closing edge. Two
 * loops in one file is also what makes this the example that would notice a swap ordered
 * per-plan rather than per-pair — the velocity pair must swap after the dye has read it.
 *
 * WHY ONLY ONE LOOP IS PINNED (§V50/§V51). Both loops are still cycles, and a cycle breaks
 * resolution/format INHERITANCE because the chain has no ground to stand on — that is why
 * E2 pins its Feedback node. Here only the velocity loop needs it: the dye loop's
 * Composite inherits from `in1`, which is the ink generator, which takes the project's
 * settings. The dye loop is grounded through the ink; the velocity loop is grounded
 * nowhere, so it says what it needs. rgba16float on the velocity is not decoration —
 * a per-step displacement of 0.005 uv has no representation in rgba8unorm at all.
 *
 * The frame is SQUARE. Displace's weight is in uv units, so a 16:9 frame would make one
 * unit of velocity travel a different distance horizontally than vertically, and the
 * vortex would come out as an ellipse.
 */
const fluidDocument = document(
  "e12-fluid",
  "E12 Fluid",
  settings({ outputResolution: { width: 640, height: 640 }, randomSeed: 17 }),
  graph(
    [
      node("mouse", "mouse", [-980, 320], {}, { label: "mouse1" }),
      node(
        "velocity",
        "feedback",
        [-640, 200],
        // T350 (§V285): the loop is a REFERENCE. The velocity feedback NAMES the kernel
        // that produces it, so `edges` stays a DAG and the picture stops showing a cycle.
        { persistence: 1, clearColor: [0, 0, 0, 0], reset: false, source: "stir1" },
        {
          label: "vel1",
          // The velocity loop's only ground (see the note above).
          resolution: { mode: "fixed", width: 640, height: 640 },
          format: { mode: "fixed", format: "rgba16float" },
        },
      ),
      node(
        "stir",
        "customWgsl",
        [-320, 200],
        { [SHADER_SOURCE_PARAMETER]: FLUID_VELOCITY_WGSL, amount: 1 },
        { label: "stir1" },
      ),
      node(
        "dye",
        "feedback",
        [-640, -120],
        { persistence: 0.985, clearColor: [0, 0, 0, 0], reset: false, source: "inject1" },
        { label: "dye1" },
      ),
      node(
        "advect",
        "displace",
        [-320, -120],
        {
          // Per STEP, signed, sampled upstream. See the note above; the sign is the claim.
          weight: [-1, -1],
          offset: [0, 0],
          sourcex: "red",
          sourcey: "green",
          // Nothing may smear in from outside the box.
          extend: "zero",
        },
        { label: "advect1" },
      ),
      node("diffuse", "blur", [-40, -120], { size: 1.4, filter: "gaussian", extend: "zero" }, { label: "diffuse1" }),
      node(
        "ink",
        "circle",
        [-40, 137],
        {
          mode: "fill",
          radius: [0.028, 0.028],
          softness: 0.055,
          fillcolor: [1, 0.62, 0.24, 0.6],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        {
          label: "ink1",
          // §V113 component slots, §V182's CPU half: the blob sits where the pointer is,
          // in the same 0..1 v-down coordinate the kernel reads (§V236).
          parameters: {
            "center.x": drivenSlot("mouse1:x", 0.5),
            "center.y": drivenSlot("mouse1:y", 0.5),
          },
        },
      ),
      node("inject", "over", [240, -60], { opacity: 1 }, { label: "inject1" }),
      node("out", "output", [520, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-velocity-stir", ["velocity", "out"], ["stir", "input"]),
      // The SAME texture that closes the velocity loop steers the dye — this frame's
      // velocity, not last frame's, and rendered once for both consumers (§V6).
      edge("e-stir-advect", ["stir", "out"], ["advect", "disp"]),
      edge("e-dye-advect", ["dye", "out"], ["advect", "source"]),
      edge("e-advect-diffuse", ["advect", "out"], ["diffuse", "input"]),
      edge("e-diffuse-inject", ["diffuse", "out"], ["inject", "in2"]),
      edge("e-ink-inject", ["ink", "out"], ["inject", "in1"]),
      edge("e-inject-out", ["inject", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E13 — Prism (T710, rebuilt; was T363/T364).
 *
 *   bar1(pointTube) ─► form1(pointKernel) ─► solid1(geometry, surface) ─┐
 *   glass1(materialPhong) ──────────────── by name ────────────────────┘
 *                                                                       ├─► shot1(render)
 *   spectrum1(ramp) ─► optics1.field                                    │
 *   optics1(pointKernel) ─┬─► shaft1(geometry, beam, p.role < 0.5) ─────┤
 *                         └─► fan1  (geometry, beam, p.role > 0.5) ─────┤
 *   sky1(ramp) ─┐                                                       │
 *   band1(circle @ 0.5,0.5) ─┴─► studio1(add) ─► shot1.environment ─────┘
 *   key1(light), eye1(camera) ──── by name ─────────────────────────────┘
 *
 *   shot1 ─► cut1(level) ─► clip1(limit) ─► halo1(blur) ─► glow1(add).in2
 *   shot1 ─────────────────────────────────────────────► glow1(add).in1 ─► out1
 *
 *   swing1(lfo, square) ─► ease1(valueLag) ┄drives┄► optics1.value1   the AIM
 *   mouse1 ─► follow1(valueLag) ┄drives┄► optics1.value3              the AIM, +pointer
 *   drift1(lfo, sine) ┄drives┄► eye1.eye.x
 *   fan1.tint ← the `tint` attribute (map mode, T478)
 *
 * THE OWNER'S REFERENCE, and the one technical fact that makes it buildable: A PRISM
 * READS AS GLASS THROUGH ITS EDGES, NOT ITS VOLUME. The body is nearly black; what says
 * "glass" is a thin bright rim on every silhouette and a dim sheen on the faces. We have
 * no refraction and no glass material, and faking either reads worse than an honest
 * edge-lit prism — so the rim is T632's `envFresnel`, used deliberately (§V640).
 *
 * `envFresnel` rises to 1 at GRAZING, and §V640's measured LIMIT — the environment-band
 * rim is a rim only on CURVED geometry and turns into fill on a flat camera-facing
 * surface — is the whole reason this shape is built the way it is. `form1` walks a
 * ROUNDED triangle: three straight runs joined by three 120° arcs, and a quarter-round
 * where each flat cap meets the barrel. Along a straight run the surface renderer's
 * central difference is collinear, so the face normal is EXACTLY constant and the faces
 * stay flat and black. Across an arc the normal sweeps 120°, and somewhere in that sweep
 * it passes through grazing — so a thread of surface at grazing runs all the way round
 * the triangle, from any camera. That thread is the picture.
 *
 * Rounding the corners does not move the faces, which is what lets `optics1` below share
 * the geometry: the straight run of a rounded triangle sits at d·cos(60°) + ρ from the
 * axis, and with d = RC − 2ρ that is exactly RC/2 — a sharp triangle's inradius, for
 * every ρ. One number, two nodes, no drift.
 *
 * Measured at THIS commit, 1280×720, display-encoded from the plan's own space (§V618),
 * environment on vs off, split by a 6px erosion of the prism's own mask — §V640's own
 * instrument: RING mean |Δ| 43.06, INTERIOR 4.21, so the environment lands 10.2× harder
 * on the OUTLINE than in the body. E33's melted goo measured 1.8× and E33's flat emblem
 * measured 0.74×, i.e. fill. On the shipped frame the ring reads 62.7 luma against an
 * interior of 6.3. Two numbers, not one adjective.
 *
 * AMBIENT IS ZERO AND THE KEY IS HARD, and that is E33's lesson (§V632/T636) rather than
 * taste: the physical terms here are tiny — a 4% head-on Fresnel on a specular of 0.86
 * and a diffuse albedo of 0.0009 linear — so any ambient worth the name drowns them and
 * the glass goes to grey slate. `key1` therefore does exactly one job: its direction is
 * the mirror of the view about the upper-left round-over's normal, so its Blinn lobe
 * (shininess 140) lands as a GLINT on that edge and nowhere else. Measured: killing it
 * moves 8,387 pixels by more than 4 luma — it earns its node (§V624).
 *
 * THE DISPERSION IS THE EXAMPLE, and it is solved rather than drawn. `optics1` runs
 * Snell's law twice per band, vectorially, in the prism's own cross-section: refract in
 * at the right face, cross to the left face plane, refract out. n runs 1.500 (red) to
 * 1.585 (violet) — real crown glass disperses about a sixth of that, and the
 * exaggeration is `value2`, a number this file owns rather than a constant hidden in the
 * kernel. Sixty-one bands take their colour from `spectrum1` through the kernel's own
 * `field` input (`fieldAt(vec3f(t·2−1, 0, 0))` samples the ramp at u = t, v = 0.5), so
 * hue and refractive index are the SAME parameter and the ramp is the authored spectrum.
 *
 * WHAT THE ANGLE ACTUALLY DOES, measured rather than assumed. The brief for this rebuild
 * said "a more oblique incoming beam spreads more". That is not what the arithmetic says
 * and the file should not claim it. Differentiating δ = θ1 + asin(n·sin(A − θ2)) − A:
 *
 *     dδ/dn = (sin θ3 + cos θ3 · tan θ2) / cos θ4
 *
 * and as θ1 grows, θ2 grows, θ3 = A − θ2 shrinks and θ4 shrinks with it — numerator down,
 * denominator up. Angular dispersion therefore FALLS monotonically as the beam lies down
 * on the entry face, and RISES as the internal ray approaches the critical angle at the
 * EXIT face. Computed over the swing: 5.98° of fan at θ1 = 62°, 10.91° at θ1 = 37°.
 * Measured on the picture at the same two aims — the vertical span of the fan at screen
 * column 240 — 46px and 108px, a ratio of 2.35. The exit face is where dispersion is
 * made; the entry face only decides how obliquely the ray arrives there.
 *
 * θ1 stops at 37° and not lower for a reason that is in the same arithmetic: at n = 1.585
 * the critical angle is 39.1°, and θ3 reaches it at θ1 ≈ 33.7°. Below that the violet end
 * TOTALLY INTERNALLY REFLECTS. `refract2` returns a zero vector there and the beam
 * collapses to zero length — which the beam shader already draws as zero AREA — so the
 * failure is a band quietly leaving the spectrum rather than a wrong picture. 37° keeps
 * 3.3° of margin at the violet end.
 *
 * ONE SOURCE, TWO READINGS (§V471.1). `optics1` writes 63 points — the shaft, the ghost,
 * and 61 bands — and two Geometries read the same pointset through a GROUP PREDICATE,
 * because they need different tapers: `shaft1` takes `p.role < 0.5` at taper 1, a
 * parallel-sided ribbon, and `fan1` takes `p.role > 0.5` at taper 0.06, because 61 beams
 * leaving the same face within 0.03 of each other fuse into an opaque wedge at any taper
 * above about zero (T680). The structure is a selection, not more nodes.
 *
 * THE GHOST IS THE PART THAT SAYS "SURFACE". Not every ray enters: Schlick on the same
 * incidence the refraction uses gives the share the entry face sends back, 4.3% at 37°
 * rising to 8.3% at 62°, and that share IS its tint — so the reflected streak brightens
 * as the fan narrows, from one number, with no second knob.
 *
 * THE BEAMS ARE DRAWN IN A PLANE 0.05 IN FRONT OF THE FRONT FACE, and that is the one
 * cheat in the file, stated. The optics are solved in the cross-section, which does not
 * use the extrusion axis at all; drawing the segments at z = 0.60 instead of inside the
 * body is a shift along exactly that unused axis, and it is what stops the prism's own
 * solid from swallowing the ends of the shaft and the fan. Gated: the shaft's tip lands
 * 1px from the prism's mask and NO beam pixel reaches an 8px erosion of it, so "the beam
 * arrives where the glass is" is a measurement, not a hope.
 *
 * TWO WAYS TO MOVE THE AIM, and they are added in the KERNEL rather than merged on a
 * wire. `swing1(lfo, square) → ease1(valueLag) → value1` is the canonical chain and the
 * square is deliberate: a square through a one-pole smoother IS an ease, so delete
 * `ease1` and the beam snaps between two angles like a shutter instead of swinging.
 * `mouse1 → follow1(valueLag) → value3` is the pointer, and the kernel computes
 * `clamp(value1 + 0.55·value3, 0, 1)` — a value graph merges channel BAGS, and an LFO's
 * channel and a pointer's `x` do not have a name in common, so the addition belongs where
 * both numbers already are. The pointer only ever ADDS: a pointer that has never moved
 * reads 0, so every gate and every fresh session sees the LFO's picture exactly, and
 * dragging right lays the beam down and opens the spectrum.
 *
 * `drift1` sways the camera 0.22 either side of 0.45 over 22 seconds, and that is not
 * decoration: `envFresnel` reads `dot(N, viewDir)`, so moving the eye moves WHICH thread
 * of the round-over is at grazing. The rim travels. A static camera over this material is
 * the one thing that would make an edge-lit prism look painted.
 *
 * WHAT IS NOT HERE. There is no caustic on the base. The reference has one; we have no
 * refraction, so a caustic would be light we invented and placed, and §V617 means a beam
 * cannot cast one either. The glow under the prism is bloom spilling off the exit face,
 * which is a real thing that happens, and it is all this file claims.
 */
const PRISM_COLS = 240;
const PRISM_ROWS = 45;
/** Circumradius of the triangular cross-section. Its faces sit at PRISM_RC/2 (see below). */
const PRISM_RC = 0.76;
/** The band the glass is drawn WITH: 61 refracted rays plus the shaft and its ghost. */
const PRISM_BANDS = 61;

/**
 * The prism's SURFACE. A tube is a grid with its u seam closed, which is exactly the
 * topology a prism's lateral loop needs (T296/T301) — `bar1` is here for its `cols`,
 * `rows` and wrapU and nothing else, because every position below is replaced.
 *
 * THE ROUNDED TRIANGLE IS THE MECHANISM, not a styling choice. §V640: the environment
 * band is a rim only where the surface CURVES AWAY, and it degrades into fill on a flat
 * camera-facing face. So the cross-section is walked by ARC LENGTH — three straight runs
 * joined by three 120° arcs — and the profile puts a quarter-round where each flat cap
 * meets the barrel. Along a straight run the surface renderer's central difference is
 * collinear, so the face normal is EXACTLY constant and the faces stay flat and black;
 * across an arc the normal sweeps 120° and passes through grazing, so a thread of
 * surface at grazing runs the whole way round the triangle from any camera.
 *
 * Rounding the corners does not move the faces: a straight run sits at d·cos(60°) + ρ
 * from the axis, and with d = RC − 2ρ that is RC/2 for EVERY ρ — a sharp triangle's
 * inradius. That identity is why `optics1` can share this geometry from one constant.
 */
const PRISM_FORM_KERNEL = `const PI: f32 = 3.14159265358979323846;
const TAU: f32 = 6.28318530717958647692;
const RC: f32 = ${PRISM_RC};
/** Corner radius. Small — the corners are where the normal sweeps FASTEST. */
const RHO: f32 = 0.046;
const HALF: f32 = 0.55;
/** The quarter-round at the cap edge, radially and axially. This is the rim's WIDTH. */
const ER: f32 = 0.120;
const EZ: f32 = 0.120;

fn contour(u: f32) -> vec2f {
  let d = RC - 2.0 * RHO;
  let seg = sqrt(3.0) * d;
  let arc = RHO * TAU / 3.0;
  let unit = seg + arc;
  let s = u * 3.0 * unit;
  let k = floor(s / unit);
  let local = s - k * unit;
  let phi = PI * 0.5 + k * TAU / 3.0;
  let c = vec2f(cos(phi), sin(phi)) * d;
  if (local < arc) {
    let psi = phi - PI / 3.0 + local / RHO;
    return c + vec2f(cos(psi), sin(psi)) * RHO;
  }
  let outward = vec2f(cos(phi + PI / 3.0), sin(phi + PI / 3.0));
  let a = c + outward * RHO;
  let b = vec2f(cos(phi + TAU / 3.0), sin(phi + TAU / 3.0)) * d + outward * RHO;
  return mix(a, b, (local - arc) / seg);
}

/* Radius scale and z, along the axis: flat cap, quarter-round, barrel, and back again.
   The cap collapses to the axis at a = 0 and a = 1, which closes the solid — a quad with
   two coincident corners is a triangle, so the last ring is a fan. */
fn profile(a: f32) -> vec2f {
  if (a <= 0.10) { return vec2f((1.0 - ER) * (a / 0.10), HALF); }
  if (a <= 0.36) {
    let th = (a - 0.10) / 0.26 * (PI * 0.5);
    return vec2f(1.0 - ER * (1.0 - sin(th)), HALF - EZ * (1.0 - cos(th)));
  }
  if (a <= 0.64) { return vec2f(1.0, mix(HALF - EZ, -(HALF - EZ), (a - 0.36) / 0.28)); }
  if (a <= 0.90) {
    let th = (0.90 - a) / 0.26 * (PI * 0.5);
    return vec2f(1.0 - ER * (1.0 - sin(th)), -(HALF - EZ * (1.0 - cos(th))));
  }
  return vec2f((1.0 - ER) * ((1.0 - a) / 0.10), -HALF);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* wrapU: the u parametrization is EXCLUSIVE, so i/cols closes the seam exactly. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let a = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let pr = profile(a);
  q.position = vec3f(contour(u) * pr.x, pr.y);
  return q;
}`;

/** `tip` is the beam's far end (T680 binds it by name); `role` is what splits ONE
 *  pointset into two draws with different tapers; `tint` is `color`-qualified (§V313). */
const PRISM_OPTICS_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tip", type: "vec3f", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "role", type: "f32", default: [1] },
]);

/**
 * THE OPTICS — Snell's law twice per band, vectorially, in the prism's cross-section.
 * This is the difference between a working prism and a picture of one: nothing here is
 * an authored angle, and the fan's spread falls out of the same arithmetic that decides
 * each band's colour, because n and hue are the SAME parameter t.
 */
const PRISM_OPTICS_KERNEL = `const PI: f32 = 3.14159265358979323846;
/* The two refracting faces, as outward normals, and the offset they share. */
const NR: vec2f = vec2f(0.86602540, 0.5);
const NL: vec2f = vec2f(-0.86602540, 0.5);
const RI: f32 = ${(PRISM_RC / 2).toFixed(3)};
/* The beams are drawn 0.05 IN FRONT of the front face — a shift along the extrusion
   axis, which is the one direction the cross-section does not use, so the optics are
   untouched and the solid cannot swallow either end. */
const PLANE: f32 = 0.60;
/* Where on the entry face the beam lands, as a tangent coordinate. The face runs
   +/-0.578, so this sits low on it — the reference's beam enters LOW. */
const ENTRY: f32 = -0.28;
const SHAFT_LEN: f32 = 2.10;
const GHOST_LEN: f32 = 0.90;
const FAN_LEN: f32 = 2.25;
const N_RED: f32 = 1.50;
/* 37 and not lower: at n = 1.585 the critical angle is 39.1 degrees and the internal ray
   reaches it at about 33.7, where the violet end goes into TOTAL INTERNAL REFLECTION. */
const THETA_LO: f32 = 37.0;
const THETA_HI: f32 = 62.0;
const AIM_POINTER: f32 = 0.55;

/* WGSL's own refract, in 2D. A zero return IS total internal reflection, and a beam
   whose two ends coincide draws zero area (T680) — so the failure is a band leaving the
   spectrum, never a wrong ray. */
fn refract2(i: vec2f, n: vec2f, eta: f32) -> vec2f {
  let d = dot(n, i);
  let k = 1.0 - eta * eta * (1.0 - d * d);
  if (k < 0.0) { return vec2f(0.0); }
  return i * eta - n * (eta * d + sqrt(k));
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The LFO and the pointer are ADDED HERE, not merged on a wire: a value graph merges
     channel BAGS, and an LFO's channel and a pointer's x share no name. value3 is 0
     until a pointer moves, so every gate sees the LFO's picture exactly. */
  let aim = clamp(ctx.value1 + AIM_POINTER * ctx.value3, 0.0, 1.0);
  let theta = mix(THETA_HI, THETA_LO, aim) * PI / 180.0;
  let inward = -NR;
  let cs = cos(-theta);
  let sn = sin(-theta);
  let dIn = vec2f(inward.x * cs - inward.y * sn, inward.x * sn + inward.y * cs);
  let pe = NR * RI + vec2f(-NR.y, NR.x) * ENTRY;

  if (ctx.index == 0u) {
    q.position = vec3f(pe - dIn * SHAFT_LEN, PLANE);
    q.tip = vec3f(pe, PLANE);
    q.tint = vec4f(1.0, 1.0, 1.0, 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 1u) {
    /* The GHOST: the share the face sent back, by Schlick on the same incidence the
       refraction uses. 4.3% at 37 degrees, 8.3% at 62 — so the streak brightens as the
       fan narrows, out of one number rather than a second knob. */
    let r = dIn - NR * (2.0 * dot(dIn, NR));
    let c = abs(dot(dIn, NR));
    let fr = 0.043 + 0.957 * pow(1.0 - c, 5.0);
    q.position = vec3f(pe, PLANE);
    q.tip = vec3f(pe + r * GHOST_LEN, PLANE);
    q.tint = vec4f(vec3f(fr), 1.0);
    q.role = 0.0;
    return q;
  }
  /* t is BOTH the refractive index and the hue: value2 is the glass's dispersive power
     (real crown glass is about a sixth of this), and the colour comes from the ramp on
     the field input at u = t. Mute value2 and the fan collapses to one ray. */
  let t = f32(ctx.index - 2u) / f32(ctx.count - 3u);
  let n = N_RED + ctx.value2 * t;
  let d2 = refract2(dIn, NR, 1.0 / n);
  let den = dot(d2, NL);
  let s = (RI - dot(pe, NL)) / max(den, 1.0e-4);
  let px = pe + d2 * s;
  let d3 = refract2(d2, -NL, n);
  q.position = vec3f(px, PLANE);
  q.tip = vec3f(px + d3 * FAN_LEN, PLANE);
  q.tint = vec4f(fieldAt(vec3f(t * 2.0 - 1.0, 0.0, 0.0)).rgb, 1.0);
  q.role = 1.0;
  return q;
}`;

const prismDocument = document(
  "e13-prism",
  "E13 Prism",
  settings({ randomSeed: 23 }),
  graph(
    [
      // ---- the aim: two chains, added in the kernel -------------------------------
      // A SQUARE, deliberately: a square through a one-pole smoother IS an ease, so
      // `ease1` is visible rather than theoretical — delete it and the beam snaps
      // between two angles like a shutter instead of swinging.
      node("swing", "lfo", [-1880, 640], { shape: "square", frequency: 0.18, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "swing1" }),
      node("ease", "valueLag", [-1560, 640], { lag: 0.6 }, { label: "ease1" }),
      node("mouse", "mouse", [-1880, 840], {}, { label: "mouse1" }),
      node("follow", "valueLag", [-1560, 840], { lag: 0.18 }, { label: "follow1" }),
      // `envFresnel` reads dot(N, viewDir), so moving the eye moves WHICH thread of the
      // round-over is at grazing: the rim TRAVELS. A static camera is the one thing that
      // would make an edge-lit prism look painted.
      node("drift", "lfo", [-1880, 1040], { shape: "sine", frequency: 0.045, amplitude: 0.22, offset: 0.45, phase: 0 }, { label: "drift1" }),

      // ---- the glass -------------------------------------------------------------
      node("bar", "pointTube", [-1880, -420], { count: PRISM_COLS * PRISM_ROWS, cols: PRISM_COLS, rows: PRISM_ROWS }, { label: "bar1" }),
      node("form", "pointKernel", [-1560, -420], {
        capacity: PRISM_COLS * PRISM_ROWS,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: PRISM_FORM_KERNEL,
      }, { label: "form1" }),
      // The environment term compiles for PHONG only, and nothing warns you otherwise: a
      // lambert or unlit prism has no Fresnel and therefore no rim at all. Diffuse is
      // 0.0009 linear — the body is meant to be black — and the whole read is `specular`
      // times `envFresnel`, which is 0.04 head-on and 1.0 at grazing.
      node("glass", "materialPhong", [-1560, -640], {
        color: [0.012, 0.013, 0.018, 1], specular: [0.86, 0.92, 1, 1], shininess: 140, roughness: 0.06,
      }, { label: "glass1" }),
      node("solid", "geometry", [-1240, -420], { mode: "surface", material: "glass1", tint: [1, 1, 1, 1] }, { label: "solid1" }),

      // ---- the light, taken apart ------------------------------------------------
      // A ramp that GOES somewhere (§V471.6), and it is not decoration: this is the
      // curve n(t) is read against, so retuning it retunes the spectrum's colour without
      // touching a line of WGSL.
      node("spectrum", "ramp", [-1880, 100], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.00, color: [1, 0.10, 0.06, 1] },
          { position: 0.17, color: [1, 0.42, 0.05, 1] },
          { position: 0.33, color: [1, 0.86, 0.10, 1] },
          { position: 0.50, color: [0.28, 1, 0.24, 1] },
          { position: 0.66, color: [0.10, 0.82, 1, 1] },
          { position: 0.83, color: [0.16, 0.30, 1, 1] },
          { position: 1.00, color: [0.55, 0.14, 1, 1] },
        ],
      }, { label: "spectrum1", definitionVersion: 2, resolution: { mode: "fixed", width: 256, height: 8 } }),
      node("optics", "pointKernel", [-1560, 100], {
        capacity: PRISM_BANDS + 2,
        attributes: PRISM_OPTICS_ATTRIBUTES,
        kernel: PRISM_OPTICS_KERNEL,
        // The glass's DISPERSIVE POWER, and the one number the whole effect rests on:
        // n runs 1.500 (red) to 1.585 (violet). Set it to 0 and the fan collapses to a
        // single ray, which is what the gate asserts.
        value2: 0.085,
      }, {
        label: "optics1",
        parameters: { value1: drivenSlot("ease1", 0.5), value3: drivenSlot("follow1:x", 0) },
      }),
      // UNLIT, and white: a beam is scattered light in the air, not a surface, and it
      // takes no part in shadowing either (§V617). The colour is the attribute's.
      node("flare", "materialUnlit", [-1560, -140], { color: [1, 1, 1, 1] }, { label: "flare1" }),
      // §V471.1 — ONE SOURCE, TWO READINGS, split by a group predicate rather than by
      // more nodes. The split is not cosmetic: a single shaft wants a parallel-sided
      // ribbon, and 61 beams leaving the same face within 0.03 of each other fuse into
      // an opaque wedge at any taper above about zero (T680).
      node("shaft", "geometry", [-1240, -140], {
        mode: "beam", endpoint: "tip", scale: 0.006, taper: 1, material: "flare1", group: "p.role < 0.5",
      }, { label: "shaft1", parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } } } }),
      node("fan", "geometry", [-1240, 100], {
        mode: "beam", endpoint: "tip", scale: 0.0075, taper: 0.06, material: "flare1", group: "p.role > 0.5",
      }, { label: "fan1", parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } } } }),

      // ---- the studio: an equirect whose horizon IS the rim -----------------------
      // v = acos(R.y)/pi, so 0.5 is the horizon; u = atan2(R.x, -R.z)/2pi + 0.5. A normal
      // lying in the cross-section plane reflects to (0,0,-1) and lands at (0.5, 0.5)
      // EXACTLY — §V640's band, at the address §V640 gives for it. The cap's normal
      // lands at u ~ 0.01 instead, well outside the band, which is why the body stays
      // black while the outline lights: one texture, two addresses.
      node("sky", "ramp", [-1880, -900], {
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.00, color: [0, 0, 0, 1] },
          { position: 0.40, color: [0.004, 0.005, 0.009, 1] },
          { position: 1.00, color: [0, 0, 0, 1] },
        ],
      }, { label: "sky1", definitionVersion: 2, resolution: { mode: "fixed", width: 512, height: 256 } }),
      // `aspectcorrect` FALSE, always, on an equirect: the map is not a picture of a
      // square. Softness 0.16 and not more — the band's tail is what greys the body.
      node("band", "circle", [-1880, -680], {
        mode: "fill", center: [0.5, 0.5], radius: [0.26, 0.075], softness: 0.16,
        fillcolor: [0.74, 0.84, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: false,
      }, { label: "band1" }),
      node("studio", "add", [-1560, -900], {}, { label: "studio1", resolution: { mode: "fixed", width: 512, height: 256 } }),

      // ---- the shot --------------------------------------------------------------
      // ONE job: the direction is the mirror of the view about the upper-left
      // round-over's normal, so the Blinn lobe lands as a GLINT on that edge and nowhere
      // else. Measured: kill it and 8,387 pixels move by more than 4 luma.
      node("key", "light", [-1240, -900], {
        kind: "directional", direction: [0.73, -0.60, 0.31], color: [0.80, 0.88, 1, 1], intensity: 2.6, shadows: false,
      }, { label: "key1" }),
      node("eye", "camera", [-1240, -680], {
        // 26 degrees is a long lens on purpose: this is a poster, and a wide one would
        // bend the spectrum's straight rays. The eye sits barely off the prism's own
        // axis, which is what keeps the lateral faces to a sliver instead of a slab.
        eye: [0.45, -0.36, 6.6], lookAt: [-0.05, -0.53, 0], fov: 26, near: 0.1, far: 40, ortho: false,
      }, { label: "eye1", parameters: { "eye.x": drivenSlot("drift1", 0.45) } }),
      node("shot", "render", [-920, -420], {
        scenes: "solid1 fan1 shaft1", camera: "eye1", lights: "key1",
        // AMBIENT ZERO, and it is E33's lesson rather than taste (§V632/T636): the
        // physical terms here are a 4% head-on Fresnel and a 0.0009 albedo, so any
        // ambient worth the name drowns them and the glass goes to grey slate.
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0,
        background: [0, 0, 0, 1], environmentIntensity: 3.2, showEnvironment: false,
      }, { label: "shot1" }),

      // ---- the bloom, and the clamp that is load-bearing --------------------------
      // Level is a SIGNED pipeline: below `blacklevel` it emits negatives, the blur
      // spreads them over the whole frame and `add` then SUBTRACTS a halo from the
      // picture. On a document this black almost every pixel is below the threshold, so
      // without `clip1` the frame goes out entirely (E33's and E34's lesson, twice).
      node("cut", "level", [-600, -140], { blacklevel: 0.32, whitelevel: 1, gamma1: 1, contrast: 1, brightness: 1, opacity: 1 }, { label: "cut1" }),
      node("clip", "limit", [-280, -140], { mode: "clamp", low: 0, high: 6, steps: 4 }, { label: "clip1" }),
      node("halo", "blur", [40, -140], { size: 22, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("glow", "add", [360, -420], {}, { label: "glow1" }),
      node("out", "output", [680, -420], {}, { label: "out1" }),
    ],
    [
      edge("e-swing-ease", ["swing", "out"], ["ease", "in"]),
      edge("e-mouse-follow", ["mouse", "out"], ["follow", "in"]),

      edge("e-bar-form", ["bar", "out"], ["form", "in"]),
      edge("e-form-solid", ["form", "out"], ["solid", "points"]),

      edge("e-spectrum-optics", ["spectrum", "out"], ["optics", "field"]),
      edge("e-optics-shaft", ["optics", "out"], ["shaft", "points"]),
      edge("e-optics-fan", ["optics", "out"], ["fan", "points"]),

      edge("e-sky-studio", ["sky", "out"], ["studio", "in1"]),
      edge("e-band-studio", ["band", "out"], ["studio", "in2"], 0),
      edge("e-studio-shot", ["studio", "out"], ["shot", "environment"]),

      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E16 — Murmuration (T410).
 *
 * The SOP-chain showcase: a sphere of anchor points flows through TWO kernels before it
 * is drawn — `sphere → flock → part → birds` — which is the shape T401 made possible and
 * nothing else demonstrates. Points are a PIPELINE here, not a source-to-sink hop.
 *
 * The flock kernel is the interesting half of T401's ownership rule (§V197) in one node:
 * `position` IS carried by the upstream sphere, so `in_position` binds the GENERATOR's
 * pair and arrives fresh every frame — the formation is re-asserted, never integrated.
 * `offset`, `velocity` and `tint` are NOT carried upstream, so they live in the kernel's
 * OWN pairs and persist across frames — which is what lets a processor still be a
 * simulation: the anchor comes from upstream, the motion accumulates locally, and
 * `position = anchor + offset` writes the kernel's own output pair. No neighbour reads
 * (a kernel sees one point), so the flocking is a shared FLOW FIELD — three phase-shifted
 * sines keyed by the anchor — plus a spring home and damping: coherent swirl, birds that
 * never abandon the formation, zero O(N²) anywhere.
 *
 * `tint` is the colour-BY-VELOCITY channel: computed from `length(velocity)` in the
 * flock kernel (slow = deep blue, fast = warm white), then it crosses the SECOND kernel
 * BY REFERENCE — `part` declares only `position`, so tint passes through as the flock's
 * own pair, untouched and uncopied (§V197's narrowing, live in a shipped file).
 *
 * `part` is the E9 cursor push as a PROCESSOR: stateless, reads the flock's positions,
 * shoves the nearby ones away from the pointer (§V182/§V236 mapping written in the
 * kernel, Gaussian falloff for the same air-not-edge reason as E9). A bird pushed too
 * far leaves the DRAW — the renderer's `group` predicate (T333) culls anything beyond
 * radius 1.7 at draw time, so strays vanish without any kernel writing a kill.
 */
const MURMURATION_FLOCK_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "offset", type: "vec3f", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0.25, 0.35, 0.9, 1] },
]);

const MURMURATION_FLOCK_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* T401: p.position is the UPSTREAM sphere's pair, fresh every frame — the anchor.
     offset/velocity are this kernel's OWN state and persist (§V197). */
  let anchor = p.position;
  /* FREE-RUNNING (§V436, T497): ctx.absTime, not ctx.time. The flow field is the wind, and
     wind does not restart when the piece does — ctx.time wraps at the out point (T455) and
     put every phase back where it was at frame zero, snapping the whole flock at each lap.
     ctx.delta below is untouched: a step is continuous across a lap by construction (T464). */
  let t = ctx.absTime * 0.6;
  /* The "flock": one shared flow field, phase-keyed by the anchor, so neighbours on the
     formation swirl together without any neighbour reads. */
  let flow = vec3f(
    sin(anchor.y * 3.1 + t) + 0.5 * sin(anchor.z * 4.7 - t * 1.3),
    sin(anchor.z * 2.9 + t * 1.1) + 0.5 * sin(anchor.x * 5.3 + t),
    sin(anchor.x * 3.7 - t) + 0.5 * sin(anchor.y * 4.1 + t * 0.7),
  );
  let spring = -q.offset * 1.8; /* home pull: the murmuration never abandons the sphere */
  q.velocity = (q.velocity + (flow * 0.9 + spring) * ctx.delta) * 0.985;
  q.offset = q.offset + q.velocity * ctx.delta;
  q.position = anchor + q.offset;
  /* Colour BY VELOCITY: slow birds sit deep blue, fast ones flare toward warm white. */
  let heat = clamp(length(q.velocity) * 1.4, 0.0, 1.0);
  q.tint = vec4f(0.25 + 0.75 * heat, 0.35 + 0.45 * heat, 0.9 - 0.35 * heat, 1.0);
  return q;
}`;

const MURMURATION_PART_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The E9 cursor push, as a stateless PROCESSOR: same §V182 pointer, same §V236
     v-down mapping written where the clip convention is known, same Gaussian-not-edge. */
  let cursor = vec3f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0, 0.0);
  let away = q.position - cursor;
  let distance = max(length(away), 0.0001);
  let falloff = exp(-(distance * distance) / 0.16);
  q.position = q.position + (away / distance) * falloff * 0.9;
  return q;
}`;

/**
 * E20 — Gooeyball (T417). The owner's ask, in their words: a ball "deformed from the
 * inside without breaking the surface". The 2D→3D crossing made literal: an animated
 * 2D noise becomes a per-point attribute (textureToAttribute), a T401 processor pushes
 * every point along the surface NORMAL by that sample, and a `geometry` object in
 * SURFACE mode — its material named by reference, drawn by `render` (T446/T447) — shades
 * the grid as a closed ball whose seam the wrap flag heals. (The legacy `renderSurface`
 * node still exists and still builds the same surface; this example went through the
 * scene pipeline when the ports→references redirect landed, and B83 is the doc that kept
 * naming the node it no longer uses.)
 *
 * WHY THE SURFACE SURVIVES — the doc's teaching, stated here for the tests:
 *  - displacement is ALONG THE NORMAL, and on a sphere the normal is free:
 *    normalize(position) IS the outward normal, no neighbours needed. A radial push
 *    moves a point toward or away from the centre and never sideways past its grid
 *    neighbours, so cells stretch but never fold or self-intersect.
 *  - the noise is CONTINUOUS in uv and in time, so neighbouring points sample nearly
 *    the same displacement and the surface stays a surface — white noise here would
 *    shred the ball into spikes.
 *  - the seam is a TOPOLOGY claim, not geometry: the ball kernel maps u = i/COLS so
 *    column 0 and a hypothetical column COLS coincide, and `pointTopology`'s wrapU adds
 *    the seam CELL that stitches the last column to the first (T302). Remove the wrap
 *    and the ball shows a slit; the points never move. Note the divisor is the KERNEL
 *    AUTHOR's — `ctx.dim` hands over cols and rows, never a normalised u, because the
 *    right divisor here (COLS, targeting a claim made DOWNSTREAM) is not the one the
 *    incoming edge's own unwrapped flags would imply (T472).
 *
 * The chain is FIVE point nodes — grid → ball → sample → goo → claim → body — and
 * every link is T401's processor mechanism or an edge-payload edit. `sample` is
 * authored by the bridge and read by `goo` as an upstream-bound attribute; topology
 * flows generator → kernels → claim by passthrough — and now flows INTO the ball kernel
 * too, as `ctx.dim` (T472, B85: the 64 that used to be typed into the WGSL).
 */
const GOOEY_COLS = 64;
const GOOEY_ROWS = 64;

const GOOEY_BALL_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The grid is an INDEX SHEET; the sphere comes from the index, not the plane.
     ctx.dim IS the sheet (T472): cols, rows and this slot's cell, read off the topology
     the grid publishes on the edge — turn grid1's Columns knob and this follows, which
     is exactly what a hard-coded 64u could not do (B85).
     u runs i/COLS (not cols-1): column 0 and "column COLS" coincide, which is what the
     wrapU seam cell downstream stitches together. v runs pole to pole. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let theta = u * 6.28318530718;
  let phi = v * 3.14159265359;
  q.position = 0.85 * vec3f(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
  return q;
}`;

const GOOEY_GOO_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* ALONG THE NORMAL, and on a sphere the normal is free: normalize(position) is the
     outward direction, no neighbour reads. Radial pushes stretch cells but never fold
     them — that is why the ball deforms from inside and never tears. */
  let normal = normalize(p.position);
  /* p.sample is the bridge's pair, upstream-bound (T401): the noise value sampled at
     THIS point's sphere position, fresh every frame. Centred so the ball breathes both
     inward and outward around its rest radius. */
  let amount = (p.sample.r - 0.5) * 0.5;
  q.position = p.position + normal * amount;
  q.sample = p.sample;
  return q;
}`;

/**
 * E24 — Audio-Reactive Reaction-Diffusion (T425). The CAPSTONE.
 *
 * E2's rebuilt chemistry, played like an instrument. The owner supplied a TouchDesigner
 * walkthrough as the brief; this file is its mapping onto OUR machinery, node by node:
 *
 *  · AUDIO → SUBSTEPS. The bass envelope multiplies iterations per frame (T425's whole
 *    reason: the count is a per-frame VALUE), so the pattern physically ACCELERATES on
 *    the beat — not brighter, FASTER. The value chain caps it (valueLimit 1..34) before
 *    it ever reaches the plan, and expandLoops clamps again at encode: two fences, one
 *    contract — a loud passage cannot spike frame time unboundedly.
 *  · AUDIO → CHEMISTRY, RANGE-MAPPED WITH SAFE BOUNDS. The tutorial's own warning is
 *    the teaching: lowMid drives the map-shaping Level's white point, but through
 *    multiply → add → valueLimit into [0.62, 0.80] — the band where the pattern keeps
 *    breaking and reforming. Unclamped, one loud moment drives feed/kill out of the
 *    regime where the simulation survives, the pattern dies, and SILENCE DOES NOT
 *    BRING IT BACK — dead state is a fixed point. The clamp is not tuning; it is what
 *    makes the instrument recoverable.
 *  · RGB DELAY, HONESTLY TEMPORAL. TD's RGB Delay is time, not space: three cache
 *    rings tap the coloured output at 2, 5 and 9 frames back, and a Reorder wears one
 *    channel from each — motion fringes into rainbow, stillness stays clean. The naive
 *    per-channel-scaling translation would be chromatic aberration, the wrong effect.
 *  · WIND. A Transform INSIDE the loop (state → wind → rd), rotating a hair per
 *    iteration. Substeps multiply it, so the bass literally stirs faster — the T350
 *    reference keeps the loop a name (`source: "pack1"`) while the body grows a node.
 *  · SILENCE IS A PICTURE, NOT A FAILURE (§V329). Unbound audio reads all-zero
 *    channels: substeps rest at their base, the chemistry sits mid-band, the palette
 *    breathes on its own LFO — the example ANIMATES (T402) with no track bound, and
 *    binding one adds the instrument on top.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T560 / T562 — TWO CLOCKS, BECAUSE THE OWNER COULD NOT SEE THE AUDIO AND THE FIELD
 * WAS ONE TEXTURE. Both complaints, and both are measurements before they are opinions.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * "I don't even see the audio reactivity. Maybe some stuttering, but nothing compelling."
 * "The reaction diffusion already felt pretty dense and regular instead of interesting
 *  with sparser regions sprinkled in."
 *
 * ## T560 — every audio path ran through a SLOW INTEGRATOR, so transients vanished
 *
 * Everything the sound touched was either Gray-Scott's feed/kill (a reaction that
 * INTEGRATES a beat into a gradual regime change over dozens of frames) or the substep
 * count (the same, one level up). Measured on the shipped file across the beat at frame
 * 194: p90 luminance moved 0.0599 → 0.0615 and p99 moved 0.4000 → 0.4036. Under one
 * percent. The audio was connected; the MEDIUM ate it.
 *
 * The one path that was supposed to be fast was arithmetically dead. `trig1` (a
 * one-frame pulse) fed a `valueLag` of 0.35 s, and a one-pole smoother answers a
 * single-frame impulse with `1 - exp(-dt/tau)` — 0.047 at 60fps. So the palette's
 * driven scale travelled 2.4000 → 2.4535 on a hit: a 2% swing, sold in the comments as
 * "the kick PUNCHES the lookup's gain". That is §V481(b) from the other side — an
 * impulse into a smoother is an impulse DIVIDED BY THE FRAME RATE — and it is why the
 * seeding below drives from the RAW trigger and nothing lags it.
 *
 * The fix is §V471 transplanted from E31, which drives EIGHT properties and most of them
 * respond in the frame they are given: a SECOND, fast lag (`snap1`, 0.04 s) beside the
 * slow one, and one band to one property with its own gain and bias —
 *   low     → the broad lens weight     (the picture swells)
 *   lowMid  → the mid lens weight       (the fronts sway)
 *   high    → the fine lens weight      (the ridges shiver)
 *   highMid → the palette's scale       (§V471.7 — the ramp breathes)
 *   level   → the output Level's gain   (a one-frame lift over everything)
 * and, on the trigger, a SEED into the simulation state (below). §V477 governs every
 * pair: the bias is where silence sits and the gain is the swing, so all five rest LOW.
 *
 * ## T562 — the chemistry map was a FIELD in name and a CONSTANT in fact
 *
 * The kernel reads `centre.b` per fragment, so the chemistry coordinate has always been
 * per-pixel — the graph paints it and the Reorder packs it. It just had nothing in it.
 * Measured at frame 322, the shipped map's own histogram: 0.45 … 1.00, median 0.645,
 * with HALF of every frame inside 0.60 … 0.69. Across the band that is feed 0.0364 to
 * 0.0377, and Gray-Scott is famously sensitive at the THOUSANDTH. Every region of the
 * picture was therefore running the same chemistry, which is exactly what "dense and
 * regular" looks like — and worse, `detail1` only ever WARPED `broad1`, so the map had
 * one spatial scale, and that scale (period 0.62) was bigger than the frame. The
 * rendered map was a flat pale cloud.
 *
 * Two changes, both on the map and neither on the shader:
 *   · `broad1` gets a smaller period and a third octave, so the map has REGIONS —
 *     features at roughly 150, 75 and 38 pixels of a 512 frame, which is several
 *     Gray-Scott features per region rather than one region per frame.
 *   · `shape1`'s window is narrowed onto the field's actual spread and its gamma lifts
 *     the midtones, so the map SPANS the band instead of hugging one end of it. §V474
 *     sets the direction and it is the direction that was got wrong once already: the
 *     HIGH corner is spots and mitosis and that is where empty field lives, so the map
 *     rests HIGH and dips into the low (labyrinth) corner in patches. Sparse ground,
 *     dense veins, several regimes in one frame.
 * The smoothed envelope still moves the white point, so the regions BREATHE across the
 * band together while sitting at different points on it.
 *
 * ## The other two asks in the same breath
 *
 *  · ONE SOURCE, SEVERAL READINGS (§V471.1). E31 draws one point cloud three times and
 *    splits it by group predicate. The texture analogue is here: the chemistry map is
 *    read a SECOND time, dimmed, and added to the simulation's V before the palette
 *    lookup — so a region's chemistry sets its base hue while V rides on top of it. The
 *    field was monochrome because V is near-binary and a near-binary coordinate visits
 *    exactly two stops of a five-stop ramp; adding a continuous term is what makes the
 *    middle of the ramp exist.
 *  · COLOUR EVOLUTION OVER TIME. The palette's own LFO stays; a second, SLOWER one
 *    (0.033 Hz — a 30-second lap, §V471.8) drives an HSV hue offset over the finished
 *    picture, so an hour of it never sits in one place. Free-running (§V436, B98).
 */
const audioRdDocument = document(
  "e24-audio-reaction-diffusion",
  "E24 Audio Reaction-Diffusion",
  settings({ outputResolution: { width: 512, height: 512 } }),
  graph(
    [
      // ---- the sound: two sources, one SWITCH, never both ------------------------
      /*
       * T442 (B74, §V363): the flagship PLAYS on first open. Assets are session-only, so
       * no example can ship a bound audio file — and an audio-reactive graph whose null
       * state is indistinguishable from a broken one demos nothing.
       *
       * T504 — AND YOUR OWN TRACK IS ONE DROP AWAY. Both sources are wired, permanently,
       * into `source1`, and the Switch's `index` picks: 0 is the deterministic pattern,
       * 1 is whatever file you drop on `track1`. Nothing downstream changes, because
       * everything downstream reads `source1`.
       *
       * IT HAS TO BE A SWITCH AND IT CANNOT BE A WIRE. Two value sources landing on ONE
       * port MERGE — `{...prior, ...next}` over sorted edge ids (§V457) — and both of
       * these publish the same channel names, so the later edge would win outright and
       * the other source would silently vanish. That is not "mixing them together", it
       * is worse: it is one of them disappearing with the graph still looking right.
       * `valueSwitch` (T508) is exclusive by construction — the unselected branch is not
       * read into the output at all.
       */
      node("music", "audioPattern", [-2000, 300], { bpm: 112, amount: 1 }, { label: "music1" }),
      /*
       * THE DROP TARGET, and it is placed where you would look for it: directly under the
       * pattern it replaces, wired into the same box, with an empty File parameter waiting.
       * Nothing about the graph has to be read to see where a track goes.
       * T493 gave this node a transport (play mode, speed, cue, trim, volume) — all on its
       * defaults here, which is a timeline-anchored playhead, so bar one of your track
       * lands on the in point and an offline render of it reproduces.
       */
      node("track", "audioFileIn", [-2000, 640], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-1720, 460], {
        /* 0 = the pattern, 1 = the file. The ORDER is the port order (in1, in2), not an
           edge tiebreak — value ports are named, so this is unambiguous by construction
           in a way the texture Switch's variadic port is not (§V131). */
        index: 0,
      }, { label: "source1" }),
      /* ---- TWO LAGS AND A TRIGGER, because the piece has three timescales -------------
       *
       * E31 smooths once at the source and drives everything from that one Lag, and its
       * comment gives the reason: the bands are noisy, so one Lag means every driven
       * property agrees about what "now" is. That is right when every property is doing
       * the same JOB. Here they are not (T560/T562): the chemistry and the substep count
       * are STRUCTURE and want the beat blurred into a swell, while the lenses, the
       * palette and the output gain are EVENTS and want the transient intact. One Lag
       * cannot be both, and the shipped file only had the slow one — which is most of why
       * a beat was invisible.
       *
       * `trig1` is the third: not a timescale at all but an INSTANT, and the seeding
       * below reads it raw. §V481(b) says light a persistent loop with a trigger rather
       * than a level, and the arithmetic says the same thing from the other end — the
       * shipped file put this pulse through a 0.35 s Lag, which answers a one-frame
       * impulse with 0.047 of it.
       */
      node("env", "valueLag", [-1440, 450], { lag: 0.12 }, { label: "env1" }),
      node("snap", "valueLag", [-1440, 1200], { lag: 0.04 }, { label: "snap1" }),
      node("trig", "valueTrigger", [-1440, 1900], { threshold: 0.5 }, { label: "trig1" }),

      // ---- SLOW: structure ------------------------------------------------------------
      // Substeps: low band, scaled 0..20 over a base of 14, fenced 1..34.
      node("sgain", "valueMath", [-980, 340], { operation: "multiply", operand: 66.897 }, { label: "sgain1" }),
      node("sbase", "valueMath", [-740, 419], { operation: "add", operand: -31.2246 }, { label: "sbase1" }),
      node("scap", "valueLimit", [-500, 419], { minimum: 1, maximum: 34 }, { label: "steps1" }),
      /* Chemistry: lowMid moves the map's white point, hard-fenced to the band where the
         pattern SURVIVES (the tutorial's "so the pattern doesn't disappear"). T562 moved
         the fence with the window below: the map's Level now sits on a much narrower
         window (see `shape1`), so the same fractional swing needs a much narrower fence —
         0.62..0.80 around a white point of 0.543 would have been the whole picture. */
      node("wgain", "valueMath", [-980, 613], { operation: "multiply", operand: 0.1788 }, { label: "wgain1" }),
      node("wbase", "valueMath", [-740, 692], { operation: "add", operand: 0.445 }, { label: "wbase1" }),
      node("wcap", "valueLimit", [-500, 676], { minimum: 0.528, maximum: 0.566 }, { label: "wlevel1" }),

      /* ---- FAST: events. §V471.3's idiom — one band, one property, its own gain+bias ---
       *
       * Five pairs off `snap1`, and the numbers are MEASURED against the Beat pattern
       * rather than intended: on that source `low` rests near 0.14 and peaks near 0.55
       * through this Lag, `lowMid` 0.15/0.45, `highMid` 0.10/0.23, `high` 0.06/0.19 and
       * `level` 0.12/0.36. §V477 is the rule every bias here obeys — the bias is the REST
       * state and the gain is the SWING, so silence sits at the bottom of each range and
       * a hit has somewhere to travel to. Biasing into the interesting part is what made
       * E31 read as permanently peaking, and it is the failure that is easy to ship.
       */
      // The three lens weights (T507). Coarse lens on the kick, mid on the snare, fine on
      // the hats — the same split the three noises were BUILT with, now audible.
      node("lagain", "valueMath", [-980, 900], { operation: "multiply", operand: 0.669 }, { label: "lagain1" }),
      node("lena", "valueMath", [-740, 965], { operation: "add", operand: -0.4342 }, { label: "lena1" }),
      node("lbgain", "valueMath", [-980, 1173], { operation: "multiply", operand: 0.3128 }, { label: "lbgain1" }),
      node("lenb", "valueMath", [-740, 1238], { operation: "add", operand: -0.1537 }, { label: "lenb1" }),
      node("lcgain", "valueMath", [-980, 1446], { operation: "multiply", operand: 0.1396 }, { label: "lcgain1" }),
      node("lenc", "valueMath", [-740, 1511], { operation: "add", operand: -0.046 }, { label: "lenc1" }),
      /* §V471.7 — THE PALETTE SCALE ITSELF IS DRIVEN, so the ramp breathes instead of
         being a fixed grade. The third fence is T544's amendment and E31's scar: a
         gain+bias pair has to be range-checked against its TARGET or the idiom ships a
         clamp. ×4.2 over a 0..1 band spans 1.83..6.03 against a Lookup Scale declared
         -4..4, so the Limit is what keeps the value legible in the graph rather than
         silently clipped at the parameter. */
      node("ggain", "valueMath", [-980, 1719], { operation: "multiply", operand: 6.7547 }, { label: "ggain1" }),
      node("gadd", "valueMath", [-740, 1784], { operation: "add", operand: -1.5095 }, { label: "gadd1" }),
      node("grade", "valueLimit", [-500, 1500], { minimum: 1.2, maximum: 3.2 }, { label: "grade1" }),
      // The whole picture lifts for a frame. Rest 0.86 — DARKER than unity on purpose, so
      // the calm state has headroom and the hit is a lift rather than a clip.
      node("bgain", "valueMath", [-980, 1992], { operation: "multiply", operand: 1.35 }, { label: "bgain1" }),
      node("bright", "valueMath", [-740, 2057], { operation: "add", operand: 0.93 }, { label: "bright1" }),

      /* ---- EVENT: the seed, and it is the one thing that makes a beat legible ---------
       *
       * A beat that nudges a rate is a rate change. A beat that SPAWNS STRUCTURE is an
       * event, and Gray-Scott is unusually good at it: drop V into the plate and the
       * reaction grows it for the next second on its own. So the trigger does not light
       * anything — it opens a Threshold for exactly one frame and the simulation keeps
       * the consequence. §V481(b) is the general form; this is the version where the loop
       * is a chemistry rather than a trail.
       *
       * The trigger drives the Threshold's CUT rather than a brightness, so the mask is a
       * clean 0..1 and a closed gate is EXACTLY zero. A Level would have gone negative
       * below its black point, and a negative through `screen` brightens — a DC term in a
       * persistent loop, which is the failure §V481(b) is about.
       * Rest 2.0: nothing in a 0..1 field is above 2.0, so between hits the gate is shut.
       */
      /* T598 — TWO MORE PROPERTIES, and the pair of them is the reference's whole verb.
         `flash1` is the stamp: the trigger, ungathered by any lag, straight onto `crest1`'s
         opacity. Rest 0.02 and hit 0.62 is §V477 read as far as it will go — at rest
         almost nothing enters the loop, so a beat is not a change of degree in a thing
         already happening, it is the only time anything happens at all. §V509 is why it
         hangs off `trig1` and not off `snap1`: a one-pole answers a single-frame impulse
         with 1-exp(-dt/tau), which at 0.04 s is 0.31 and at 0.35 s is 0.047 — a trigger
         through a smoother is a trigger you have deleted.
         `xspeed1` is E29's lurch: the kick opens the magnification from 1.012 to 1.029 per
         pass and `env1` closes it again over the beat, so the whole field surges outward
         and settles. Both fences are ARITHMETIC and not a clamp — the band is 0..1, so the
         pair cannot reach 1.0 (where the loop stops expanding and piles up into white) nor
         pass ~1.03 (where the corridor outruns the eye). A `valueLimit` here would be a
         fence around a range the gain already cannot leave. */
      node("fgain", "valueMath", [-980, 2538], { operation: "multiply", operand: 0.53 }, { label: "fgain1" }),
      node("flash", "valueMath", [-740, 2603], { operation: "add", operand: 0.02 }, { label: "flash1" }),
      node("xgain", "valueMath", [-980, 2811], { operation: "multiply", operand: 0.0569 }, { label: "xgain1" }),
      node("xspeed", "valueMath", [-740, 2876], { operation: "add", operand: 0.9736 }, { label: "xspeed1" }),
      node("seedamt", "valueMath", [-980, 2265], { operation: "multiply", operand: -1.28 }, { label: "seedamt1" }),
      node("seedcut", "valueMath", [-740, 2330], { operation: "add", operand: 2 }, { label: "seedcut1" }),

      // ---- the chemistry map (E2's, verbatim in spirit) -------------------------
      /* T535: `t4d` is 0.37, not 0. Zero sits ON a lattice plane of the 4D noise, where the
         gradient basis collapses and amplitude with it — so frame 0 is systematically
         flatter than every later frame, and frame 0 is exactly what a gallery thumbnail
         shows. Starting off-lattice makes the first frame representative of the piece.
         `exp` above 1 is T507's negative space at the SOURCE: a power on a 0..1 field pulls
         the midtones down, so the chemistry map has broad quiet plains with peaks standing
         out of them instead of a uniform mid-grey everywhere. */
      /* T562 — THE MAP NEEDED REGIONS, and period 0.62 with two octaves gave it none: one
         feature bigger than the frame, so the rendered map was a flat pale cloud and every
         part of the picture ran the same chemistry. 0.30 with THREE octaves puts features
         at roughly 150, 75 and 38 pixels of a 512 frame — several Gray-Scott features per
         region, which is the scale at which "this area is spots and that one is labyrinth"
         is a thing the eye can see rather than a statistic. */
      node("broad", "noise", [-1460, -140], {
        type: "perlin4d", seed: 5, period: 0.3, harmon: 3, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1.25, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.05,
      }, { label: "broad1" }),
      node("detail", "noise", [-1460, 117], {
        type: "perlin4d", seed: 19, period: 0.15, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.6, exp: 1.2, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.09,
      }, { label: "detail1" }),
      node("warp", "displace", [-1180, -60], {
        weight: [0.22, 0.22], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, { label: "warp1" }),
      node("shape", "level", [-940, -60], {
        /* T507 — NEGATIVE SPACE. The owner's read was that the dish sat too dense: every
           part of the frame in the labyrinth regime at once, so the reaction-diffusion had
           no empty field to resolve against and the whole thing read as one texture. This
           is the lever, and the DIRECTION is the finding: my first attempt raised
           `blacklevel` to push more of the map to the LOW end of the band, and the frame
           came back DENSER — wall-to-wall labyrinth. Gray-Scott's low corner
           (feed 0.028 / kill 0.0545) is the labyrinth regime; the HIGH corner is spots
           and mitosis, which is where the empty field lives. So negative space here means
           lowering the black point and lifting the midtones (gamma under 1), not raising
           them. Measured at four settings; 0.09 was too sparse to be a picture, 0.46 was
           the fingerprint, and this sits where a coherent organism has a void around it.
           §V427 is the reason to fix it HERE rather than by masking the output: the
           structure is the simulation's, and giving it room is a chemistry decision.

           T562 — AND THE WINDOW WAS THE OTHER HALF OF IT. Measured, the shipped settings
           put the map at median 0.645 with half of every frame inside 0.60..0.69 — one
           twentieth of the band, which across feed/kill is 0.0013 and therefore one
           chemistry everywhere. The warped field's own p10..p90 is 0.465..0.539 — an
           interquartile of 0.039 — so a window of 0.485 was twelve times wider than the
           signal in it and the Level was mostly moving DC around. 0.451..0.543 is fitted
           to the field's MEASURED spread, which is what makes the map span; contrast
           goes back to 1 because a narrow window IS the contrast and two controls doing
           one job is how the first set got so hard to reason about; and gamma 1.25 lifts
           the midtones so the map RESTS in the high (spots, empty ground) corner and dips
           into the low (labyrinth) corner in patches, which is §V474's direction. The
           tails fall OUTSIDE the window on purpose — the kernel clamps the coordinate, so
           the deepest patches sit at the labyrinth end and the airiest at the mitosis end
           rather than everything crowding the middle. */
        blacklevel: 0.451, contrast: 1, brightness: 1, gamma1: 1.25,
      }, {
        label: "shape1",
        parameters: { whitelevel: drivenSlot("wlevel1:lowMid", 0.543) },
      }),

      /* ---- T598: WHERE THE ORGANISM IS ALLOWED TO EXIST ------------------------------
       *
       * The owner's reference is four fifths BLACK, with the living material a small dense
       * cluster off the middle. Every earlier round of this file argued about the TEXTURE
       * and left the COMPOSITION alone, and a wall-to-wall carpet is a composition however
       * beautiful its texture is. Measured on the reference: 77.9% of it is under 0.08
       * displayed luminance and its 90th percentile is 0.127; the shipped E24 measured
       * 65.2% and 0.431. The gap is not a grade, it is where the material is.
       *
       * `bowl1` is that decision as one node — a soft disc, off-centre, and everything
       * about the frame's occupancy is its `center`, `radius` and `softness`. It is read
       * TWICE and never drawn (§V471.1): once inverted, as the chemistry's kill switch,
       * and once straight, as the mask on the beat's seeding. Two readings of one shape is
       * why "where does the material live" is a single number to change.
       *
       * IT IS A CHEMISTRY DECISION AND NOT A MATTE, which is §V427's point and T507's: a
       * matte over the output would leave a full-frame simulation running underneath and
       * cropped, and the edge would be a cut. `rim1` inverts the disc to 1 OUTSIDE, and
       * `dish1` SCREENS that into the map — `1-(1-a)(1-b)` is exactly `mix(map, 1, rim)`
       * for a 0..1 rim, so outside the disc the coordinate is pinned at the band's HIGH
       * corner. §V474: the high corner (feed 0.042, kill 0.068) fails Gray-Scott's own
       * existence condition — `F < 4(F+k)^2`, 0.042 against 0.0484 — so V there does not
       * merely go sparse, it has no non-trivial steady state at all and decays to nothing.
       * The black is the simulation being genuinely empty, and the soft edge of the disc
       * is a gradient THROUGH the band, so the cluster frays into spots before it stops.
       */
      node("bowl", "circle", [-1720, -420], {
        mode: "fill", center: [0.395, 0.635], radius: [0.225, 0.225], softness: 0.055,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "bowl1" }),
      node("rim", "level", [-1720, -160], {
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, invert: 1, opacity: 1,
      }, { label: "rim1" }),
      node("dish", "screen", [-700, -127], { opacity: 1 }, { label: "dish1" }),

      // ---- the simulation loop, with wind ---------------------------------------
      node("state", "feedback", [-680, 162], { source: "pack1", persistence: 1, clearColor: [0, 0, 0, 0] }, {
        resolution: { mode: "fixed", width: 512, height: 512 },
        format: { mode: "fixed", format: "rgba16float" },
        parameters: { substeps: drivenSlot("steps1:low", 14) },
      }),
      // The wind: a hair of rotation per ITERATION, inside the loop — substeps
      // multiply it, so the bass stirs the dish faster, which is the point.
      node("wind", "transform", [-440, 120], {
        t: [0, 0], r: 0.02, s: [1, 1], p: [0, 0], xord: "srt", extend: "mirror", aspectcorrect: true,
      }, { label: "wind1" }),
      node("rd", "customWgsl", [-200, 120], { [SHADER_SOURCE_PARAMETER]: GRAY_SCOTT_WGSL }, { label: "rd1" }),

      /* ---- T560: THE BEAT SEEDS THE PLATE ---------------------------------------------
       *
       * A sparse field, gated open for exactly the frame the trigger fires, SCREENED into
       * the simulation's state. Screen is the operator this wants and not a convenience:
       * `1-(1-a)(1-b)` takes U and V to 1 where the mask is 1 and leaves them untouched
       * where it is 0, and (U=1, V=1) in a small patch is LITERALLY the kernel's own
       * `seededState` — the classic Gray-Scott starting plate. So a hit does not brighten
       * the picture, it drops new chemistry into it, and the reaction spends the next
       * second growing what the beat put there. That is the difference between an event
       * you can see and a rate you cannot.
       *
       * The lookup reads THIS node rather than `rd1`, so the seed is in the frame it
       * lands on rather than one frame later.
       *
       * `speed: 0.9` is what keeps consecutive beats from seeding the same places: the
       * field has moved most of a feature between hits, so the constellation is new every
       * time. Free-running (§V436) like every other field here.
       */
      node("spark", "noise", [-460, -400], {
        type: "perlin4d", seed: 313, period: 0.035, harmon: 1, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.9,
      }, { label: "spark1" }),
      /* T598 — AND THE SEED IS CONFINED TO THE SAME DISC, by multiplying the field before
         the gate rather than the gate's output after it. Outside `bowl1` the sparse field
         is exactly zero, so it cannot cross the cut however far the cut drops, and no beat
         can strew a one-frame sprinkle across the empty four fifths of the frame. Masking
         the FIELD and not the MASK matters here: the cut is what the trigger drives, and a
         zero field keeps the gate honestly shut instead of shut-then-multiplied-out. */
      node("sow", "multiply", [-700, -416], { opacity: 1 }, { label: "sow1" }),
      node("gate", "threshold", [-200, -400], {
        softness: 0.06, channel: "luminance", compare: "greater",
      }, {
        label: "gate1",
        parameters: { threshold: drivenSlot("seedcut1:onsetCount", 2) },
      }),
      /* THE MASK IS THE FRONT and the simulation is the back, which looks backwards for a
         commutative operator and is not: Composite's `opacity` scales the FRONT only, so
         wiring it this way turns `opacity` into "how much V a hit drops into the plate" —
         the seed's amplitude, on the node that does the seeding, with no extra node to
         hold it. At 0.5 the strike is strong enough to start a colony and short of the
         saturating V=1 that made every seed read as a white-hot pop for one frame. */
      /* T598 — AND IT CARRIES THE SIMULATION'S OWN RESOLUTION, which is a latent flaw this
         round had to fix before it could measure anything. Composite inherits its size from
         `in1`, and `in1` is the GATE (that is §V510: opacity scales the front, so the mask
         has to be the front). The gate is a `project`-resolution chain, so the loop was
         running 512-square through `rd1`, being DOWNSAMPLED to the output's size here, and
         being resampled back up by `state1` — a low-pass through the whole reaction, once
         per frame. At 512-square output that is a no-op and nothing showed; at T521's
         192x108 probe it wipes Gray-Scott's structure out completely, and with the T598
         disc confining the chemistry to a fifth of the frame there was not enough left to
         survive it: the probe measured range 0.0700 and a colony that DIED by frame 600.
         Pinning the composite to the state's size takes the output resolution out of the
         simulation entirely, which is what it should never have been in. */
      node("inject", "screen", [60, 240], { opacity: 0.6 }, {
        label: "inject1",
        resolution: { mode: "fixed", width: 512, height: 512 },
      }),

      node("pack", "reorder", [320, 120], {
        outr: "in1r", outg: "in1g", outb: "in2lum", outa: "in1a",
      }, { label: "pack1" }),

      // ---- colour, then TIME ----------------------------------------------------
      /* SEVEN STOPS THAT TRAVEL (§V471.6): near-black, near-black navy, blue, violet,
         crimson, gold, cream. E31's arc, and the reason it is worth copying is that it
         crosses HUE as well as brightness — a ramp from navy to cream through nothing
         gives a monochrome picture however many stops it has. The shipped ramp had five
         and was perfectly good; the reason it read as two colours is below, and it is not
         the ramp's fault. */
      node("palette", "ramp", [60, 818], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.004, 0.006, 0.025, 1] },
          { position: 0.16, color: [0.012, 0.025, 0.09, 1] },
          { position: 0.34, color: [0.07, 0.19, 0.5, 1] },
          { position: 0.52, color: [0.44, 0.18, 0.66, 1] },
          { position: 0.7, color: [0.98, 0.36, 0.26, 1] },
          { position: 0.87, color: [1, 0.7, 0.3, 1] },
          { position: 1, color: [1, 0.96, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("cycle", "lfo", [60, 1075], { shape: "sine", frequency: 0.05, amplitude: 0.06, offset: 0 }, {
        label: "lfo1",
      }),
      /* ---- §V471.1: THE CHEMISTRY MAP, READ A SECOND TIME — as COLOUR -----------------
       *
       * E31 gets its richness from drawing ONE point cloud three times and splitting it by
       * group predicate: structure from SELECTION, not from more nodes. The texture
       * analogue is a second reading of a field already in the graph, and the field that
       * earns it is the chemistry map, because it is the thing that differs from region to
       * region.
       *
       * Why it is needed at all: the Lookup's coordinate was V alone, and V in Gray-Scott
       * is NEAR-BINARY — empty plate or front, nothing in between. A near-binary
       * coordinate visits exactly two positions on a ramp however many stops that ramp
       * has, which is why the shipped file was cream fronts on navy and the blue and teal
       * in the middle of its palette were never on screen. Adding a dimmed, CONTINUOUS
       * term moves each region's ground to its own place on the ramp and carries its
       * fronts with it: the hue now says which chemistry you are looking at, and V says
       * how far along the reaction is. Opacity 0 so the add contributes colour and no
       * coverage.
       *
       * T598 — IT NOW READS THE MASKED MAP AND IT IS INVERTED, and both halves are forced
       * by the composition rather than chosen. `dish1` is pinned at 1 outside the disc, so
       * reading it straight would lift the empty four fifths of the frame to ramp position
       * 0.11×2.25 = 0.25 — a navy ground everywhere, which is exactly the wall-to-wall look
       * this round exists to remove. Inverted, the dead field contributes EXACTLY ZERO and
       * the ground is the ramp's own first stop, which is black. Inside the disc the sense
       * is also the better one: a region running the LOW (labyrinth) chemistry is the dense
       * one, and it now gets the warmer base rather than the colder. */
      node("chem", "level", [-200, 700], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 1,
        brightness: 0.17, opacity: 0,
      }, { label: "chem1" }),
      node("blend", "add", [60, 529], {}, { label: "blend1" }),
      node("tint", "lookup", [320, 393], { channel: "green", row: 0.5 }, {
        label: "tint1",
        parameters: {
          offset: drivenSlot("lfo1", 0),
          /* §V471.7 — the grade BREATHES with highMid. Rest at 2.25 puts the FRONTS
             in the crimson and leaves the gold and cream as somewhere for a loud passage
             to reach, while the ground — V is near zero over most of the frame — sits down
             in the navy whatever the music does. The shipped 2.4 rest had the fronts
             already at cream, which is §V477's "always in blast mode" and the reason a hit
             had nowhere to go. */
          scale: drivenSlot("grade1:highMid", 2.25),
        },
      }),

      /* ═══ T598 — THE OUTWARD DRIVING FORCE, AND THE FEEDBACK THAT CARRIES IT ═══════════
       *
       * The owner's third ask came with a picture: concentric rings propagating outward
       * from a centre, several systems of them at once, and the material carried out with
       * them so a ring TRAVELS rather than sitting there as a moiré. Six nodes, and every
       * one of them is E29-Descent's mechanism rather than a rediscovery of it (§V481).
       *
       * ## What is born, and by WHAT
       *
       * `rings1` is a RADIAL ramp with `period: 6` — one node, six concentric rings, which
       * is the "several ring systems at different scales" of the reference read literally.
       * Its coordinate is `clamp(|uv-0.5|*2, 0, 1)`, so the rings are born inside the
       * frame's inscribed circle and the loop below is what carries them out past the
       * corners. `phase` rides `lfo1` (the palette's own 20-second sine, read a second
       * time) so consecutive beats do not stamp their rings at identical radii and the set
       * never stands still.
       *
       * §V481(b) IS THE WHOLE DESIGN OF `crest1`. Anything added into a persistent loop
       * every frame is a DC term: at persistence 0.972 the loop integrates it about
       * thirty-five fold and the frame goes white — three of E29's thirteen builds died
       * exactly there. So the ring family and the living cluster are added through an
       * `opacity` that is 0.02 at rest and 0.62 for the ONE frame `trig1` fires. A beat
       * STAMPS the current picture and a new set of rings into the loop; between beats
       * nothing enters it at all, and the mean input is a thirtieth of the peak by
       * construction rather than by luck. That is also, exactly, the owner's sentence: a
       * beat sends a ring outward.
       *
       * And it is why the stamp carries `tint1` as well as the rings. The reference's
       * speckle is not one cluster — it is the SAME cluster at three or four sizes, out
       * along the rings, each one older and blurrier than the last. Those are strobed
       * copies of the living material, which is what a magnifying loop does to anything
       * you drop into it once per beat.
       *
       * ## What carries it, and what stops it running away
       *
       * §V481(a), the one that cost E29 four builds: AN EXPANDING LOOP DOES NOT DIM
       * ITSELF. `s > 1` DIVIDES the sampling coordinates, so `grow1` magnifies about the
       * frame's centre and DUPLICATES pixels — nothing leaves, nothing is diluted, and a
       * near-unity gain goes to white in seconds. Every bit of the decay here is
       * deliberate: `echo1`'s persistence, `dim1`'s black point, and `dim1`'s gamma.
       *
       * §V481(c) WITH ITS SIGN CHECKED AGAINST THIS CATALOGUE'S SHADER, which is worth
       * stating because the invariant's word and this node's parameter point opposite
       * ways. Level computes `pow(c, 1.0/gamma1)`. Contractive therefore means gamma1
       * BELOW one: 0.86 is the exponent 1.163, which is under `v` everywhere in [0,1) and
       * so sharpens and shrinks in the same term. A gamma1 ABOVE one in this node is
       * positive feedback, as a Contrast above one would be.
       *
       * `extend: "zero"` on the magnify, not `hold`: with hold, the edge pixels of an
       * expanding image streak outward forever and the corners fill with smeared colour.
       * The quarter-degree of rotation per pass does nothing to the rings — a rotation of
       * a rotationally symmetric figure is invisible, which E29 learned the expensive way
       * — but the STAMPED CLUSTER is not symmetric, so its echoes spiral as they travel
       * and the shells read as depth rather than as a bullseye.
       *
       * `grow1`'s scale is on the audio (`low`), which is E29's lurch: the whole field
       * SURGES outward on the kick and settles over the beat. Both fences are arithmetic
       * rather than a clamp — the band is 0..1 and the pair spans 1.012…1.029, so it can
       * neither stop expanding (which piles up into white) nor outrun the eye.
       *
       * ## Where it closes, and where it is read again
       *
       * The loop closes on the GRADED picture (§V471.5): `tint1` is downstream of the
       * palette, so the echoes carry the ramp's own colour instead of raw simulation
       * state. `show1` then puts the LIVE cluster back on top at full strength, which is
       * the second reason the stamp is strobed — the thing you are watching is never the
       * loop's own copy of itself.
       *
       * And `crest1` is read a SECOND time, as the finest lens (§V471.1): the ring field is
       * `warpc1`'s displacement source, so the picture is physically pushed where a ring
       * crosses it. `offset: [0, 0]` there rather than the usual 0.5 — the field is black
       * over most of the frame, and a 0.5 offset would turn "no ring here" into a constant
       * diagonal slide of the whole image. At 0 the displacement is zero where the field
       * is, and only the rings move anything.
       */
      node("rings", "ramp", [320, 1120], {
        type: "radial", interp: "smooth", period: 8,
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.14, color: [0, 0, 0, 1] },
          { position: 0.56, color: [0.075, 0.08, 0.095, 1] },
          { position: 0.83, color: [0.28, 0.3, 0.36, 1] },
          { position: 0.97, color: [0, 0, 0, 1] },
          { position: 1, color: [0, 0, 0, 1] },
        ],
      }, { label: "rings1", definitionVersion: 2, parameters: { phase: drivenSlot("lfo1", 0) } }),
      /* THE PICTURE IS THE FRONT AND THE RINGS ARE BEHIND, which is the opposite of how
         the stack reads and is the only wiring that does the job. `opacity` scales the
         FRONT only, so this one number says "stamp the ring family WHOLE and the living
         picture at a third of itself". Both halves of that are load-bearing. The echoes
         should be a HINT of the material — the reference's outer shells are ghosts of its
         centre, not second copies of it — and it is also what keeps the loop stable: the
         cluster's fronts reach V=1 and the ramp's cream, and a full-strength stamp of THAT
         every beat is the one term in here that can integrate past 1. Wired the other way
         round (measured, and it is an easy mistake because the ring is what you are
         thinking about) the number lands on the rings instead and they go three times too
         faint while the echoes go three times too hot: the frame becomes a bright smear
         with a couple of arcs in the corner of it. */
      node("stamp", "add", [580, 1120], { opacity: 0.32 }, { label: "stamp1" }),
      node("echo", "feedback", [840, 1120], {
        source: "crest1", persistence: 0.987, clearColor: [0, 0, 0, 1],
      }, { label: "echo1" }),
      node("grow", "transform", [1100, 1120], {
        t: [0, 0], r: 0.25, s: [1.012, 1.012], p: [0, 0], xord: "srt", extend: "zero",
        aspectcorrect: true,
      }, {
        label: "grow1",
        parameters: {
          "s.x": drivenSlot("xspeed1:low", 1.012),
          "s.y": drivenSlot("xspeed1:low", 1.012),
        },
      }),
      node("fade", "level", [1360, 1120], {
        blacklevel: 0.0005, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 0.98, opacity: 1,
      }, { label: "dim1" }),
      node("born", "add", [1620, 1120], {}, {
        label: "crest1",
        parameters: { opacity: drivenSlot("flash1:onsetCount", 0.02) },
      }),
      node("show", "add", [1880, 1120], {}, { label: "show1" }),

      /* ---- T507: THREE LENSES, and the point is that they are at different SCALES ----
       *
       * The owner's reference stacked roughly three layers of lens. Stacking is not "turn
       * the displacement up": one strong displacement is a smear, and a smear has no
       * depth in it. Three at genuinely different spatial frequencies and rates read as
       * separated layers of glass — a broad slow swell you feel rather than see, a mid one
       * that gives the fronts their sway, and a fine fast one that is the only thing
       * touching the individual ridges.
       *
       * Each is ~2.5x finer and ~2.5x faster than the one before it, with a third of the
       * weight, so no layer can dominate. The weights come down as the frequency goes up
       * for the same reason a fractal's gain does: equal weight at every scale is white
       * noise, not depth.
       *
       * MONO IS OFF ON ALL THREE, and that is the difference between a lens and a shear.
       * `displace` reads x from red and y from green; a MONOCHROME field has red == green,
       * so every pixel moves along the SAME 45-degree diagonal and the image slides rather
       * than warps. (E24's older `warp1` on the chemistry map is mono and does exactly
       * that — deliberately, because a diagonal shear of a feed/kill map is a fine thing
       * to want; it is not what a lens is.)
       *
       * They sit AFTER the palette and BEFORE the cache rings, so the RGB delay tastes the
       * lens motion: glass that moves disperses, and the fringing follows the warp.
       *
       * T560 — AND ALL THREE AMOUNTS ARE NOW ON THE AUDIO, one band each, which is the
       * whole T507 structure finally being audible. They were built at genuinely
       * different scales and rates; driving them from ONE envelope would have collapsed
       * that back into a single pump. Coarse on `low` (the picture swells on the kick),
       * mid on `lowMid` (the fronts sway with the snare), fine on `high` (the ridges
       * shiver with the hats). The retained values below are the shipped weights, so
       * every host without the channel attached still gets the picture T507 tuned.
       *
       * T598 — THE THIRD LENS IS NOW THE RING FIELD, and that is a node REMOVED rather
       * than added. `lensc1` was a fine, fast perlin and it was the one layer with nothing
       * to say: the fastest displacement in the file was uncorrelated with everything else
       * in it. `crest1` is faster, is already in the graph, and is the thing the picture is
       * about — so the finest glass now ripples exactly where a ring is passing.
       */
      node("lensA", "noise", [1880, 860], {
        type: "perlin4d", seed: 71, period: 1.15, harmon: 1, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.018,
      }, { label: "lensa1" }),
      node("warpA", "displace", [2140, 380], {
        offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpa1",
        parameters: {
          "weight.x": drivenSlot("lena1:low", 0.062),
          "weight.y": drivenSlot("lena1:low", 0.062),
        },
      }),
      node("lensB", "noise", [2140, 860], {
        type: "perlin4d", seed: 137, period: 0.42, harmon: 2, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.046,
      }, { label: "lensb1" }),
      node("warpB", "displace", [2400, 380], {
        offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpb1",
        parameters: {
          "weight.x": drivenSlot("lenb1:lowMid", 0.024),
          "weight.y": drivenSlot("lenb1:lowMid", 0.024),
        },
      }),
      node("warpC", "displace", [2660, 380], {
        offset: [0, 0], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpc1",
        parameters: {
          "weight.x": drivenSlot("lenc1:high", 0.011),
          "weight.y": drivenSlot("lenc1:high", 0.011),
        },
      }),

      // The RGB delay: three taps into time, one per channel. Full scale — this ring
      // is read for its colour, not just its motion.
      node("tapR", "cache", [2920, 240], { frames: 4, index: 2, scale: 1 }, { label: "tapr1" }),
      node("tapG", "cache", [2920, 500], { frames: 5, index: 4, scale: 1 }, { label: "tapg1" }),
      node("tapB", "cache", [2920, 760], { frames: 8, index: 7, scale: 1 }, { label: "tapb1" }),
      // Reorder is two-input, so the three taps braid in two steps: red-with-green
      // first, then the blue tap joins.
      node("fringeRG", "reorder", [3180, 330], {
        outr: "in1r", outg: "in2g", outb: "in1b", outa: "in1a",
      }, { label: "fringerg1" }),
      node("fringe", "reorder", [3440, 600], {
        outr: "in1r", outg: "in1g", outb: "in2b", outa: "in1a",
      }, { label: "fringe1" }),
      /* T560 — THE ONE-FRAME LIFT. The fastest path in the file: `level` on the finished
         picture, its Brightness on the `level` band through the fast Lag. Nothing
         integrates it, so it is up and down inside the beat. Rest 1.08 against a hit at 1.44 is
         §V477 again — the calm state is deliberately UNDER unity so the hit is a lift
         rather than a clip, and the picture has a floor to come back to. */
      node("glow", "level", [3700, 600], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "glow1", parameters: { brightness: drivenSlot("bright1:level", 1.08) } }),
      /* §V471.8 — A LONG CYCLE. 0.033 Hz is a 30-SECOND lap, slower than anyone's
         attention span, which is most of why an hour of E31 is watchable. The palette's
         own LFO above moves the ramp's offset a hair at 0.05 Hz; this one turns the whole
         graded picture through ±15° of hue, so the piece never sits in one colour.
         Free-running (§V436, B98): a timeline lap must not restart the drift. */
      node("drift", "lfo", [3700, 857], {
        shape: "sine", frequency: 0.033, amplitude: 15, offset: 0, phase: 0,
      }, { label: "drift1" }),
      node("hue", "hsv", [3960, 600], { saturation: 1.08, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      node("out", "output", [4220, 600]),
    ],
    [
      // sound. BOTH sources reach the Switch; exactly one leaves it.
      edge("e-music-source", ["music", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      // three timescales off ONE switch: slow structure, fast events, instant seeding.
      edge("e-source-env", ["source", "out"], ["env", "in"]),
      edge("e-source-snap", ["source", "out"], ["snap", "in"]),
      edge("e-source-trig", ["source", "out"], ["trig", "in"]),
      edge("e-env-sgain", ["env", "out"], ["sgain", "a"]),
      edge("e-sgain-sbase", ["sgain", "out"], ["sbase", "a"]),
      edge("e-sbase-scap", ["sbase", "out"], ["scap", "in"]),
      edge("e-env-wgain", ["env", "out"], ["wgain", "a"]),
      edge("e-wgain-wbase", ["wgain", "out"], ["wbase", "a"]),
      edge("e-wbase-wcap", ["wbase", "out"], ["wcap", "in"]),
      // five fast pairs, one band each (§V471.3)
      edge("e-snap-lagain", ["snap", "out"], ["lagain", "a"]),
      edge("e-lagain-lena", ["lagain", "out"], ["lena", "a"]),
      edge("e-snap-lbgain", ["snap", "out"], ["lbgain", "a"]),
      edge("e-lbgain-lenb", ["lbgain", "out"], ["lenb", "a"]),
      edge("e-snap-lcgain", ["snap", "out"], ["lcgain", "a"]),
      edge("e-lcgain-lenc", ["lcgain", "out"], ["lenc", "a"]),
      edge("e-snap-ggain", ["snap", "out"], ["ggain", "a"]),
      edge("e-ggain-gadd", ["ggain", "out"], ["gadd", "a"]),
      edge("e-gadd-grade", ["gadd", "out"], ["grade", "in"]),
      edge("e-snap-bgain", ["snap", "out"], ["bgain", "a"]),
      edge("e-bgain-bright", ["bgain", "out"], ["bright", "a"]),
      // the seed gate: raw trigger, no lag between it and the Threshold's cut.
      edge("e-trig-seedamt", ["trig", "out"], ["seedamt", "a"]),
      edge("e-seedamt-seedcut", ["seedamt", "out"], ["seedcut", "a"]),
      // T598: the stamp is the raw trigger too; the expansion rate rides the envelope.
      edge("e-trig-fgain", ["trig", "out"], ["fgain", "a"]),
      edge("e-fgain-flash", ["fgain", "out"], ["flash", "a"]),
      edge("e-env-xgain", ["env", "out"], ["xgain", "a"]),
      edge("e-xgain-xspeed", ["xgain", "out"], ["xspeed", "a"]),
      // chemistry map, and the disc that decides where any of it is allowed to exist
      edge("e-broad-warp", ["broad", "out"], ["warp", "source"]),
      edge("e-detail-warp", ["detail", "out"], ["warp", "disp"]),
      edge("e-warp-shape", ["warp", "out"], ["shape", "input"]),
      edge("e-bowl-rim", ["bowl", "out"], ["rim", "input"]),
      // rim is the FRONT: screen is commutative, but the front is the layer being placed.
      edge("e-rim-dish", ["rim", "out"], ["dish", "in1"]),
      edge("e-shape-dish", ["shape", "out"], ["dish", "in2"], 0),
      edge("e-dish-pack", ["dish", "out"], ["pack", "in2"]),
      // the loop, wind inside it, and the beat's seed screened into the state
      edge("e-state-wind", ["state", "out"], ["wind", "input"]),
      edge("e-wind-rd", ["wind", "out"], ["rd", "input"]),
      edge("e-spark-sow", ["spark", "out"], ["sow", "in1"]),
      edge("e-bowl-sow", ["bowl", "out"], ["sow", "in2"], 0),
      edge("e-sow-gate", ["sow", "out"], ["gate", "input"]),
      edge("e-gate-inject", ["gate", "out"], ["inject", "in1"]),
      edge("e-rd-inject", ["rd", "out"], ["inject", "in2"], 0),
      edge("e-inject-pack", ["inject", "out"], ["pack", "in1"]),
      // colour then time. The map is read a SECOND time, as colour (§V471.1).
      edge("e-dish-chem", ["dish", "out"], ["chem", "input"]),
      edge("e-inject-blend", ["inject", "out"], ["blend", "in1"]),
      edge("e-chem-blend", ["chem", "out"], ["blend", "in2"], 0),
      edge("e-blend-tint", ["blend", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      /* T598 — the expansion. The stamp is rings + the graded picture; `crest1` is what the
         loop records, and `show1` puts the LIVE cluster back over its own travelling
         echoes. Nothing here reads a clock: the motion is the loop's own iteration, so a
         timeline lap cannot snap it (T489). */
      edge("e-tint-stamp", ["tint", "out"], ["stamp", "in1"]),
      edge("e-rings-stamp", ["rings", "out"], ["stamp", "in2"], 0),
      edge("e-echo-grow", ["echo", "out"], ["grow", "input"]),
      edge("e-grow-fade", ["grow", "out"], ["fade", "input"]),
      edge("e-stamp-born", ["stamp", "out"], ["born", "in1"]),
      edge("e-fade-born", ["fade", "out"], ["born", "in2"], 0),
      edge("e-tint-show", ["tint", "out"], ["show", "in1"]),
      edge("e-born-show", ["born", "out"], ["show", "in2"], 0),
      // three lenses, coarse to fine, in series — the finest one IS the ring field
      edge("e-show-warpa", ["show", "out"], ["warpA", "source"]),
      edge("e-lensa-warpa", ["lensA", "out"], ["warpA", "disp"]),
      edge("e-warpa-warpb", ["warpA", "out"], ["warpB", "source"]),
      edge("e-lensb-warpb", ["lensB", "out"], ["warpB", "disp"]),
      edge("e-warpb-warpc", ["warpB", "out"], ["warpC", "source"]),
      edge("e-born-warpc", ["born", "out"], ["warpC", "disp"]),
      edge("e-warpc-tapr", ["warpC", "out"], ["tapR", "input"]),
      edge("e-warpc-tapg", ["warpC", "out"], ["tapG", "input"]),
      edge("e-warpc-tapb", ["warpC", "out"], ["tapB", "input"]),
      edge("e-tapr-fringerg", ["tapR", "out"], ["fringeRG", "in1"]),
      edge("e-tapg-fringerg", ["tapG", "out"], ["fringeRG", "in2"]),
      edge("e-fringerg-fringe", ["fringeRG", "out"], ["fringe", "in1"]),
      edge("e-tapb-fringe", ["tapB", "out"], ["fringe", "in2"]),
      edge("e-fringe-glow", ["fringe", "out"], ["glow", "input"]),
      edge("e-glow-hue", ["glow", "out"], ["hue", "input"]),
      edge("e-hue-out", ["hue", "out"], ["out", "input"]),
    ],
  ),
);

const gooeyballDocument = document(
  "e20-gooeyball",
  "E20 Gooeyball",
  settings({ randomSeed: 37 }),
  graph(
    [
      node(
        "wobble",
        "noise",
        [-1480, -220],
        {
          type: "perlin4d",
          period: 0.45,
          harmon: 3,
          spread: 2,
          gain: 0.5,
          rough: 0.5,
          exp: 1,
          amp: 1,
          offset: 0,
          mono: true,
          aspectcorrect: true,
          seed: 37,
          s4d: 1,
          t4d: 0.37, // T535: off the lattice plane — see E2's note
          /* Animated, and a 4D type so `speed` actually does something (B14): the goo
             crawls over the ball instead of freezing into one dent. */
          speed: 0.3,
        },
        { label: "noise1" },
      ),
      node("sheet", "pointGrid", [-1480, 0], { cols: GOOEY_COLS, rows: GOOEY_ROWS }, { label: "grid1" }),
      node(
        "ball",
        "pointKernel",
        [-1180, 0],
        {
          capacity: GOOEY_COLS * GOOEY_ROWS,
          seed: 37,
          attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
          kernel: GOOEY_BALL_KERNEL,
        },
        { label: "ball1" },
      ),
      node("bridge", "textureToAttribute", [-880, 0], { count: GOOEY_COLS * GOOEY_ROWS }, { label: "sample1" }),
      node(
        "goo",
        "pointKernel",
        [-580, 0],
        {
          capacity: GOOEY_COLS * GOOEY_ROWS,
          seed: 37,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
          ]),
          kernel: GOOEY_GOO_KERNEL,
        },
        { label: "goo1" },
      ),
      node(
        "claim",
        "pointTopology",
        [-280, 0],
        { connectivity: "grid", cols: GOOEY_COLS, rows: GOOEY_ROWS, wrapU: true, wrapV: false },
        { label: "topology1" },
      ),
      /*
       * T429: the SKIN. The owner's complaint — "lame and kinda single colored" — and
       * its fix in one clause: the SAME noise that displaces the ball also paints it.
       * The field goes through a palette (lookup) into the material's ALBEDO map, and
       * raw into its ROUGHNESS map, so bulges are coloured differently from hollows
       * and shine differently too. One field, three uses.
       */
      node("palette", "ramp", [-880, -420], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.12, 0.07, 0.25, 1] },
          { position: 0.4, color: [0.5, 0.12, 0.38, 1] },
          { position: 0.7, color: [0.95, 0.45, 0.2, 1] },
          { position: 1, color: [1, 0.9, 0.6, 1] },
        ],
      }, { label: "goopalette1", definitionVersion: 2 }),
      node("paint", "lookup", [-580, -420], { channel: "red", row: 0.5, scale: 1, offset: 0 }, { label: "paint1" }),
      node("gooskin", "materialPhong", [-280, -420], {
        color: [1, 1, 1, 1], specular: [1, 0.9, 0.7, 1], shininess: 64, roughness: 0.45,
      }, { label: "gooskin1" }),
      node("body", "geometry", [20, -200], { mode: "surface", material: "gooskin1" }, { label: "body1" }),
      node("cam", "camera", [20, -420], { eye: [0, 0.5, 2.6], lookAt: [0, 0, 0], fov: 55 }, { label: "cam1" }),
      /*
       * TWO lights, one of them MOVING — the first shipped example with an animated
       * light: the warm key holds still, the cool fill ORBITS (its x/z driven by two
       * LFOs in quadrature), and because a light is VALUES, the orbit never rebuilds
       * anything (§V5).
       */
      node("key", "light", [340, -580], {
        kind: "directional", color: [1, 0.9, 0.75, 1], intensity: 0.9, direction: [-0.5, -0.7, -0.5],
      }, { label: "key1" }),
      node("orbitx", "lfo", [340, -760], { shape: "sine", frequency: 0.11, amplitude: 2.2, offset: 0, phase: 0 }, { label: "orbitx1" }),
      node("orbitz", "lfo", [340, -940], { shape: "sine", frequency: 0.11, amplitude: 2.2, offset: 0, phase: 0.25 }, { label: "orbitz1" }),
      node("fill", "light", [340, -400], {
        kind: "point", color: [0.35, 0.65, 1, 1], intensity: 1.6,
      }, {
        label: "fill1",
        parameters: {
          "position.x": drivenSlot("orbitx1", 2),
          "position.y": 0.8,
          "position.z": drivenSlot("orbitz1", 0.5),
        },
      }),
      node("skin", "render", [340, -200], {
        scenes: "body1", camera: "cam1", lights: "key1 fill1",
        ambientColor: [0.4, 0.45, 0.6, 1], ambientIntensity: 0.22,
      }, { label: "shot1" }),
      node("out", "output", [620, -200], {}, { label: "out1" }),
    ],
    [
      edge("e-sheet-ball", ["sheet", "out"], ["ball", "in"]),
      edge("e-ball-bridge", ["ball", "out"], ["bridge", "points"]),
      edge("e-wobble-bridge", ["wobble", "out"], ["bridge", "texture"]),
      edge("e-bridge-goo", ["bridge", "out"], ["goo", "in"]),
      edge("e-goo-claim", ["goo", "out"], ["claim", "points"]),
      edge("e-claim-body", ["claim", "out"], ["body", "points"]),
      edge("e-wobble-paint", ["wobble", "out"], ["paint", "source"]),
      edge("e-palette-paint", ["palette", "out"], ["paint", "lookup"]),
      edge("e-paint-albedo", ["paint", "out"], ["gooskin", "albedo"]),
      edge("e-wobble-rough", ["wobble", "out"], ["gooskin", "roughness"]),
      edge("e-skin-out", ["skin", "out"], ["out", "input"]),
    ],
  ),
);

const murmurationDocument = document(
  "e16-murmuration",
  "E16 Murmuration",
  settings({ randomSeed: 31 }),
  graph(
    [
      node("sphere", "pointSphere", [-1180, 0], { count: 2000, radius: 0.9 }, { label: "sphere1" }),
      node(
        "flock",
        "pointKernel",
        [-880, 0],
        { capacity: 2000, seed: 31, attributes: MURMURATION_FLOCK_ATTRIBUTES, kernel: MURMURATION_FLOCK_KERNEL },
        { label: "flock1" },
      ),
      node(
        "part",
        "pointKernel",
        [-580, 0],
        {
          capacity: 2000,
          seed: 31,
          attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
          kernel: MURMURATION_PART_KERNEL,
        },
        { label: "part1" },
      ),
      node(
        "birds",
        "renderInstances",
        [-280, 0],
        {
          count: 2000,
          shape: "octahedron",
          scale: 0.016,
          rotate: [0, 0, 0],
          eye: [0, 0.35, 2.7],
          lookAt: [0, 0, 0],
          fov: 55,
          /* T333: strays the cursor shoved past the flock's airspace vanish at DRAW time. */
          group: "length(p.position) < 1.7",
        },
        {
          label: "birds1",
          parameters: {
            color: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                /* tint authored two nodes UPSTREAM, crossing `part` by reference (§V197). */
                map: { kind: "map", attribute: "tint" },
              },
            },
          },
        },
      ),
      node("out", "output", [40, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-sphere-flock", ["sphere", "out"], ["flock", "in"]),
      edge("e-flock-part", ["flock", "out"], ["part", "in"]),
      edge("e-part-birds", ["part", "out"], ["birds", "points"]),
      edge("e-birds-out", ["birds", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E25 — Stage (T444). The MULTI-STAGE render the owner asked for, verbatim: "a multi
 * stage setup of a camera, geometry, reproduction, picked up by another camera then to
 * screen and all this driven interestingly."
 *
 * Scene A — the PERFORMANCE: a torus of lit octahedra under a magenta key, filmed by
 * a camera ORBITING on two quadrature LFOs. Its render is a TEXTURE.
 *
 * That texture crosses into scene B as a MATERIAL MAP — one plain edge into an unlit
 * material's albedo slot (V372: pixels are data, they travel on wires) — worn by a
 * flat grid standing in scene B like a cinema screen. A second camera, itself drifting,
 * films the screen and a floor of instanced boxes under a warm key, and THAT goes to
 * the output: a virtual screen inside a scene, the TD/Notch classic.
 *
 * Every stage is driven and nothing rebuilds: both orbits and the breathing fill are
 * VALUES through the scene payload channel (T377, §V5) — camera eyes and light
 * intensity re-publish per frame as uniform writes.
 */
const stageDocument = document(
  "e25-stage",
  "E25 Stage",
  settings({ outputResolution: { width: 768, height: 432 } }),
  graph(
    [
      // ---- scene A: the performance ---------------------------------------------
      node("ringA", "pointTorus", [-1460, -200], { cols: 36, rows: 18, radius: 0.7, radius2: 0.28 }, { label: "ringa1" }),
      node("matA", "materialPhong", [-1460, -400], {
        color: [1, 0.25, 0.55, 1], specular: [1, 1, 1, 1], shininess: 80, roughness: 0.25,
      }, { label: "mata1" }),
      node("geoA", "geometry", [-1180, -200], {
        mode: "instances", shape: "octahedron", scale: 0.075, material: "mata1",
      }, { label: "geoa1" }),
      node("orbAx", "lfo", [-1180, -560], { shape: "sine", frequency: 0.07, amplitude: 2.4, offset: 0, phase: 0 }, { label: "orbax1" }),
      node("orbAz", "lfo", [-1180, -740], { shape: "sine", frequency: 0.07, amplitude: 2.4, offset: 0, phase: 0.25 }, { label: "orbaz1" }),
      node("camA", "camera", [-1180, -380], { lookAt: [0, 0, 0], fov: 50 }, {
        label: "cama1",
        parameters: {
          "eye.x": drivenSlot("orbax1", 2.4),
          "eye.y": 0.9,
          "eye.z": drivenSlot("orbaz1", 0),
        },
      }),
      node("keyA", "light", [-1180, -920], {
        kind: "directional", color: [1, 0.85, 0.95, 1], intensity: 1.1, direction: [-0.3, -0.8, -0.5],
      }, { label: "keya1" }),
      node("shotA", "render", [-880, -200], {
        scenes: "geoa1", camera: "cama1", lights: "keya1",
        ambientColor: [0.3, 0.2, 0.5, 1], ambientIntensity: 0.3,
        background: [0.14, 0.05, 0.2, 1],
      }, { label: "shota1" }),

      // ---- the crossing: render A becomes a MATERIAL MAP -------------------------
      node("screenMat", "materialUnlit", [-580, -200], { color: [1, 1, 1, 1] }, { label: "screenmat1" }),

      // ---- scene B: the stage ----------------------------------------------------
      node("screenGrid", "pointGrid", [-580, 40], { cols: 48, rows: 27, count: 1296, sizeX: 3.2, sizeY: 1.8 }, { label: "screengrid1" }),
      node("screen", "geometry", [-280, 40], { mode: "surface", material: "screenmat1" }, { label: "screen1" }),
      node("floorPts", "pointGrid", [-620, 240], { cols: 12, rows: 12, count: 144, sizeX: 4, sizeY: 3 }, { label: "floorpts1" }),
      node("floorKernel", "pointKernel", [-410, 240], {
        capacity: 144,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the xy plane lies down: y becomes depth, the floor sits under the screen */\n  q.position = vec3f(p.position.x, -1.15, p.position.y - 0.6);\n  return q;\n}",
      }, { label: "floorkernel1" }),
      node("matFloor", "materialPhong", [-410, 450], {
        color: [0.25, 0.28, 0.38, 1], specular: [0.6, 0.7, 1, 1], shininess: 24, roughness: 0.7,
      }, { label: "matfloor1" }),
      node("floor", "geometry", [-200, 240], {
        mode: "instances", shape: "box", scale: 0.09, material: "matfloor1",
      }, { label: "floor1" }),
      node("orbBx", "lfo", [0, -160], { shape: "sine", frequency: 0.045, amplitude: 1.4, offset: 0, phase: 0 }, { label: "orbbx1" }),
      node("breathe", "lfo", [0, -340], { shape: "sine", frequency: 0.2, amplitude: 0.5, offset: 1.1, phase: 0 }, { label: "breathe1" }),
      node("camB", "camera", [0, 40], { lookAt: [0, -0.1, 0], fov: 55 }, {
        label: "camb1",
        parameters: {
          "eye.x": drivenSlot("orbbx1", 0.8),
          "eye.y": 0.35,
          "eye.z": 3.1,
        },
      }),
      node("keyB", "light", [0, 240], {
        kind: "directional", color: [1, 0.9, 0.7, 1], direction: [-0.4, -0.75, -0.4],
      }, {
        label: "keyb1",
        parameters: { intensity: drivenSlot("breathe1", 1.1) },
      }),
      node("shotB", "render", [280, 40], {
        scenes: "screen1 floor1", camera: "camb1", lights: "keyb1",
        ambientColor: [0.5, 0.55, 0.8, 1], ambientIntensity: 0.25,
        background: [0.03, 0.04, 0.08, 1],
      }, { label: "shotb1" }),
      node("out", "output", [560, 40], {}, { label: "out1" }),
    ],
    [
      edge("e-ringa-geoa", ["ringA", "out"], ["geoA", "points"]),
      // THE WIRE (V372): scene A's picture, into a material's map slot, one edge.
      edge("e-shota-screenmat", ["shotA", "out"], ["screenMat", "albedo"]),
      edge("e-screengrid-screen", ["screenGrid", "out"], ["screen", "points"]),
      edge("e-floorpts-kernel", ["floorPts", "out"], ["floorKernel", "in"]),
      edge("e-kernel-floor", ["floorKernel", "out"], ["floor", "points"]),
      edge("e-shotb-out", ["shotB", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E26 — Interference (T475).
 *
 *   rings1(circle: distance) ─► gain1(level) ─► wrap1(limit: zigzag) ─┬──────► beat1.in1
 *                                                                     │
 *                                          warp1(transform) ◄─────────┘
 *                                                │  t.x ┄ driftx1, t.y ┄ drifty1
 *                                                └───────────────────────► beat1.in2
 *   beat1(difference) ─► tint1(lookup) ◄─ palette1(ramp) ─► out1
 *
 * THE WHOLE EXAMPLE IS THE FAN-OUT. `wrap1` is generated ONCE and consumed TWICE — once
 * as itself, once through a Transform — and the output is the difference between those
 * two readings. Nothing in this file oscillates faster than 0.05 Hz and nothing in it is
 * bigger than a few pixels, yet the picture carries enormous rosettes and hyperbolic fans
 * sweeping across the frame. That is moiré: the visible structure is the BEAT between two
 * patterns, and it belongs to neither of them.
 *
 * WHY IT IS A DISTANCE FIELD AND NOT A RADIAL RAMP. Ramp's radial coordinate is
 * `clamp(length(uv - 0.5) * 2, 0, 1)` — it saturates at radius 0.5, so a periodic radial
 * ramp is flat in the corners, which on a 16:9 frame is a fifth of the image. Circle's
 * `distance` mode is an unclamped signed distance in uv units over the WHOLE frame, and
 * aspect-correct, so the rings stay circular. Level then says how many rings there are
 * (`whitelevel` is a gain: 1/0.007 ≈ 143), and Limit in ZIGZAG mode folds that ramp into a
 * triangle wave. Zigzag rather than loop is deliberate and it is the anti-aliasing: a
 * sawtooth has a hard edge every ring and crawls under motion; a triangle wave is
 * continuous, so ~18px rings resolve cleanly instead of shimmering.
 *
 * WHY THE SECOND COPY IS OFFSET AND SCALED, NOT ROTATED. Concentric rings are
 * rotationally symmetric about their own centre: rotating them changes nothing and the
 * difference would be exactly zero — a black frame, every wire correct. What breaks the
 * symmetry is a translation (which gives hyperbolic fringes with foci at the two centres)
 * and a scale difference (which gives concentric beat rings, one every 1/(s−1) ≈ 10
 * rings). Both are present, and the two LFOs on `t` run at incommensurate rates — 0.05 Hz
 * and 0.031 Hz — so the offset traces a Lissajous figure rather than a circle and the
 * pattern does not repeat on any period a viewer will sit through.
 *
 * The Transform samples at most 2.5% outside its input, so `extend: "mirror"` shows in a
 * thin border and nowhere else; `hold` there would streak the rings radially.
 *
 * There is no WGSL in this file, no simulation, no state, and no temporal boundary. It is
 * the cheapest graph in the set that produces something you cannot read off its inputs.
 */
const interferenceDocument = document(
  "e26-interference",
  "E26 Interference",
  settings({ randomSeed: 26 }),
  graph(
    [
      node(
        "rings",
        "circle",
        [-1160, 0],
        {
          // `distance` publishes the signed distance in red and leaves g/b at zero, so
          // everything downstream is operating on ONE channel that means "how far from
          // the centre" — never on a colour (§V56/§V57).
          mode: "distance",
          center: [0.5, 0.5],
          radius: [0.5, 0.5],
          softness: 0.005,
          fillcolor: [1, 1, 1, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        { label: "rings1" },
      ),
      node(
        "gain",
        "level",
        [-900, 0],
        {
          /**
           * THE RING COUNT LIVES HERE. whitelevel is the divisor in
           * `(v - black)/(white - black)`, so 0.011 is a gain of ~91 and the distance
           * field crosses ~18 full triangle periods between the centre and a corner: an
           * ~28px ring at 720p.
           *
           * 0.007 (~18px) was the first number and the look pass rejected it: at that
           * pitch the fine structure reads as corduroy across the whole frame and
           * competes with the beat rather than carrying it. Wider rings let the rosettes
           * be the subject.
           */
          blacklevel: 0,
          whitelevel: 0.011,
          invert: 0,
          gamma1: 1,
          contrast: 1,
          brightness: 1,
          opacity: 1,
        },
        { label: "gain1" },
      ),
      node(
        "wrap",
        "limit",
        [-640, 0],
        // Zigzag: `abs(fract(v/2)*2 - 1)`, which is a continuous triangle. Loop would be a
        // sawtooth with a hard edge on every ring, and hard edges at this pitch crawl.
        { mode: "zigzag", low: 0, high: 1, steps: 4 },
        { label: "wrap1" },
      ),
      node(
        "warp",
        "transform",
        [-380, 0],
        {
          t: [0, 0],
          r: 0,
          /**
           * 16% larger, so the two ring families beat once every ~6 rings — and, just as
           * load-bearing, so the Transform never samples outside its input. A scale of s
           * reads the region `0.5 ± 0.5/s`, the drift shifts that by up to its amplitude,
           * and 0.5/1.16 + 0.05 = 0.481 leaves a ~2% margin on every edge. At s = 1.1 and
           * a drift of 0.07 the window ran 2.5% PAST the edge and the extend mode showed
           * as a hard mirrored band crawling along whichever edge the drift was pushing
           * toward — visible in the render, invisible to every assertion.
           */
          s: [1.16, 1.16],
          p: [0, 0],
          xord: "srt",
          // Never reached at these numbers; it is the honest answer if someone widens the
          // drift, and a mirrored ring field folds more gracefully than a held edge.
          extend: "mirror",
          aspectcorrect: true,
        },
        {
          label: "warp1",
          parameters: {
            "t.x": drivenSlot("driftx1", 0),
            "t.y": drivenSlot("drifty1", 0),
          },
        },
      ),
      node(
        "beat",
        "difference",
        [-120, 0],
        {},
        { label: "beat1" },
      ),
      node(
        "palette",
        "ramp",
        [-120, 240],
        {
          type: "horizontal",
          interp: "smooth",
          phase: 0,
          period: 1,
          /**
           * THE PALETTE IS WHERE THIS EXAMPLE WAS WON OR LOST (V420), and the shape of it
           * is the finding: nearly half the range is FLOOR.
           *
           * The difference field puts most of its pixels in the upper half, so a palette
           * that travels evenly from 0 to 1 spends its whole journey inside the busy part
           * and the frame comes out as a uniform woven texture — correct, animated, and
           * dull. Holding 0..0.46 near black gives the image somewhere to REST, so the
           * beat reads as luminous filaments standing on a dark ground instead of as
           * corduroy. The colour then travels indigo → violet → coral → gold in the top
           * third, where the pixels actually are.
           *
           * Five candidates were rendered and looked at; this one won on having both a
           * real dark and a real hue journey. Display space, decoded per entry (§V196).
           */
          stops: [
            { position: 0, color: [0.01, 0.01, 0.04, 1] },
            { position: 0.46, color: [0.06, 0.03, 0.22, 1] },
            { position: 0.68, color: [0.42, 0.09, 0.5, 1] },
            { position: 0.83, color: [0.92, 0.25, 0.36, 1] },
            { position: 0.93, color: [1, 0.66, 0.28, 1] },
            { position: 1, color: [1, 0.97, 0.85, 1] },
          ],
        },
        { label: "palette1", definitionVersion: 2 },
      ),
      node(
        "tint",
        "lookup",
        [140, 0],
        // RED, not luminance: the whole chain carries its value in red and leaves green
        // and blue at zero, so a luminance index would read the beat at 21% strength.
        { channel: "red", row: 0.5, offset: 0, scale: 1 },
        { label: "tint1" },
      ),
      node(
        "driftx",
        "lfo",
        [-640, 240],
        { shape: "sine", frequency: 0.05, amplitude: 0.05, offset: 0, phase: 0 },
        { label: "driftx1" },
      ),
      node(
        "drifty",
        "lfo",
        [-380, 240],
        // Not 0.05: two commensurate rates trace a closed ellipse and the piece loops in
        // twenty seconds. 0.031 against 0.05 does not close.
        { shape: "sine", frequency: 0.031, amplitude: 0.05, offset: 0, phase: 0.25 },
        { label: "drifty1" },
      ),
      node("out", "output", [400, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-rings-gain", ["rings", "out"], ["gain", "input"]),
      edge("e-gain-wrap", ["gain", "out"], ["wrap", "input"]),
      // ONE generator, TWO consumers (§V6): the ring field is rendered once per frame.
      edge("e-wrap-beat", ["wrap", "out"], ["beat", "in1"]),
      edge("e-wrap-warp", ["wrap", "out"], ["warp", "input"]),
      edge("e-warp-beat", ["warp", "out"], ["beat", "in2"]),
      edge("e-beat-tint", ["beat", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-out", ["tint", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E27 — Relief (T475, T409).
 *
 * A moving picture STANDS UP off the screen: a grid of points is pushed toward the viewer
 * in proportion to the brightness under it, drawn as thousands of small unlit quads and
 * filmed by a drifting camera. Rutt-Etra, the analog video-synth look — except the source
 * is a live graph rather than a scan converter.
 *
 * ## THE UNDERSTUDY PATTERN (V411), and it is the reusable idea here
 *
 * §V363 says a demo must demonstrate itself, and until now that has meant no example may
 * contain a live input at all. That is exactly why `webcam` shipped DEAD for months (B39):
 * no example used it, so nothing ever compiled its shader or bound its external texture.
 *
 * `pick1` dissolves the conflict. A Switch's branches are all rendered — it selects a
 * RESOURCE, it does not prune a subgraph — so with `index: 0` this file opens playing its
 * own synthetic performer, AND `cam1` is in the graph, in the plan, and compiled on Dawn by
 * `examples.gpu.test.ts`. That is the integration gate §V362 names as the only one we have,
 * and it is the gate B39 escaped. Move the index to 1 and it is your camera; nothing else
 * in the graph changes.
 *
 * The same shape generalises to `audioIn`/`audioFileIn`, the other two nodes §V363 has been
 * keeping unexampled. It is not applied here — one example, one claim — but it is the
 * reason to write this one down.
 *
 * ## Why POINTS and not a surface
 *
 * `textureToAttribute` reads with `textureLoad` — NEAREST, unfiltered, deliberately, so a
 * data field survives it (§V57). A displaced SURFACE is therefore brutally sensitive to the
 * ratio between mesh and field: coarser and a narrow feature falls between two vertices and
 * spikes, finer and every vertex in one texel shares a height and the surface steps. Points
 * have neither failure, because there is no shared edge between them to tear or facet — a
 * point that samples a texel just sits where that texel says. That is what makes a relief
 * the honest thing to build on this bridge, and it is why the grid here can be a different
 * shape from the field without anything going wrong.
 *
 * ## The aspect fix lives in the kernel
 *
 * The bridge maps `position.xy * 0.5 + 0.5` to uv, so the sampling grid HAS to span
 * x,y in [-1,1] — a square. The source is 16:9. So `lift1` samples on the square and then
 * stretches x by 16/9 on its way out: the picture is read square and DRAWN wide, which is
 * one line of kernel and the only place the aspect appears.
 *
 * ## T503 — THE THREE THINGS THAT WERE WRONG, and they were different bugs
 *
 * The owner's verdict on the first build was "weak, inverted and hard to see". All three
 * were true and none of them was tuning.
 *
 * **1. IT WAS LITERALLY UPSIDE DOWN, by construction.** The bridge maps `position.y = -1`
 * to `uv.y = 0`, and `uv.y = 0` is TEXEL ROW 0 — the row an output node shows at the TOP
 * of the frame. But world +y is UP, so `position.y = -1` renders at the BOTTOM. Every
 * texture-to-points bridge therefore hands the picture back mirrored across the horizon,
 * and nothing in the understudy was asymmetric enough to make that visible. Flip the
 * Switch to the webcam and it is your own face, upside down. The fix is `-p.position.y`
 * in the kernel: the bridge already sampled at the grid's own xy, so negating y at DRAW
 * time reseats the image without touching what was read.
 *
 * **2. THE HEIGHT CAME OUT OF THE PALETTE, so the terrain was a caricature of the
 * picture.** `lift1` took luminance off the COATED colour, and this palette's luminance
 * runs 0.02 / 0.14 / 0.28 / 0.49 / 0.95 across its five stops — monotone, yes, but wildly
 * non-linear. Four fifths of the source was squashed into the bottom half of the height
 * range and the last fifth exploded, which renders as a flat plate with one needle spike
 * in it. That is the whole of "weak".
 *
 * The fix is the reason `braid1` exists: a Reorder carries the COLOUR in rgb and the
 * SOURCE's own luminance in alpha, so one RGBA texture crosses the one bridge carrying two
 * different fields. The kernel then reads `sample.a` for shape and `sample.rgb` for colour,
 * and the palette is free to be chosen for how it LOOKS instead of doubling as a height
 * transfer function. Generalisable: the bridge is four channels wide and a displacement
 * only needs one.
 *
 * **3. THE CAMERA WAS ALMOST DOWN THE HEIGHT AXIS.** The old eye looked along (-0.32,
 * 0.40, -0.86) at a sheet whose relief is entirely in z — 86% of the view direction was
 * parallel to the displacement, so the thing the example is about barely projected. The
 * doc claimed the opposite ("face-on, a height field is just the picture again"), which is
 * how it survived review. `eye1` now sits low and off to one side, a landscape view: the
 * height axis is across the frame, the hills have silhouettes, and the scan lines bunch on
 * a rising slope the way a contour map's do.
 */
const RELIEF_COLS = 480;
const RELIEF_ROWS = 220;

const RELIEF_LIFT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* p.sample is the bridge's pair, bound from UPSTREAM (T401), and it carries TWO fields:
     rgb is the paletted colour, alpha is the SOURCE's own luminance (braid1). Height comes
     off alpha so the palette never doubles as a height curve — see the note above. */
  let height = p.sample.a;
  /* T676 — THE SHEET STANDS UP, 70 degrees off the floor, and ORIENTATION FOLLOWS THE
     SOURCE.

     Owner: "its on its Back both in preview and final output. we're laying the points on
     their back which makes sense for the mountains but looks weird when we do webcam
     right". That sentence is the rule, and it is why this is not a tuning change. A
     HEIGHTFIELD is read from above, so T503 was right to lay the sheet down for the
     noise-and-dome understudy. A SCANNED VIDEO IMAGE is read FACE-ON — you look at a face
     the way you looked at it — and this example's real subject is the webcam on branch 1.
     Face-on with a slight lean is also the historical Rutt-Etra frame, which is what this
     document is quoting.

     WHY 70 AND NOT THE 90 THE OWNER SAID. The owner gave a number describing the problem.
     A true 90 with a camera in front puts the view direction straight back down the height
     axis, which is EXACTLY the failure T503 fixed (the first build looked 86% down it and
     the relief did not project at all). It also removes both cues this example actually
     reads by, and it has no third one to fall back on: the material is UNLIT, so there is
     no shading and no raking light — a bas-relief's usual mechanism is simply unavailable
     here. What is left is SILHOUETTE against the far ground and SCAN LINES BUNCHING on a
     rising slope, and both are obliquity cues. Leaning the sheet back 20 degrees keeps the
     camera about 20-25 degrees off its normal: the image reads face-on, and the relief
     still has somewhere to project.

     THE GEOMETRY. The grid arrives in the xy plane. Read 'u' as across, 'v' as up the
     sheet, 'h' as out along its normal, then rotate (v, h) about x by 70 degrees:
       y = v*sin70 + h*cos70,  z = -v*cos70 + h*sin70
     so the sheet's own up axis leans back and its normal leans toward the camera on +z.
     At 0 degrees this collapses to the old (u, h, v) lay-down, which is the check that the
     rotation is the only thing that changed.

     THE 'v' SIGN IS T512's AND IT SURVIVES INTACT. The bridge reads
     uv.y = 0.5 - position.y*0.5, so position.y = +1 is TEXEL ROW 0 — the row an output
     shows at the TOP of the frame. Laid flat, the top of a picture belonged at the FAR
     edge, which is z NEGATIVE from a camera on +z. STOOD UP, the top of a picture belongs
     at the TOP, which is y POSITIVE — and the same negation delivers both, because the
     rotation carries it. Read the mapping in points/codegen.ts rather than guessing: this
     sign is coupled to it and B105 is what guessing costs.

     Baked rather than parameterised: this kernel has exactly one consumer, the 'lift1'
     node below. A shared kernel that could only do one orientation would be the same fault
     as two hand-maintained branches — but there is nothing here to share it with.
     Sampled on a square (the mapping demands it), drawn 16:9. */
  let v = p.position.y * 1.15;
  let h = height * 1.05 - 0.16;
  q.position = vec3f(p.position.x * 1.7778, v * 0.9397 + h * 0.3420, -v * 0.3420 + h * 0.9397);
  /* Alpha has done its job, so it goes back to 1 before the draw: body1 maps this same
     attribute onto the material TINT (T478), and a tint whose alpha carried the HEIGHT
     would have made the low ground transparent as well as dark. */
  q.sample = vec4f(p.sample.rgb, 1.0);
  return q;
}`;

const reliefDocument = document(
  "e27-relief",
  "E27 Relief",
  settings({ randomSeed: 41 }),
  graph(
    [
      /* THE UNDERSTUDY. A hill travelling across a living bed of noise: something with
         SHAPE in it, so the relief is a picture rather than a texture, and something that
         moves everywhere, so no part of the frame is still (T402). */
      node("ripple", "noise", [-1680, 300], {
        type: "perlin4d", seed: 41, period: 0.32, harmon: 4, spread: 2.1, gain: 0.58,
        rough: 0.55, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.16, // T535: off the lattice plane
      }, { label: "ripple1" }),
      node("bed", "level", [-1380, 300], {
        /* T503: the bed used to be crushed to a 0.42..1.05 sliver — a sixth of the height
           range for the entire terrain, which is most of why nothing read. It now uses its
           whole range, and `gamma1` under 1 lifts the mid-slopes so the valleys stay dark
           and the ridges separate. The DOME is still the subject; contrast is what makes
           the ground it stands on a landscape rather than a haze. */
        blacklevel: 0.12, whitelevel: 0.86, contrast: 1.25, brightness: 1, gamma1: 0.85, opacity: 1,
      }, { label: "bed1" }),
      /* THE SWELL. A soft dome, wide and low-contrast, wandering across the sea on two
         incommensurate drifts. It is the SHAPE in the picture: without it the relief is a
         texture, and a texture in relief is E20 with extra steps. */
      node("swell", "circle", [-1680, 0], {
        mode: "fill", center: [0.5, 0.5], radius: [0.3, 0.3],
        /* Softness far past the radius makes this a DOME rather than a disc (E13's
           finding): a hard disc lifts as a cylinder with a cliff edge, and a cliff is
           where a point relief looks like a bug. */
        softness: 0.62,
        /* Under 1.0 on purpose: the bed is ADDED on top, and a dome already at full
           brightness clips flat where the two meet — which renders as a scooped, level
           summit instead of a peak. */
        fillcolor: [0.72, 0.7, 0.66, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, {
        label: "swell1",
        parameters: {
          "center.x": drivenSlot("driftx1", 0.5),
          "center.y": drivenSlot("drifty1", 0.5),
        },
      }),
      node("driftx", "lfo", [-1680, 560], {
        shape: "sine", frequency: 0.019, amplitude: 0.3, offset: 0.5, phase: 0,
      }, { label: "driftx1" }),
      node("drifty", "lfo", [-1380, 560], {
        shape: "sine", frequency: 0.013, amplitude: 0.22, offset: 0.5, phase: 0.25,
      }, { label: "drifty1" }),
      node("sum", "add", [-1080, 140], {}, { label: "sum1" }),

      /* THE REAL THING — in the graph, in the plan, compiled on Dawn, one index away. */
      node("cam", "webcam", [-1080, 420], {}, { label: "cam1" }),
      node("pick", "switch", [-780, 280], { index: 0 }, { label: "pick1" }),

      node("palette", "ramp", [-1080, -180], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* A scan-line palette: near-black in the valleys, through a cold teal and a hot
           magenta, to a white crest. T503 freed it from a second job — `braid1` carries the
           height separately now — so these stops are chosen for CONTRAST and nothing else:
           a long dark foot so the low ground goes properly black at thumbnail size, then a
           short, violent climb through the top third so a ridge line ignites. */
        stops: [
          { position: 0, color: [0.004, 0.01, 0.035, 1] },
          { position: 0.34, color: [0.02, 0.13, 0.3, 1] },
          { position: 0.56, color: [0.08, 0.5, 0.62, 1] },
          { position: 0.76, color: [0.86, 0.2, 0.6, 1] },
          { position: 0.9, color: [1, 0.46, 0.32, 1] },
          { position: 1, color: [1, 0.97, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("coat", "lookup", [-780, -20], {
        channel: "luminance", row: 0.5, scale: 1, offset: 0,
      }, { label: "coat1" }),
      /* T503 — TWO FIELDS, ONE BRIDGE. rgb is the paletted colour; ALPHA is the source's
         own luminance, straight off `pick1` before the palette touched it. There is exactly
         one texture-to-points bridge in the catalogue and it carries four channels, so the
         shape and the colour do not have to be the same number — which is what stopped the
         relief from being a caricature of the palette's transfer curve. */
      node("braid", "reorder", [-480, -20], {
        outr: "in1r", outg: "in1g", outb: "in1b", outa: "in2lum",
      }, { label: "braid1" }),

      node("sheet", "pointGrid", [-480, 280], {
        count: RELIEF_COLS * RELIEF_ROWS, cols: RELIEF_COLS, rows: RELIEF_ROWS,
      }, { label: "grid1" }),
      node("bridge", "textureToAttribute", [-180, 140], {
        count: RELIEF_COLS * RELIEF_ROWS,
      }, { label: "bridge1" }),
      node("lift", "pointKernel", [120, 140], {
        capacity: RELIEF_COLS * RELIEF_ROWS,
        seed: 41,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
        ]),
        kernel: RELIEF_LIFT_KERNEL,
      }, { label: "lift1" }),

      /* UNLIT, and that is the look: a phosphor does not have a diffuse response. The
         colour comes entirely from T478's per-point TINT, so `render`'s light list is
         empty and nothing shades these quads. */
      node("phosphor", "materialUnlit", [120, -180], {
        color: [1, 1, 1, 1],
      }, { label: "phosphor1" }),
      node("body", "geometry", [420, 140], {
        /* The quad half-extent must stay UNDER half the point spacing (3.56 world units
           across 480 columns = 0.0074), or the quads overlap into a solid slab and the
           scan lines disappear. The first build ran 0.0075 and rendered one flat sheet. */
        mode: "instances", shape: "quad", scale: 0.0026, material: "phosphor1",
        tint: [1, 1, 1, 1],
      }, {
        label: "body1",
        /* T478: the sampled colour multiplies the material's base colour PER POINT. White
           base means the tint IS the colour. */
        parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "sample" } } } },
      }),
      node("eye", "camera", [420, -180], {
        /* T676 — A FRONT VIEW, because the sheet stands up now (see RELIEF_LIFT_KERNEL).
           T503's number is still the one that matters — how much of the view direction runs
           PARALLEL to the height axis — and this framing keeps it where T503 put it. The
           first build ran 86% and the relief did not project at all; the landscape camera
           got it to ~19%; standing the sheet up and looking at it LEVEL gives the same ~19%
           from the other side, because the sheet leans back 20 degrees and the eye is on its
           centre line. So the picture reads face-on, as a scanned frame should, and the
           silhouettes and the scan-line bunching are still there to read it by.

           Framed on the stood-up extent rather than guessed: the sheet spans y -1.14..+1.39
           and its middle row sits at z ~ +0.35, so a half-height of 1.26 at fov 40 needs
           3.46 and this sits at 3.90 for margin. Width is not the binding constraint at
           16:9 (half-width 1.78 against 2.53 available).

           THE SWAY IS NOW LOAD-BEARING, not decoration. A relief seen face-on under no
           light has no shading to give it depth, so PARALLAX is what remains: eye.x swings
           +/-1.15 at 0.024 Hz, which is +/-16 degrees at this distance, and the near ridges
           slide against the far ground the way they would if you moved your head. Laid down
           this was a garnish; stood up it is the depth cue. */
        eye: [0, 0.13, 4.25], lookAt: [0, 0.13, 0.35], fov: 40, near: 0.1, far: 100, ortho: false,
      }, {
        label: "eye1",
        parameters: { "eye.x": drivenSlot("sway1", 0) },
      }),
      node("sway", "lfo", [120, -420], {
        shape: "sine", frequency: 0.024, amplitude: 1.15, offset: 0, phase: 0,
      }, { label: "sway1" }),
      node("shot", "render", [720, 140], {
        scenes: "body1", camera: "eye1", lights: "",
        ambientColor: [1, 1, 1, 1], ambientIntensity: 0,
        background: [0.002, 0.004, 0.011, 1],
      }, { label: "shot1" }),

      /* BLOOM, and on an unlit phosphor it is not decoration: it is what makes thousands of
         separate quads read as one glowing surface instead of as a dotted grid. */
      node("halo", "blur", [1020, 300], { size: 18, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("burn", "add", [1320, 140], {}, { label: "burn1" }),
      node("out", "output", [1620, 140], {}, { label: "out1" }),
    ],
    [
      edge("e-ripple-bed", ["ripple", "out"], ["bed", "input"]),
      edge("e-swell-sum", ["swell", "out"], ["sum", "in1"]),
      edge("e-bed-sum", ["bed", "out"], ["sum", "in2"]),
      // BRANCH 0 is the understudy, BRANCH 1 is the camera, and the ORDER SAYS SO (§V131).
      // Left to the id tiebreak, "e-cam-pick" sorts before "e-sum-pick" and the file opens
      // on a black camera — the exact null state §V363 exists to prevent, chosen by
      // alphabet.
      edge("e-sum-pick", ["sum", "out"], ["pick", "inputs"], 0),
      edge("e-cam-pick", ["cam", "out"], ["pick", "inputs"], 1),
      edge("e-pick-coat", ["pick", "out"], ["coat", "source"]),
      edge("e-palette-coat", ["palette", "out"], ["coat", "lookup"]),
      // THE BRAID: colour in from the palette, SHAPE in from the un-coated source.
      edge("e-coat-braid", ["coat", "out"], ["braid", "in1"]),
      edge("e-pick-braid", ["pick", "out"], ["braid", "in2"]),
      edge("e-sheet-bridge", ["sheet", "out"], ["bridge", "points"]),
      edge("e-braid-bridge", ["braid", "out"], ["bridge", "texture"]),
      edge("e-bridge-lift", ["bridge", "out"], ["lift", "in"]),
      edge("e-lift-body", ["lift", "out"], ["body", "points"]),
      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-halo-burn", ["halo", "out"], ["burn", "in2"]),
      edge("e-burn-out", ["burn", "out"], ["out", "input"]),
    ],
  ),
);

/** Every example, in the order they are meant to be read. */
/**
 * E28 — Sundial (T484).
 *
 * A hard shadow travelling across a floor — the owner's bar, stated as a shot. One warm
 * directional key rakes in low from the west with `shadows` on (T481); a single amber
 * octahedron rides two quadrature LFOs in a slow circle above a stone floor; its shadow
 * sweeps the ground and climbs over three standing cubes like the hand of a clock. The
 * sky is a Ramp worn as the render's ENVIRONMENT (T482): a dusk gradient the stones'
 * specular lobes pick up as a cool sheen, so the unlit side of everything still reads.
 *
 * Why the composition is what it is:
 *
 * - The CASTER moves, the light does not. An orbiting light changes the whole frame's
 *   exposure every second; an orbiting object under a fixed key changes only the one
 *   thing the eye is meant to follow. The shadow is the performer.
 * - The orbit is two LFOs into the kernel's VALUE SLOTS (T479) — `ctx.value1/value2`
 *   re-publish per frame as uniform writes, nothing rebuilds (§V5). The same channel
 *   drives a slow camera drift, because a locked-off camera reads as a screenshot.
 * - `shadowExtent` is set to 5 BY HAND to hug the floor (V426): nothing knows the
 *   scene's bounds, and the tighter the volume, the more of the r32float map's
 *   resolution the shot actually spends on the floor the shadow lives on.
 * - The floor is a pointGrid LAID FLAT by a kernel (xy → xz at y = 0) and rendered as a
 *   SURFACE — grid topology survives a kernel, so central-difference normals give the
 *   floor its even lambert falloff. The stones are one instanced geometry: a box's
 *   vertices are ±1 × scale, so `scale: 0.4` cubes SIT on the floor at y = 0.4 exactly.
 *
 * ## T503 — THE ANTIALIASING, and why it is SUPERSAMPLING rather than analytic coverage
 *
 * Say the tempting thing first and then rule it out: analytic coverage from a distance
 * field — `smoothstep` over `fwidth(d)` — is nearly always the better answer, because it
 * costs one extra instruction and gives an exact 1-pixel filter width instead of a
 * quantised approximation. **It does not apply here, because there is no distance field in
 * this graph.** Every edge in this frame comes from a RASTERISER: triangle silhouettes of
 * an octahedron and three boxes, and the depth comparison against a shadow map. A fragment
 * shader cannot recover an analytic coverage term for a triangle edge it was never told
 * about, and the shadow test is a discrete comparison — there is no `d` to take `fwidth`
 * of. Reaching for `fwidth` here would have been the right tool on the wrong image.
 *
 * So this renders at 2× and lets the present resample it: `shot1` carries a per-node
 * resolution override (§V50) of 1536×864 over a 768×432 project, and the output's blit
 * downsamples it. At exactly 2:1 each destination pixel's sample lands on the corner
 * between four source texels, so a bilinear read returns their exact mean — a true 4×
 * box-filtered SSAA rather than a blur that happens to soften.
 *
 * THE COST, STATED, because 4× fragment work is not free: this frame is four boxes' worth
 * of triangles over a 768-point floor at 1.3 megapixels, which is nothing. The reason it
 * is worth paying twice over is that the SHADOW MAP scales with the render (`scratch`
 * entries are `scale: 2` of the node's own size), so the same one change takes the map
 * from 1536×864 to 3072×1728 — and the blocky staircase along the shadow's leading edge
 * was always the worse of the two aliases. Both go away for one parameter. 3072 stays
 * under `maxResolution` (4096) with room, which is the reason it is 2× and not 3×.
 */
const sundialDocument = document(
  "e28-sundial",
  "E28 Sundial",
  settings({ outputResolution: { width: 768, height: 432 } }),
  graph(
    [
      // ---- the floor: a grid laid flat, worn as a lit surface ---------------------
      node("floorPts", "pointGrid", [-1460, 40], { cols: 32, rows: 24, count: 768, sizeX: 13, sizeY: 10 }, { label: "floorpts1" }),
      node("floorLay", "pointKernel", [-1180, 40], {
        capacity: 768,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the grid lies down: xy becomes xz, the floor is the world's ground plane */\n  q.position = vec3f(p.position.x, 0.0, p.position.y);\n  return q;\n}",
      }, { label: "floorlay1" }),
      node("ground", "geometry", [-880, 40], { mode: "surface", material: "matground1" }, { label: "ground1" }),

      // ---- three standing stones: the sundial's fixed marks -----------------------
      node("stonePts", "pointGrid", [-1460, 340], { cols: 3, rows: 1, count: 3, sizeX: 3, sizeY: 1 }, { label: "stonepts1" }),
      node("stoneLay", "pointKernel", [-1180, 340], {
        capacity: 3,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* three marks, placed off-axis so no two shadows ever agree */\n  if (ctx.index == 0u) { q.position = vec3f(-1.5, 0.4, -0.9); }\n  else if (ctx.index == 1u) { q.position = vec3f(0.5, 0.4, -1.5); }\n  else { q.position = vec3f(1.7, 0.4, 0.3); }\n  return q;\n}",
      }, { label: "stonelay1" }),
      node("stones", "geometry", [-880, 340], { mode: "instances", shape: "box", scale: 0.4, material: "matstone1" }, { label: "stones1" }),

      // ---- the caster: one octahedron on a slow circular orbit --------------------
      node("sunPt", "pointGrid", [-1460, 660], { cols: 1, rows: 1, count: 1, sizeX: 1, sizeY: 1 }, { label: "sunpt1" }),
      node("orbX", "lfo", [-1460, 900], { shape: "sine", frequency: 0.04, amplitude: 1.7, offset: 0, phase: 0 }, { label: "orbx1" }),
      node("orbZ", "lfo", [-1460, 1080], { shape: "sine", frequency: 0.04, amplitude: 1.7, offset: 0, phase: 0.25 }, { label: "orbz1" }),
      node("sunOrbit", "pointKernel", [-1180, 660], {
        capacity: 1,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* two quadrature LFOs, in through the value slots (T479): values, never rebuilds */\n  q.position = vec3f(ctx.value1, 0.85, ctx.value2);\n  return q;\n}",
      }, {
        label: "sunorbit1",
        parameters: {
          value1: drivenSlot("orbx1", 1.7),
          value2: drivenSlot("orbz1", 0),
        },
      }),
      node("sun", "geometry", [-880, 660], { mode: "instances", shape: "octahedron", scale: 0.34, material: "matsun1" }, { label: "sun1" }),

      // ---- materials and the sky ---------------------------------------------------
      node("matGround", "materialPhong", [-580, 40], {
        color: [0.36, 0.37, 0.42, 1], specular: [0.25, 0.28, 0.35, 1], shininess: 10, roughness: 0.85,
      }, { label: "matground1" }),
      node("matStone", "materialPhong", [-580, 300], {
        color: [0.58, 0.52, 0.44, 1], specular: [0.8, 0.85, 1, 1], shininess: 60, roughness: 0.3,
      }, { label: "matstone1" }),
      node("matSun", "materialPhong", [-580, 560], {
        color: [1, 0.55, 0.2, 1], specular: [1, 0.9, 0.7, 1], shininess: 40, roughness: 0.35,
      }, { label: "matsun1" }),
      node("sky", "ramp", [-580, 820], {
        type: "vertical",
        interp: "linear",
        phase: 0,
        period: 1,
        /* v = acos(R.y)/π (T482): 0 is the zenith, 1 the nadir. Deep blue overhead,
           a hot amber band AT the horizon, dark below it. */
        stops: [
          { position: 0, color: [0.06, 0.13, 0.34, 1] },
          { position: 0.42, color: [0.42, 0.5, 0.68, 1] },
          { position: 0.52, color: [1, 0.55, 0.28, 1] },
          { position: 0.62, color: [0.2, 0.12, 0.1, 1] },
          { position: 1, color: [0.08, 0.06, 0.06, 1] },
        ],
      }, { label: "sky1", definitionVersion: 2 }),

      // ---- the shot ---------------------------------------------------------------
      node("drift", "lfo", [-280, 560], { shape: "sine", frequency: 0.03, amplitude: 0.5, offset: 0.4, phase: 0 }, { label: "drift1" }),
      node("cam", "camera", [-280, 40], { lookAt: [0, 0.15, -0.4], fov: 40 }, {
        label: "cam1",
        parameters: {
          "eye.x": drivenSlot("drift1", 0.4),
          "eye.y": 1.25,
          "eye.z": 4.9,
        },
      }),
      node("key", "light", [-280, 300], {
        kind: "directional", color: [1, 0.88, 0.72, 1], intensity: 1.4,
        /* low and from the west: the raking angle IS the long shadow */
        direction: [-1, -0.45, 0.25],
        shadows: true, shadowExtent: 3.6,
      }, { label: "key1" }),
      node("shot", "render", [0, 40], {
        scenes: "ground1 stones1 sun1", camera: "cam1", lights: "key1",
        ambientColor: [0.4, 0.5, 0.95, 1], ambientIntensity: 0.3,
        background: [0.05, 0.06, 0.12, 1],
        environmentIntensity: 1,
      }, {
        label: "shot1",
        /* T503 — the whole antialiasing fix, and it is one field. EXACTLY 2× the project's
           768×432 (§V50): at any other ratio the downsample is an interpolation with
           unequal weights, and at this one it is a box filter. See the note above for why
           analytic coverage is not available on a rasterised silhouette. */
        resolution: { mode: "fixed", width: 1536, height: 864 },
      }),
      node("out", "output", [280, 40], {}, { label: "out1" }),
    ],
    [
      edge("e-floorpts-lay", ["floorPts", "out"], ["floorLay", "in"]),
      edge("e-floorlay-ground", ["floorLay", "out"], ["ground", "points"]),
      edge("e-stonepts-lay", ["stonePts", "out"], ["stoneLay", "in"]),
      edge("e-stonelay-stones", ["stoneLay", "out"], ["stones", "points"]),
      edge("e-sunpt-orbit", ["sunPt", "out"], ["sunOrbit", "in"]),
      edge("e-sunorbit-sun", ["sunOrbit", "out"], ["sun", "points"]),
      // THE SKY WIRE (T482, V372): pixels are data — a Ramp worn as the environment.
      edge("e-sky-shot", ["sky", "out"], ["shot", "environment"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E29 — Descent (T503). A VJ piece first: an endless tunnel you fall into.
 *
 * A ring of light is born in the middle of the frame, then rushes outward past you,
 * turning as it goes and sliding around the hue wheel — and behind it the next ring, and
 * the next, so the frame reads as a corridor receding to a point that never arrives. On
 * every kick the fall LURCHES: the zoom per frame jumps, the whole corridor surges, and it
 * settles back over the following beat.
 *
 * ## Why this is not E1 with more knobs
 *
 * E1 Feedback Echo is a SMEAR — a trail that transforms slightly and fades. The two
 * differences here are the whole picture and neither is a matter of degree:
 *
 *  1. **The scale inside the loop is greater than one.** E1's loop shrinks and drifts;
 *     this one MAGNIFIES by 5.5% per pass about the frame's centre. Content therefore
 *     leaves through the edges rather than piling up, which is what a corridor is, and it
 *     is also what keeps the loop stable without a hard fade — an expanding image spreads
 *     its energy over more pixels every pass, so the gain can sit essentially at unity and
 *     the picture still terminates.
 *  2. **The hue rotates inside the loop.** Each pass is a few degrees further round, so
 *     depth reads as COLOUR: the ring nearest you is a different hue from the one behind
 *     it, and you can count the corridor's rings by their colour even where their edges
 *     have blurred into each other.
 *
 * ## The clock, and why this one cannot snap at a lap
 *
 * There is no clock read in the picture path at all — not `time`, not `absTime`. The
 * motion is the feedback loop's own iteration, one pass per frame, and the state carries
 * across a timeline lap like any other frame boundary (T489). An example whose animation
 * comes from state rather than from a clock position is loop-proof BY CONSTRUCTION, which
 * for a piece meant to run for an hour behind a set is worth more than it sounds. The one
 * clock reader is `beat1`, which is timeline-anchored ON PURPOSE (§V436): it stands in for
 * a track, so bar one lands on the in point.
 *
 * ## The sound, and what happens when you drop your own in
 *
 * `beat1` is the deterministic Audio Pattern, so the file OPENS PLAYING with no asset
 * bound (§V363, B74) and an offline render of it reproduces (§V45). The kick drives two
 * things at different time constants — the zoom, through a fast Lag so the surge is felt
 * as an impact, and the ring's own brightness, through a slower one so the corridor stays
 * lit between beats. Swap `beat1` for an `audioFileIn` and keep its label and every
 * mapping downstream follows.
 */
const descentDocument = document(
  "e29-descent",
  "E29 Descent",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 29 }),
  graph(
    [
      // ---- the sound -------------------------------------------------------------
      node("beat", "audioPattern", [-1560, 600], { bpm: 124, amount: 1 }, { label: "beat1" }),
      /* Two envelopes off one source, and the difference between them is the feel — but
         also, for the ring, the difference between a stable loop and a white frame. The
         slow one (0.28 s) reaches the ZOOM, where a smooth surge is what you want. The fast
         one (30 ms) reaches the ring's brightness, and it has to be fast: anything the ring
         adds is added EVERY FRAME into a loop whose gain is 0.985, so a DC term of `x`
         settles at `x / 0.015` — sixty-odd times itself. A ring lit by an ENVELOPE is a DC
         term. A ring lit by a STRIKE is not, and that is why this one is nearly zero
         between beats rather than merely dimmer. */
      node("punch", "valueLag", [-1300, 480], { lag: 0.28 }, { label: "punch1" }),
      /* THE RING IS BORN BY A TRIGGER, not by an envelope, and this is the load-bearing
         line in the graph. Whatever the ring adds is added into a loop whose gain is 0.985,
         so the loop integrates roughly 67 frames of it: a DC term of `x` settles at
         `x / 0.015`. An envelope — even a fast one — is a DC term, and three builds of this
         example went to solid white before that was the diagnosis rather than the fade
         being "not strong enough". A Trigger emits 1 for the ONE frame the kick crosses its
         threshold and 0 for the other twenty-eight, so the mean input is a twenty-ninth of
         the peak and the steady state lands under one by arithmetic instead of by luck. */
      node("hit", "valueTrigger", [-1300, 740], { threshold: 0.84 }, { label: "hit1" }),
      node("zgain", "valueMath", [-1040, 480], { operation: "multiply", operand: 0.107 }, { label: "zgain1" }),
      node("zbase", "valueMath", [-780, 480], { operation: "add", operand: 0.9466 }, { label: "zbase1" }),
      /* Two fences, like E24's: above ~1.13 per frame the corridor outruns the eye and
         reads as a flash, and at or below 1.0 the loop stops expanding and piles up into
         white. The clamp is not tuning, it is what keeps a loud passage recoverable. */
      node("zcap", "valueLimit", [-520, 480], { minimum: 1.006, maximum: 1.048 }, { label: "zoom1" }),
      node("strike", "valueMath", [-1040, 740], { operation: "multiply", operand: 0.85 }, { label: "strike1" }),
      node("bcap", "valueLimit", [-780, 740], { minimum: 0, maximum: 0.85 }, { label: "lamp1" }),

      // ---- the ring that is born every frame --------------------------------------
      /* THE FRAME, as two rounded squares and a Difference.
         WHY A SQUARE AND NOT A CIRCLE, and it is the difference between a tunnel and a
         dartboard: the loop ROTATES, and a rotation of a rotationally symmetric shape is
         invisible. The first build seeded circles, and the 0.26° per pass — thirty degrees
         between one ring and the next — did nothing at all to the picture. A square turns
         visibly, so the corridor reads as a twisting shaft rather than a bullseye, and the
         twist per ring is something you can literally count off the corners.
         AND WHY TWO SHAPES AND NOT ONE NODE: `rectangle`'s `distance` mode gives a SIGNED
         field, and a Level cannot cut a band out of a signed field because it has no
         absolute value — every setting that brightens the edge also brightens the whole
         interior, which renders as a soft blob (measured, on the build before that one).
         |a − b| over two coverage masks is exact, and the frame's WIDTH is then the
         difference of two sizes, which is a number you can reason about. */
      node("bore", "rectangle", [-1560, -80], {
        mode: "fill", center: [0.5, 0.5], size: [0.124, 0.124], roundness: 0.028, softness: 0.004,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "bore1" }),
      node("core", "rectangle", [-1560, 180], {
        mode: "fill", center: [0.5, 0.5], size: [0.113, 0.113], roundness: 0.028, softness: 0.004,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "core1" }),
      node("ring", "difference", [-1300, 50], {}, { label: "ring1" }),
      /* The kick lands HERE — AFTER the palette, and that ordering is the whole of it. Put
         the same gain BEFORE the lookup and a quiet moment does not dim the ring, it moves
         it to the DARK END OF THE RAMP: the ring turns black-purple instead of faint, and
         between beats the frame goes to nothing. Measured on the first build. A brightness
         that means brightness has to act on colour, not on a lookup coordinate. */
      node("lamp", "level", [-780, -80], {
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, {
        label: "lampl1",
        parameters: { brightness: drivenSlot("lamp1:low", 1) },
      }),
      /* The frame's colour, and the crest is SATURATED rather than white — which is not a
         taste call, it is what makes the hue rotation inside the loop do anything at all.
         Rotating the hue of a neutral is a no-op: the first coloured build ended on
         (1, 0.98, 0.92), every ring came out white, and thirty degrees per ring changed
         nothing. Ending on a saturated teal gives `shift1` something to turn, so depth
         reads as colour down the whole corridor. */
      node("hue", "ramp", [-1300, -280], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.4, color: [0.03, 0.06, 0.22, 1] },
          { position: 0.72, color: [0.05, 0.42, 0.6, 1] },
          { position: 1, color: [0.1, 0.95, 0.88, 1] },
        ],
      }, { label: "hue1", definitionVersion: 2 }),
      node("paint", "lookup", [-1040, -80], { channel: "luminance", row: 0.5, scale: 1, offset: 0 }, { label: "paint1" }),

      // ---- the loop: magnify, turn, shift hue, add the new ring ---------------------
      /* THE TEMPORAL BOUNDARY (§V4/§V22). `source` names the node whose output is captured,
         so last frame's finished picture re-enters here and the three stages below run on
         it before the new ring is added on top. */
      node("loop", "feedback", [-780, 230], {
        /* PERSISTENCE IS THE ENERGY SINK, and the first build got this wrong in a way worth
           recording: I assumed an expanding loop dims itself, because the same light lands
           on more pixels. It does not. `s > 1` DIVIDES the sampling coordinates, so the
           pass magnifies the centre and DUPLICATES its pixels — nothing leaves the frame
           and nothing is diluted. With a near-unity gain the corridor went to white in
           under four seconds. Every bit of the decay here is deliberate. */
        source: "born1", persistence: 0.985, clearColor: [0, 0, 0, 1],
      }, { label: "loop1" }),
      node("fall", "transform", [-520, 230], {
        /* Scale ABOVE ONE about the centre: the corridor's whole geometry, in one number.
           `extend: "zero"` matters — with `hold`, the edge pixels of an expanding image
           streak outward forever and the corners fill with smeared colour. */
        t: [0, 0], r: 0.55, s: [1.019, 1.019], p: [0, 0], xord: "srt", extend: "zero", aspectcorrect: true,
      }, {
        label: "fall1",
        parameters: {
          "s.x": drivenSlot("zoom1:low", 1.019),
          "s.y": drivenSlot("zoom1:low", 1.019),
        },
      }),
      node("fade", "level", [-260, 230], {
        /* Two jobs, neither of them the fade (that is `loop1`'s persistence). `blacklevel`
           above zero gives the corridor an END — without it the far rings asymptote toward
           a permanent grey haze instead of going out. GAMMA above one fights the other
           thing the loop does to a picture: every pass resamples bilinearly, so an edge
           that has gone round fifty times is a gradient, and lifting the midtones
           re-steepens its dark ramp.
           SIGN CHECKED (T618, §V481c): Level computes `pow(v, 1 / gamma1)`, so 1.12 is
           `pow(v, 0.893)` — ABOVE `v` on (0,1), a midtone LIFT, i.e. mildly expansive.
           An earlier version of this comment claimed the opposite and §V481(c) was
           first recorded from it. What actually keeps the loop bounded is not this
           stage contracting — it is `persistence 0.989` shrinking every pass and the
           `blacklevel` floor clipping the tail; the lift only has to stay small enough
           that their product with it is below one, which at 1.12 it does. Contrast was
           still the wrong knob for a different reason: its expansion PIVOTS at mid-grey,
           so the bright half gets gain exactly where the loop already accumulates, and
           the first build went to white in seven seconds with contrast 1.05.
           Every stage inside a feedback loop has to be sign-checked like this. */
        blacklevel: 0.006, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1.12, opacity: 1,
      }, { label: "fade1" }),
      node("shift", "hsv", [0, 230], {
        /* Three degrees per pass. Each frame of the corridor has been round the loop one
           more time than the one inside it, so ~90° separates one square from the next and
           DEPTH READS AS COLOUR — you can count the shaft by hue where the edges have
           already blurred into each other. Small numbers do not work here: at 1.6° the
           corridor was one colour with a fringe. */
        hueoffset: 3.1, saturation: 1.004, value: 1,
      }, { label: "shift1" }),
      /* ADD, not Screen. Screen is `1 − (1 − a)(1 − b)`: it saturates toward white by
         construction, which is fine once but is a ratchet inside a loop — the first build
         used it and the corridor was solid white within four seconds, whatever the fade
         was set to. Add is linear, so the steady state is the ring's height over one minus
         the loop gain, which is a number you can choose. */
      node("born", "add", [260, 60], {}, { label: "born1" }),

      // ---- the look ---------------------------------------------------------------
      node("halo", "blur", [520, 340], { size: 26, filter: "gaussian", extend: "zero" }, { label: "halo1" }),
      node("haze", "level", [780, 340], {
        /* The bloom's own gain. A blur normalises, so adding it back at unity doubles the
           picture's total light; at 0.55 it reads as glow around the rings rather than as
           a second, softer copy of them. */
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 0.5, gamma1: 1, opacity: 1,
      }, { label: "haze1" }),
      node("burn", "add", [1040, 60], {}, { label: "burn1" }),
      node("trim", "level", [1300, 60], {
        /* W5, stated: there is no tone map yet, so an additive bloom over an additive loop
           clips at the encode. This is the hand gain that keeps the crest inside the range,
           and it should come OUT the day an output transform lands. */
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, { label: "trim1" }),
      node("out", "output", [1560, 60], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-punch", ["beat", "out"], ["punch", "in"]),
      edge("e-beat-hit", ["beat", "out"], ["hit", "in"]),
      edge("e-punch-zgain", ["punch", "out"], ["zgain", "a"]),
      edge("e-zgain-zbase", ["zgain", "out"], ["zbase", "a"]),
      edge("e-zbase-zcap", ["zbase", "out"], ["zcap", "in"]),
      edge("e-hit-strike", ["hit", "out"], ["strike", "a"]),
      edge("e-strike-bcap", ["strike", "out"], ["bcap", "in"]),

      edge("e-bore-ring", ["bore", "out"], ["ring", "in1"]),
      edge("e-core-ring", ["core", "out"], ["ring", "in2"]),
      edge("e-ring-paint", ["ring", "out"], ["paint", "source"]),
      edge("e-paint-lamp", ["paint", "out"], ["lamp", "input"]),
      edge("e-hue-paint", ["hue", "out"], ["paint", "lookup"]),

      edge("e-loop-fall", ["loop", "out"], ["fall", "input"]),
      edge("e-fall-fade", ["fall", "out"], ["fade", "input"]),
      edge("e-fade-shift", ["fade", "out"], ["shift", "input"]),
      // in1 is the corridor, in2 is the new ring: Screen is commutative, but the order is
      // still the reading order of the picture and it costs nothing to state it.
      edge("e-shift-born", ["shift", "out"], ["born", "in1"]),
      edge("e-lamp-born", ["lamp", "out"], ["born", "in2"]),

      edge("e-born-halo", ["born", "out"], ["halo", "input"]),
      edge("e-born-burn", ["born", "out"], ["burn", "in1"]),
      edge("e-halo-haze", ["halo", "out"], ["haze", "input"]),
      edge("e-haze-burn", ["haze", "out"], ["burn", "in2"]),
      edge("e-burn-trim", ["burn", "out"], ["trim", "input"]),
      edge("e-trim-out", ["trim", "out"], ["out", "input"]),
    ],
  ),
);

const NAVE_RIBS = 60;
const NAVE_ROUND = 176;

const NAVE_KERNEL = `const TAU: f32 = 6.28318530717958647692;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The grid's two axes become the tunnel's two axes: x goes AROUND the bore, y indexes
     which rib you are on. Nothing else in the kernel knows it started life as a plane. */
  let around = (p.position.x * 0.5 + 0.5) * TAU;
  let rib = p.position.y * 0.5 + 0.5;

  /* ctx.absTime, and this is the whole reason it exists (T489, §V437). The tunnel's motion
     is a POSITION read off a clock — the one shape that snaps at a timeline lap if it reads
     the wrapping one. On the absolute clock the fract() below is continuous forever: the
     ribs keep coming, a lap does nothing, and an hour behind a set is an hour of tunnel.
     Deterministic too: absTime is SECONDS since transport start (the manifest's own
     contract - a reader who takes this for a frame count and retunes 0.052 to match
     reproduces the E35 frozen-clock fault, §V645/§V637), zeroed at render (T467). */
  let depth = fract(rib + ctx.absTime * 0.052);

  /* ctx.value1 is the bass (T479): a value write per frame, never a rebuild (§V5). The bore
     BREATHES on the kick — the whole tunnel widens and settles — which reads at the size a
     projection is watched from, where a colour change does not. */
  let flute = 0.19 * sin(around * 8.0 + ctx.absTime * 0.42);
  let radius = 1.05 + flute + ctx.value1 * 0.62;

  /* Depth 0 sits BEHIND the camera on purpose. A scrolling tunnel has to recycle its ribs
     somewhere, and the recycle is a teleport; putting it behind the eye means the pop
     happens where nobody is looking, instead of as a flash in the middle of the frame. */
  let z = 2.9 - depth * 34.0;
  q.position = vec3f(cos(around) * radius, sin(around) * radius, z);

  /* p.sample is the palette, read off the ramp by the bridge at this point's own grid
     position — so the COLOUR is a gradient in the graph, not a formula in this text. All
     the kernel does is fade it, which is the one thing the ramp cannot know.
     TWO FADES, and the near one is not optional. A quad has a fixed WORLD size, so a rib
     three units from the eye draws as a fistful of blocks; the first build looked like the
     tunnel was made of postage stamps. Fading a rib out as it passes the eye hides the
     recycle AND the blockiness in one term, and it is also just what depth of field and
     atmosphere do to a real corridor. */
  let far = smoothstep(1.0, 0.7, depth);
  let near = smoothstep(2.0, -2.4, z);
  q.sample = vec4f(p.sample.rgb * far * near * (0.7 + ctx.value2 * 1.1), 1.0);
  return q;
}`;

/**
 * E30 — Nave (T503). The audio-and-3D corner, which nothing in the set filled.
 *
 * You are inside a cathedral of light moving toward you: ninety-six fluted ribs of glowing
 * points, receding to a vanishing point, sliding past forever. On the kick the whole bore
 * OPENS — the tunnel widens by half a radius and settles over the beat — and the ribs
 * brighten with it. It is the shot every VJ set has and none of our examples had: E24 is
 * audio and 2D, E25 is 3D and silent, and this is the crossing.
 *
 * ## Everything in this file is a decision about which clock
 *
 * The rib motion is a POSITION read off a clock — `fract(rib + t · 0.052)` — which is
 * exactly the shape that breaks at a loop boundary. On `ctx.time` the whole tunnel would
 * jump back a third of a rib every lap, forever, in the one setting these examples are
 * for. It reads `ctx.absTime` instead (T489/B97), so the scroll is continuous across a lap
 * and an offline render still reproduces, because absolute time is frames-since-transport-
 * start and T467 zeroes it at render (§V44, §V45).
 *
 * Its neighbours own different clocks, and that is §V436 working rather than an
 * inconsistency: `sway1`/`rise1` are LFOs and free-running, so the camera drift also
 * survives a lap; `beat1` is the Audio Pattern and TIMELINE-ANCHORED by design, so bar one
 * lands on the in point and a scrub finds the same beat.
 *
 * ## Where the colour lives, and why it is not in the kernel
 *
 * The obvious way to colour four thousand points is six lines of cosine palette in WGSL,
 * and it would look the same. It is in a Ramp instead, read through `textureToAttribute` at
 * each point's own grid position, because a gradient you can drag stops around in is worth
 * more in a node tool than a gradient you have to recompile — and because the entire reason
 * this example exists is to be OPENED and messed with. The kernel only does the one thing
 * the ramp cannot: fade a rib by how far away it ended up.
 *
 * ## Unlit, and that is not laziness
 *
 * `materialUnlit` with a per-point tint (T478), no lights, and a wide bloom. Points ARE
 * the light here — a lambert response on four thousand tiny quads would just make them
 * grey where they face away, and the shot is a light source rather than a lit object.
 */
const naveDocument = document(
  "e30-nave",
  "E30 Nave",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 30 }),
  graph(
    [
      // ---- the sound ---------------------------------------------------------------
      node("beat", "audioPattern", [-1740, 700], { bpm: 120, amount: 1 }, { label: "beat1" }),
      node("swellEnv", "valueLag", [-1480, 700], { lag: 0.11 }, { label: "swell1" }),
      node("bgain", "valueMath", [-1740, 960], { operation: "multiply", operand: 1.8397 }, { label: "bgain1" }),
      /* T701: the dB-domain pattern rests at 0.712 where the linear one rested at 0.12,
         so the single multiply grew the house bias half — same output range as before,
         read off the new input range. */
      node("bnorm", "valueMath", [-1740, 1180], { operation: "add", operand: -1.2437 }, { label: "bnorm1" }),
      node("bcap", "valueLimit", [-1480, 960], { minimum: 0, maximum: 0.5 }, { label: "bore1" }),
      node("lgain", "valueMath", [-1220, 960], { operation: "multiply", operand: 0.8 }, { label: "lgain1" }),
      node("lcap", "valueLimit", [-960, 960], { minimum: 0.05, maximum: 0.85 }, { label: "lum1" }),

      // ---- the palette, as a gradient rather than as a formula -----------------------
      node("palette", "ramp", [-1740, 40], {
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        /* Read along the RIB index, and since depth is `fract(rib + t)` that is the same
           thing as reading along DEPTH, rotating slowly. One pass of the gradient down the
           shaft, not several: `period: 4` was tried and is worse, because the ramp node
           compresses the gradient into the first quarter rather than tiling it, so the
           whole tunnel came out one blue. Deep indigo through a cold cyan to a hot coral,
           with a near-black notch at 0.86 — the notch is what gives the shaft visible
           SEGMENTS instead of one continuous wash. */
        stops: [
          { position: 0, color: [0.05, 0.03, 0.24, 1] },
          { position: 0.26, color: [0.08, 0.45, 0.85, 1] },
          { position: 0.5, color: [0.25, 0.95, 0.85, 1] },
          { position: 0.7, color: [1, 0.72, 0.3, 1] },
          { position: 0.86, color: [0.02, 0.01, 0.06, 1] },
          { position: 1, color: [0.55, 0.12, 0.7, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),

      // ---- the tunnel ----------------------------------------------------------------
      node("sheet", "pointGrid", [-1480, 340], {
        count: NAVE_RIBS * NAVE_ROUND, cols: NAVE_ROUND, rows: NAVE_RIBS,
      }, { label: "grid1" }),
      node("bridge", "textureToAttribute", [-1220, 160], {
        count: NAVE_RIBS * NAVE_ROUND,
      }, { label: "bridge1" }),
      node("roll", "pointKernel", [-960, 160], {
        capacity: NAVE_RIBS * NAVE_ROUND,
        seed: 30,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
        ]),
        kernel: NAVE_KERNEL,
      }, {
        label: "roll1",
        parameters: {
          value1: drivenSlot("bore1:low", 0.16),
          value2: drivenSlot("lum1:level", 0.28),
        },
      }),

      node("glass", "materialUnlit", [-700, -140], { color: [1, 1, 1, 1] }, { label: "glass1" }),
      node("ribs", "geometry", [-700, 160], {
        mode: "instances", shape: "quad", scale: 0.0092, material: "glass1", tint: [1, 1, 1, 1],
      }, {
        label: "ribs1",
        parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "sample" } } } },
      }),

      // ---- the shot ------------------------------------------------------------------
      node("sway", "lfo", [-960, 440], { shape: "sine", frequency: 0.031, amplitude: 0.34, offset: 0, phase: 0 }, { label: "sway1" }),
      node("rise", "lfo", [-960, 700], { shape: "sine", frequency: 0.023, amplitude: 0.3, offset: 0, phase: 0.25 }, { label: "rise1" }),
      node("eye", "camera", [-440, 160], {
        /* Inside the bore, off the axis by a hair and drifting. Dead centre on the axis is
           a perfectly symmetric frame, and a perfectly symmetric frame has no parallax —
           the tunnel stops reading as a space and starts reading as a target. */
        eye: [0, 0, 2], lookAt: [0, 0, -12], fov: 50, near: 0.05, far: 120, ortho: false,
      }, {
        label: "eye1",
        parameters: {
          "eye.x": drivenSlot("sway1", 0),
          "eye.y": drivenSlot("rise1", 0),
        },
      }),
      node("shot", "render", [-180, 160], {
        scenes: "ribs1", camera: "eye1", lights: "",
        ambientColor: [1, 1, 1, 1], ambientIntensity: 0,
        background: [0.004, 0.005, 0.014, 1],
      }, { label: "shot1" }),

      node("halo", "blur", [80, 420], { size: 20, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haze", "level", [340, 420], {
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 0.7, gamma1: 1, opacity: 1,
      }, { label: "haze1" }),
      node("burn", "add", [600, 160], {}, { label: "burn1" }),
      node("out", "output", [860, 160], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-swell", ["beat", "out"], ["swellEnv", "in"]),
      edge("e-swell-bgain", ["swellEnv", "out"], ["bgain", "a"]),
      edge("e-bgain-bnorm", ["bgain", "out"], ["bnorm", "a"]),
      edge("e-bnorm-bcap", ["bnorm", "out"], ["bcap", "in"]),
      edge("e-swell-lgain", ["swellEnv", "out"], ["lgain", "a"]),
      edge("e-lgain-lcap", ["lgain", "out"], ["lcap", "in"]),

      edge("e-grid-bridge", ["sheet", "out"], ["bridge", "points"]),
      edge("e-palette-bridge", ["palette", "out"], ["bridge", "texture"]),
      edge("e-bridge-roll", ["bridge", "out"], ["roll", "in"]),
      edge("e-roll-ribs", ["roll", "out"], ["ribs", "points"]),

      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-halo-haze", ["halo", "out"], ["haze", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-haze-burn", ["haze", "out"], ["burn", "in2"]),
      edge("e-burn-out", ["burn", "out"], ["out", "input"]),
    ],
  ),
);

const CORONA_POINTS = 65_536;

const CORONA_KERNEL = `
fn lm_hash(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q = q + vec3f(dot(q, q.zyx + 31.32));
  return fract((q.x + q.y) * q.z);
}

fn lm_noise(x: vec3f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(lm_hash(i + vec3f(0.0, 0.0, 0.0)), lm_hash(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let b = mix(lm_hash(i + vec3f(0.0, 1.0, 0.0)), lm_hash(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let c = mix(lm_hash(i + vec3f(0.0, 0.0, 1.0)), lm_hash(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let d = mix(lm_hash(i + vec3f(0.0, 1.0, 1.0)), lm_hash(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z) * 2.0 - 1.0;
}

fn lm_fbm(x: vec3f, oct: i32) -> f32 {
  var v = 0.0; var a = 0.5; var q = x;
  for (var k: i32 = 0; k < oct; k = k + 1) {
    v = v + a * lm_noise(q);
    q = q * 2.03 + vec3f(17.3, 9.1, 4.7);
    a = a * 0.55;
  }
  return v;
}

// Ridged: 1-|n| squared per octave. Creases and filaments instead of blobs.
fn lm_ridged(x: vec3f, oct: i32) -> f32 {
  var v = 0.0; var a = 0.5; var q = x;
  for (var k: i32 = 0; k < oct; k = k + 1) {
    let n = 1.0 - abs(lm_noise(q));
    v = v + a * n * n;
    q = q * 2.07 + vec3f(11.1, 3.3, 7.7);
    a = a * 0.52;
  }
  return v - 0.62;
}

fn lm_rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}
fn lm_rotX(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let t = ctx.absTime;

  // ---- THE SMOOTH PIPE -------------------------------------------------
  // pointgenerator1.radius is the only drivable number that reaches this
  // kernel, so the sphere's radius is the audio's way in: length is divided
  // straight back out and what survives is a continuous 0..1 control.
  //
  // THESE TWO CONSTANTS ARE swell1's BIAS AND GAIN, and they are a SILENT
  // COUPLING (T554). The radius is driven by swell1 = "lowMid x 1.25 + 0.68",
  // so subtracting the bias and dividing by the gain is the only thing that
  // makes a 0..1 band arrive here as a 0..1 control. They were 1.0 and 0.6 -
  // swell1's values from BEFORE T547 lowered the bias to 0.68 - and the
  // mismatch did not warn, it just quietly stopped delivering: MEASURED on
  // the shipped Beat source, damp1:lowMid spans 0.152..0.327, so the radius
  // spans 0.870..1.088 and the old "(inR - 1.0) / 0.6" yielded fromAudio
  // 0.000..0.147 - CLAMPED FLAT AT ZERO for most of every beat. The eight
  // post-processing pairs kept reacting, so the picture still moved and the
  // severed kernel looked like a style choice. Retune swell1 and you MUST
  // retune these in the same commit.
  let pin = p.position;
  let inR = max(1.0e-4, length(pin));
  let fromAudio = clamp((inR - 0.68) / 1.25, 0.0, 1.0);
  // SILENCE HAS TO BE SILENT (T554, V477 in the kernel rather than in the
  // value chain). This was "0.30 + 0.28 * sin(...)": with no audio at all
  // "drive" still sat a third of the way up its range and swept 0.02..0.58
  // over a 67-second cycle, which is most of the lobes-to-filaments
  // crossfade happening on its own. The bias is the rest state, so it comes
  // down to near zero - but not TO zero: a completely frozen rest state is
  // its own failure (V427), and this keeps a slow shimmer under the
  // rotation and the breath while leaving the EXTENT to the audio.
  let drift = 0.05 + 0.04 * sin(t * 0.093);
  let drive = clamp(fromAudio + drift, 0.0, 1.1);

  var s = normalize(pin);

  s = lm_rotY(s, t * 0.13);
  s = lm_rotX(s, t * 0.081);

  // taffy twist: shear grows with drive, very readable on the silhouette
  s = lm_rotY(s, (0.8 + 2.4 * drive) * s.y + t * 0.05);

  let wf = 1.25 + 0.85 * drive;
  let w = vec3f(
    lm_fbm(s * wf + vec3f(0.0, 0.0, t * 0.13), 4),
    lm_fbm(s * wf + vec3f(5.2, 1.3, t * 0.11), 4),
    lm_fbm(s * wf + vec3f(9.1, 7.7, t * 0.15), 4)
  );

  // two fields, crossfaded by drive: soft lobes -> sharp filaments
  let lobes = lm_fbm(s * 1.9 + w * 1.5 + vec3f(0.0, t * 0.20, 0.0), 5);
  let creases = lm_ridged(s * (2.4 + 2.6 * drive) + w * 1.1 - vec3f(t * 0.17, 0.0, 0.0), 5);
  let field = mix(lobes, creases * 1.15, clamp(drive, 0.0, 1.0));

  let ripple = sin(s.y * 6.0 - t * 1.05);
  let breath = 0.05 * sin(t * 0.60) + 0.03 * sin(t * 1.03 + 1.3);
  let amp = 0.24 + 0.32 * drive;

  // T554 — THE EXTENT, and it is the term that was missing. The base here was
  // a CONSTANT 1.0: "drive" moved "amp" and crossfaded lobes into creases, so
  // the audio changed the creature's ROUGHNESS and CHARACTER and its SIZE
  // never moved at all. No retune of the value chain could reach it, because
  // there was nothing in the arithmetic for a retune to scale.
  //
  // Calibrated against the two ends rather than picked: the slope puts a LOUD
  // passage back at the extent the constant 1.0 used to hold permanently, so
  // nothing is lost at the top - the creature still fills the frame when the
  // music is loud, it simply no longer does so in silence. MEASURED (99% of
  // the luminance mass, as a fraction of half-frame-height): silence 0.47,
  // Beat between hits 0.50, Beat on a hit 0.58, a loud passage 0.72. It was
  // 0.71..0.72 at ALL FOUR before.
  let core = 0.55 + 0.62 * drive;
  let rad = core + breath + amp * field + 0.055 * ripple * (0.25 + drive);
  let p3 = s * rad * 0.90;

  let dcam = 4.5;
  let zc = max(0.05, dcam - p3.z);
  let ff = 3.17;
  let aspect = 16.0 / 9.0;

  q.position = vec3f((p3.x * ff / zc) / aspect, p3.y * ff / zc, 0.5);
  q.velocity = vec3f(field, creases, drive);
  return q;
}
`;

/**
 * E31 — Corona (T538, §V471). **The owner's own working file**, adopted as an example and
 * as the definition of the bar.
 *
 * A luminous organism turning in the dark: sixty-five thousand additive points on a sphere
 * that the audio pulls between two entirely different characters. Quiet, it CONTRACTS to a
 * small dim knot of soft lobes breathing. Loud, it throws itself outward and the same
 * points snap into RIDGED FILAMENTS, the silhouette twists like taffy, orange crests light
 * along the fastest creases and a cyan frost picks out only the sharpest. Bloom, a
 * seven-stop grade, trails and a 29-second hue drift sit on top. Nothing about it is subtle
 * and nothing about it is arbitrary.
 *
 * **Read this file before writing another example.** Eight ideas do the work, and none of
 * them is "add more nodes":
 *
 * ## 1. ONE SOURCE, THREE READINGS — and this is the transferable one
 *
 * `drawbase1`, `drawmid1` and `drawtip1` are three `renderPoints` over the SAME point
 * cloud. They differ only in a GROUP PREDICATE, a colour and a size:
 *
 * | | predicate | colour | reads as |
 * | --- | --- | --- | --- |
 * | `drawbase1` | (none — all 65,536) | deep blue | the body |
 * | `drawmid1` | `p.velocity.y > 0.04` | orange | the lit crests |
 * | `drawtip1` | `p.velocity.y > 0.17` | cyan | the sharpest tips only |
 *
 * Structure comes from SELECTION, not from adding elements. Three draws over one
 * simulation give a picture with three depths in it and cost one more node each — where
 * three separate systems would cost three of everything and still not be registered with
 * each other. This is the answer to "more interesting without overloading".
 *
 * ## 2. THE KERNEL WRITES DATA FOR THE SELECTION TO SLICE
 *
 * `q.velocity = vec3f(field, creases, drive)`. Velocity is not velocity here — it is an
 * ATTRIBUTE CARRIER, and `creases` is the ridged-noise field. So `p.velocity.y > 0.17`
 * means "only where the surface is sharply creased". The kernel and the compositing were
 * designed together; the predicates are not a filter bolted on afterwards, they are
 * reading a channel the kernel wrote for them.
 *
 * ## 3. GAIN AND BIAS PER BAND, NOT ONE REACTIVITY KNOB
 *
 * Eight `valueMath` multiply→add pairs, each mapping ONE band to ONE property with its own
 * scale and offset — `high` × 6 + 0.15 into the cyan band's gain is a completely different
 * curve from `level` × 0.30 + 0.62 into the trail persistence, and it has to be. A single
 * master gain makes everything move together, which reads as one thing pumping. One
 * `valueLag` at 0.09 s sits between the audio and all eight, so nothing jitters.
 *
 * SEVEN of the eight land on a post-processing parameter and take effect directly. The
 * eighth, `swell1`, is different in kind and T554 is the bill for not noticing: it drives
 * the point generator's RADIUS, which exists only so the kernel can divide it back out and
 * recover the band. That makes it a TRANSPORT with a decoder at the far end, and a
 * transport whose two constants are duplicated in a WGSL string is a coupling no gate sees.
 *
 * ## 4. LAYERED POST, EACH STAGE DOING ONE JOB
 *
 * bloom (blur 34 → level → add), grade (lookup ← a seven-stop ramp), two highlight
 * screens, feedback trails, hue drift. Five stages, each legible alone, none of them
 * doing two things.
 *
 * ## 5. THE FEEDBACK CLOSES ON THE FINAL OUTPUT
 *
 * `loop1.source` is `tail1` — the very last node — not the raw render. So the trails carry
 * the GRADED, hue-drifted colour, and a trail looks like it belongs to the image rather
 * than like a ghost of an earlier stage.
 *
 * ## 6. A RAMP THAT GOES SOMEWHERE
 *
 * Seven stops: black → near-black navy → blue → purple → red → gold → white. Every shipped
 * example before this used four or five and most of them travelled less far. The grade is
 * why the same three colours read as a hundred.
 *
 * ## 7. THE GRADE ITSELF BREATHES
 *
 * `coat1.scale` is driven by `highMid`, so the whole image slides along the ramp with the
 * music instead of the ramp being a fixed decision.
 *
 * ## 8. THE SLOWEST THING IS SLOWER THAN YOUR ATTENTION SPAN
 *
 * `hue1`'s LFO runs at 0.035 Hz — a 29-second cycle — and swings ±30 degrees on it. It
 * takes BOTH numbers (T574): `lfoValue`'s amplitude is in the driven parameter's units, so
 * a period this slow with a swing too small to see is a cycle nothing travels through.
 * Together they are most of why it does not get boring: at any moment something is
 * changing that you did not notice start.
 *
 * ## What T538 changed, and it is one thing
 *
 * The owner's file bound their own track. Assets are session-only (§V363), so the shipped
 * version puts the deterministic Beat pattern and an empty `audioFileIn` BOTH into a
 * `valueSwitch` (T508) — index 0 plays on open with no asset, index 1 is your file. Same
 * treatment as E24, and for the same reason: two value sources on one port would merge and
 * one of them would silently vanish (§V457).
 *
 * ## What T554 changed: the audio finally moves the creature's SIZE
 *
 * The owner: *"when there's no source input or very low levels I'd expect the corona to
 * collapse further inwards and vice versa."* Three defects, all in the kernel, and none of
 * them reachable by retuning a value node:
 *
 * 1. **The extent was a CONSTANT.** `rad` started from a literal `1.0`. Audio moved `amp`
 *    and crossfaded lobes into creases, so it owned the creature's ROUGHNESS and CHARACTER
 *    and never its SIZE. A `core` term that rests at 0.55 and travels with `drive` is the
 *    missing arithmetic; the slope is set so a loud passage lands where the constant used
 *    to sit, which means the collapse is bought at no cost to the peak.
 * 2. **Silence was not silent.** `drift` was `0.30 + 0.28·sin(t·0.093)`, so with no audio
 *    at all `drive` sat a third of the way up its range and swept a 67-second sine across
 *    most of the lobes→filaments crossfade. That is §V477 — bias is the rest state — living
 *    in a WGSL string rather than in the value chain where T547 could see it. Now
 *    `0.05 + 0.04·sin`: a shimmer, not a performance.
 * 3. **The decoder had drifted off the encoder.** See the kernel comment: T547 lowered
 *    `swell1`'s bias and the kernel kept subtracting the old one, which clamped the Beat
 *    source's contribution flat at zero for most of every beat. Nothing warned, because the
 *    other seven pairs went on reacting and the picture went on moving.
 *
 * The general lesson, and it is why this belongs in the calibration artefact: **a value
 * chain can only retune what the shader already varies.** Before reaching for gains and
 * biases, check that the quantity you want to move is a term in the arithmetic at all.
 *
 * Already clean and deliberately left alone: the kernel reads `ctx.absTime`, so the
 * rotation survives a timeline lap, and the LFO is free-running (§V436, B98).
 */
const coronaDocument = document(
  "e31-corona",
  "E31 Corona",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 1, previewFps: 20 }),
  graph(
    [
      // ---- the sound: pattern or your track, exclusively (T504's shape) ------------
      node("beat", "audioPattern", [-1800, 700], { bpm: 124, amount: 1 }, { label: "beat1" }),
      node("track", "audioFileIn", [-1800, 980], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-1520, 840], { index: 0 }, { label: "source1" }),
      /* ONE Lag for all eight mappings. The bands are already noisy; smoothing once at the
         source means every driven property agrees about what "now" is. */
      node("damp", "valueLag", [-1240, 840], { lag: 0.09 }, { label: "damp1" }),

      /* EIGHT multiply -> add PAIRS, one band to one property, each with its own gain and
         bias. This is §V471's third idea and it is the difference between a reactive image
         and an image that pumps: a single master gain moves everything together. */
      /* T547 (§V477) — THE BIAS IS THE REST STATE, THE GAIN IS THE SWING, and the owner's
         file biased every pair INTO the interesting part of its range, so there was nowhere
         to go but up. The bias here was +1.0: rest radius 1.0 is already the full sphere, so
         there was no contracted state to expand FROM and the audio could only ever add.
         0.68 rest / 1.93 peak gives the creature somewhere to come back to, which is what
         makes the expansion read as an expansion rather than as jitter on a still image. */
      node("swellG", "valueMath", [-960, 520], { operation: "multiply", operand: 3.724 }, { label: "swellg1" }),
      node("swell", "valueMath", [-700, 520], { operation: "add", operand: -1.1733 }, { label: "swell1" }),
      node("glowG", "valueMath", [-960, 780], { operation: "multiply", operand: 6.0207 }, { label: "glowg1" }),
      node("glow", "valueMath", [-700, 780], { operation: "add", operand: -3.6202 }, { label: "glow1" }),
      node("dotG", "valueMath", [-960, 1040], { operation: "multiply", operand: 2.2 }, { label: "dotg1" }),
      node("dot", "valueMath", [-700, 1040], { operation: "add", operand: 1.2 }, { label: "dot1" }),
      node("heatG", "valueMath", [-960, 1300], { operation: "multiply", operand: 7.3587 }, { label: "heatg1" }),
      node("heat", "valueMath", [-700, 1300], { operation: "add", operand: -4.7247 }, { label: "heat1" }),
      /* T547 asked whether ×20 was deliberate. It was not: on the Beat source `high` rests
         around 0.2, so ×20 rested at 4 and the Limit below PINNED at its ceiling on every
         loud frame — the cyan band was in blast mode permanently, which is §V477 stated as
         a symptom. ×6 rests near 0.5 and travels to ~3, and the Limit goes back to being a
         fence for a real track rather than the thing setting the level. */
      node("sparkG", "valueMath", [-440, 520], { operation: "multiply", operand: 6.9825 }, { label: "sparkg1" }),
      node("sparkAdd", "valueMath", [-180, 520], { operation: "add", operand: -2.1476 }, { label: "sparkadd1" }),
      /* THE THIRD FENCE, and the pair above is why it has to exist. A gain of 20 is the
         right sensitivity — `high` is a small channel and the cyan tips are the faintest
         thing in the frame, so a quiet passage still has to light them — but ×20 + 0.1 over
         a 0..1 band spanned 0.1..20.1 against a Brightness declared 0..8. §V471's third idea
         (gain and bias per band) is right and INCOMPLETE: the pair has to be range-checked
         against its TARGET, or the idiom ships a clamp. Two fences, E24's shape: the Limit
         holds the value in the graph where you can see it, and T368's clamp is the backstop
         rather than the mechanism. */
      node("spark", "valueLimit", [80, 520], { minimum: 0.05, maximum: 5 }, { label: "spark1" }),
      /* T547 — "colors down, not always in blast mode", and the number is the BIAS again.
         Rest scale was 1.4, which drives the lookup coordinate far up a seven-stop ramp that
         ENDS IN WHITE: the palette sat permanently at its hot end, so a peak had nowhere to
         climb to and the seven stops might as well have been two. Resting near 0.85 puts the
         calm state in the navy and blue and lets a loud passage reach the gold — which is
         §V471's sixth idea finally doing something. */
      node("gradeG", "valueMath", [-440, 780], { operation: "multiply", operand: 4.1815 }, { label: "gradeg1" }),
      node("grade", "valueMath", [-180, 780], { operation: "add", operand: -1.5173 }, { label: "grade1" }),
      /* T538 FOLLOW-UP: this gain was 0.95 in the owner's file, which put persistence at
         0.62..1.57 against a range of 0..1 — so it raised a `parameter.range` problem on any
         moderately loud passage, and T368's clamp was the only thing standing between the
         piece and PERSISTENCE 1.0, which is perfect accumulation: an image that never
         decays. Retuning to 0.30 is a better LOOK, not a compromise for a warning: it keeps
         "louder means longer trails" and tops out at 0.92, where a trail still ends. */
      node("trailG", "valueMath", [-440, 1040], { operation: "multiply", operand: 0.3 }, { label: "trailg1" }),
      node("trail", "valueMath", [-180, 1040], { operation: "add", operand: 0.62 }, { label: "trail1" }),
      node("tipG", "valueMath", [-440, 1300], { operation: "multiply", operand: 10.4737 }, { label: "tipg1" }),
      node("tip", "valueMath", [-180, 1300], { operation: "add", operand: -2.4465 }, { label: "tip1" }),

      // ---- the body ----------------------------------------------------------------
      /* `radius` is the ONLY drivable number that reaches a point kernel, so the owner used
         it as the audio's way in: lowMid maps to radius 0.68..1.93, the kernel divides the
         length straight back out, and what survives is a 0..1 CONTROL rather than a scale.
         T554 NOTE: because the kernel un-does this mapping exactly, this pair is a pure
         TRANSPORT — its gain and bias cancel and cannot change the look. Every extent and
         character decision lives in the kernel. What the pair still owes is the range check
         (it drives a declared parameter) and AGREEMENT with the kernel's two constants. */
      node("gen", "pointGenerator", [-1240, 0], {
        shape: "sphere", cols: 256, rows: 256, count: CORONA_POINTS,
        radius2: 0.25, sizeX: 2, sizeY: 2, sizeZ: 2,
      }, {
        label: "gen1",
        parameters: { radius: drivenSlot("swell1:lowMid", 1.2) },
      }),
      node("shape", "pointKernel", [-960, 0], {
        capacity: CORONA_POINTS, seed: 7, attributes: "", group: "",
        kernel: CORONA_KERNEL,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "shape1" }),

      // ---- ONE cloud, THREE readings (§V471.1) --------------------------------------
      node("drawBase", "renderPoints", [-700, -240], {
        count: CORONA_POINTS, blend: "additive", accumulate: false,
        color: [0.17, 0.27, 0.54, 1], group: "",
      }, {
        label: "drawbase1",
        parameters: { sizePixels: drivenSlot("dot1:level", 1.4) },
      }),
      node("drawMid", "renderPoints", [-700, 20], {
        count: CORONA_POINTS, blend: "additive", accumulate: false,
        color: [1, 0.42, 0.1, 1], sizePixels: 1.3,
        /* The kernel wrote `creases` into velocity.y (§V471.2), so this predicate reads
           "only where the surface is creased" — a selection on SHAPE, not on position. */
        group: "p.velocity.y > 0.04",
      }, { label: "drawmid1" }),
      node("drawTip", "renderPoints", [-700, 280], {
        count: CORONA_POINTS, blend: "additive", accumulate: false,
        color: [0.1, 0.85, 1, 1], group: "p.velocity.y > 0.17",
      }, {
        label: "drawtip1",
        parameters: { sizePixels: drivenSlot("tip1:high", 1.4) },
      }),

      node("base", "null", [-440, -240], {}, { label: "base1" }),
      node("heatLvl", "level", [-440, 20], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "heatlvl1", parameters: { brightness: drivenSlot("heat1:low", 0.8) } }),
      node("sparkLvl", "level", [-440, 280], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "sparklvl1", parameters: { brightness: drivenSlot("spark1:high", 0.6) } }),

      // ---- the post, one job per stage (§V471.4) -------------------------------------
      node("halo", "blur", [-180, -480], { size: 34, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haloLvl", "level", [80, -480], {
        blacklevel: 0.01, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "halolvl1", parameters: { brightness: drivenSlot("glow1:low", 1.1) } }),
      node("burn", "add", [340, -240], {}, { label: "burn1" }),
      node("palette", "ramp", [340, 20], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* SEVEN stops, and they travel (§V471.6): black, a near-black navy, blue, purple,
           red, gold, white. The grade is why three colours read as a hundred. */
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.1, color: [0.01, 0.02, 0.07, 1] },
          { position: 0.3, color: [0.06, 0.13, 0.42, 1] },
          { position: 0.52, color: [0.48, 0.09, 0.64, 1] },
          { position: 0.72, color: [0.98, 0.26, 0.22, 1] },
          { position: 0.89, color: [1, 0.74, 0.3, 1] },
          { position: 1, color: [1, 0.98, 0.93, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("coat", "lookup", [600, -240], {
        channel: "luminance", row: 0.5, offset: 0,
      }, { label: "coat1", parameters: { scale: drivenSlot("grade1:highMid", 1.6) } }),
      node("liftHeat", "screen", [860, -240], {}, { label: "liftheat1" }),
      node("liftSpark", "screen", [1120, -240], {}, { label: "liftspark1" }),
      /* THE TRAILS CLOSE ON THE FINAL OUTPUT (§V471.5), not on the raw render: `tail1` is
         the last node, so what smears is the GRADED, hue-drifted picture. A trail taken
         from an earlier stage looks like a ghost of something else. */
      node("loop", "feedback", [1120, 60], {
        source: "tail1", clearColor: [0, 0, 0, 1], reset: false, substeps: 1,
      }, { label: "loop1", parameters: { persistence: drivenSlot("trail1:level", 0.9) } }),
      node("mixTrail", "screen", [1380, -240], {}, { label: "mixtrail1" }),
      /* 0.035 Hz — a 29-SECOND cycle (§V471.8). The slowest thing in the piece is slower
         than the viewer's attention span, which is most of why an hour of it is watchable.
         Free-running (§V436, B98), so a timeline lap does not restart the drift.

         T574 — AND THE AMPLITUDE IS IN THE TARGET'S UNITS, which is what this file got
         wrong for four rounds. `lfoValue` returns `offset + amplitude·wave` in whatever
         the DRIVEN PARAMETER measures, and `hue1.hueoffset` is DEGREES on a -180..180
         range. So the old `0.35` swung ±0.35 DEGREES — a tenth of a percent of a turn —
         while the .md claimed the drift was most of why the piece does not get boring.
         The period was always right; the travel was ~100x short and no test could see it
         (§T575: the range checker reads an LFO as a default 0..1 span, not its real one,
         so this one is checked BY EYE).

         30 is 30 degrees either side — 60 PEAK-TO-PEAK, a sixth of the wheel. Calibrated
         against E32-Pasture, which runs 24 on this identical `drift1 -> hueoffset` shape
         and reads as genuinely travelling: a quarter more than Pasture, which suits Corona
         being the more colour-forward piece, and nowhere near a rainbow cycle. The palette
         should be somewhere else than it was a moment ago, not somewhere ELSE ENTIRELY. */
      node("drift", "lfo", [1380, 60], { shape: "sine", frequency: 0.035, amplitude: 30, offset: 0, phase: 0 }, { label: "drift1" }),
      node("hue", "hsv", [1640, -240], { saturation: 1.12, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      node("tail", "null", [1900, -240], {}, { label: "tail1" }),
      node("out", "output", [2160, -240], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-source", ["beat", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-damp", ["source", "out"], ["damp", "in"]),
      edge("e-damp-swellg", ["damp", "out"], ["swellG", "a"]),
      edge("e-swellg-swell", ["swellG", "out"], ["swell", "a"]),
      edge("e-damp-glowg", ["damp", "out"], ["glowG", "a"]),
      edge("e-glowg-glow", ["glowG", "out"], ["glow", "a"]),
      edge("e-damp-dotg", ["damp", "out"], ["dotG", "a"]),
      edge("e-dotg-dot", ["dotG", "out"], ["dot", "a"]),
      edge("e-damp-heatg", ["damp", "out"], ["heatG", "a"]),
      edge("e-heatg-heat", ["heatG", "out"], ["heat", "a"]),
      edge("e-damp-sparkg", ["damp", "out"], ["sparkG", "a"]),
      edge("e-sparkg-sparkadd", ["sparkG", "out"], ["sparkAdd", "a"]),
      edge("e-sparkadd-spark", ["sparkAdd", "out"], ["spark", "in"]),
      edge("e-damp-gradeg", ["damp", "out"], ["gradeG", "a"]),
      edge("e-gradeg-grade", ["gradeG", "out"], ["grade", "a"]),
      edge("e-damp-trailg", ["damp", "out"], ["trailG", "a"]),
      edge("e-trailg-trail", ["trailG", "out"], ["trail", "a"]),
      edge("e-damp-tipg", ["damp", "out"], ["tipG", "a"]),
      edge("e-tipg-tip", ["tipG", "out"], ["tip", "a"]),

      edge("e-gen-shape", ["gen", "out"], ["shape", "in"]),
      edge("e-shape-base", ["shape", "out"], ["drawBase", "points"]),
      edge("e-shape-mid", ["shape", "out"], ["drawMid", "points"]),
      edge("e-shape-tip", ["shape", "out"], ["drawTip", "points"]),

      edge("e-base-null", ["drawBase", "out"], ["base", "in"]),
      edge("e-mid-heatlvl", ["drawMid", "out"], ["heatLvl", "input"]),
      edge("e-tip-sparklvl", ["drawTip", "out"], ["sparkLvl", "input"]),

      edge("e-null-halo", ["base", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-null-burn", ["base", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),
      edge("e-burn-coat", ["burn", "out"], ["coat", "source"]),
      edge("e-palette-coat", ["palette", "out"], ["coat", "lookup"]),
      edge("e-coat-liftheat", ["coat", "out"], ["liftHeat", "in1"]),
      edge("e-heatlvl-liftheat", ["heatLvl", "out"], ["liftHeat", "in2"], 0),
      edge("e-liftheat-liftspark", ["liftHeat", "out"], ["liftSpark", "in1"]),
      edge("e-sparklvl-liftspark", ["sparkLvl", "out"], ["liftSpark", "in2"], 0),
      edge("e-liftspark-mixtrail", ["liftSpark", "out"], ["mixTrail", "in1"]),
      edge("e-loop-mixtrail", ["loop", "out"], ["mixTrail", "in2"], 0),
      edge("e-mixtrail-hue", ["mixTrail", "out"], ["hue", "input"]),
      edge("e-hue-tail", ["hue", "out"], ["tail", "in"]),
      edge("e-tail-out", ["tail", "out"], ["out", "input"]),
    ],
  ),
);

/* ═══ E32 — PASTURE (T621) ═══════════════════════════════════════════════════════════
 *
 * THE FIRST EXAMPLE IN THE CATALOGUE WHERE THE POINTS WRITE THE FIELD THAT STEERS THEM.
 *
 * Everything shipped before this is one-directional. E24 is a field that makes a picture;
 * E16 and E31 are points that make a picture. No example lets the two halves talk. Here
 * they are one system, and the cycle is the whole idea:
 *
 *     herd1 (agents) ─► sow1 (draw into a 640x360 texture) ─► sowin1 ─► pack1
 *          ▲                                                              │
 *          │                                          state1 ◄────────────┘  (by name)
 *          │                                             │
 *          └── herd1.field ◄─ smell1 (blur) ◄─ rd1 (Gray-Scott) ◄┘
 *
 * As a sentence: the animals DEPOSIT where they walk, the deposit REACTS, and the reaction
 * is what the animals smell on the next lap. The middle step is what keeps this from being
 * a Physarum clone. A Physarum trail only blurs and decays, so the picture can never be
 * more than the paths that were walked. A Gray-Scott deposit SPOTS, BRANCHES and MITOSES
 * on its own — a trail the herd laid twenty seconds ago is still inventing structure while
 * the herd is somewhere else entirely, and the herd then comes back and eats it.
 */
const PASTURE_AGENTS = 5_000;

/**
 * SEMANTICS OF THE SCHEMA, because three of these four numbers are read by nodes that are
 * not this kernel (§V471.2 — the kernel WRITES data for downstream selection):
 *
 *   position  clip space, z unused. The renderer splats at `position.xy` directly and
 *             `fieldAt` maps the same xy to the field's texels (T477/T512), so ONE
 *             coordinate system spans the herd, the picture and the simulation.
 *   velocity  the heading, as a unit vector in SCREEN units. Not a velocity in the E16
 *             sense — there is no inertia here; an animal turns and walks.
 *   graze.x   FED: a short lag of the reaction rate under its feet. `graze1` draws these.
 *   graze.y   FAMINE: seconds since the last mouthful, over a six-second scale. `scout1`
 *             draws these AND the kernel reads it back as its own exploration policy.
 *   graze.z   FOUND: 1 on the step a long-starved animal eats, decaying after. `find1`
 *             draws these — the pioneers, marking where the colony is about to be.
 *   graze.w   the grazer's SIZE in pixels, so `graze1` maps sprite size per point (T286)
 *             instead of taking one number for the whole layer.
 */
const PASTURE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "graze", type: "vec4f", default: [0, 0, 0, 0] },
]);

const PASTURE_KERNEL = `/* A clip unit is 640 px across x and 360 px across y on this 16:9 frame, so every
   displacement is squashed in x to make walking ISOTROPIC ON SCREEN. One constant, and it
   is the only thing in this kernel that knows the output's shape. */
const PX: vec2f = vec2f(0.5625, 1.0);
/* The pasture, in clip space: the same disc \`bowl1\` cuts out of the chemistry map, and the
   ONE number stated in two coordinate systems in this file. bowl1.center is uv with v DOWN;
   this is clip with y UP, so (0.40, 0.54) uv is (-0.20, -0.08) clip (T512's mapping,
   uv.y = 0.5 - y*0.5). Move one and move the other. There is deliberately NO radius here to
   match \`bowl1\`'s: an animal does not know the shape of the coastline, only that it is
   hungry and which way the middle is. Which side of the coast it is standing on it finds out
   by starving. */
const HOME: vec2f = vec2f(-0.2, -0.08);
/* T657: 0.60, where it was 0.42. The roost's circuit is the piece's disturbance and the
   outskirts were outside it — a lattice is what a Gray-Scott field does when nothing
   arrives to disturb it, and nothing did. A wider circuit sweeps the grazed clearing
   through most of the pasture over its 83-second lap, so a region that is lattice now was
   torn open a minute ago and will be again. This is the half of the fix that MOVES; the
   chemistry gradient is the half that VARIES. */
const RANGE: f32 = 0.60;

/* WHAT AN ANIMAL SMELLS: the reaction RATE, not a concentration. U*V*V is Gray-Scott's own
   reaction term, and it is largest exactly on a GROWING front — zero in empty plate (V=0)
   and small inside a saturated blob (U already eaten). Steering on it puts the herd on the
   living edge and nowhere else, which is why the swarm never piles onto a dead spot and
   never has to be told not to. The field arrives BLURRED (\`smell1\`): fieldAt is a
   textureLoad, NEAREST and unfiltered by construction (§V57), and a Gray-Scott V is
   near-binary (§V427), so an unblurred difference of it is mostly quantisation. */
fn forage(spot: vec2f) -> f32 {
  let f = fieldAt(vec3f(spot, 0.0));
  return f.r * f.g * f.g;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T510: firstRun is 1u on exactly the dispatches whose storage was just created or
     cleared — the seeding signal, and the only honest one (frameIndex == 0 is a timeline
     lap, not a fresh buffer). Scatter once, deterministically: pointRand is a hash of the
     identity, not a stream, so the same seed lays the same herd on any device (§V45). */
  if (ctx.firstRun == 1u) {
    /* ON THE PASTURE, not across the frame. A uniform scatter walks a fifth of the herd
       through the dead ground before the spring gathers it, and every one of them seeds a
       spot out there that then persists for the rest of the run — measured: the first build
       to get this far had the empty four fifths covered in stray colonies laid in the first
       two seconds. sqrt() on the radius is what makes the disc UNIFORM rather than
       centre-heavy; without it the middle is seeded four times as hard as the rim. */
    let a = pointRand(ctx.index, 37u) * 6.2831853;
    let r = sqrt(pointRand(ctx.index, 11u)) * 0.8;
    let h = pointRand(ctx.index, 23u) * 6.2831853;
    q.position = vec3f(HOME + vec2f(cos(a), sin(a)) * r * PX, 0.0);
    q.velocity = vec3f(cos(h), sin(h), 0.0);
    q.graze = vec4f(0.0, 0.0, 0.0, 0.0);
    return q;
  }

  let pos = q.position.xy;
  let dir = normalize(select(vec2f(1.0, 0.0), q.velocity.xy, dot(q.velocity.xy, q.velocity.xy) > 1e-8));
  let nrm = vec2f(-dir.y, dir.x);

  /* THREE SENSORS, not a finite difference — and this is the cheaper of the two ways to
     get a direction out of a field. The alternative is to make the reaction shader encode
     its own gradient into spare channels, and there are none spare (b is the chemistry
     map, a is the kernel's initialised flag), so it would cost a second full-field pass:
     230 400 texels. Three taps per animal costs 72 000 loads for the whole herd — a third
     of that, with no extra node and no channel budget. Sensing scales with the HERD; a
     field encoding scales with the FIELD, and the field is the bigger of the two.
     ctx.value2 is the audio on the reach: the hats make the herd look further ahead. */
  let reach = ctx.value2;
  let sway = 0.62;
  let leftDir = dir * cos(sway) + nrm * sin(sway);
  let rightDir = dir * cos(sway) - nrm * sin(sway);
  let ahead = forage(pos + dir * reach * PX);
  let left = forage(pos + leftDir * reach * PX);
  let right = forage(pos + rightDir * reach * PX);

  /* A FIXED TURN TOWARD THE BETTER SIDE — Physarum's rule — and NOT a proportional
     controller on (left - right)/total, which is what this kernel had for six builds and
     which measured as doing nothing at all. The reason is worth keeping: a gain small
     enough that a saturated sensor does not spin the animal is also too small to turn it
     onto a feature ten pixels wide before it has walked past. ABLATION, at gain 3.6: the
     reaction rate under the herd was 1.56x the pasture's average with steering on and
     1.71x with the term deleted entirely. A term you can delete without the measurement
     moving is not a mechanism, however good the sentence describing it is.
     The 1e-4 guard is the other half: on bare ground all three sensors read zero, the
     comparison is meaningless, and an animal that turns on noise never travels. */
  var steer = 0.0;
  if (max(left, right) > ahead + 1e-4) {
    steer = select(-9.5, 9.5, left > right);
  }

  /* HUNGER RANDOMISES, and this is the line that makes \`graze.y\` a POLICY rather than a
     colour. A fed animal walks its front; a starving one loses the plot and random-walks,
     which is the only thing in the file that ever finds the NEXT colony. The picture reads
     the same number as "scouts", so what you see streaming out of the cluster is literally
     the search. The gain is 2.4 and not 7: at 7 a starved animal spins fast enough that it
     cannot hold a heading long enough to follow a gradient at all, so hunger became a TRAP
     — measured, the starving fraction saturated at famine 1.0 and never recovered, and the
     "found" caste below rendered nothing, ever. Exploration has to stay navigable. */
  steer = steer + (pointRand(ctx.index, 5u) - 0.5) * (0.45 + 2.4 * q.graze.y);

  /* E16's spring — but keyed to HUNGER rather than to distance, and that one change is
     what stops the picture being a circle. A distance spring draws a disc: every animal is
     equally pulled wherever it is, so the flock fills a round region whatever the field is
     doing underneath it, and the pasture's shape stops mattering. Gated on famine instead,
     a WELL-FED animal is not homing at all — it stays where the food is — and only an
     animal that has gone hungry turns back toward the middle. The flock's outline is
     therefore drawn by the FOOD, it migrates as it eats a region down, and E16's sentence
     still holds: the murmuration never abandons the sphere. The second term is the frame's
     fence and nothing else: past 0.95 of a half-height from home, everything turns back. */
  /* WHERE HOME IS THIS MINUTE. A fixed spring has a FIXED POINT, and a flock sitting on
     its own fixed point eats one spot to the ground and stays there forever — measured, a
     blown-out core in the same place at frames 300, 900 and 1500 with the rest of the
     pasture untouched. §V532 is the same sentence about an expanding loop; this is the herd
     saying it. So the roost walks a slow circle: ctx.value4 is an 83-second SAW on an
     ANGLE, which is the one wave whose wrap is continuous once you take its cosine, and the
     flock makes a circuit of its range, grazing it down behind and finding it regrown by
     the time it comes round again. It is the piece's longest cycle and it is in the
     ANIMALS, not in the grade. */
  let home = HOME + vec2f(cos(ctx.value4), sin(ctx.value4)) * RANGE * PX;
  let toHome = (home - pos) / PX;
  let away = length(toHome);
  let sinHome = (dir.x * toHome.y - dir.y * toHome.x) / max(away, 1e-5);
  steer = steer + sinHome * (5.5 * q.graze.y + 9.0 * smoothstep(0.8, 1.2, away));

  /* §V481(b) ON THE HERD, which is the half of that invariant nobody had a place to put.
     An envelope on the turn rate is a DC term: it bends every animal the same way for as
     long as it is up, which is a drift, not an event. A beat arrives as an ANGLE instead —
     one frame, a different kick per animal — and because the HEADING IS STATE the swarm
     carries the consequence for seconds afterwards. It is E24's seeded plate said in the
     other half of the loop: the impulse is instant and the consequence is not. It is an
     ANGLE and not a rate, and deliberately NOT multiplied by ctx.delta: a trigger has no
     duration, so scaling it by time would be scaling an event by how long it did not last
     (§V509). */
  let burst = (pointRand(ctx.index, 9u) - 0.5) * ctx.value3;

  let ang = atan2(dir.y, dir.x) + steer * ctx.delta + burst;
  let walk = vec2f(cos(ang), sin(ang));
  var nextPos = pos + walk * ctx.value1 * ctx.delta * PX;
  /* A fence, not a mechanism — the spring above is what actually holds the herd. Anything
     that reaches this has been pushed by a burst on the far side of the frame. */
  nextPos = clamp(nextPos, vec2f(-1.02), vec2f(1.02));

  q.velocity = vec3f(walk, 0.0);
  q.position = vec3f(nextPos, 0.0);

  /* WHAT THE ANIMAL KNOWS ABOUT ITSELF — three numbers the picture then slices on. */
  /* THE GAIN IS MEASURED, not chosen: over the blurred field the reaction rate is 0 at the
     median and 0.136 at the ninth decile, so x14 saturates on roughly the richest tenth of
     the pasture and reads zero on the half of it that is bare. */
  let meal = clamp(forage(nextPos) * 14.0, 0.0, 1.0);
  /* A SHORT lag, 1/12 s — long enough to smooth the crossing of a single texel, short
     enough to actually REACH what it is tracking. At 1/5 s it never did: an animal crosses
     a front in about six frames, the lag only closes 8% of the gap per frame, and the value
     equilibrated near the duty cycle instead of near the value — measured, it never passed
     0.45 for any animal in the herd, so every threshold above it was dead. */
  let fed = q.graze.x + (meal - q.graze.x) * clamp(ctx.delta * 12.0, 0.0, 1.0);
  /* FAMINE RESETS ON A PROPER MOUTHFUL, NOT ON A BRUSH PAST ONE, and that
     one number is the difference between a live mechanism and a decorative attribute.
     Reset at 0.20 and every animal brushes enough structure to keep its clock at zero: the
     scout caste renders ONE sprite in the whole frame and the hunger term in the steering
     above multiplies by zero — an idea the file states and never delivers, which is the
     exact failure §V471.8 records in Corona's hue drift. Measured at both settings. */
  let famine = select(min(1.0, q.graze.y + ctx.delta / 1.6), 0.0, fed > 0.45);
  let found = select(0.0, 1.0, q.graze.y > 0.20 && fed > 0.40);
  /* .w is the grazer's own size in pixels: a per-point pscale (T286), so \`graze1\` is not
     one sprite size for a whole layer but every animal drawn at how much it is eating. */
  /* T671: the decay was 0.8 and is now 0.45. \`found\` is a hard threshold and the caste
     that reads it (\`find1\`, group p.graze.z > 0.30) POPS when a point dithers across the
     line — E34's lesson in the other example, that a binary verdict wants a slower state
     under it rather than a filter over the picture. 2.2 s instead of 1.25 s keeps a point
     on one side long enough to stop flickering, and the caste still empties. */
  q.graze = vec4f(fed, famine, max(found, q.graze.z * exp(-ctx.delta * 0.45)), 0.7 + 1.4 * fed);
  return q;
}`;


/**
 * THE REACTION. It is E2's kernel in shape — a nine-tap Laplacian and two coupled rate
 * equations, with the feed/kill pair read PER PIXEL out of the state's blue channel — and
 * it is NOT E2's kernel, for two measured reasons.
 *
 * ## 1. THE BAND, and the correction it forced
 *
 * §V474 says the HIGH corner of a Gray-Scott feed/kill band is spots and mitosis and the
 * LOW corner is the labyrinth, and E2's own docstring says both ends stay alive. Both are
 * claims about E2's SPECIFIC constants and neither survives being pointed at. MEASURED, by
 * driving E2's band with a horizontal 0..1 ramp and running 4800 steps: the imported band
 * is DENSE WORMS at 0, OPEN WORMS at 1, and labyrinth at every point between. There is no
 * spot regime in it and, more to the point here, NO DEAD CORNER — so an example that wants
 * empty field cannot get it by pushing E2's coordinate to either end. E24's black four
 * fifths comes from its colour inversion, not from a chemistry that stopped.
 *
 * (The arithmetic that made both claims look safe is also wrong, and worth naming so the
 * next person does not redo it: F >= 4(F+k)^2 is the condition for a non-trivial
 * HOMOGENEOUS steady state, and Gray-Scott's whole interesting region — self-replicating
 * spots included — lives OUTSIDE it. A pattern is not a fixed point.)
 *
 * So this band is chosen against Pearson's map rather than inherited, and it travels:
 *   chemistry 0.0  ->  F 0.037, k 0.060   dense worms, the pasture at its richest
 *   chemistry 0.5  ->  F 0.0205, k 0.069  self-replicating spots — trails that MITOSE
 *   chemistry 1.0  ->  F 0.004, k 0.078   dead: no feed to grow on, and V starves out
 * which is the range the example needs, because "a trail can branch and divide on its own"
 * is the sentence that separates this from a Physarum clone, and "there is empty field to
 * walk across" is the one that separates it from a carpet.
 *
 * ## 2. THE PLATE STARTS EMPTY, because the herd is the seed
 *
 * E2 answers a cleared pair with a sprinkled starting plate. Here that would be the one
 * thing in the file the herd did not do. Alpha below 0.5 still means "history is gone" and
 * still re-seeds — with U = 1 and V = 0, a field full of food and nothing growing in it —
 * so a reset is a bare pasture and EVERY structure on screen from then on was deposited by
 * an animal. It also makes the coupling test trivial to state: turn the herd off and the
 * frame stays empty forever.
 */
const PASTURE_REACTION_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

const FEED_LOW: f32 = 0.037;
const KILL_LOW: f32 = 0.0600;
const FEED_HIGH: f32 = 0.002;
const KILL_HIGH: f32 = 0.0860;

const DIFFUSE_U: f32 = 0.2097;
const DIFFUSE_V: f32 = 0.105;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(inputTexture));

  let centre = textureSample(inputTexture, inputSampler, uv);
  let west = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, 0.0)).rg;
  let east = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, 0.0)).rg;
  let south = textureSample(inputTexture, inputSampler, uv + vec2f(0.0, -texel.y)).rg;
  let north = textureSample(inputTexture, inputSampler, uv + vec2f(0.0, texel.y)).rg;
  let sw = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, -texel.y)).rg;
  let se = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, -texel.y)).rg;
  let nw = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, texel.y)).rg;
  let ne = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, texel.y)).rg;

  // b is a 0..1 coordinate the GRAPH paints per pixel; the band it walks is above.
  let chemistry = clamp(centre.b, 0.0, 1.0);
  let feed = mix(FEED_LOW, FEED_HIGH, chemistry);
  let kill = mix(KILL_LOW, KILL_HIGH, chemistry);

  let state = centre.rg;
  let laplacian =
    ((west + east + south + north) * 0.2) + ((sw + se + nw + ne) * 0.05) - state;

  let reaction = state.x * state.y * state.y;
  let stepped = clamp(
    vec2f(
      state.x + ((DIFFUSE_U * laplacian.x) - reaction + (feed * (1.0 - state.x))),
      state.y + ((DIFFUSE_V * laplacian.y) + reaction - ((kill + feed) * state.y)),
    ),
    vec2f(0.0),
    vec2f(1.0),
  );

  // alpha < 0.5 == the pair was cleared: a BARE pasture, not a seeded plate.
  let next = select(vec2f(1.0, 0.0), stepped, centre.a >= 0.5);
  return vec4f(next, 0.0, 1.0);
}`;

/**
 * E32 — Pasture (T621).
 *
 * ## What is inherited, named
 *
 * FROM E16-MURMURATION: local rules producing global structure. The herd has no neighbour
 * reads and no global plan — three field samples, a random turn scaled by hunger, and one
 * weak spring toward home (E16's, verbatim in intent). Everything that looks like a
 * decision in this frame is those four lines meeting a field.
 *
 * FROM E31-CORONA (§V471, the calibration file): ONE CLOUD READ FOUR WAYS by group
 * predicate on kernel-written attributes (.1/.2), and one of the four is not a picture at
 * all — `sow1` is the simulation's INPUT. Gain and bias per band (.3), nine of them, each
 * one band to one property, with the bias as the rest state and the gain as the swing
 * (§V477). A ramp that goes somewhere (.6). A long cycle (.8) — and note that §V471.8 is
 * marked INERT in Corona itself because `lfoValue` returns `offset + amplitude*wave` in the
 * TARGET's units and 0.35 on a degrees parameter is a tenth of a percent of a turn. The
 * amplitude here is 24, which is 24 degrees, which travels.
 *
 * FROM E24: the field as a living substrate with real REGIMES rather than one chemistry
 * everywhere (§V474 — the HIGH corner of the feed/kill band is spots and mitosis, and that
 * is where empty field lives), and the off-centre composition (§V532). The reaction shader
 * is E2's, imported rather than re-derived.
 *
 * ## Where the audio goes, and the answer is BOTH HALVES
 *
 * Five of the nine driven properties are inside the simulation and four are on the picture.
 * On the herd: `pace1` is walking speed, `reach1` is how far ahead an animal smells, and
 * `burst1` is a scatter angle on the raw trigger. On the field: `drop1` is how much
 * chemistry a footstep leaves, `warm1` walks the chemistry map's white point through the
 * feed/kill band so whole regions change regime. Only then the picture: `grade1` on the
 * palette scale, `spark1` on the pioneers' size, `glow1` on the bloom, `trail1` on the
 * persistence. A beat is therefore visible three ways at three timescales — the herd
 * scatters THIS frame, the deposit that scatter lays becomes structure over the next few
 * seconds, and the regime it lands in was set by the bar before.
 *
 * ## T671 — a lattice needs a stationary substrate, so deny it one
 *
 * The owner looked at the T657 build and said the field still "consists of all these
 * very regular dots with no interesting motion and things happening outside the absolute
 * nucleus". T657 removed the cause of ONE regime everywhere (§V623); it did not answer
 * why a uniform regime packs regularly, which is simply what Gray-Scott does when the
 * medium under the pattern holds still. Three of the four changes are that one idea:
 *
 *  - ADVECTION (§V626). `flow1` displaces the whole state along a slow flow between the
 *    feedback and the reaction, while `pack1` repaints the chemistry AFTER the reaction —
 *    so the field moves and its parameters do not, which SHEARS. A rigid rotation would
 *    have turned the lattice and left it a lattice.
 *  - WEATHER. `front1` is a fertile ring expanding on the herd's own 83-second lap,
 *    multiplying the chemistry down as it passes, so a region is walked out of the
 *    lattice band and back — the owner's "across screen, at least occasionally".
 *  - THE CAMERA (§V625). A sway on the same clock, a SINE rather than `range1`'s saw
 *    because a saw snaps a rotation once a lap, outside the trail loop.
 *
 * And the fourth, the blink, which is temporal and was measured rather than judged:
 * `env1`'s lag and the `found` caste's decay, both named at their sites.
 *
 * MEASURED, on the shipped file. Blob-area spread in the outskirts 0.872 → 1.132 and
 * mean blob area 60.6 → 106.0 — the outskirts carry worms, dashes, rings, open cells and
 * aligned striations instead of one texture. Negative space not paid for: dark fraction
 * 26.8% → 31.7%. Nucleus hard-flip rate 23.28% → 18.68%. AND THE LOOP IS UNCHANGED,
 * which was the owner's own constraint: deposit off → mean V 0.00000 with zero texels
 * above 0.05; steering on 1.079× the frame mean against a field the herd cannot write,
 * steering deleted 0.996× — chance — versus 1.080× / 0.994× before. A prettier Pasture
 * with a dead stigmergy loop would have been a failure that photographs well.
 *
 * ## The two traps this file paid attention to rather than rediscovering
 *
 * §V533: the loop is pinned. `state1`, `rd1`, `sowin1`, `pack1`, `sow1`, `bowl1`,
 * `terrain1` and `smell1` are all fixed at 640x360, so NOTHING about the simulation rides
 * the output resolution — including the herd's render, which is a `project`-resolution node
 * by policy and would otherwise have splatted its deposit at 192x108 under the liveness
 * probe. `look1` is where the picture leaves the simulation's grid, explicitly.
 *
 * §V509/§V481(b): the trigger is raw. `trig1` reaches `burst1` with no lag between them,
 * because a one-pole answers a single-frame impulse with 1-exp(-dt/tau) — 0.047 at 0.35 s
 * — and a trigger through an envelope-sized smoother is a trigger you deleted.
 *
 * ## SUBSTEPS ARE STRUCTURALLY UNAVAILABLE HERE, and the reason is the example itself
 *
 * A feedback loop's substep body is "every node on a current-frame path from a consumer of
 * the Feedback's output back into the Feedback" (`compiler/substeps.ts`). The herd reads
 * `rd1` and writes `pack1`, so THE HERD IS IN THE LOOP — structurally, not by choice, and
 * that sentence is the whole example. It also means the point kernel's own ping-pong swaps
 * (`swap:scratch:herd:position` and its two siblings) sit inside the span the substep
 * repartition would reorder across, and §V288's guard in `applySubstepLoops` refuses that
 * rather than land a swap on the wrong side of the passes that bind it. Measured, not
 * reasoned: `state1.substeps = 12` compiles to
 *
 *     warning compiler/substeps-refused: Node "state" asked for 12 substeps, but another
 *     temporal pair swaps inside the loop; it runs one step per frame.
 *
 * and the rendered frames came back byte-identical to one step. A shipped example may raise
 * no diagnostic of any severity (T521/T545), so the reaction's speed comes from a CHAIN of
 * eight `customWgsl` nodes instead — the same arithmetic with the count visible in the
 * graph rather than hidden in a parameter, and every one of the eight is a real pass doing
 * a real Laplacian.
 *
 * WORTH KNOWING FOR THE NEXT PERSON: `renderHeadless` reports BACKEND diagnostics only. The
 * substeps refusal lives on `plan.diagnostics`, which a look harness printing
 * `result.diagnostics` never sees — this file ran three builds believing substeps worked.
 */
export const pastureDocument = document(
  "e32-pasture",
  "E32 Pasture",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 21, previewFps: 20 }),
  graph(
    [
      // ---- the sound: pattern or your track, exclusively (T504's shape) --------------
      node("beat", "audioPattern", [-2860, 1320], { bpm: 104, amount: 1 }, { label: "beat1" }),
      node("track", "audioFileIn", [-2860, 1540], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-2600, 1320], { index: 0 }, { label: "source1" }),
      /* ONE lag and ONE trigger, which is the smallest honest set. 0.07 s is short enough
         that a kick is an event and long enough that the bands stop jittering; the trigger
         is the instant, and §V509 is why nothing stands between it and what it drives. */
      /* T671: 0.16 s, where it was 0.07. Four frames of lag still let a high band arrive
         as a per-frame pulse on two sprite castes' SIZE, which is what "blinky" was.
         MEASURED on the nucleus alone, thresholded at display 205 so it is the core and
         not the field, at the project's full 1280×720 (§V627 — an additive points
         document read at half res is a different exposure): hard-flip rate 23.28% →
         15.42%, mean frame-to-frame delta 38.25 → 32.91. The TRIGGER is untouched — it
         reaches `burst1` on its own wire from `source1` and never through this lag, so
         §V509 still holds and a beat is still an event rather than a drift. */
      /* T686/T701 — THE ASYMMETRIC FOLLOWER. One symmetric lag either lags the attack or
         passes the flicker; this is the standard envelope shape instead: fast attack
         (max of a 45ms and a 400ms lag) measured AGAINST the source's own 5s average,
         floored at zero. Under music it took the nucleus hard-flip rate 1.839 → 0.853 —
         landing ON the pattern's own 0.869, so the two sources finally behave alike.
         `env`'s id and label live on the FLOOR node so all fourteen downstream edges and
         the nine re-derived biases (now in the deviation domain: rest IS zero) are
         untouched by construction. */
      node("envFast", "valueLag", [-3120, 1100], { lag: 0.045 }, { label: "envfast1" }),
      node("envMid", "valueLag", [-3120, 1320], { lag: 0.4 }, { label: "envmid1" }),
      node("envSlow", "valueLag", [-3120, 1540], { lag: 5 }, { label: "envslow1" }),
      node("envPeak", "valueMath", [-2860, 880], { operation: "maximum" }, { label: "envpeak1" }),
      node("envDiff", "valueMath", [-2600, 880], { operation: "subtract" }, { label: "envdiff1" }),
      node("env", "valueLimit", [-2340, 880], { minimum: 0, maximum: 4 }, { label: "env1" }),
      node("trig", "valueTrigger", [-2340, 1540], { threshold: 0.5 }, { label: "trig1" }),

      /* ---- THE HERD'S THREE BANDS. These reach ctx.value1..3 (T479), which is the only
         way audio has ever been able to change what a point kernel DOES rather than what
         it is scaled by — E31 had to smuggle its one number in through `radius`. */
      /* Walking speed, in clip units per second: 0.06 at rest, 0.40 flat out. */
      node("paceG", "valueMath", [-2080, 880], { operation: "multiply", operand: 1.1372 }, { label: "paceg1" }),
      node("pace", "valueMath", [-1820, 880], { operation: "add", operand: 0.2208 }, { label: "pace1" }),
      /* Sensor reach, in the same units: 6.5 px at rest, 26 px on the hats. */
      node("reachG", "valueMath", [-2080, 1100], { operation: "multiply", operand: 0.0931 }, { label: "reachg1" }),
      node("reach", "valueMath", [-1820, 1100], { operation: "add", operand: 0.0648 }, { label: "reach1" }),
      /* The scatter, in RADIANS and off the raw trigger: +-0.01 rad at rest (nothing),
         +-1.2 rad on the frame a beat lands. §V477 read as far as it goes — at rest this
         term does not exist, so the beat is not a change of degree in something already
         happening, it is the only time it happens at all. */
      node("burstG", "valueMath", [-2080, 1320], { operation: "multiply", operand: 3.4 }, { label: "burstg1" }),
      node("burst", "valueMath", [-1820, 1320], { operation: "add", operand: 0.02 }, { label: "burst1" }),

      /* ---- THE FIELD'S TWO BANDS ---------------------------------------------------- */
      /* How much chemistry a footstep leaves. Rest 0.035 is a whisper; 0.135 on a loud
         passage is a herd that paints. */
      node("dropG", "valueMath", [-2080, 1540], { operation: "multiply", operand: 0.14 }, { label: "dropg1" }),
      node("drop", "valueMath", [-1820, 1540], { operation: "add", operand: 0.1758 }, { label: "drop1" }),
      /* HOW BIG A MOUTHFUL IS, in pixels of the simulation's own grid. Rest 1.6 px is a
         nibble; 3.4 px on a loud passage strips the ground bare — and this is the one number
         that keeps the pasture from becoming a carpet, so it is on the kick rather than
         left static. */
      node("gnawG", "valueMath", [-2080, 1980], { operation: "multiply", operand: 6.6897 }, { label: "gnawg1" }),
      node("gnaw", "valueMath", [-1820, 1980], { operation: "add", operand: 2.24 }, { label: "gnaw1" }),
      /* The chemistry map's white point, hard against the band where the pattern survives.
         T562's lesson is the fence: the map's Level sits on a narrow window fitted to the
         noise's measured spread, so the same fractional swing needs a narrow fence too. */
      /* T657: the swing widens 0.05 → 0.14 with the rest state at 0.55, because the
         window it moves is now three times as wide — the same gain on a wider window is a
         smaller gesture (§V471.3, §V477: the bias is the rest state, the gain is the
         swing). Achievable span 0.55…0.69 against a declared −1…4 (T545). */
      node("warmG", "valueMath", [-2080, 1760], { operation: "multiply", operand: 0.4171 }, { label: "warmg1" }),
      node("warm", "valueMath", [-1820, 1760], { operation: "add", operand: 0.571 }, { label: "warm1" }),

      /* ---- AND ONLY THEN THE PICTURE ------------------------------------------------ */
      node("gradeG", "valueMath", [-1560, 880], { operation: "multiply", operand: 1.6083 }, { label: "gradeg1" }),
      node("grade", "valueMath", [-1300, 880], { operation: "add", operand: 0.98 }, { label: "grade1" }),
      node("sparkG", "valueMath", [-1560, 1100], { operation: "multiply", operand: 2.3275 }, { label: "sparkg1" }),
      node("spark", "valueMath", [-1300, 1100], { operation: "add", operand: 1.32 }, { label: "spark1" }),
      node("glowG", "valueMath", [-1560, 1320], { operation: "multiply", operand: 0.24 }, { label: "glowg1" }),
      node("glow", "valueMath", [-1300, 1320], { operation: "add", operand: 0.1571 }, { label: "glow1" }),
      node("trailG", "valueMath", [-1560, 1540], { operation: "multiply", operand: 0.22 }, { label: "trailg1" }),
      node("trail", "valueMath", [-1300, 1540], { operation: "add", operand: 0.6249 }, { label: "trail1" }),

      // ---- THE HERD -----------------------------------------------------------------
      node("herd", "pointKernel", [780, 0], {
        capacity: PASTURE_AGENTS, seed: 21, group: "",
        attributes: PASTURE_ATTRIBUTES,
        kernel: PASTURE_KERNEL,
      }, {
        label: "herd1",
        parameters: {
          value1: drivenSlot("pace1:low", 0.28),
          value2: drivenSlot("reach1:high", 0.08),
          value3: drivenSlot("burst1:onsetCount", 0.02),
          /* The roost's bearing — see the kernel's `home`. */
          value4: drivenSlot("range1", 0),
        },
      }),

      /* ---- ONE CLOUD, FOUR READINGS (§V471.1) — and the first one is not a picture ---
       *
       * `sow1` is the DEPOSIT: every animal, no predicate, white, drawn into the
       * simulation's own 640x360 grid rather than the frame's. It is the input to the
       * reaction, and it is also (through the state, one node later) most of what you see
       * of the herd — so the swarm's body is visible as CHEMISTRY and only its castes are
       * visible as sprites. §V533 is why the resolution is pinned: renderPoints is a
       * `project`-resolution node by policy, so at T521's 192x108 liveness probe this
       * would otherwise have splatted the whole herd's deposit into a tenth of the grid
       * the reaction runs on. */
      node("sow", "renderPoints", [1040, 220], {
        /* ALPHA, not additive, and this is the one blend decision in the file that is not
           taste. A deposit answers "is there spore on this texel", which is bounded; two
           animals standing together cannot leave twice as much. Additive, they do: five
           thousand sprites in the opening frame's disc overlapped three deep, the screen
           below took V straight to 1 across the whole herd, and the first frame rendered as
           a solid white disc — invisible at 1280 wide, where the specks are separated, and
           the entire picture at T521's 192x108 probe, where they merge. */
        count: PASTURE_AGENTS, blend: "alpha", accumulate: false,
        /* GREEN, AND THAT IS THE WHOLE DIFFERENCE BETWEEN AN ECOLOGY AND A COLLAPSE.
           The state is (U = substrate, V = autocatalyst), and a WHITE deposit screens both
           of them toward 1 — so a footprint hands the animal back everything its own sensor
           multiplies together, U*V*V goes maximal exactly where the herd already is, and the
           flock converges to a point and stays there. Measured: a blown-out core at the
           spring's centre by frame 900, the rest of the pasture untouched.
           An animal deposits SPORE, not SOIL. Green touches V only; U is the pasture's to
           give, and it is depleted by the reaction that the spore starts. So a patch the
           herd has worked is rich in V and BARE of U, its reaction rate falls, and the herd
           has to move on to eat — which is the negative feedback the picture is made of. */
        color: [0, 1, 0, 1], sizePixels: 3, group: "",
      }, { label: "sow1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* The three castes, each a predicate on a number THE KERNEL WROTE (§V471.2): who is
         starving, who is eating, and who has just found something. */
      node("scout", "renderPoints", [1040, -440], {
        count: PASTURE_AGENTS, blend: "additive", accumulate: false,
        color: [0.03, 0.07, 0.24, 1], sizePixels: 0.9,
        group: "p.graze.y > 0.45",
      }, { label: "scout1", resolution: { mode: "fixed", width: 1280, height: 720 } }),
      node("graze", "renderPoints", [1300, -440], {
        count: PASTURE_AGENTS, blend: "additive", accumulate: false,
        color: [0.62, 0.2, 0.03, 1], group: "p.graze.x > 0.30",
      }, {
        label: "graze1",
        resolution: { mode: "fixed", width: 1280, height: 720 },
        parameters: {
          /* T286's pscale: the sprite size is a PER-POINT attribute, so a grazer is drawn
             at how much it is eating rather than at one number for the whole layer. */
          sizePixels: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 2.2 },
              map: { kind: "map", attribute: "graze", channel: "w" },
            },
          },
        },
      }),
      /* THE FIFTH READING, and the one that makes this an ECOLOGY rather than a paint
         program. Everything above ADDS to the field; without a negative term a deposit that
         grows into a colony stays a colony, the pasture fills the disc and the composition
         freezes into a carpet — measured, by frame 900 of the build before this one. So the
         animals that are EATING (the same predicate `graze1` draws in amber) are drawn a
         second time into a mask that is MULTIPLIED out of the state. An animal that finds
         food takes it, the ground behind the herd goes bare, and the reaction grows it back
         from the edges: that is the whole reason the frame never settles.
         The sprite is nearly twice the deposit's, so a grazer removes more than it lays and
         a well-fed patch cannot run away. */
      /* THE DEPTH OF ONE MOUTHFUL IS THE SPRITE'S COLOUR, 0.45, and the SIZE of it is the
         audio. Both of those are decisions this node had to be talked into. Level applies
         `brightness` AFTER `invert` — `(1 - x) * b`, not `1 - b*x` — so putting the depth on
         the mask's brightness multiplies the ENTIRE simulation by b every frame instead of
         only under a grazer, and the field collapses to nothing in about a second. Measured,
         and it looked exactly like a chemistry that would not ignite. Composite's own
         `opacity` cannot hold the depth either: multiply is `front * back` with opacity
         scaling the FRONT, so it dims the whole state the same way. */
      node("bite", "renderPoints", [1040, 440], {
        count: PASTURE_AGENTS, blend: "alpha", accumulate: false,
        color: [0.55, 0.55, 0.55, 1], group: "p.graze.x > 0.30",
      }, { label: "bite1",
        resolution: { mode: "fixed", width: 640, height: 360 },
        parameters: { sizePixels: drivenSlot("gnaw1:low", 2.6) },
      }),
      /* Exactly 1 - coverage, and nothing else: every number here is at its identity so the
         mask cannot quietly become a gain on the simulation. */
      node("chew", "level", [1300, 440], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 1, brightness: 1, opacity: 1,
      }, { label: "chew1" }),
      node("find", "renderPoints", [1560, -440], {
        count: PASTURE_AGENTS, blend: "additive", accumulate: false,
        color: [0.2, 0.55, 0.75, 1], group: "p.graze.z > 0.30",
      }, {
        label: "find1",
        resolution: { mode: "fixed", width: 1280, height: 720 },
        parameters: { sizePixels: drivenSlot("spark1:high", 1.5) },
      }),

      // ---- THE CHEMISTRY MAP, and where the pasture is allowed to exist -------------
      /*
       * T657 — THE OUTSKIRTS WERE STATIC BECAUSE A COMPOSITE DELETED THEIR VARIATION, and
       * that is one step further down than "nothing disturbs them". `terrain1` is already
       * spatially varied and already drifting; `screen(coast1, shape1)` then threw it
       * away, because `screen(1, anything) = 1` and this disc's background was WHITE.
       * MEASURED by rendering `dish1` straight to the output: median 0.9989, and p90, p99
       * and p999 all 0.9989 as well — the chemistry map was ONE NUMBER across the whole
       * frame outside the disc, so every region ran the same regime for ever and a
       * Gray-Scott field with nothing to distinguish one place from another packs
       * hexagonally. The lattice was not the chemistry's fault; it was the falloff's.
       *
       * §V554 obeyed rather than inherited: this file's own band, driven end to end with a
       * 0..1 ramp for 2400 steps, is LABYRINTH below ~0.15, worms breaking into segments
       * 0.15–0.35, rings and irregular blobs 0.35–0.60, the REGULAR SPOT LATTICE 0.60–0.85,
       * and dying above ~0.85. The outskirts sat at 0.999. Widening the falloff walks them
       * back down through the interesting part of that band instead, and because `terrain1`
       * drifts, WHICH region is in which regime keeps changing.
       *
       * The author's constraint was the real brief — break it up WITHOUT costing the
       * negative space — so the two aggressive versions were tried and REJECTED by
       * measurement: pinning the far outskirts on the death line (background 0.86, then
       * 0.92) took the dark fraction from 46.4% to 38.6% and the blob-area spread from
       * 0.483 to 0.449, i.e. it cost negative space AND came back more regular. The
       * gradient keeps both: dark fraction 46.2% → 46.4% early and 28.4% → 26.8% at frame
       * 3000, blob-area CV in the outskirts 0.757 → 0.872.
       */
      /* §V474 and §V532 in one pair of nodes. `bowl1` is a disc painted BLACK INSIDE and
         WHITE OUTSIDE — already the inversion E24 needed a second node for — so screening
         it into the map pins the coordinate at the band's HIGH corner everywhere outside.
         There (feed 0.042, kill 0.068) Gray-Scott's existence condition F < 4(F+k)^2 fails
         — 0.042 against 0.0484 — so V has no non-trivial steady state at all and decays to
         nothing. The dark part of this frame is the simulation being genuinely empty, not
         a matte over a full-frame carpet, and the soft edge is a gradient THROUGH the
         band, so the pasture frays into spots before it stops. T657 made that gradient
         WIDE, which is the whole fix: a narrow one put almost everything on the far side
         of it at a single saturated value. Off-centre
         because the composition wants it there and because §V532 is the record of what
         happens to material sitting on a loop's own fixed point. */
      /* T657: radius 0.26 and softness 0.42, where it was 0.29 and 0.24. The disc is
         slightly smaller and its falloff nearly TWICE as wide, so the ramp through the band
         occupies most of the frame instead of a narrow ring — the outskirts become a
         REGIME GRADIENT, and only the far corners still pin at 1.0. The background stays
         white on purpose: that is what keeps the negative space, and it is the half of
         this the two rejected variants gave away. */
      node("bowl", "circle", [-2860, -440], {
        mode: "fill", center: [0.4, 0.54], radius: [0.26, 0.26], softness: 0.42,
        fillcolor: [0, 0, 0, 1], bgcolor: [1, 1, 1, 1], aspectcorrect: true,
      }, { label: "bowl1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* THE COASTLINE. A circle is a shape nobody chose, and a pasture with a circular
         boundary reads as a mask over a simulation rather than as a place. Warping the disc
         by a slow two-channel noise gives it bays and peninsulas — and because the noise is
         ANIMATED at 0.02 (a fifty-second lap), the coast itself creeps, so the herd is
         forever losing ground on one side and gaining it on the other. That is the piece's
         slowest timescale and it costs two nodes.
         MONO IS OFF, which is the whole difference between a coast and a shove: `displace`
         reads x from red and y from green, and a monochrome field has red == green, so
         every pixel of the disc would slide along the SAME 45-degree diagonal and the
         circle would simply move. */
      node("swell", "noise", [-2860, -220], {
        type: "perlin4d", seed: 41, period: 0.55, harmon: 2, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.035,
      }, { label: "swell1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* T657: 0.30 rather than 0.15, and the swell drifting at 0.035 rather than 0.02.
         The coastline is now the width of the falloff it is warping, so the regime bands
         are ragged and interlocking rather than concentric — a wide smooth ramp warped a
         little is still visibly a ring. */
      node("coast", "displace", [-2600, -440], {
        weight: [0.30, 0.30], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold",
      }, { label: "coast1" }),
      node("terrain", "noise", [-2600, -220], {
        type: "perlin4d", seed: 5, period: 0.18, harmon: 4, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1.25, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        /* T657: 0.06 rather than 0.04. The regime map is what "evolves" means here —
           which patch of the pasture is lattice and which is worms is now visibly a
           function of time, not just of place. The PERIOD is deliberately left at 0.18:
           tried at 0.34 the patches grew larger than the frame, which reads as uniform
           again from inside one of them. */
        t4d: 0.37, s4d: 1, speed: 0.06,
      }, { label: "terrain1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* THE WINDOW IS T562's AND THE BRIGHTNESS IS THIS FILE'S OWN FINDING. Gray-Scott has
         a non-trivial steady state only where F >= 4(F+k)^2, and over the imported band
         that is chemistry BELOW about 0.16: at 0 (F 0.028, k 0.0545) it is 0.028 against
         0.0272 and alive, at 0.5 it is 0.035 against 0.0371 and already dead. So a map
         spanning the whole 0..1 coordinate spends four fifths of itself in a regime with
         nothing in it — which is what killed the first build of this file stone dead by
         frame 800. RE-MEASURED for T657, because the earlier note here was too coarse to
         act on: driving this file's own band with a 0..1 ramp gives LABYRINTH below ~0.15,
         worms breaking into segments 0.15–0.35, rings and irregular blobs 0.35–0.60, the
         REGULAR SPOT LATTICE 0.60–0.85, and death only above ~0.85. Which of those a
         region is in is the difference between "the outskirts are interesting" and "the
         outskirts are a hex grid", so the boundary that matters is 0.60, not the death
         line. `brightness: 0.72` therefore
         puts the pasture across the whole living part of the band and a little way past it,
         so a few patches inside the disc are bare ground the herd has to cross, while
         `bowl1` pins everything outside at 1.0, which is well clear of the boundary rather
         than balanced on it. §V474 read one level down: the "high corner" where empty field
         lives is high RELATIVE TO WHAT SURVIVES, not the top of whatever coordinate the
         graph happens to hand over — and where that boundary is, is a measurement. */
      /* T657: the black point drops 0.45 → 0.36, which is where a four-harmonic perlin
         sum's LINEAR band actually starts (§V587's measurement, reused). At 0.45 against a
         white point of ~0.54 the window was a sliver of that band and `shape1` was very
         nearly BINARY — the terrain contributed an on/off mask rather than a landscape, so
         even where the screen did not saturate there were only two regimes to be in. The
         window now spans the band and the audio drive widens with it. */
      node("shape", "level", [-2340, -220], {
        blacklevel: 0.36, contrast: 1, brightness: 0.72, gamma1: 1.25, invert: 0, opacity: 1,
      }, { label: "shape1", parameters: { whitelevel: drivenSlot("warm1:lowMid", 0.62) } }),
      node("dish", "screen", [-2080, -440], { opacity: 1 }, { label: "dish1" }),
      /*
       * T671 — WEATHER. A fertile front, expanding on the herd's own 83-second lap.
       * Multiplying the chemistry map DOWN in a moving ring walks that ring's regime
       * from the lattice band (0.60–0.85) back toward worms and coral, and then releases
       * it: the owner's "more effect on the field all across screen, at least
       * occasionally". `range1` is the piece's clock and this is its second consequence,
       * so the front and the grazing circuit are in step by construction rather than by
       * two numbers that happen to agree.
       *
       * The ×0.30 is a RANGE fit, not a taste knob: `range1` spans ±π and `phase` is
       * declared −1…1, so the raw channel would clamp (T545). ±0.94 fills the parameter
       * and leaves a margin.
       *
       * Verified TRAVELLING rather than assumed — a driven parameter that never arrives
       * is §V471.8's exact failure. Rendering `front1` alone, its median walks
       * 0.9989 → 0.9967 → 0.8364 → 0.9989 across frames 0 / 600 / 1200 / 1800.
       */
      node("sweepG", "valueMath", [-2600, 1760], { operation: "multiply", operand: 0.30 }, { label: "sweepg1" }),
      node("front", "ramp", [-2340, -640], {
        type: "radial", interp: "smooth", period: 2.2,
        stops: [
          { position: 0.0, color: [1, 1, 1, 1] },
          { position: 0.40, color: [1, 1, 1, 1] },
          { position: 0.62, color: [0.55, 0.55, 0.55, 1] },
          { position: 0.84, color: [1, 1, 1, 1] },
          { position: 1.0, color: [1, 1, 1, 1] },
        ],
      }, {
        label: "front1", definitionVersion: 2,
        resolution: { mode: "fixed", width: 640, height: 360 },
        parameters: { phase: drivenSlot("sweepg1", 0) },
      }),
      node("weather", "multiply", [-2080, -652], { opacity: 1 }, {
        label: "weather1", resolution: { mode: "fixed", width: 640, height: 360 },
      }),
      /*
       * T671 — ADVECTION, and it is the one that kills the lattice. §V626: to break a
       * pattern you move the MEDIUM; rotating the pattern turns a lattice and leaves it a
       * lattice. One `displace` between the feedback and the reaction nudges the whole
       * state along `swell1`'s slow two-channel flow every frame, and the chemistry map
       * does NOT move with it — `pack1` repaints b from the map AFTER the reaction — so
       * this is advection THROUGH a static parameter field, which shears.
       *
       * 0.0025 is the DENSITY knob and it is a real trade, stated rather than discovered:
       * at 0.006 the dark fraction reaches 71% and the pasture visibly shrinks, because
       * the flow carries V away faster than a low-feed regime can regrow it. Turn it up
       * for wilder and emptier, down for denser and more regular.
       */
      node("flow", "displace", [-1690, -260], {
        weight: [0.0025, 0.0025], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold",
      }, { label: "flow1", resolution: { mode: "fixed", width: 640, height: 360 } }),

      // ---- THE REACTION -------------------------------------------------------------
      node("state", "feedback", [-1820, 0], {
        source: "pack1", persistence: 1, clearColor: [0, 0, 0, 0], reset: false, substeps: 1,
      }, {
        label: "state1",
        resolution: { mode: "fixed", width: 640, height: 360 },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      /* EIGHT REACTION STEPS BETWEEN ONE LOOK AND THE NEXT, as eight nodes — see the
         header for why this is not `substeps`. The shader is E2's, imported rather than
         re-derived: a nine-tap Laplacian, two coupled rate equations, and a feed/kill band
         the GRAPH paints per pixel through the state's blue channel. */
      node("rd", "customWgsl", [-1560, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd1" }),
      node("rd2", "customWgsl", [-1300, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd2" }),
      node("rd3", "customWgsl", [-1040, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd3" }),
      node("rd4", "customWgsl", [-780, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd4" }),
      node("rd5", "customWgsl", [-520, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd5" }),
      node("rd6", "customWgsl", [-260, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd6" }),
      node("rd7", "customWgsl", [0, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd7" }),
      node("rd8", "customWgsl", [260, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd8" }),
      /* WHAT THE HERD SMELLS. §V427 is the reason this node exists: `fieldAt` is a
         textureLoad — NEAREST, unfiltered — and a Gray-Scott V is near-binary, so the
         difference between two adjacent texels of it is mostly quantisation and a herd
         steering on that jitters instead of turning. Five pixels of blur is a field the
         three sensors can actually answer, and it costs one pass on a 640x360 texture.
         It reads rd8 rather than sowin1 ON PURPOSE: the animals smell what the REACTION
         made, never their own footprint one node earlier — which is the difference between
         this and a trail-follower, and it is also what keeps the graph a DAG. */
      node("smell", "blur", [520, 0], { size: 8, filter: "gaussian", extend: "hold" }, {
        label: "smell1", resolution: { mode: "fixed", width: 640, height: 360 },
      }),
      /* THE DEPOSIT ENTERS. Screen is the operator this wants and not a convenience:
         1-(1-a)(1-b) takes U and V toward 1 where a footstep is, and (U=1, V=1) in a small
         patch is LITERALLY the reaction kernel's own `seededState` — the classic
         Gray-Scott starting plate. So an animal does not brighten the picture, it drops new
         chemistry into it and the reaction spends the next second growing what the animal
         put there. The DEPOSIT IS THE FRONT (§V510's shape): Composite's opacity scales the
         front only, so `drop1` reads as "how much chemistry a footstep leaves" on the node
         that does the depositing, with no extra node to hold it. */
      node("sowIn", "screen", [1300, 0], {}, {
        label: "sowin1",
        resolution: { mode: "fixed", width: 640, height: 360 },
        parameters: { opacity: drivenSlot("drop1:level", 0.2) },
      }),
      /* AND THE DEPOSIT IS EATEN BACK. `chew1` is 1 everywhere and 1-depth under a
         grazer, so this is the herd's mouth. */
      node("eat", "multiply", [1560, 0], { opacity: 1 }, {
        label: "eat1", resolution: { mode: "fixed", width: 640, height: 360 },
      }),
      /* r = U, g = V, b = the chemistry coordinate the map paints, a = the INITIALISED
         FLAG — and it is written as a CONSTANT ONE rather than carried through. Alpha below
         0.5 is the reaction kernel's "history is gone, re-seed" signal, and `eat1`
         multiplies alpha by the bite mask like every other channel: carried through, a
         grazer's own footprint would read as a cleared pair and re-seed the pixel it stood
         on. `one` here means only a genuinely cleared feedback pair (project load, reset,
         resize) can ever re-seed, which is what the flag is for. */
      node("pack", "reorder", [1820, 0], {
        outr: "in1r", outg: "in1g", outb: "in2lum", outa: "one",
      }, { label: "pack1", resolution: { mode: "fixed", width: 640, height: 360 } }),

      // ---- COLOUR, then TIME --------------------------------------------------------
      /* §V511: V is NEAR-BINARY, so a Gray-Scott picture visits exactly TWO stops of any
         ramp unless something continuous is added to the index first. The chemistry map is
         that something, read a SECOND time (§V471.1) and inverted for the same reason E24
         inverts it: `dish1` is pinned at 1 outside the disc, so reading it straight would
         lift the empty four fifths of the frame onto the ramp and give the whole frame a
         ground colour. Inverted, the dead field contributes exactly zero and the ground is
         the ramp's own first stop. Inside, the sense is also the better one — a region
         running the LOW (labyrinth) chemistry is the dense one and gets the warmer base. */
      node("chem", "level", [1560, 220], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 1,
        brightness: 0.26, opacity: 0,
      }, { label: "chem1" }),
      /* WHERE THE PICTURE LEAVES THE SIMULATION'S GRID — and it lands on a SECOND fixed
         resolution rather than on the project's, which is §V533 pushed one step further
         than E24 needed to push it. Two things in this file are measured in OUTPUT PIXELS
         and would otherwise ride whatever resolution the host asks for: `sizePixels` on the
         three caste renders, and `halo1`'s blur radius. At 1280 wide a 0.9 px scout is a
         speck and an 18 px bloom is a soft edge; at T521's 192x108 probe the same numbers
         are a six-pixel blob and a bloom nine percent of the frame across, and the herd
         renders as one saturated white mass — measured, p90 0.99 at frame 0.
         Pinning here (and on the three caste renders above, which are `project`-policy
         nodes) makes the whole picture resolution-independent: the Output node scales a
         finished 1280x720 frame instead of re-deciding what a pixel means. The simulation
         upstream is pinned at 640x360 for the same reason and neither number is the
         other's. */
      node("look", "add", [2080, 0], { opacity: 1 }, {
        label: "look1", resolution: { mode: "fixed", width: 1280, height: 720 },
      }),
      node("palette", "ramp", [2080, 440], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* SEVEN STOPS THAT TRAVEL (§V471.6), and they cross hue as well as brightness:
           near-black, teal-black, dark teal, jade, moss, gold, cream. The bulk of the frame
           lives in the first three and only a front reaches the gold, which is §V477 stated
           as a palette rather than as a gain. */
        stops: [
          { position: 0, color: [0.004, 0.007, 0.016, 1] },
          { position: 0.16, color: [0.02, 0.05, 0.1, 1] },
          { position: 0.34, color: [0.03, 0.2, 0.32, 1] },
          { position: 0.52, color: [0.06, 0.45, 0.44, 1] },
          { position: 0.7, color: [0.35, 0.66, 0.42, 1] },
          { position: 0.86, color: [0.95, 0.72, 0.3, 1] },
          { position: 1, color: [1, 0.97, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("tint", "lookup", [2340, 0], { channel: "green", row: 0.5, offset: 0 }, {
        label: "tint1",
        /* §V471.7 — the grade BREATHES. Rest 1.15 puts the fronts in the jade and leaves
           the moss and the gold as somewhere for a loud passage to reach. */
        parameters: { scale: drivenSlot("grade1:highMid", 1.15) },
      }),
      /* The three castes go on top of the graded field, coldest first. Screen rather than
         add: an animal on an already-bright front should not double it. */
      node("liftScout", "screen", [2600, 0], { opacity: 1 }, { label: "liftscout1" }),
      node("liftGraze", "screen", [2860, 0], { opacity: 1 }, { label: "liftgraze1" }),
      node("liftFind", "screen", [3120, 0], { opacity: 1 }, { label: "liftfind1" }),
      node("halo", "blur", [3120, 220], { size: 18, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      /* The bloom's WEIGHT is the audio (§V471.3): the blurred copy is the front here, so
         one number says how much halo, and it rests low. */
      node("burn", "add", [3380, 0], {}, {
        label: "burn1",
        parameters: { opacity: drivenSlot("glow1:level", 0.17) },
      }),
      /* §V471.5 — THE TRAILS CLOSE ON THE FINAL OUTPUT. `hue1` is the last node before the
         Output, so what smears is the graded, hue-drifted picture rather than the raw
         render, and the persistence is on the audio: louder means longer memory. */
      node("loop", "feedback", [3380, 220], {
        source: "hue1", clearColor: [0, 0, 0, 1], reset: false, substeps: 1,
      }, { label: "loop1", parameters: { persistence: drivenSlot("trail1:level", 0.7) } }),
      node("mixTrail", "screen", [3640, 0], { opacity: 1 }, { label: "mixtrail1" }),
      /* §V471.8 — A LONG CYCLE, with the amplitude in the TARGET'S UNITS. 0.028 Hz is a
         36-second lap and `hueoffset` is DEGREES on a -180..180 range, so 24 is 24 degrees
         and the piece actually travels. Corona's own 0.35 on the same parameter is a tenth
         of a percent of a turn, which is why T574 exists. Free-running (§V436, B98). */
      /* THE TRANSHUMANCE. 0.012 Hz is an 83-second circuit — three times slower than the
         hue drift, and the slowest thing in the piece. SAW rather than sine because it
         drives an ANGLE: the wrap from +pi to -pi is invisible once you take its cosine,
         where a sine would make the flock swing back and forth along one line instead of
         going round. Free-running (§V436, B98): a timeline lap must not put the herd back
         where it started. */
      node("range", "lfo", [-2340, 1980], {
        shape: "saw", frequency: 0.012, amplitude: 3.14159, offset: 0, phase: 0,
      }, { label: "range1" }),
      node("drift", "lfo", [3640, 220], {
        shape: "sine", frequency: 0.028, amplitude: 24, offset: 0, phase: 0,
      }, { label: "drift1" }),
      node("hue", "hsv", [3900, 0], { saturation: 1.06, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      /*
       * T671 — THE CAMERA, the owner's "rotate camera lerpy on bar or whatever". A slow
       * sway on the piece's OWN 83-second lap, the same clock the herd's circuit walks.
       *
       * §V625: a SINE at `range1`'s frequency, not `range1` itself. That saw is right for
       * an angle the herd WALKS — its wrap from +π to −π is invisible once you take the
       * cosine — and wrong for a rotation, where the same wrap snaps the frame back once
       * a lap. Same clock, same period, re-shaped rather than re-used. No audio: a
       * gesture this slow must not acquire a live-device dependency.
       *
       * OUTSIDE the trail loop, which closes on `hue1`. §V481(a) is exactly about a
       * transform inside a feedback loop; a rotation in there would spiral the trails
       * instead of swaying the picture. The 1.12 scale is the cover for ±4.5°.
       */
      node("sway", "lfo", [3900, 400], {
        shape: "sine", frequency: 0.012, amplitude: 4.5, offset: 0, phase: 0,
      }, { label: "sway1" }),
      node("spin", "transform", [4160, 0], {
        t: [0, 0], s: [1.12, 1.12], p: [0, 0], xord: "srt", extend: "hold", aspectcorrect: true,
      }, { label: "spin1", parameters: { r: drivenSlot("sway1", 0) } }),
      node("out", "output", [4420, 0], {}, { label: "out1" }),
    ],
    [
      // sound: both sources reach the Switch, exactly one leaves it (T504/T508).
      edge("e-beat-source", ["beat", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-envfast", ["source", "out"], ["envFast", "in"]),
      edge("e-source-envmid", ["source", "out"], ["envMid", "in"]),
      edge("e-source-envslow", ["source", "out"], ["envSlow", "in"]),
      edge("e-envfast-envpeak", ["envFast", "out"], ["envPeak", "a"]),
      edge("e-envmid-envpeak", ["envMid", "out"], ["envPeak", "b"]),
      edge("e-envpeak-envdiff", ["envPeak", "out"], ["envDiff", "a"]),
      edge("e-envslow-envdiff", ["envSlow", "out"], ["envDiff", "b"]),
      edge("e-envdiff-env", ["envDiff", "out"], ["env", "in"]),
      edge("e-source-trig", ["source", "out"], ["trig", "in"]),
      // the herd's three bands
      edge("e-env-paceg", ["env", "out"], ["paceG", "a"]),
      edge("e-paceg-pace", ["paceG", "out"], ["pace", "a"]),
      edge("e-env-reachg", ["env", "out"], ["reachG", "a"]),
      edge("e-reachg-reach", ["reachG", "out"], ["reach", "a"]),
      edge("e-trig-burstg", ["trig", "out"], ["burstG", "a"]),
      edge("e-burstg-burst", ["burstG", "out"], ["burst", "a"]),
      // the field's two
      edge("e-env-dropg", ["env", "out"], ["dropG", "a"]),
      edge("e-dropg-drop", ["dropG", "out"], ["drop", "a"]),
      edge("e-env-warmg", ["env", "out"], ["warmG", "a"]),
      edge("e-warmg-warm", ["warmG", "out"], ["warm", "a"]),
      edge("e-env-gnawg", ["env", "out"], ["gnawG", "a"]),
      edge("e-gnawg-gnaw", ["gnawG", "out"], ["gnaw", "a"]),
      // the picture's four
      edge("e-env-gradeg", ["env", "out"], ["gradeG", "a"]),
      edge("e-gradeg-grade", ["gradeG", "out"], ["grade", "a"]),
      edge("e-env-sparkg", ["env", "out"], ["sparkG", "a"]),
      edge("e-sparkg-spark", ["sparkG", "out"], ["spark", "a"]),
      edge("e-env-glowg", ["env", "out"], ["glowG", "a"]),
      edge("e-glowg-glow", ["glowG", "out"], ["glow", "a"]),
      edge("e-env-trailg", ["env", "out"], ["trailG", "a"]),
      edge("e-trailg-trail", ["trailG", "out"], ["trail", "a"]),

      // the chemistry map: a disc that decides where the pasture is, over a noise
      edge("e-terrain-shape", ["terrain", "out"], ["shape", "input"]),
      edge("e-bowl-coast", ["bowl", "out"], ["coast", "source"]),
      edge("e-swell-coast", ["swell", "out"], ["coast", "disp"]),
      edge("e-coast-dish", ["coast", "out"], ["dish", "in1"]),
      edge("e-shape-dish", ["shape", "out"], ["dish", "in2"], 0),

      // THE LOOP, both directions of it.
      // outward: the state reacts four times, and the herd smells the result.
      edge("e-state-flow", ["state", "out"], ["flow", "source"]),
      edge("e-swell-flow", ["swell", "out"], ["flow", "disp"], 0),
      edge("e-flow-rd", ["flow", "out"], ["rd", "input"]),
      edge("e-rd1-rd2", ["rd", "out"], ["rd2", "input"]),
      edge("e-rd2-rd3", ["rd2", "out"], ["rd3", "input"]),
      edge("e-rd3-rd4", ["rd3", "out"], ["rd4", "input"]),
      edge("e-rd4-rd5", ["rd4", "out"], ["rd5", "input"]),
      edge("e-rd5-rd6", ["rd5", "out"], ["rd6", "input"]),
      edge("e-rd6-rd7", ["rd6", "out"], ["rd7", "input"]),
      edge("e-rd7-rd8", ["rd7", "out"], ["rd8", "input"]),
      edge("e-rd8-smell", ["rd8", "out"], ["smell", "input"]),
      edge("e-smell-herd", ["smell", "out"], ["herd", "field"]),
      // inward: the herd deposits, and the deposit is screened back into the state.
      edge("e-herd-sow", ["herd", "out"], ["sow", "points"]),
      edge("e-sow-sowin", ["sow", "out"], ["sowIn", "in1"]),
      edge("e-rd8-sowin", ["rd8", "out"], ["sowIn", "in2"], 0),
      edge("e-herd-bite", ["herd", "out"], ["bite", "points"]),
      edge("e-bite-chew", ["bite", "out"], ["chew", "input"]),
      edge("e-chew-eat", ["chew", "out"], ["eat", "in1"]),
      edge("e-sowin-eat", ["sowIn", "out"], ["eat", "in2"], 0),
      edge("e-eat-pack", ["eat", "out"], ["pack", "in1"]),
      edge("e-range-sweepg", ["range", "out"], ["sweepG", "a"]),
      edge("e-dish-weather", ["dish", "out"], ["weather", "in1"]),
      edge("e-front-weather", ["front", "out"], ["weather", "in2"], 0),
      edge("e-weather-pack", ["weather", "out"], ["pack", "in2"]),

      // the same cloud, three more times
      edge("e-herd-scout", ["herd", "out"], ["scout", "points"]),
      edge("e-herd-graze", ["herd", "out"], ["graze", "points"]),
      edge("e-herd-find", ["herd", "out"], ["find", "points"]),

      // colour
      edge("e-dish-chem", ["dish", "out"], ["chem", "input"]),
      edge("e-chem-look", ["chem", "out"], ["look", "in1"]),
      edge("e-eat-look", ["eat", "out"], ["look", "in2"], 0),
      edge("e-look-tint", ["look", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-liftscout", ["tint", "out"], ["liftScout", "in1"]),
      edge("e-scout-liftscout", ["scout", "out"], ["liftScout", "in2"], 0),
      edge("e-liftscout-liftgraze", ["liftScout", "out"], ["liftGraze", "in1"]),
      edge("e-graze-liftgraze", ["graze", "out"], ["liftGraze", "in2"], 0),
      edge("e-liftgraze-liftfind", ["liftGraze", "out"], ["liftFind", "in1"]),
      edge("e-find-liftfind", ["find", "out"], ["liftFind", "in2"], 0),
      edge("e-liftfind-halo", ["liftFind", "out"], ["halo", "input"]),
      edge("e-halo-burn", ["halo", "out"], ["burn", "in1"]),
      edge("e-liftfind-burn", ["liftFind", "out"], ["burn", "in2"], 0),
      edge("e-burn-mixtrail", ["burn", "out"], ["mixTrail", "in1"]),
      edge("e-loop-mixtrail", ["loop", "out"], ["mixTrail", "in2"], 0),
      edge("e-mixtrail-hue", ["mixTrail", "out"], ["hue", "input"]),
      edge("e-hue-spin", ["hue", "out"], ["spin", "input"]),
      edge("e-spin-out", ["spin", "out"], ["out", "input"]),
    ],
  ),
);

/* The MASS's grid — recovered at T724 with the mass itself. 208x160 with wrapU, so the
   longitude seam closes and the blob has no slit down it. */
const OBOL_COLS = 208;
const OBOL_ROWS = 160;
const OBOL_POINTS = OBOL_COLS * OBOL_ROWS;

/**
 * THE TILES. 1728 of them since T716, and the number is a size rather than a taste. A
 * phyllotaxis lattice of N tiles over a face of radius 0.888 has a hexagonal pitch of
 * 1.0746*sqrt(pi*0.888^2/N), so 1728 gives 0.0407 — and a 0.038 tile then closes to 93.4%
 * of its own spacing: a 6.6% gutter, about 26 screen pixels of tile and 2 of gutter at
 * 1280x720. BOTH bounds are load-bearing now that there is no bed behind the mosaic
 * (T716): past about 115% the tiles interpenetrate and the face goes back to being the
 * solid disc the owner asked us to remove, and below about 60% it is confetti. The count
 * itself only sets how finely the dividing curve is drawn — the coverage is the ratio.
 */
const OBOL_SEG_COLS = 54;
const OBOL_SEG_ROWS = 32;
const OBOL_SEG_POINTS = OBOL_SEG_COLS * OBOL_SEG_ROWS;

/**
 * E33's SHARED WGSL. One definition of the emblem's field, the melt's order and the goo's
 * field, pasted into BOTH kernels below. T673 shared it so a tile could not hover off the
 * face it was inlaid into; T724 gives it a second and harder job, because the mass now
 * has to GROW under an arriving tile at the moment that tile lands, which means both
 * kernels have to agree about the tile's station, its order in the wave and where the
 * goo's surface is. Two copies of that arithmetic is two chances for the skin to
 * materialise somewhere the tiles are not.
 */
const OBOL_PRELUDE = `const TAU: f32 = 6.28318530717958647692;
const PI: f32 = 3.14159265358979323846;

fn ihash(cell: vec3i) -> f32 {
  let q = vec3u(cell + vec3i(4096));
  var n = (q.x * 1597334673u) ^ (q.y * 3812015801u) ^ (q.z * 2246822519u);
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  return f32(n ^ (n >> 16u)) * 2.3283064e-10;
}

fn vnoise(p: vec3f) -> f32 {
  let base = floor(p);
  let f = p - base;
  let w = f * f * (3.0 - 2.0 * f);
  let c = vec3i(base);
  let x00 = mix(ihash(c + vec3i(0, 0, 0)), ihash(c + vec3i(1, 0, 0)), w.x);
  let x10 = mix(ihash(c + vec3i(0, 1, 0)), ihash(c + vec3i(1, 1, 0)), w.x);
  let x01 = mix(ihash(c + vec3i(0, 0, 1)), ihash(c + vec3i(1, 0, 1)), w.x);
  let x11 = mix(ihash(c + vec3i(0, 1, 1)), ihash(c + vec3i(1, 1, 1)), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z) * 2.0 - 1.0;
}

fn fbm(p: vec3f) -> f32 {
  return vnoise(p) * 0.74 + vnoise(p * 2.07 + vec3f(19.1, 7.3, 31.7)) * 0.20
       + vnoise(p * 4.19 + vec3f(41.7, 63.1, 11.9)) * 0.06;
}

fn spectrum(t: f32) -> vec3f {
  var stops = array<vec3f, 6>(
    vec3f(0.014, 0.020, 0.058),
    vec3f(0.048, 0.098, 0.290),
    vec3f(0.235, 0.086, 0.372),
    vec3f(0.556, 0.108, 0.276),
    vec3f(0.812, 0.372, 0.104),
    vec3f(0.972, 0.836, 0.560),
  );
  let x = clamp(t, 0.0, 1.0) * 5.0;
  let lo = u32(floor(x));
  let hi = min(lo + 1u, 5u);
  return mix(stops[lo], stops[hi], x - floor(x));
}

fn taiji(p: vec2f) -> f32 {
  let e = 0.030;
  let dTop = distance(p, vec2f(0.0, 0.5));
  let dBot = distance(p, vec2f(0.0, -0.5));
  var tone = smoothstep(-e, e, p.x);
  tone = max(tone, smoothstep(e, -e, dTop - 0.5));
  tone = min(tone, smoothstep(-e, e, dBot - 0.5));
  tone = min(tone, smoothstep(-e, e, dTop - 0.142));
  tone = max(tone, smoothstep(e, -e, dBot - 0.142));
  return tone;
}

/* ---- THE ORDER OF THE MELT, in the emblem's own disc coordinate. Built from the two
   circles the S-curve is built from, so the front LEAVES THE SEAM and travels outward.
   The mass and the segments both read it, so a tile lifts exactly as the surface under
   it goes soft. */
fn meltOrder(d: vec2f) -> f32 {
  let arcTop = distance(d, vec2f(0.0, 0.5)) - 0.5;
  let arcBot = distance(d, vec2f(0.0, -0.5)) - 0.5;
  return clamp(min(abs(arcTop), abs(arcBot)) / 0.42, 0.0, 1.0) * 0.6 + length(d) * 0.4;
}

/* ---- THE GOO, as a FOUR-CHARGE METABALL. This is the answer to "still too much like a
   sphere", and the reason it is a field rather than more noise: displacement on a sphere
   changes TEXTURE, and the eye reads shape from the OUTLINE. Only a low-frequency term
   moves the outline, so the lobes are the whole point and the noise below is a skin.
   The CORE charge is load-bearing: without it the three lobes separate and a ray from
   the origin misses entirely, which is a radius of zero and a torn mesh. */
fn gooCentre(k: u32, t: f32) -> vec3f {
  var dirs = array<vec3f, 3>(
    vec3f( 0.895,  0.264,  0.113),
    vec3f(-0.680, -0.566,  0.321),
    vec3f( 0.039,  0.877, -0.479),
  );
  let d = dirs[k] * 0.66;
  let a = t * 0.115 + f32(k) * 2.094;
  return vec3f(
    d.x * cos(a) - d.z * sin(a),
    d.y + 0.10 * sin(t * 0.21 + f32(k) * 1.7),
    d.x * sin(a) + d.z * cos(a),
  );
}

fn gooField(p: vec3f, t: f32) -> f32 {
  var weights = array<f32, 3>(0.130, 0.107, 0.081);
  var f = 0.085 / max(dot(p, p), 1e-5);
  for (var k = 0u; k < 3u; k = k + 1u) {
    let d = p - gooCentre(k, t);
    f = f + weights[k] / max(dot(d, d), 1e-5);
  }
  return f;
}

/* The radius along s where the field crosses 1, found from the OUTSIDE IN. A bracketed
   bisection would converge on whichever crossing it happened to trap, and a ray through
   three charges can cross three times — neighbouring directions landing on different
   crossings is a CRACK in the mesh. Scanning inward always takes the outermost. */
fn gooRadius(s: vec3f, t: f32) -> f32 {
  let top = 1.70;
  let step = top / 30.0;
  var lo = 0.0;
  var hi = 0.0;
  for (var i = 1u; i <= 30u; i = i + 1u) {
    let r = top - f32(i) * step;
    if (gooField(s * r, t) > 1.0) { lo = r; hi = r + step; break; }
  }
  if (hi == 0.0) { return 0.10; }
  for (var j = 0u; j < 7u; j = j + 1u) {
    let mid = (lo + hi) * 0.5;
    if (gooField(s * mid, t) > 1.0) { lo = mid; } else { hi = mid; }
  }
  return (lo + hi) * 0.5;
}

/* The goo's surface point along s: the lobed radius, a small high-frequency skin (texture,
   NOT outline), and a differential sag so the thing hangs rather than floats. */
fn gooAt(s: vec3f, t: f32) -> vec3f {
  let r = gooRadius(s, t) * (1.0 + 0.050 * fbm(s * 2.60 + vec3f(0.0, t * 0.090, 0.0)));
  var g = s * r;
  g.y = g.y - 0.105 * (1.0 - s.y * 0.55);
  g.x = g.x + 0.045 * sin(t * 0.27);
  return g;
}

/* The medallion's own tilt — 17 degrees, so the rim bevel is on screen as a lit edge and
   a disc seen dead-on cannot be mistaken for a sphere. Shared: a tile that did not wear
   the same tilt would float off the face it is inlaid into. */
fn emblemTilt(p: vec3f) -> vec3f {
  let tilt = 0.30;
  return vec3f(p.x, p.y * cos(tilt) - p.z * sin(tilt), p.y * sin(tilt) + p.z * cos(tilt));
}

/* The object's slow yaw. On the ABSOLUTE clock and applied last, to both readings. */
fn obolYaw(p: vec3f, t: f32) -> vec3f {
  let yaw = 0.21 * sin(t * 0.185);
  return vec3f(p.x * cos(yaw) + p.z * sin(yaw), p.y, -p.x * sin(yaw) + p.z * cos(yaw));
}

/* ---- THE STAGING. A sine never HOLDS, and a morph the eye cannot register the ends of
   reads as a crossfade. Squeezing the drive to the middle of the LFO's travel parks the
   piece at each configuration for about a third of the cycle each and spends the rest
   travelling — so there is a medallion, then an event, then a goo. */
fn meltDrive(v: f32) -> f32 {
  return smoothstep(0.18, 0.82, v);
}
`;

/**
 * THE MASS — the organic blob, and ONLY the blob (T724). Its emblem configuration is
 * deleted: the coin behind the mosaic was the disc the owner objected to, and it was the
 * only thing this kernel drew at the emblem end. What is left is the shape the whole piece
 * morphs onto, plus the rule for when it is there.
 */
const OBOL_KERNEL = `${OBOL_PRELUDE}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  let lon = f32(ctx.dim.i) / f32(ctx.dim.cols) * TAU;
  let lat = f32(ctx.dim.j) / f32(max(ctx.dim.rows - 1u, 1u)) * PI;
  let s = vec3f(sin(lat) * cos(lon), sin(lat) * sin(lon), cos(lat));

  /* T724 — THE MASS IS ONLY THE GOO, AND IT GROWS INTO EXISTENCE UNDER THE TILES.
     Its emblem configuration is deleted: the coin behind the mosaic was the disc the
     owner asked us to remove (T716), and it was the only thing this kernel did at the
     emblem end. What is left is the organic blob — which is the gimmick — plus the rule
     for when it is there. */

  /* WHICH TILE LANDS HERE. The tiles walk a Fibonacci sphere whose latitude is z = 1 - 2u
     against a Fibonacci disc of radius 0.930*sqrt(u), and both share their azimuth — so
     the disc station of the tile arriving along s is recoverable exactly, and this
     surface can be told to appear ON THAT TILE'S OWN CLOCK. That is what makes the fuse
     read as one event instead of two: the skin materialises under a tile at the moment
     the tile reaches it, not on a schedule of its own. */
  let ax = vec2f(s.x, s.y);
  let axLen = length(ax);
  /* the pole is one point with no azimuth; give it its neighbours' RADIUS rather than
     the disc centre's, or it grows first while everything around it grows last and the
     mesh leaves a spike standing at the south pole. */
  let dir2 = select(vec2f(1.0, 0.0), ax / max(axLen, 1e-6), axLen > 1e-4);
  let station = dir2 * (0.930 * sqrt(max(0.0, (1.0 - s.z) * 0.5)));

  let order = meltOrder(station);
  let drive = meltDrive(ctx.value1);
  let front = clamp(drive * 2.35 - order * 1.35, 0.0, 1.0);
  let melt = front * front * (3.0 - 2.0 * front);

  /* A BUD, not a switch. The radius runs from a speck to the field's own value on the
     same front the tiles ride, so the drop swells out of the seam under the arriving
     mosaic. melt is smooth in s, so the surface stays star-shaped about the origin
     at every intermediate size and nothing tangles. The floor is not zero: a mesh
     collapsed to a point has no normals, and 0.010 is a speck 2px across at 1280x720,
     behind the mosaic that is still standing in front of it. */
  q.position = obolYaw(gooAt(s, ctx.absTime) * mix(0.010, 1.0, melt), ctx.absTime);

  /* ONE WET BLACK THING. There is no emblem configuration left to travel from, so there
     is no rest tone here any more — the tiles carry the emblem, all of it. What the
     mass keeps is the halved marbling that stops the oil reading as flat paint, and the
     spectrum on the growth front, which is what makes the skin look like it is forming
     rather than being revealed. */
  let tone = taiji(station);
  let oil = mix(vec3f(0.0125, 0.0120, 0.0195), vec3f(0.0335, 0.0315, 0.0290), tone);
  let band = 1.0 - abs(melt * 2.0 - 1.0);
  let irid = spectrum(fract(order * 1.85 + ctx.value2 + tone * 0.18));
  let colour = oil + irid * band * band * 0.26 * (1.0 - tone * 0.55);
  q.tint = vec4f(colour, 1.0);
  return q;
}`;

/* THE TILES. The owner's own idea, and after T716/T724 it is the emblem end's ONLY
   substance: the medallion is not decorated with tiles and it is not a disc with tiles on
   it, it IS the tiles. That is what the owner asked for — "the obol thing should not have
   the disc behind the cubes assembling the yinyang" — and the mass is grown down to a
   speck there rather than merely hidden, so that dropping `body1` from the render changes
   ZERO pixels of the emblem frame.

   AND THE GOO END IS THE ORGANIC BLOB, which is the gimmick (T724). The tiles do not have
   to BE the drop — a drop made of cubes is the thing the owner did not ask for. They travel
   ONTO it and FUSE into it, which is a better event than either end alone: the mosaic opens,
   the skin buds out underneath, and each tile lands on the surface and settles just inside
   it. Discrete becoming continuous.

   THE MAP IS WHAT MAKES THE FUSE LEGIBLE. The disc layout is a Fibonacci lattice
   (`rr = sqrt(u)`, `ang = i*137.5deg`) and the Fibonacci SPHERE is the same sequence read
   with `z = 1 - 2u`. Every tile keeps its azimuth exactly, the centre of the face goes to
   one pole and the rim to the other, and the density is area-uniform at both ends — so an
   individual tile can be FOLLOWED across the change rather than being re-dealt, and the
   mass can invert that map to grow on the arriving tile's own clock. */
const OBOL_SEG_KERNEL = `${OBOL_PRELUDE}
/* Stable per-segment noise. NOT pointRand: that hash is salted with the FRAME index by
   contract, so a "random" draw taken per point changes every frame — a per-element
   constant has to come from the element's own index. */
fn segRand(i: u32, salt: u32) -> f32 {
  var n = (i * 1597334673u) ^ (salt * 2246822519u);
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  return f32(n ^ (n >> 16u)) * 2.3283064e-10;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* PHYLLOTAXIS, not a grid. A polar lattice crowds at the centre and a square one leaves
     a stepped rim; the golden angle gives even spacing at every radius, so the tile size
     can be one number and the mosaic still has no seam. */
  let n = f32(max(ctx.count, 1u));
  let u = (f32(ctx.index) + 0.5) / n;
  let ang = f32(ctx.index) * 2.39996323;
  let rr = sqrt(u) * 0.930;
  let disc = vec2f(rr * cos(ang), rr * sin(ang));

  /* CONFIGURATION A — the tile IS the medallion. There is no bed behind it (T716): the
     face, the two tones and the dividing curve are carried by the tiles ALONE, and the
     mass is grown down to a speck at this end of the morph so that the disc the owner
     objected to genuinely is not there. Measured: dropping body1 from the render
     changes ZERO pixels of the emblem frame. The small height jitter is what keeps the
     tiles reading as laid pieces rather than as one plate, and it is what the key light's
     shadow and the occlusion pass bite on. */
  let face = sqrt(max(0.0, 1.0 - dot(disc, disc)));
  let plateau = smoothstep(0.0, 0.36, face);
  let relief = plateau * 0.125 + 0.030 + 0.008 * segRand(ctx.index, 47u);
  let emblem = emblemTilt(vec3f(disc.x, disc.y, relief) * 0.955);

  /* CONFIGURATION B — the SAME tile's place on the goo's SKIN. The disc's golden-angle
     layout is a Fibonacci lattice and the Fibonacci SPHERE is that same sequence read with
     z = 1 - 2u, so this map keeps every tile's AZIMUTH exactly, sends the centre of the
     face to one pole and the rim to the other, and is area-uniform at both ends. One tile,
     one continuous journey, and an eye can follow it the whole way. */
  let zc = 1.0 - 2.0 * u;
  let ring = sqrt(max(0.0, 1.0 - zc * zc));
  let sdir = vec3f(ring * cos(ang), ring * sin(ang), zc);

  let order = meltOrder(disc);
  let drive = meltDrive(ctx.value1);
  let front = clamp(drive * 2.35 - order * 1.35, 0.0, 1.0);
  let melt = front * front * (3.0 - 2.0 * front);

  /* THE MASS IS BACK AT THIS END (T724), so the tiles no longer have to BE the skin —
     they LAND on it. They ride a little proud of the field's own radius while the front
     passes, which is what lets the eye follow one cube all the way in, and then settle
     just under it: a tile drawn ON an oil drop is a barnacle, a tile drawn just inside it
     is a tile that has fused. The drop is at full size again — T716 shrank it to 0.620
     because 1728 fixed-size tiles could not cover a sphere twice the area of the face,
     and with a surface under them that constraint is gone — which is the whole reason the
     goo end is an ORGANIC BLOB again rather than a blob made of cubes. */
  let sink = mix(1.030, 0.880, smoothstep(0.45, 1.0, front));
  let goo = gooAt(sdir, ctx.absTime) * sink;

  /* The ARC. Straight-line travel between two configurations is a crossfade with extra
     steps; lifting each tile off its own normal at the half-way point makes the change a
     FLIGHT, and the band peaks exactly where the wave is passing. */
  let band = 1.0 - abs(melt * 2.0 - 1.0);
  let lift = normalize(emblem - vec3f(0.0, -0.12, 0.0)) * band * band * (0.16 + 0.10 * segRand(ctx.index, 29u));

  q.position = obolYaw(mix(emblem, goo, melt) + lift, ctx.absTime);

  /* THE TWO HALVES ARE THE TILES' OWN COLOUR — at the emblem end there is nothing under
     them to carry the S-curve, so the emblem is legible only if this tone survives at
     tile resolution. Measured rather than hoped: see the gate in examples.gpu.test.ts. */
  let tone = taiji(disc);
  let porcelain = vec3f(0.400, 0.388, 0.360);
  let ink = vec3f(0.0180, 0.0205, 0.0295);
  let oil = mix(vec3f(0.0125, 0.0120, 0.0195), vec3f(0.0335, 0.0315, 0.0290), tone);
  let irid = spectrum(fract(order * 1.85 + ctx.value2 + tone * 0.18));
  let colour = mix(mix(ink, porcelain, tone), oil, melt) + irid * band * band * 0.34 * (1.0 - tone * 0.55);
  q.tint = vec4f(colour, 1.0);
  return q;
}`;

const OBOL_SWEEP_COLS = 64;
const OBOL_SWEEP_ROWS = 96;
const OBOL_SWEEP_POINTS = OBOL_SWEEP_COLS * OBOL_SWEEP_ROWS;

/**
 * The studio itself: a CYCLORAMA, not a floor. A floor ends, and its far edge lands
 * inside a 42° frame as a hard horizon with black above it — which is the "floating
 * torus and no screen" failure of §V383 wearing a different hat. Curving the same grid
 * up into a cove removes the horizon entirely and gives the key light something to
 * throw a shadow onto.
 */
const OBOL_SWEEP_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let across = p.position.x * 19.0;
  let run = (p.position.y * 0.5 + 0.5);
  let depth = 2.5 - run * 23.0;
  let rise = clamp((-2.0 - depth) / 16.0, 0.0, 1.0);
  q.position = vec3f(across, -1.04 + 14.0 * rise * rise, depth);
  return q;
}`;

/**
 * E33 — Obol (T625/T624, reworked T673, T716, T724).
 *
 * WHAT YOU SEE. A yin-yang medallion — SEVENTEEN HUNDRED little tiles and nothing behind
 * them — turns slowly on a dark studio sweep under two softboxes it can see in itself. It
 * holds. Then its dividing curve goes soft, and the tiles lift off the face in a wave that
 * leaves the seam and travels outward, arc, and close again around a three-lobed drop of
 * black oil that pinches between its lobes and hangs. It holds there too. Then the whole
 * thing runs backwards and the medallion reassembles, tile by tile. One sixteen-second
 * breath, both directions.
 *
 * **The morph is a deformation with a FRONT, not a cross-fade.** Every tile carries two
 * configurations — a place on the medallion and a place on the goo — and ONE rule decides
 * how far along it has travelled, from its distance to the emblem's own dividing curve.
 * The seam melts first and re-forms last, so the picture is always ONE object changing
 * shape. A cross-fade at 50% shows a ghost of both; this shows a medallion whose middle
 * has already gone liquid while its rim is still a hard edge, and its own tiles in the air
 * between the two states.
 *
 * **T716: nothing is behind the tiles AT THE EMBLEM END.** The owner, on the T673 build:
 * "the obol thing should not have the disc behind the cubes assembling the yinyang". The
 * mass's coin configuration is deleted and the mass itself is grown down to a speck there,
 * so the tiles are the only thing drawing the medallion. THE MEASUREMENT THAT SAYS WHY:
 * shrink the tiles to `scale 0.007` and the T673 file's emblem is STILL a legible yin-yang
 * (the smaller of its two tone populations holds 41.3% of the object) because the disc was
 * drawing it, while this one collapses to 19.1%. That is the owner's complaint stated
 * arithmetically, and it is why the emblem's legibility is now measured rather than
 * assumed — 45.6% / 129.6 luma of tone contrast / 17.4% straight-line error.
 *
 * **T724: and the goo end is the ORGANIC BLOB, which is the gimmick.** T716 read the note
 * as "the mass must go" and made the goo end a blob built of cubes; the owner: "obol is
 * supposed to morph onto the organic blob not a blob made up of cubes thats the whole
 * gimmick on top of the reorg". The complaint was only ever about the EMBLEM end. So the
 * mass is back at the goo end and FADES IN as the morph runs, with the tiles landing on
 * its surface and settling just inside it — discrete becoming continuous, which is a
 * better event than either end alone and is what makes a cube followable all the way in.
 * Measured: dropping `body1` changes 0 pixels of the emblem frame and 106,056 of the goo
 * frame, and the goo end's object-to-room separation recovers to 41.7 luma — past T716's
 * 31.6 and past T673's own 38.4, because the gutters the tiles used to show through are
 * now closed by a skin.
 *
 * ## What T673 changed, and why each was a defect rather than a preference
 *
 * The owner's verdict was "not looking interesting enough… the morph does not read too
 * well and the target is still too much like a sphere". Four things, three of them
 * measurable.
 *
 * **"TOO MUCH LIKE A SPHERE" WAS A SILHOUETTE FAULT, NOT A SHADING ONE.** The eye reads
 * shape from the OUTLINE, and high-frequency displacement changes surface TEXTURE while
 * leaving the outline circular — so a sphere with noise on it stays a sphere however well
 * it is lit. The goo is now a FOUR-CHARGE METABALL: three lobes far enough apart that the
 * surface between them pinches, plus a core charge that keeps the form star-shaped about
 * the origin so no ray from the centre misses and no radius collapses to zero. Measured
 * over 12 orbit angles x 5 moments, on the same 208x160 directions the kernel uses:
 *
 *   | silhouette                       | shipped | T673  | perfect sphere |
 *   | -------------------------------- | ------- | ----- | -------------- |
 *   | radius CV vs angle (mean)        | 0.086   | 0.234 | 0.000          |
 *   | radius CV vs angle (WORST angle) | 0.049   | 0.191 | 0.000          |
 *   | convexity deficit (mean)         | 0.0054  | 0.049 | 0.000          |
 *   | max/min radius (mean)            | 1.375   | 2.171 | 1.000          |
 *
 * The row that matters is the second: T673's WORST orbit angle is more non-circular than
 * the shipped file's BEST one, so this is a shape that is lobed from everywhere rather
 * than from the angle somebody happened to render.
 *
 * **THE MORPH DID NOT READ BECAUSE ITS ENDPOINTS WERE TOO ALIKE.** A morph is legible in
 * proportion to the distance between its two ends, and the shipped goo kept the emblem's
 * two tones as marbling over a smooth ball — so the verb was "the disc inflates". Both
 * ends were pushed apart: the emblem is flatter (a 0.36 bevel where it was 0.72, so the
 * face is a plateau to within 6% of the rim rather than a dome) and made of hard-edged
 * parts; the goo is lobed, self-occluding, and its marbling is halved so the mass can be
 * one wet black thing. The memory of the emblem is carried by the SLABS instead, which
 * travel — and travel is something an eye can follow.
 *
 * And the transition is STAGED. `meltDrive` squeezes the LFO's travel into its middle
 * (smoothstep 0.18..0.82 where it was 0.06..0.94), so the piece parks at each
 * configuration for about a third of the cycle and spends the rest moving: there is a
 * medallion, then an EVENT, then a goo, rather than a continuous ooze the eye reads as a
 * dissolve.
 *
 * **THE EMBLEM IS NOW MADE OF PARTS** — the owner's own idea, and the strongest one in
 * the note. `segs1` is a second point system whose 720 slabs are laid out by golden angle
 * (a polar lattice crowds at the centre; a square one leaves a stepped rim), each wearing
 * its own piece of `taiji` and each melting on the same `meltOrder` wave the mass melts
 * on, so a slab lifts exactly as the surface under it goes soft. Two things fall out of
 * it that a single smooth body could not give: motion becomes readable PER ELEMENT, and
 * the gutters between slabs are real geometry for the shadow pass and the occlusion pass
 * to bite on.
 *
 * **THE LIGHTING WAS FLAT BECAUSE THE AMBIENT WAS DOING THE WORK.** 0.62 of ambient
 * against 0.26 of key is a rig with its contrast turned off — and ambient is the one term
 * that cannot describe a shape, as well as being the term AO multiplies. Ambient is now
 * 0.20, the key is 0.55 and casts over a wider volume, the room's albedo is down to 46%
 * of what it was, and the sky is dimmed to 42% while the softboxes keep their brightness
 * and grow. Measured against a render of the same frame with the object removed, on the
 * DISPLAY-ENCODED output (§V618, and the space read off the plan per §V470):
 *
 *   | goo frame (484)                        | shipped | T673 |
 *   | -------------------------------------- | ------- | ---- |
 *   | object median luma                     | 60.7    | 72.5 |
 *   | backdrop median luma                   | 62.3    | 34.3 |
 *   | separation                             | 1.6     | 38.2 |
 *   | p99 (the highlight)                    | 127.4   | 196.7|
 *   | object pixels within 12 luma of backdrop| 36.2%  | 15.3%|
 *
 * A separation of 1.6 luma is §V618's "dark blob" in the shipped file's own pixels: the
 * goo was carried by its cast shadow and nothing else.
 *
 * Both columns measured at 154ddf1, minutes apart on one tree (§V641) — an absolute with
 * no commit behind it cannot be told apart from a table stale since authoring, which is
 * T689. The silhouette table above is exempt: it is computed from the kernel's own
 * arithmetic in TypeScript and never rendered, so no shader change can move it.
 *
 * ## The rim is not a light, and that is a fact about this renderer
 *
 * "Rim light" is the standard answer to "make it look wet", and it is unavailable here:
 * the diffuse term is TWO-SIDED by rule (`lambert = abs(dot(N, L))`, T301) and so is the
 * highlight, so a directional light behind the subject lights the faces pointing at the
 * camera exactly as hard as the ones pointing away. One at 1.60 blew the emblem's light
 * half to white and produced no edge at all.
 *
 * What rims in this engine is the environment's Schlick term (T632): `envFresnel` rises
 * to 1 at grazing, and at grazing the reflection vector points away from the camera — so
 * the silhouette samples the equirect at its horizon, (0.5, 0.5), where nothing had ever
 * been put. `rimband1` is that texel — and it is a RIM ON THE GOO and a FILL ON THE
 * EMBLEM, which is the Fresnel term working rather than a compromise: on the goo frame
 * the silhouette ring moves 45.8 luma against the body's 25.9, and on the emblem frame
 * 14.5 against 19.5. A flat disc facing the camera has almost no grazing surface for a
 * Fresnel rim to land on, which is the same fact as "the emblem end is flat".
 *
 * ## Graph
 *
 *   ramp ─┐
 *  circle ─┤ add ── environment
 *  circle ─┤  │                    ┌── level ── limit ── blur ──┐
 *  circle ─┘  │                    │                            │
 *             ▼                    │                            add ── output
 *  pointTube ── pointKernel ── geometry (surface) ─┐             │
 *   (grid,wrapU)   (morph1)        (body1)         │             │
 *                                                  ├── render ───┘
 *  pointGrid ── pointKernel ── geometry (instances)│   ▲  ▲
 *   (segpts1)     (segs1)         (shards1)        │   │  └── camera
 *                                                  │   └── 3 lights
 *  pointGrid ── pointKernel ── geometry (surface) ─┘
 *   (sweeppts1)   (sweep1)         (cyc1)
 *
 * ## What it took from §V471, and where
 *
 *  - **§V471.1/.2 — the kernel writes what selection reads.** Corona's cloud is split
 *    three ways by a group predicate over an attribute its kernel wrote. Here the split
 *    is between two READINGS of the same idea — a continuous mass and a set of discrete
 *    parts — and the thing both of them read is the same free attribute: `meltOrder`, the
 *    distance to the emblem's dividing curve, which the shape already knows. It decides
 *    the colour, the order the surface melts in AND the order the slabs leave, which is
 *    why they agree without either one being told about the other.
 *  - **§V471.3 / §V477 — gain and bias per band.** One source (`tide1`) drives three
 *    properties, each through its OWN multiply→add pair rather than one shared knob:
 *    AO intensity 0.55→1.45, environment intensity 1.00→1.85, roughness 0.190→0.085.
 *    Every one rests where the eye expects calm and travels toward the interesting end.
 *  - **§V471.6/.8 — a ramp that goes somewhere, on a long cycle.** Six stops
 *    (midnight, indigo, violet, magenta, amber, gold) worn by the melt FRONT only — now
 *    by the slabs' fronts as well as the surface's, so the travelling parts are the
 *    coloured ones. Its phase turns on a 0.011 Hz LFO: 91 seconds a lap, and unlike the
 *    file §V471.8 was measured from this amplitude IS in its target's units.
 *
 * ## Clock
 *
 * The kernels read `ctx.absTime` only — the goo's field, its turn, its drift and the
 * object's YAW all ride the absolute clock, so nothing snaps at a timeline lap (§V437).
 * The morph rides an LFO, free-running for the same reason. The yaw is the one motion
 * that does not come through the value graph, and it is there because a value-graph-only
 * piece is a still frame wherever no resolver runs — the cook oracle caught exactly that.
 *
 * ## What is still not here
 *
 * A per-instance SCALE or ORIENTATION. The instanced path carries one `instance.x` for
 * the whole draw and per-point position and tint, nothing else — so every slab is the
 * same size and the same way up. That reads as a deliberate tiling here, and it is worth
 * knowing rather than discovering: a mosaic that wanted to tumble as it flew would need a
 * node-level change, not a parameter.
 *
 * Soft shadow edges. The cast shadow is hard, because the catalogue's lights are point
 * and directional and an area source is a different feature (§V328 — state it, never
 * promise the hardware).
 */
const obolDocument = document(
  "e33-obol",
  "E33 Obol",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 33 }),
  graph(
    [
      /* ---- the studio, as an equirect environment ---------------------------- */
      node(
        "sky",
        "ramp", [-2400, -1200],
        {
          type: "vertical",
          interp: "smooth",
          phase: 0,
          period: 1,
          stops: [
            /* DIMMED to 42% of what shipped (T673), and the reason is what the sky is
               FOR here. It is not a backdrop — nothing draws it — it is the environment
               map, and its widest reader is the irradiance tap: five samples over a broad
               cone along N, which is a DIFFUSE fill. A bright sky therefore lifts a
               near-black oil to putty grey no matter how dark its albedo, and no amount
               of tuning the albedo gets it back, because the fill scales with the sky and
               not with the surface. Dim the room and leave the softboxes where they are:
               the reflections keep their brightness, the fill goes away, and what is left
               is the ratio the eye reads as GLOSS rather than the level it reads as
               exposure. Measured on the goo frame: the body's median falls to 38 luma
               above its backdrop where it used to sit 1.6 luma above it. */
            { position: 0, color: [0.277, 0.302, 0.361, 1] },
            { position: 0.4, color: [0.071, 0.080, 0.109, 1] },
            { position: 0.62, color: [0.025, 0.027, 0.036, 1] },
            { position: 1, color: [0.013, 0.013, 0.016, 1] },
          ],
        },
        { label: "sky1", definitionVersion: 2 },
      ),
      node(
        "keyBox",
        "circle", [-2400, -740],
        {
          mode: "fill",
          center: [0.46, 0.265],
          /* GROWN (T673). On a slick surface the visually load-bearing part of a softbox
             is its REFLECTION, and a 0.150 x 0.052 ellipse reflects as a glint. A box
             this size reads as a broad shape TRAVELLING across the form as it turns,
             which is the half of "wet" a tighter specular cannot supply. */
          radius: [0.280, 0.130],
          softness: 0.22,
          fillcolor: [1, 1, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: false,
        },
        { label: "keybox1" },
      ),
      node(
        "fillBox",
        "circle", [-2400, -280],
        {
          mode: "fill",
          center: [0.715, 0.375],
          radius: [0.110, 0.220],
          softness: 0.26,
          fillcolor: [0.62, 0.74, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: false,
        },
        { label: "fillbox1" },
      ),
      /*
       * THE RIM, and the whole point is that it is NOT A LIGHT.
       *
       * This renderer's diffuse term is TWO-SIDED by rule — `lambert = abs(dot(N, L))`,
       * T301, and the highlight is `abs(dot(N, H))` beside it — so a directional light
       * placed behind the subject lights the faces pointing AT the camera exactly as hard
       * as the ones pointing away. A back light here is a second key wearing a rim's
       * name; one at intensity 1.60 blew the emblem's light half to white and produced no
       * edge at all.
       *
       * What DOES rim in this engine is the environment's Schlick term (T632).
       * `envFresnel` rises to 1 at grazing incidence, and at grazing the reflection
       * vector points AWAY from the camera — so the silhouette reflects the equirect at
       * (0.5, 0.5), its horizon dead centre, and until now there was nothing there but
       * the dim end of the sky ramp. This band is that texel.
       *
       * WHAT IT ACTUALLY DOES, measured rather than claimed — it is a rim on the GOO and
       * a fill on the EMBLEM, and the difference is the Fresnel term doing its job. Mean
       * |delta| luma with the band wired vs unwired, split by a 6px erosion of the object
       * mask: on the goo frame the silhouette ring moves 45.8 against the body's 25.9
       * (1.8x, a rim); on the emblem frame the ring moves 14.5 against the body's 19.5
       * (fill, not a rim). A flat disc facing the camera has almost no grazing surface,
       * so there is nothing there for a Fresnel rim to land on — which is the same fact
       * as "the emblem end is flat" wearing a different hat. The room moves under 3 luma
       * either way.
       */
      node(
        "rimBand",
        "circle", [-2400, 180],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.500, 0.160],
          softness: 0.55,
          fillcolor: [0.74, 0.84, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: false,
        },
        { label: "rimband1" },
      ),
      node("studio", "add", [-2080, -740], {}, { label: "studio1" }),

      /* ---- the emblem / the goo ---------------------------------------------- */
      node(
        "shell",
        "pointTube", [-2080, 200],
        { count: OBOL_POINTS, cols: OBOL_COLS, rows: OBOL_ROWS, radius: 1, sizeZ: 2 },
        { label: "shell1" },
      ),
      node(
        "morph",
        "pointKernel", [-1760, 200],
        {
          capacity: OBOL_POINTS,
          seed: 33,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
          ]),
          kernel: OBOL_KERNEL,
        },
        {
          label: "morph1",
          parameters: {
            value1: drivenSlot("tide1", 0),
            value2: drivenSlot("sheen1", 0.5),
          },
        },
      ),
      node(
        "oil",
        "materialPhong", [-1760, -260],
        { color: [1, 1, 1, 1], specular: [1, 0.97, 0.93, 1], shininess: 300, roughness: 0.190 },
        { label: "oil1", parameters: { roughness: drivenSlot("glossrest1", 0.190) } },
      ),
      node(
        "body",
        "geometry", [-1440, 200],
        { mode: "surface", material: "oil1", tint: [1, 1, 1, 1] },
        {
          label: "body1",
          parameters: {
            tint: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                map: { kind: "map", attribute: "tint" },
              },
            },
          },
        },
      ),

      /* ---- the tiles: the emblem, and the mosaic that fuses into the goo ------- */
      node(
        "segPts",
        "pointGrid", [-2080, 1280],
        { count: OBOL_SEG_POINTS, cols: OBOL_SEG_COLS, rows: OBOL_SEG_ROWS, sizeX: 2, sizeY: 2 },
        { label: "segpts1" },
      ),
      node(
        "segs",
        "pointKernel", [-1760, 1280],
        {
          capacity: OBOL_SEG_POINTS,
          seed: 33,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
          ]),
          kernel: OBOL_SEG_KERNEL,
        },
        {
          label: "segs1",
          /* One clock for one object: `tide1` is the morph and `sheen1` is the melt
             front's spectrum. There is no second kernel to keep in step any more — T716
             deleted it — so this is the whole of the object's timing. */
          parameters: {
            value1: drivenSlot("tide1", 0),
            value2: drivenSlot("sheen1", 0.5),
          },
        },
      ),
      node(
        "shards",
        /*
         * INSTANCES mode, and §V617 is why that matters rather than being a draw-call
         * detail: an instanced primitive under a LIT material CASTS, and a points-mode
         * billboard does not. These tiles wear `oil1`, so the depth sweep takes them and
         * the occlusion pass finds the gutters between them. That was worth having in
         * T673 and it is LOAD-BEARING after T716, because self-shadowing is now the only
         * thing giving the object a body — there is no mass under the mosaic to be solid
         * on its behalf. Re-measured at THIS commit with nothing else in the scene, so
         * nothing else could be casting: 22 016 pixels of the emblem frame and 11 710 of
         * the goo frame darken when the key's shadow is switched on, and BOTH go to
         * exactly 0 when the material is mutated to the unlit one. The zero is the point:
         * it is what makes the other two evidence rather than a coincidence.
         *
         * The scale is UNIFORM — this path has one `instance.x` for every point and no
         * per-point size or orientation attribute — which is what makes the mosaic read
         * as a tiling rather than as debris. Position and tint are per point; those are
         * the two the path carries. It is also the constraint that sets the goo's size:
         * one tile size has to serve a face of area 2.478 and a drop whose surface at the
         * field's natural size is 5.059, so the drop is drawn at 0.620 instead.
         */
        "geometry", [-1440, 1280],
        { mode: "instances", shape: "box", scale: 0.019, material: "oil1", tint: [1, 1, 1, 1] },
        {
          label: "shards1",
          parameters: {
            tint: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                map: { kind: "map", attribute: "tint" },
              },
            },
          },
        },
      ),

      /* ---- the cyclorama ------------------------------------------------------ */
      node(
        "sweepPts",
        "pointGrid", [-2080, 660],
        { count: OBOL_SWEEP_POINTS, cols: OBOL_SWEEP_COLS, rows: OBOL_SWEEP_ROWS, sizeX: 2, sizeY: 2 },
        { label: "sweeppts1" },
      ),
      node(
        "sweep",
        "pointKernel", [-1760, 660],
        {
          capacity: OBOL_SWEEP_POINTS,
          seed: 3,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          ]),
          kernel: OBOL_SWEEP_KERNEL,
        },
        { label: "sweep1" },
      ),
      node(
        "plaster",
        "materialPhong", [-1760, 1060],
        /* THE ROOM GOES DOWN (T673). A slick black object is separated from its backdrop
           by its HIGHLIGHT, and a highlight needs somewhere to be brighter than: on the
           goo frame the shipped file put the object's median at 60.7 luma against a
           backdrop of 62.3 — the silhouette was carried by the cast shadow and nothing
           else, and 36% of the object's pixels sat within 12 luma of the room. At 46% of
           this albedo the same frame reads 72.5 against 34.3. */
        { color: [0.085, 0.090, 0.108, 1], specular: [0.101, 0.106, 0.133, 1], shininess: 40, roughness: 0.58 },
        { label: "plaster1" },
      ),
      node("cyc", "geometry", [-1440, 660], { mode: "surface", material: "plaster1", tint: [1, 1, 1, 1] }, { label: "cyc1" }),

      /* ---- lights, camera ----------------------------------------------------- */
      node(
        "key",
        "light", [-1120, -1200],
        {
          kind: "directional",
          direction: [0.42, -0.72, -0.55],
          color: [1, 0.95, 0.88, 1],
          /* UP from 0.26 (T673). The shipped rig put 0.62 of flat ambient against 0.26 of
             key, which is a lighting setup with the contrast turned off: the shadow it
             throws is a smudge and the occlusion pass has almost nothing to darken. The
             ambient is now 0.20 and the key is the light in the room. */
          intensity: 0.55,
          shadows: true,
          /* WIDER, because the shadow volume is a box around the origin and the object it
             has to hold got bigger: the goo's lobes reach 1.1 where the medallion reached
             1.02, and the slabs arc out past both at the half-way point. */
          shadowExtent: 3.2,
        },
        { label: "key1" },
      ),
      node(
        "fill",
        "light", [-1120, -780],
        { kind: "directional", direction: [-0.85, -0.10, -0.52], color: [0.58, 0.70, 1, 1], intensity: 0.22 },
        { label: "fill1" },
      ),
      node(
        "crown",
        /*
         * A POINT light, and the choice is the whole studio. Directional lights do not
         * fall off, so three of them paint the cyclorama one flat grey and the piece
         * reads as a model on a card table. A point light attenuates by 1/(1+d^2) — a
         * POOL behind the object falling into the corners, which is the one thing a
         * backdrop has to do. The intensity looks enormous because the attenuation eats
         * it: at the object's ~3.3 units it is 1/(1+11) of what is written here.
         */
        "light", [-1120, -360],
        { kind: "point", position: [0, 2.90, -3.40], color: [0.90, 0.95, 1, 1], intensity: 14 },
        { label: "crown1" },
      ),
      node(
        "eye",
        "camera", [-1120, 100],
        { eye: [0, 0.78, 3.70], lookAt: [0, -0.10, 0], fov: 42, near: 0.1, far: 40, ortho: false },
        {
          label: "eye1",
          parameters: {
            "eye.x": drivenSlot("swing1", 0.50),
            "eye.y": drivenSlot("lift1", 0.78),
          },
        },
      ),
      node(
        "shot",
        "render", [-800, 200],
        {
          scenes: "cyc1 body1 shards1",
          camera: "eye1",
          lights: "key1 fill1 crown1",
          ambientColor: [0.62, 0.68, 0.84, 1],
          /* DOWN from 0.62 (T673). Ambient is a constant added to every surface whatever
             it faces — it is the one term that cannot describe a shape — and at 0.62 it
             was most of the light in the picture. It is also the term AO multiplies, so a
             large flat ambient is not "more occlusion to find", it is a floor the
             occlusion has to climb out of. */
          ambientIntensity: 0.20,
          background: [0.008, 0.009, 0.013, 1],
          /* T643: the STATIC value matches the driven slot's rest (1.00) — 7.00 was the
             Fresnel-era re-exposure left stranded under the slot after T636 brought the
             constant home; the driven value always won, so this row was dead and lying. */
          environmentIntensity: 1.00,
          ambientOcclusion: true,
          /* TIGHTER (T673): the occlusion now has 0.052 slabs with 0.009 gutters to bite
             on, and a 0.50 radius sweeps clean over a contact that size. */
          aoRadius: 0.34,
          aoIntensity: 0.55,
          aoQuality: "high",
        },
        {
          label: "shot1",
          parameters: {
            environmentIntensity: drivenSlot("envrest1", 1.00),
            aoIntensity: drivenSlot("aorest1", 0.55),
          },
        },
      ),

      /* ---- bloom, so the softbox highlights bleed the way a real one does ----- */
      /*
       * §V510, paid for again here: a Level's black point is a SUBTRACTION, and on a
       * float target the whole background lands at (0.0006 - 0.80) / 0.5 = -1.6. `add`
       * is front + back, so the first build of this chain SUBTRACTED a constant -1.6
       * from the picture and the frame came back black with a blown object floating in
       * it. `limit` is the node that was missing — the same pairing E4 records.
       */
      node("cut", "level", [-480, 660], { blacklevel: 0.55, whitelevel: 1.20, gamma1: 1, contrast: 1, brightness: 1 }, { label: "cut1" }),
      node("clip", "limit", [-160, 660], { mode: "clamp", low: 0, high: 6, steps: 4 }, { label: "clip1" }),
      node("halo", "blur", [160, 660], { size: 34, filter: "gaussian", extend: "hold" }, { label: "veil1" }),
      node("glow", "add", [440, 200], {}, { label: "bloom1" }),
      node("out", "output", [720, 200], {}, { label: "out1" }),

      /* ---- the value graph ---------------------------------------------------- */
      node("tide", "lfo", [-2400, 1560], { shape: "sine", frequency: 0.062, amplitude: 0.5, offset: 0.5, phase: 0.75 }, { label: "tide1" }),
      node("sheen", "lfo", [-2400, 1920], { shape: "sine", frequency: 0.011, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "sheen1" }),
      node("swing", "lfo", [-2400, 2280], { shape: "sine", frequency: 0.035, amplitude: 1.35, offset: 0, phase: 0.06 }, { label: "swing1" }),
      node("lift", "lfo", [-2400, 2640], { shape: "sine", frequency: 0.029, amplitude: 0.30, offset: 0.78, phase: 0.0 }, { label: "lift1" }),
      node("aoswing", "valueMath", [-2080, 1560], { operation: "multiply", operand: 0.90 }, { label: "aoswing1" }),
      node("aorest", "valueMath", [-1760, 1560], { operation: "add", operand: 0.55 }, { label: "aorest1" }),
      /*
       * BACK TO THE AUTHORED VALUES (T636), and the round trip is the story. These were
       * 1.00/0.85; T632's Fresnel removed the head-on reflection from the dielectric
       * goo and, with only a SPECULAR environment half, nothing physical was left to
       * fill it — so T632 re-exposed to 7.00/9.00, a tuning constant doing a missing
       * term's job. T636 added the missing term (diffuse irradiance along N, scaled by
       * (1 − F)(1 − metallic)), and the constant comes home: measured on the same two
       * frames T632 used, 1.00/0.85 puts the melted frame's environment contribution
       * at 17.2 against the 17.3 that was judged (and the old 7× frame was blown to
       * chalk — the fill reads as oil where the re-exposure read as plaster).
       */
      node("envswing", "valueMath", [-2080, 1920], { operation: "multiply", operand: 0.85 }, { label: "envswing1" }),
      node("envrest", "valueMath", [-1760, 1920], { operation: "add", operand: 1.00 }, { label: "envrest1" }),
      node("glossswing", "valueMath", [-2080, 2280], { operation: "multiply", operand: -0.105 }, { label: "glossswing1" }),
      node("glossrest", "valueMath", [-1760, 2280], { operation: "add", operand: 0.190 }, { label: "glossrest1" }),
    ],
    [
      edge("e-sky-studio", ["sky", "out"], ["studio", "in1"]),
      edge("e-key-studio", ["keyBox", "out"], ["studio", "in2"], 0),
      edge("e-fill-studio", ["fillBox", "out"], ["studio", "in2"], 1),
      edge("e-rim-studio", ["rimBand", "out"], ["studio", "in2"], 2),
      edge("e-studio-shot", ["studio", "out"], ["shot", "environment"]),

      edge("e-shell-morph", ["shell", "out"], ["morph", "in"]),
      edge("e-morph-body", ["morph", "out"], ["body", "points"]),

      edge("e-segpts-segs", ["segPts", "out"], ["segs", "in"]),
      edge("e-segs-shards", ["segs", "out"], ["shards", "points"]),

      edge("e-sweeppts-sweep", ["sweepPts", "out"], ["sweep", "in"]),
      edge("e-sweep-cyc", ["sweep", "out"], ["cyc", "points"]),

      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),

      edge("e-tide-aoswing", ["tide", "out"], ["aoswing", "a"]),
      edge("e-aoswing-aorest", ["aoswing", "out"], ["aorest", "a"]),
      edge("e-tide-envswing", ["tide", "out"], ["envswing", "a"]),
      edge("e-envswing-envrest", ["envswing", "out"], ["envrest", "a"]),
      edge("e-tide-glossswing", ["tide", "out"], ["glossswing", "a"]),
      edge("e-glossswing-glossrest", ["glossswing", "out"], ["glossrest", "a"]),
    ],
  ),
);


/**
 * E34 — Lidar (T641). THE RAY POP, WORKING FOR ITS LIVING.
 *
 * A night survey: a mast at the origin sweeps a ring of 240 rays over a dark noise
 * terrain. Every ray is AIMED BY AN ATTRIBUTE — `aim1` writes a vec3f `direction` per
 * point (azimuth from the point's index, the ring's tilt breathing on a driven Value
 * slot) — which is the reason Ray is a POP and not a SOP: a grid of downward rays is a
 * heightmap lookup, a cloud of independently-aimed rays is an instrument.
 *
 * ## The central teaching: ONE texture, TWO mappings, made to agree
 *
 * The terrain the camera sees and the field the rays march are THE SAME noise texture,
 * and nothing checks that for you. The bridge (`textureToAttribute`) samples at the
 * point's clip xy with v INVERTED (uv = (x/2+0.5, 0.5−y/2), T512); the Ray field maps
 * world x,z ∈ [−extent, +extent] with NO inversion (uv = (x,z)/(2·extent)+0.5). So
 * `unfold1` parks the sample sheet at (X/extent, −Z/extent) — the minus sign IS the
 * agreement — and `raise1` rebuilds (X, height, Z) from the same indices. Get that sign
 * wrong and the scan line drapes over a terrain the picture mirrors front-to-back:
 * plausible at a glance, wrong everywhere, invisible until a ray "hits" a valley.
 *
 * T672 gave that agreement a THIRD reader: `pool1` parks each return at the same clip
 * (X/extent, −Z/extent) so the light pool lands on the terrain that made it. See the
 * kernel's own comment for why the minus sign survives the composition.
 *
 * ## Reflection, literally (the owner's "raycasting / reflection ala TD POPs")
 *
 * TWO Ray nodes, chained. `ricochet1` reflects each hit's direction about its
 * `hitNormal` and re-origins at the hit (lifted 0.03 along the normal so the second
 * march does not start inside the ground it just found); `rebound1` casts again. A
 * first-leg MISS keeps marching from its end — physically fine — and is masked out of
 * the echo reading by `echo = hit₁` carried across the second cast, because the second
 * Ray writes its own `hit` over the first one's.
 *
 * ## The readings (§V471 — and an honest deviation, T642)
 *
 * One cast, three readings: IMPACTS (hot amber, brightness by 1 − distance/range — the
 * lidar return), OUT-OF-RANGE (the same ray set, `hit = 0`: faint steel points hanging
 * at the ray ends, a cone rim in the air where the beam gave out — `maxDistance` is
 * deliberately SHORTER than the shallow ring's slant, so the ring crosses the range
 * boundary as it breathes and RIDGES come into range before valleys: the relief reads
 * in the hit/miss boundary itself), and ECHOES (cyan, both legs hit). These readings
 * are kernel-written TINT classes plus a parked-position cull (mark2 sends non-echoes
 * to y = −60), and since T642 the SELECTION itself is a group predicate on the lit draw
 * — §V471's idiom, running through the shared camera and depth buffer rather than as a
 * predicate-filtered 2D overlay under its own projection, which cannot sit on a 3D
 * camera's picture. T672 makes this file run BOTH halves of that resolver: `poolmap1` is
 * a genuine `renderPoints` draw, into a texture, feeding the terrain's albedo.
 *
 * ## Why the dots are unlit and the ground is not
 *
 * A lidar return is an EMITTER on the display — `materialUnlit` × per-point tint —
 * while the terrain is a dielectric under the whole T632/T636 stack: a shadowed cool
 * key, an equirect night sky whose Fresnel reflection rims the ridges at grazing and
 * whose diffuse irradiance (1 − F)(1 − metallic) fills the valleys the key never
 * reaches. Kill the environment wire and the valleys go black; that is the diffuse
 * half doing the work `ambientIntensity` used to fake.
 *
 * ## What T658 changed, and why each was a defect rather than a preference
 *
 * CLIPPING (the owner's "prevent clipping with the camera and the mountain on one
 * edge"). It was never a near plane: the orbit clears the terrain box by 1.1 world
 * units against a near of 0.1. It was the PLATE'S RIM. The sheet is a finite square
 * and the camera orbited OUTSIDE its footprint, so at every angle a segment of the
 * near rim fell inside a 46°/74° frustum and drew as a ruler-straight cut with the
 * void behind it. The plate now outgrows the orbit — extent 4.8 against a radius of
 * 3.8 — so the near rim is always behind the camera and only distant rim remains,
 * which reads as a horizon because ridges break it. The grid went to 192² to hold the
 * cell size at 0.05, and the noise period scaled by 3.2/4.8 to hold the world feature
 * size, so growing the ground changed the geometry and not the look.
 *
 * And the trap worth one line: THE ORBIT RADIUS IS NOT IN THE CAMERA. `eye.x` and
 * `eye.z` are driven by `orbx1`/`orbz1`, so the static `eye` vector's x and z are
 * inert (§V465) — editing them to reframe is a no-op that looks like a fix in a diff.
 *
 * SHADOWS (T666/§V617). Not the slope-scaled bias — forcing the old constant 0.002
 * back makes it strictly worse. Not the billboard skip — these markers are instances,
 * which that skip does not reach. Rendering the terrain ALONE settled it: the ground
 * self-shadows almost nowhere, and the black combing was 480 unlit octahedra casting
 * hard, texel-quantised fins down every grazing slope. An unlit surface takes no part
 * in lighting, so it does not block light either; the rule now lives in the compiler.
 *
 * FLICKER AND TRAILS ARE ONE MECHANISM, and that is the interesting part. A ray's
 * verdict is BINARY, so a ray sitting on the range frontier flips it every frame —
 * which means the smoothing had to be TEMPORAL AND ON THE READING, not a blur on the
 * picture. `wake` on both mark kernels is that persistence, and the same state that
 * stops the blinking is what leaves a fade behind a moving return. Measured with the
 * camera frozen, so nothing but the reading can change: the hard-flip rate among
 * bright pixels falls 36.2% → 22.8% and the mean frame-to-frame change 59.4 → 37.8.
 * What is left is the beam's own rotation at 0.22 rad/s, which is the example.
 *
 * ## The sky is the same map (T659)
 *
 * `skyband1` is now DRAWN as well as taken — `showEnvironment` on this render. Until
 * T659 the environment had exactly two readers, the reflection vector and the five
 * irradiance taps, and no pass ever rendered it: the visible night was the `background`
 * colour, so tuning the ramp changed the fill and the rim and never the sky. One map now
 * lights the scene and IS the scene's backdrop, which is the only way the rim light on a
 * ridge can agree with what is behind it. The switch is off by default and this is the
 * only example that opts in.
 *
 * ## What T672 changed: the beams, the pool, and the hold
 *
 * The owner, on the shipped T658 build: "it feels like some weird noise still and
 * missing something that ties it together". THE BEAMS ARE THE THING THAT TIES IT
 * TOGETHER. A lidar without them is a hillside with dots appearing on it, and the owner
 * read it exactly that way; `rays1` draws the causal chain in `beam` mode (T680), which
 * spans each ray's origin to the `hitPosition` `cast1` already carries.
 *
 * THE GROUND IS NOW LIT BY ITS OWN RETURNS, through the albedo map rather than through
 * 240 lights: `pool1` → `poolmap1` → `poolsoft1` → `poolbase1` → `basalt1.albedo`. §V644
 * lives in `poolbase1`'s comment and is the one thing here that fails as a lighting bug.
 *
 * AND THE "FLICKER" WAS SEMANTIC (T681). Camera frozen, the terrain contributes EXACTLY
 * ZERO frame-to-frame energy and the echoes carried 82% of it; colouring each echo by
 * the index of the ray that made it shows the primary ring as a smooth colour wheel and
 * the echoes SCRAMBLED — adjacent rays land metres apart, so the second leg's landing
 * point is a chaotic function of azimuth and a marker that re-reads while lit teleports
 * constantly. Sample-and-hold on `mark2a` is the fix, in one condition.
 *
 * MEASURED — camera frozen (orbx1/orbz1 at frequency 0), 15 frame-pairs over frames
 * 400–415, full 1280×720 (§V627), display-encoded (§V618). Both halves re-measured back
 * to back on ONE tree so the comparison is not an argument (§V641): engine `d8ed47e`,
 * "before" = this entry as shipped at `83e03ff`.
 *
 *     band            BEFORE                      AFTER
 *     total energy    1,386,519                   727,237
 *     green energy      873,292 (63.0%)            53,657 (7.4%)   −93.9%
 *     green hard-flip      39.1% on 9,502 px         6.6% on 3,730 px
 *     amber energy      205,286 (14.8%)           626,612 (86.2%)  ← the beams' own sweep
 *     amber hard-flip       7.7%                      6.0%
 *     halo energy       307,942                    46,968
 *
 * Free-running throughout (§V436): the sweep, the tilt and the orbit read absolute
 * clocks, so a timeline lap never snaps the scan.
 */
const LIDAR_EXTENT = 4.8;
const LIDAR_HEIGHT_SCALE = 2.6;
const LIDAR_HEIGHT_OFFSET_V = -0.6;
const LIDAR_MAST = 3.3;
const LIDAR_HEIGHT_OFFSET = LIDAR_HEIGHT_OFFSET_V;
/* T711 — RANGE AND CONTRACTION ARE ONE NUMBER, and this is the constraint the next
   person tuning this file will hit. The tightest the target circle can be is set by the
   STEEPEST tilt, and the steepest tilt is capped by how far a shot can reach: the mast
   stands at y = 3.3 and the terrain floor is −0.6, so a vertical shot needs 3.9 to touch
   the bottom of the basin. At the shipped 3.4 a vertical shot bottoms out at y = −0.1 —
   measured at tilt span 0.72 the whole middle of the ring falls SHORT, turns
   out-of-range steel, and exactly one beam survives. So "contract the circle further"
   costs REACH, and 3.4 → 3.9 moves with the span below or the ask breaks the picture. */
const LIDAR_RANGE = 3.9;
/* The tilt's shallow end and its SPAN, in radians below horizontal. The shallow end does
   not move (§V639: the echoes exist BECAUSE shallow rays reflect forward off back-slopes,
   and steepening that end deletes the reading). The span is the owner's "a bit smaller
   even than what we have now": 0.50 → 0.62 takes the tightest ring's radius to
   tan(1.10)/tan(1.22) = 0.719 of what it was — 28% smaller, and the ratio is free of the
   local ground height, so it is a fact about the instrument rather than about one frame. */
const LIDAR_TILT_MIN = 0.6;
const LIDAR_TILT_SPAN = 0.62;
/* T658: the terrain GRID, sized so a cell stays 0.05 world units after the plate grew
   — 2·4.8/192 = 0.05, the exact spacing the 3.2/128 sheet had. */
const LIDAR_GRID = 192;
const LIDAR_SHEET_COUNT = LIDAR_GRID * LIDAR_GRID;
/* The camera's orbit radius. It lives HERE and in the two LFO amplitudes, never in the
   camera's `eye`: eye.x and eye.z are DRIVEN, so the static vector's x and z are inert
   and editing them to reframe is a silent no-op (§V465, and it cost an hour to learn).*/
const LIDAR_ORBIT = 3.8;
/* T672: one ray in ten is DRAWN as a beam. Every ray is still CAST — `spoke` costs one
   f32 pair and no marching at all — and the subset is a picture decision measured rather
   than chosen: 240 beams sharing one origin fuse into a solid opaque cone that hides the
   terrain, 24 read as an instrument. */
const LIDAR_SPOKE_EVERY = 10;
/* The light-pool map's resolution. The terrain grid is 192², so this is ~2.7 texels a
   cell — enough that the pool's edge is the blur's and not the map's. */
const LIDAR_POOL_RES = 512;

const LIDAR_SHEET_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);

/* `sample` is declared to be READ — it binds the bridge's own pair upstream (T401),
   exactly E20's dance. */
const LIDAR_RAISE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
]);

/* The sample sheet: place each grid point where the BRIDGE will read the texel the RAY
   will march at (X, Z). Clip (X/extent, −Z/extent) — the minus is the v-inversion
   agreement argued in the header. */
const LIDAR_UNFOLD_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let worldX = (u * 2.0 - 1.0) * ${LIDAR_EXTENT};
  let worldZ = (v * 2.0 - 1.0) * ${LIDAR_EXTENT};
  q.position = vec3f(worldX / ${LIDAR_EXTENT}, -worldZ / ${LIDAR_EXTENT}, 0.0);
  return q;
}`;

/* Rebuild (X, height, Z) from the SAME indices — the bridge's sample is the r channel
   the Ray node reads, through the same y = r × scale + offset the Ray applies. */
const LIDAR_RAISE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let worldX = (u * 2.0 - 1.0) * ${LIDAR_EXTENT};
  let worldZ = (v * 2.0 - 1.0) * ${LIDAR_EXTENT};
  q.position = vec3f(worldX, p.sample.r * ${LIDAR_HEIGHT_SCALE} + (${LIDAR_HEIGHT_OFFSET}), worldZ);
  return q;
}`;

/* THREE attributes, six bindings — still inside §V588's baseline eight. `spoke` is the
   whole cost of drawing the beams: a per-ray f32 the aim kernel writes and the beam
   geometry's group predicate reads, riding the Ray node's pass-through to the draw. No
   extra march, no extra pass. */
const LIDAR_AIM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "direction", type: "vec3f", default: [0, -1, 0] },
  { name: "spoke", type: "f32", default: [0] },
]);

/* The instrument. Azimuth from the INDEX (240 rays around the full circle), the ring's
   tilt on the driven value slot (T479): tiltwave1 breathes it steep↔shallow, and the
   whole ring turns on the absolute clock. maxDistance is chosen against these angles —
   see the ray node's comment. */
const LIDAR_AIM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let azimuth = (f32(ctx.index) / f32(ctx.count)) * 6.28318530718 + ctx.absTime * 0.22;
  /* 0.60..1.22 rad (34°..70° below horizontal): the steep end lands well inside range,
     the shallow end's slant exceeds it and the outer ring goes dark — and shallow
     strikes reflect FORWARD off back-slopes, which is where the echoes come from.
     The steep end is capped by LIDAR_RANGE, not by taste — see that constant. */
  let tilt = ${LIDAR_TILT_MIN} + ctx.value1 * ${LIDAR_TILT_SPAN};
  q.position = vec3f(0.0, ${LIDAR_MAST}, 0.0);
  q.direction = normalize(vec3f(
    sin(azimuth) * cos(tilt),
    -sin(tilt),
    cos(azimuth) * cos(tilt),
  ));
  /* T672: every ray is CAST, every tenth is DRAWN. See LIDAR_SPOKE_EVERY. */
  q.spoke = select(0.0, 1.0, (ctx.index % ${LIDAR_SPOKE_EVERY}u) == 0u);
  return q;
}`;

/* T711 — THE BEAM'S OWN COLOUR, one slot per attribute and four of them (§V588 again).
   `spoke` is declared because the draw's predicate reads it and this kernel sits between
   `cast1` and the draw; `hitPosition` because the beam's far end is written here. */
const LIDAR_SIGHT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "spoke", type: "f32", default: [0] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
]);

/* T711 — A RAY AND THE MARK IT MAKES SHARE A COLOUR, which is the whole reason this
   kernel exists. `haze1` used to be a FLAT [0.36, 0.21, 0.08] — one colour for every
   beam, unrelated to the box it lands on — and the mechanism nobody had named is that
   0.36 sits just BELOW `cut1`'s 0.42 bloom knee, so 24 lit ribbons read as matte orange
   sticks while the ring they end on glowed. The expression here is `mark1`'s own return
   colour at a lower gain, so the beam is the same yellow as its impact and lands ABOVE
   the knee: the eye traces cause to effect because the two are literally one colour.

   And the second half: A RAY WITH NO RETURN IS NOT DRAWN. Both ends on the same point
   is a ZERO-AREA beam, which is the honest reading of a shot that never landed, and it
   needs no flag — the Ray node's contract is that a miss ends exactly `maxDistance` from
   its origin, so the same `slant` that colours the beam also classifies it.

   The two alternatives were built and measured, and both lose (§V668). RECOLOURING the
   misses takes the green band's hard-flip rate from 0.4% to 11.3%, because the CLASS
   BOUNDARY is what oscillates — a recoloured miss class blinks worse than the hit class
   it replaces. FADING the beam out at max range paints a BLACK RIBBON across the lit
   terrain: a beam is opaque scene geometry, so dimming it toward zero does not hide it,
   it darkens whatever is behind it. Dropping costs nothing on the metric — the amber
   hard-flip rate is unchanged at 0.4% with the drop alone, and the 0.4% → 1.9% this
   rework does spend is attributable entirely to the BRIGHTNESS, measured separately. */
const LIDAR_SIGHT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - p.position);
  let near = clamp(1.0 - slant / ${LIDAR_RANGE}, 0.0, 1.0);
  q.tint = vec4f(1.0, 0.62 + 0.30 * near, 0.18, 1.0) * (0.35 + 0.90 * near);
  q.hitPosition = select(p.position, p.hitPosition, slant < ${LIDAR_RANGE} - 0.01);
  return q;
}`;

/* FOUR attributes, and the count is load-bearing: each declared attribute costs a
   read-and-write pair, and the WebGPU BASELINE grants 8 storage buffers per stage —
   five attrs is ten bindings and a refused pipeline on any device that reports no
   better (§V588). Two things are therefore DERIVED rather than carried:
   `hitDistance`, because a ray's own origin arrives as `position` from upstream and
   `length(hitPosition − position)` is the distance; and `hit`, because the Ray node's
   contract is that a MISS ends exactly `maxDistance` from the origin, so the same
   length says which happened. The slot that buys pays for `wake`.

   T658 — `wake` is the persistence, and it is why this reading stops blinking. A
   ray's verdict is BINARY and a ray sitting on the range frontier flips it every
   frame, which is a property of the instrument and not of the picture: smoothing
   belongs on the READING, temporally, not on the frame as a blur. `wake.xyz` is the
   lagged position (a miss's marker no longer TELEPORTS between the ground and the
   ray's end in the air — it slides) and `wake.w` is the lagged verdict, so the amber
   return fades to steel through a continuous mix instead of snapping. One vec4f, so
   both fit in the one slot the derivations freed. */
const LIDAR_MARK_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "wake", type: "vec4f", default: [0, 0, 0, 0] },
]);

/* Reading one and two, from one cast: a hit is a RETURN (hot, brighter the nearer —
   1 − d/range is the lidar intensity model at its crudest and reads instantly), a miss
   is OUT OF RANGE (the ray's end hangs in the air, faint steel — the node's own
   contract: "a miss carries the ray's end and the full distance").

   `p.position` is the ray's ORIGIN, read from upstream (T401: an attribute this schema
   shares with the incoming set reads the upstream pair, not this node's last frame),
   so the mast needs no constant here and `slant` is the true ray length. Everything
   else on `p` that is NOT upstream — `wake` — is this kernel's own previous frame,
   which is the entire persistence mechanism.

   The two rates are different on purpose. POSITION leads (0.22, a ~4-frame time
   constant): a marker crossing the frontier has to travel metres, and a slow slide
   reads as lag rather than as smoothing. The VERDICT trails (0.10, ~10 frames), and
   the colour mixes on `level²` rather than `level` so the transit passes through the
   dark end instead of through khaki — a fade-out, not a hue rotation. */
const LIDAR_MARK_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - p.position);
  let landed = select(0.0, 1.0, slant < ${LIDAR_RANGE} - 0.01);
  let near = clamp(1.0 - slant / ${LIDAR_RANGE}, 0.0, 1.0);
  let pos = mix(p.wake.xyz, p.hitPosition, 0.22);
  let level = mix(p.wake.w, landed, 0.10);
  q.wake = vec4f(pos, level);
  q.position = pos;
  let ret = vec4f(1.0, 0.60 + 0.30 * near, 0.16, 1.0) * (0.5 + 1.6 * near);
  let lost = vec4f(0.16, 0.30, 0.52, 1.0) * 0.32;
  q.tint = mix(lost, ret, level * level);
  return q;
}`;

/* FOUR again (see mark1's comment). Even the first leg's `hit` flag goes: a miss
   carries the ray's FULL-RANGE end, so length(hitPosition − mast) says which leg this
   was without a flag — the verdict travels as geometry. A first-leg miss is PARKED at
   y = −80; its second cast from the parking depth hits instantly below the field, and
   mark2 recognises the park by the hit's own y. Two selects instead of two buffers. */
const LIDAR_RICOCHET_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "direction", type: "vec3f", default: [0, -1, 0] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "hitNormal", type: "vec3f", default: [0, 1, 0] },
]);

/* The bounce: re-origin at the hit, lifted along the normal so the second march does
   not begin inside the ground it just found; reflect the aim about the surface. A
   first-leg miss parks (see the attribute comment above). */
const LIDAR_RICOCHET_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - vec3f(0.0, ${LIDAR_MAST}, 0.0));
  let landed = slant < ${LIDAR_RANGE} - 0.01;
  q.position = select(vec3f(0.0, -80.0, 0.0), p.hitPosition + p.hitNormal * 0.03, landed);
  q.direction = normalize(reflect(p.direction, p.hitNormal) + vec3f(0.0, 0.0001, 0.0));
  return q;
}`;

const LIDAR_MARK2_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "wake", type: "vec4f", default: [0, 0, 0, 0] },
]);

/* Reading three: an echo counts only when BOTH legs landed — and since T642 the
   SELECTION lives on the DRAW, not in this kernel. This kernel only places, colours,
   and (T658) REMEMBERS.

   The trail and the smoothing turned out to be ONE mechanism, which is why there is
   no second one. An echo's qualification is binary and intermittent, so the group
   predicate used to pop the marker in and out of existence entirely — no colour ramp
   can soften a point that is not drawn. `wake` holds the LAST QUALIFYING POSITION and
   a level that rises instantly and decays 0.94 per frame, the predicate now reads
   that level, and the same state therefore delivers both asks: nothing blinks, and a
   sweep leaves a fading wake of where it just found something. Instant rise is
   deliberate — §V509's lesson that a one-pole smoother sized for an envelope
   annihilates the transient it is fed, so the transient gets its own path.

   T672 — and the state was right while the RE-READING was wrong. Round two adopted a
   new hit on every qualifying frame, so a marker whose ray re-qualified metres away
   TELEPORTED WHILE LIT — and the second leg's landing point is a chaotic function of
   azimuth, so it re-qualifies metres away constantly (§V638). The gate `p.wake.w <
   0.06` moves the relocation to where no eye can see it: the marker lights at a place,
   HOLDS still, fades, and only then re-arms. A display's phosphor. Green-band
   frame-to-frame energy 873,292 → 53,657 for that one condition; every tail remedy was
   measured first and every one failed (position lag made it WORSE at 2,386,000, a
   lagged rise moved 4.5%, decay 0.90 → 0.98 moved the hard-flip rate 39.1% → 34.7%),
   because the churn was BIRTHS and not the tail.

   `hit` is derived rather than carried, buying the slot (see mark1's note): the Ray
   node's contract is that a MISS ends exactly `maxDistance` from its origin, and this
   ray's origin arrives as `position` from upstream. A parked first-leg miss re-casts
   from y = −80 and hits instantly below the field, so its hit y still betrays it. */
const LIDAR_MARK2_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let leg2 = length(p.hitPosition - p.position);
  let landed = leg2 < ${LIDAR_RANGE} - 0.02 && p.hitPosition.y > -10.0;
  /* T672 — SAMPLE AND HOLD. The gate is \`p.wake.w < 0.06\`, and it is the whole fix: a
     marker takes a new reading only while it is already DARK. Delete it and the echoes
     scintillate again while every STILL frame still looks right (§V638). */
  let take = landed && p.wake.w < 0.06;
  let pos = select(p.wake.xyz, p.hitPosition, take);
  let level = select(p.wake.w * 0.94, 1.0, take);
  q.wake = vec4f(pos, level);
  q.position = pos;
  /* T711 — the BOUNCE LEG's far end, and the only place it can live. \`p.position\` here
     is the FIRST hit, the primary ray's landing, and this kernel's own \`hitPosition\`
     slot is a LEAF: nothing downstream reads it, because the only consumer of mark2a is
     the draw. Four attributes is the whole budget (§V588), so the segment gets published
     through a slot that already exists rather than through a fifth pair. The far end is
     LIVE while the near end is HELD, which is the right way round: the first hit is a
     SMOOTH function of azimuth (T681 measured the primary ring as a clean colour wheel),
     so the beam's base creeps while its tip stays put, and nothing pops. */
  q.hitPosition = p.position;
  /* round-trip attenuation, crudely: mast → surface → echo, against 1.8× range. The
     floor is LOW (0.15) so the far scatter stays a scatter and the near returns are
     the ones that read — depth, rather than confetti at one brightness. */
  let near = clamp(1.0 - length(pos - vec3f(0.0, ${LIDAR_MAST}, 0.0)) / (${LIDAR_RANGE} * 1.8), 0.0, 1.0);
  q.tint = vec4f(0.30, 0.95, 0.85, 1.0) * (0.15 + 1.35 * near) * level;
  return q;
}`;

const LIDAR_POOL_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
]);

/* T672 — THE SAME AGREEMENT, STATED A SECOND TIME. `unfold1` parks the sample sheet at
   clip (X/extent, −Z/extent); this parks each RETURN at exactly the same place, and that
   is not a coincidence to be maintained by luck. The terrain surface samples its albedo
   map by GRID uv, grid v runs along world Z, and `renderPoints` draws at clip xy where
   +1 is the TOP of the picture and therefore texel row 0 and therefore v = 0. Compose
   those three and the minus sign comes back out — the same minus, for the same reason.
   Get it wrong and the pool lights the terrain's mirror image, which is plausible at a
   glance and wrong everywhere. */
const LIDAR_POOL_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x / ${LIDAR_EXTENT}, -p.position.z / ${LIDAR_EXTENT}, 0.0);
  return q;
}`;

const lidarDocument = document(
  "e34-lidar",
  "E34 Lidar",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 34 }),
  graph(
    [
      /* ---- the terrain, once: one texture, two readers ------------------------ */
      node("relief", "noise", [-2880, -440], {
        type: "perlin4d", seed: 11, period: 0.40 * 3.2 / LIDAR_EXTENT, harmon: 4, spread: 2, gain: 0.58,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: false,
        t4d: 0.37, s4d: 1, speed: 0, /* static ground; T535's slice, off the lattice plane */
      }, { label: "relief1", resolution: { mode: "fixed", width: 512, height: 512 } }),
      /* E27's lesson, reapplied: four perlin harmonics sum to a SLIVER (measured here:
         r in 0.63..0.80), and a terrain built on a sliver is a plain with a rumor of
         hills. The stretch to full range happens ONCE, on the texture BOTH readers
         share — the mesh and the rays march the same carved field by construction. */
      node("carve", "level", [-2560, -880], {
        /* the window is LINEAR (the ray and the mesh both read this target raw): the
           harmonic sum lands in ~0.36..0.61 linear, measured — an early read of these
           numbers through the OUTPUT node was display-encoded and off by a transfer
           curve, which is exactly the trap §V56 keeps warning about. */
        blacklevel: 0.36, whitelevel: 0.62, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, { label: "carve1", resolution: { mode: "fixed", width: 512, height: 512 } }),

      /* ---- the terrain MESH: unfold → sample → raise -------------------------- */
      node("sheet", "pointGrid", [-2560, -440], { cols: LIDAR_GRID, rows: LIDAR_GRID, count: LIDAR_SHEET_COUNT }, { label: "sheet1" }),
      node("unfold", "pointKernel", [-2240, -440], {
        capacity: LIDAR_SHEET_COUNT, attributes: LIDAR_SHEET_ATTRIBUTES, kernel: LIDAR_UNFOLD_KERNEL,
      }, { label: "unfold1" }),
      node("probe", "textureToAttribute", [-1920, -440], {}, { label: "probe1" }),
      node("raise", "pointKernel", [-1600, -440], {
        capacity: LIDAR_SHEET_COUNT, attributes: LIDAR_RAISE_ATTRIBUTES, kernel: LIDAR_RAISE_KERNEL,
      }, { label: "raise1" }),
      node("basalt", "materialPhong", [-1600, -920], {
        color: [0.14, 0.15, 0.18, 1], specular: [0.30, 0.33, 0.40, 1], shininess: 26, roughness: 0.82,
      }, { label: "basalt1" }),
      node("ground", "geometry", [-1280, -440], {
        mode: "surface", material: "basalt1", tint: [1, 1, 1, 1],
      }, { label: "ground1" }),

      /* ---- the instrument: aim → cast → readings ------------------------------ */
      node("tiltwave", "lfo", [-2880, 40], {
        shape: "sine", frequency: 0.045, amplitude: 0.5, offset: 0.5, phase: 0,
      }, { label: "tiltwave1" }),
      node("fan", "pointLine", [-2560, 40], { count: 240 }, { label: "fan1" }),
      node("aim", "pointKernel", [-2240, 40], {
        capacity: 240, attributes: LIDAR_AIM_ATTRIBUTES, kernel: LIDAR_AIM_KERNEL,
      }, { label: "aim1", parameters: { value1: drivenSlot("tiltwave1", 0.5) } }),
      /* RANGE 3.4 against a 2.7 m mast and 41°..73° tilts: the steep ring's slant
         (~2.8) is inside range, the shallow ring's (~4.1) is not — the breathing ring
         CROSSES the range boundary, and ridges (shorter slant) come into range before
         valleys, so the relief reads in the hit/miss frontier itself. */
      node("cast", "pointRay", [-1920, 40], {
        steps: 64, maxDistance: LIDAR_RANGE, direction: [0, -1, 0],
        extent: LIDAR_EXTENT, heightScale: LIDAR_HEIGHT_SCALE, heightOffset: LIDAR_HEIGHT_OFFSET,
      }, { label: "cast1" }),
      node("mark", "pointKernel", [-1600, 40], {
        capacity: 240, attributes: LIDAR_MARK_ATTRIBUTES, kernel: LIDAR_MARK_KERNEL,
      }, { label: "mark1" }),
      node("spark", "materialUnlit", [-1600, 520], { color: [1, 1, 1, 1] }, { label: "spark1" }),
      node("impacts", "geometry", [-1280, 40], {
        mode: "instances", shape: "octahedron", scale: 0.052, material: "spark1",
      }, {
        label: "impacts1",
        /* T478: the kernel's per-point verdict IS the colour — tint in MAP mode. */
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- the beams: the cause, drawn (T672/T680), coloured by it (T711) ------- */
      node("sight", "pointKernel", [-1920, 900], {
        capacity: 240, attributes: LIDAR_SIGHT_ATTRIBUTES, kernel: LIDAR_SIGHT_KERNEL,
      }, { label: "sight1" }),
      /* WHITE, and UNLIT on purpose: a beam is scattered light in the air, not a surface —
         and an unlit primitive takes no part in shadowing either (§V617). T711 moved the
         colour off this material and onto the POINT, because one flat colour for every
         beam is exactly what stopped the beams reading as the cause of the marks; the
         material is now the identity element so the tint IS the colour. */
      node("haze", "materialUnlit", [-1600, 900], { color: [1, 1, 1, 1] }, { label: "haze1" }),
      node("rays", "geometry", [-1280, 900], {
        /* `beam` spans each ray's `position` — the mast — to its `hitPosition`, which
           `cast1` ALREADY carries, so 24 beams cost 24 instances of six vertices and NOT
           ONE extra ray march. The sampled-billboard fake was built and measured first:
           983,000 texture reads a frame against this file's 15,400, for a serrated ribbon
           that cannot taper (T680). */
        /* T711: the far end is now `sight1`'s, not `cast1`'s — same attribute, one kernel
           later, so a ray with no return arrives with both ends on the same point and
           collapses to zero area instead of drawing a hit that did not happen. */
        mode: "beam", endpoint: "hitPosition", scale: 0.013,
        /* TAPER 0, and it is load-bearing, not tidiness: every beam here shares ONE
           origin, so at any taper above ~0 they fuse into a solid wedge at the mast
           whatever their number. Pinching the near end to a point is both the cure and
           what a divergent beam actually does. */
        taper: 0,
        material: "haze1",
        /* §V471's idiom, on the DRAW: every ray is cast, every tenth is drawn. Empty this
           predicate and 240 beams fuse into an opaque cone that hides the terrain — which
           is why the subset is measured rather than chosen. */
        group: "p.spoke > 0.5",
      }, {
        label: "rays1",
        /* T478 again, on a BEAM this time: the kernel's per-ray colour IS the beam's. */
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- the ground, LIT BY ITS OWN RETURNS (T672, §V644) -------------------- */
      node("pool", "pointKernel", [-1280, 300], {
        capacity: 240, attributes: LIDAR_POOL_ATTRIBUTES, kernel: LIDAR_POOL_KERNEL,
      }, { label: "pool1" }),
      node("poolmap", "renderPoints", [-960, 300], {
        count: 240, sizePixels: 22, blend: "additive", accumulate: false,
        /* only RETURNS light the ground — the steel out-of-range markers hang in the air
           and have nothing under them to light. */
        group: "p.tint.r > 0.3",
      }, {
        label: "poolmap1",
        resolution: { mode: "fixed", width: LIDAR_POOL_RES, height: LIDAR_POOL_RES },
        parameters: {
          color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      node("poolsoft", "blur", [-640, 300], {
        size: 26, filter: "gaussian", extend: "hold",
      }, { label: "poolsoft1", resolution: { mode: "fixed", width: LIDAR_POOL_RES, height: LIDAR_POOL_RES } }),
      /* §V644 — THE IDENTITY ELEMENT, and the one thing in this chain that looks like a
         lighting bug when it is missing. An albedo map MULTIPLIES, so an additive
         contribution through it must read 1.0 where nothing is lit. Black point −0.1 with
         white at 0 is how a Level says ADD ONE: out = 10·in + 1. Drop the offset and the
         naive map (unlit texels = 0) multiplies the ground to BLACK everywhere the pool
         is not — which reads as "the light broke the terrain" and is really the identity
         element going missing. */
      node("poolbase", "level", [-320, 300], {
        blacklevel: -0.1, whitelevel: 0, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, { label: "poolbase1", resolution: { mode: "fixed", width: LIDAR_POOL_RES, height: LIDAR_POOL_RES } }),

      /* ---- the bounce: reflection, literally ---------------------------------- */
      node("ricochet", "pointKernel", [-1920, 520], {
        capacity: 240, attributes: LIDAR_RICOCHET_ATTRIBUTES, kernel: LIDAR_RICOCHET_KERNEL,
      }, { label: "ricochet1" }),
      node("rebound", "pointRay", [-1280, 520], {
        steps: 48, maxDistance: LIDAR_RANGE, direction: [0, -1, 0],
        extent: LIDAR_EXTENT, heightScale: LIDAR_HEIGHT_SCALE, heightOffset: LIDAR_HEIGHT_OFFSET,
      }, { label: "rebound1" }),
      node("mark2", "pointKernel", [-960, 520], {
        capacity: 240, attributes: LIDAR_MARK2_ATTRIBUTES, kernel: LIDAR_MARK2_KERNEL,
      }, { label: "mark2a" }),
      node("echoes", "geometry", [-640, 520], {
        mode: "instances", shape: "octahedron", scale: 0.030, material: "spark1",
        /* T642: the reading IS a selection — §V471's idiom, in the lit path. T658: and
           it selects on the PERSISTENT level rather than on the raw verdict, so an echo
           leaves a fading wake instead of vanishing between one frame and the next. */
        group: "p.wake.w > 0.03",
      }, {
        label: "echoes1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- the bounce leg, DRAWN (T711) --------------------------------------- */
      /* THIS WAS REJECTED ONCE, BY MEASUREMENT, AND THE REJECTION WAS RIGHT FOR ITS TREE.
         T681 drew this segment off `rebound1`'s RAW verdict and it cost green energy
         873k → 1,399k, "because the segments pop in and out with the raw verdict and
         have no persistence to inherit". §V638's sample-and-hold then landed — and a
         beam hung on mark2a inherits exactly the persistence the rejected version
         lacked. Re-measured on THIS tree, same ten rays, same width, same colour, camera
         frozen, 15 frame-pairs, the ONLY variable being where the segment reads from:

             no bounce beam        green    663,533 on   171,680 px   hard-flip 0.4%
             bounce, HELD          green  4,961,526 on   393,877 px   hard-flip 2.2%
             bounce, RAW verdict   green 32,123,665 on 1,490,859 px   hard-flip 7.1%

         The hold is worth 6.5× the green energy and 3.2× the churn, and 2.2% sits under
         the amber band T681 itself judged against. A conclusion measured on one tree is
         not evidence about another one. */
      node("mist", "materialUnlit", [-960, 900], { color: [0.85, 0.85, 0.85, 1] }, { label: "mist1" }),
      node("bounce", "geometry", [-640, 900], {
        /* `position` is the HELD echo point and `hitPosition` the first hit mark2a
           publishes, so the segment is the echo's own cause. Taper 1: unlike the
           primaries these share no origin, so there is no apex to pinch. */
        mode: "beam", endpoint: "hitPosition", scale: 0.006, taper: 1, material: "mist1",
        /* Both halves matter. `wake.w` is echoes1's OWN predicate, so a bounce beam
           lights, holds, fades and re-arms with the box it belongs to — that is where the
           persistence comes from. `spoke` is the same every-tenth subset the primaries
           use, and it reaches this draw for free: an attribute a pointKernel does not
           DECLARE still flows through the pointset, so mark2a never had to spend a slot
           on it. Drop it and all 240 legs draw: the basin becomes green spaghetti, green
           energy ×6.5 again, and it is T681's picture exactly. */
        group: "p.wake.w > 0.03 && p.spoke > 0.5",
      }, {
        label: "bounce1",
        /* mark2a's tint, unchanged — so the leg and the echo it ends on are ONE colour,
           the same agreement the primaries and their boxes now keep. */
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- night: key, sky, camera -------------------------------------------- */
      node("moon", "light", [-960, -920], {
        kind: "directional", direction: [0.35, -0.70, -0.42], color: [0.72, 0.80, 1, 1],
        /* 7.0, not 4.5: §V426 says nothing knows your scene's bounds, and the plate
           grew. A volume that no longer spans the terrain leaves its corners
           UNSHADOWED — "outside the volume means the light simply shines" — which is a
           discontinuity across the frame that reads as a rendering fault. */
        intensity: 0.50, shadows: true, shadowExtent: 7.0,
      }, { label: "moon1" }),
      /* T658, the owner's "more interesting lights": the instrument LIGHTS ITS OWN
         GROUND. A point light at the mast, warm against the moon's cool key, with the
         1/(1+d²) falloff putting a pool of amber under the emitter and nothing at the
         range boundary — so the picture says where the thing doing the measuring is,
         which the scene never did before. It does not cast: a point caster needs six
         faces and the render refuses it by name, which is the right refusal. */
      node("lamp", "light", [-960, -1160], {
        kind: "point", position: [0, LIDAR_MAST, 0], color: [1.0, 0.70, 0.42, 1],
        /* 0.8, and desaturated. At 2.0 the pool became a flat orange blob whose edge
           was really the moon's shadow boundary — a second light is meant to say where
           the instrument is, not to relight the scene. */
        intensity: 0.8, shadows: false,
      }, { label: "lamp1" }),
      node("skyband", "ramp", [-960, -1400], {
        /* T659 retune, now that this map is DRAWN and not only taken. v = acos(y)/π,
           so position 0 is the zenith and 1 the nadir; the camera's 46° frustum, tilted
           34° down, sees v ≈ 0.56 … 0.81 and NOTHING above the horizon. Every stop that
           matters therefore sits in that band: the glow at 0.66 is the light behind the
           ridges, and the warm smudge at 0.78 is the horizon the returns answer to.
           The old ramp put its brightest stop at 0.78 by luck; this one puts it there
           on purpose, and the two stops outside the band still shape the irradiance. */
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.0, color: [0.008, 0.010, 0.028, 1] },
          { position: 0.52, color: [0.026, 0.040, 0.098, 1] },
          { position: 0.66, color: [0.070, 0.112, 0.215, 1] },
          { position: 0.78, color: [0.150, 0.130, 0.150, 1] },
          { position: 1.0, color: [0.020, 0.018, 0.030, 1] },
        ],
      }, { label: "skyband1", definitionVersion: 2, resolution: { mode: "fixed", width: 256, height: 128 } }),
      /* THE ORBIT RADIUS IS HERE, in the two amplitudes — see LIDAR_ORBIT. */
      node("orbx", "lfo", [-2880, 520], {
        shape: "sine", frequency: 0.019, amplitude: LIDAR_ORBIT, offset: 0, phase: 0.25,
      }, { label: "orbx1" }),
      node("orbz", "lfo", [-2880, 1000], {
        shape: "sine", frequency: 0.019, amplitude: LIDAR_ORBIT, offset: 0, phase: 0,
      }, { label: "orbz1" }),
      node("eye", "camera", [-640, -440], {
        /* T672 — `lookAt` IS live, unlike eye.x and eye.z, and 1.60 rather than 0.55 is
           what puts the beams' convergence at the mast just above the frame instead of
           off the top of it. Raising it tilts the camera UP, which is exactly the move
           that could re-expose the plate rim T658 spent its pass removing, so it was
           checked at all eight of the orbit's worst angles — edges at frames 0/790/1579/
           2369, corners at 395/1184/1974/2763 — and the near rim stays behind the camera. */
        eye: [LIDAR_ORBIT, 3.1, 0], lookAt: [0, 1.60, 0], fov: 46, near: 0.1, far: 40, ortho: false,
      }, {
        label: "eye1",
        parameters: {
          "eye.x": drivenSlot("orbx1", LIDAR_ORBIT),
          "eye.z": drivenSlot("orbz1", 0),
        },
      }),
      node("shot", "render", [-320, -140], {
        scenes: "ground1 impacts1 echoes1 rays1 bounce1",
        camera: "eye1",
        lights: "moon1 lamp1",
        ambientColor: [0.50, 0.60, 0.92, 1],
        /* 0.11, down from 0.16: the sky is now a real diffuse source AND a visible
           backdrop, so the flat ambient floor that used to stand in for it can step
           back — the fill arrives from a direction now, not from everywhere. */
        ambientIntensity: 0.11,
        background: [0.006, 0.008, 0.016, 1],
        /* The owner's "colour reflection a bit increased" — a BIT: 1.15, not the 1.8
           the first pass tried, which lifted the terrain 2.3× and turned a night into
           an overcast dusk. */
        environmentIntensity: 1.15,
        /* T659: and the sky band is now DRAWN as well as taken. It was already the only
           thing filling the valleys; the frame behind the ridges was the `background`
           colour and nothing else, which is why the night read as flat black however the
           ramp was tuned. This is the opt-in — the switch is off everywhere else. */
        showEnvironment: true,
      }, { label: "shot1" }),

      /* ---- the returns glow --------------------------------------------------- */
      /* The glow's window. 0.95 rather than 1.15 for the white point — the owner's
         "the glow can be a bit increased", applied where the glow is actually made
         rather than by turning something up downstream. */
      node("cut", "level", [0, -140], {
        blacklevel: 0.42, whitelevel: 0.95, gamma1: 1, contrast: 1, brightness: 1, opacity: 1,
      }, { label: "cut1" }),
      /* The clamp is LOAD-BEARING, not tidiness (E33's lesson, relearned the hard way):
         Level is a SIGNED pipeline — below blacklevel it emits NEGATIVES, the blur
         spreads them across the whole frame, and add then SUBTRACTS the halo from the
         picture. On this night scene almost everything sits below the threshold, so the
         un-clamped chain blacked out the entire film. */
      node("clip", "limit", [320, -140], { mode: "clamp", low: 0, high: 6, steps: 4 }, { label: "clip1" }),
      node("halo", "blur", [640, -140], { size: 28, filter: "gaussian", extend: "hold" }, { label: "halo1" }),

      /* ---- the trail: a LUMINANCE-thresholded feedback (T711) ------------------ */
      /* THE TUNING QUESTION IS WHERE THIS SITS RELATIVE TO THE POOL-LIT GROUND, and it
         is answered with a number rather than an eye. Rendered with the marks, beams and
         echoes taken out of the Scenes list, the terrain — moonlit AND lit by its own
         impact pool — tops out at linear luma 0.102. Threshold 0.16 with softness 0.10 is
         a smoothstep across 0.11 … 0.21, so the transition's FOOT is above the brightest
         ground there is: the ground contributes EXACTLY NOTHING and everything the eye
         reads as a glow trails. Lower it under 0.10 and the whole lit hillside smears;
         raise it past 0.40 and only the 0.7% of the frame that is core survives. */
      node("hot", "threshold", [0, 340], {
        threshold: 0.16, softness: 0.10, channel: "luminance", compare: "greater",
      }, { label: "hot1" }),
      /* Threshold emits a MASK in rgb and alpha alike, so the colour has to be put back:
         multiply keeps what passed and discards what did not. `opacity` scales the FRONT
         layer, which makes it the loop's INJECTION GAIN and the only place it lives. */
      node("stain", "multiply", [320, 340], { opacity: 0.05 }, { label: "stain1" }),
      node("smear", "add", [640, 340], {}, { label: "smear1" }),
      /* §V631 — BOUNDED BY ARITHMETIC, not by hope: steady state is injection ÷ (1 −
         persistence), so 0.90 settles at 10× the injection and 0.05 × 10 = 0.5 of the
         source at a mark that holds still. Positive gain below 1: convergent, and no sign
         alternation (§V630's oscillator needs a NEGATIVE gain, which needs a Screen this
         path does not have). Measured rather than assumed, and not over a short window:
         `smear1`'s own alpha reads [0, 0.47] at frame 60 and [0, 0.50] at frame 800, and
         the sink's stays inside [0, 1]. What it buys, camera frozen: the amber band's
         hard-flip rate 2.9% → 0.5% at the steep end and 4.5% → 1.0% at the shallow one,
         with TOTAL energy down 1.6% — trails add frame-to-frame correlation, which is
         the point, and here they paid for themselves in energy as well. */
      node("trail", "feedback", [640, 560], {
        source: "smear1", persistence: 0.90, clearColor: [0, 0, 0, 0],
      }, { label: "trail1" }),
      node("glow", "add", [960, -140], {}, { label: "glow1" }),
      node("out", "output", [1280, -140], {}, { label: "out1" }),
    ],
    [
      edge("e-sheet-unfold", ["sheet", "out"], ["unfold", "in"]),
      edge("e-unfold-probe", ["unfold", "out"], ["probe", "points"]),
      edge("e-relief-carve", ["relief", "out"], ["carve", "input"]),
      edge("e-carve-probe", ["carve", "out"], ["probe", "texture"]),
      edge("e-probe-raise", ["probe", "out"], ["raise", "in"]),
      edge("e-raise-ground", ["raise", "out"], ["ground", "points"]),

      edge("e-fan-aim", ["fan", "out"], ["aim", "in"]),
      edge("e-aim-cast", ["aim", "out"], ["cast", "points"]),
      edge("e-carve-cast", ["carve", "out"], ["cast", "field"]),
      edge("e-cast-mark", ["cast", "out"], ["mark", "in"]),
      edge("e-mark-impacts", ["mark", "out"], ["impacts", "points"]),
      edge("e-cast-sight", ["cast", "out"], ["sight", "in"]),
      edge("e-sight-rays", ["sight", "out"], ["rays", "points"]),

      edge("e-mark-pool", ["mark", "out"], ["pool", "in"]),
      edge("e-pool-poolmap", ["pool", "out"], ["poolmap", "points"]),
      edge("e-poolmap-poolsoft", ["poolmap", "out"], ["poolsoft", "input"]),
      edge("e-poolsoft-poolbase", ["poolsoft", "out"], ["poolbase", "input"]),
      edge("e-poolbase-basalt", ["poolbase", "out"], ["basalt", "albedo"]),

      edge("e-cast-ricochet", ["cast", "out"], ["ricochet", "in"]),
      edge("e-ricochet-rebound", ["ricochet", "out"], ["rebound", "points"]),
      edge("e-carve-rebound", ["carve", "out"], ["rebound", "field"]),
      edge("e-rebound-mark2", ["rebound", "out"], ["mark2", "in"]),
      edge("e-mark2-echoes", ["mark2", "out"], ["echoes", "points"]),
      edge("e-mark2-bounce", ["mark2", "out"], ["bounce", "points"]),

      edge("e-skyband-shot", ["skyband", "out"], ["shot", "environment"]),
      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-hot", ["shot", "out"], ["hot", "input"]),
      edge("e-shot-stain", ["shot", "out"], ["stain", "in1"]),
      edge("e-hot-stain", ["hot", "out"], ["stain", "in2"], 0),
      edge("e-stain-smear", ["stain", "out"], ["smear", "in1"]),
      edge("e-trail-smear", ["trail", "out"], ["smear", "in2"], 0),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-smear-glow", ["smear", "out"], ["glow", "in2"], 1),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E14 — Self-Regulating Bloom (T408).
 *
 *   sway(lfo) ─► field.amp                                      the DISTURBANCE
 *   field(noise) ─► gain(level) ─► clipbase ─┬─► cut ─► clip ─► halo ─► tint ─► glow.in1
 *                       ▲ brightness         └──────────────────────────────► glow.in2
 *   glow ─► out                palette ─► tint.lookup (phase ← "swirl1")
 *   glow ─► meter(analyze "meter1")                             the SENSOR
 *   probe(channelIn) ─► neg(×−1) ─► err(+target) ─► push(×K) ─► lift(+base) ─► clampg ─► engage(valueSwitch) = "gain1"   (in2 ◄ rest, the open loop)
 *                                       └─► swirl(×0.15) ─► swirlbias(+0.03) ─► swirlclamp = "swirl1"
 *
 * §V144's image → parameter → image loop, closed THROUGH PROCESSING for the first time
 * (§V615): analyze meters the finished frame, channelIn (T654) brings the number back
 * into the value graph, and a proportional controller drives the picture's brightness
 * toward a setpoint while an LFO breathes the field's amplitude to give it work to do.
 *
 * gain1 = clamp(1.3 + 2.0·(0.18 − meter1), 0.8, 1.8). Every constant is sized from a
 * measured plant curve, not taste — the md carries the numbers. The short version:
 * meter/brightness slope ≈ 0.23 at the operating point, so the brightness path closes
 * at K·G ≈ 0.47; the palette-phase tap adds ≈ 0.27 in the same corrective direction;
 * total loop gain ≈ 0.7 with the measurement one frame late (§V144), which is an
 * alternating decay with ratio 0.7 — the visible ringing on open IS the loop gain,
 * and `push` past ~4 crosses −1 into genuine oscillation. It settles near 0.206, not
 * 0.18: a P-controller leans on its error, and the residual ships undisguised.
 */
export const selfRegulatingBloomDocument = document(
  "self-regulating-bloom",
  "E14 Self-Regulating Bloom",
  settings(),
  graph(
    [
      /**
       * THE DISTURBANCE. ±0.35 of field amplitude over a 77-second cycle — enough to
       * swing the meter 0.172 peak-to-peak open-loop (measured with the sway sped up so
       * a run covers whole cycles); closed, the same swing measures 0.114 — attenuation
       * by 1/(1+L), not elimination. The clamp does NOT saturate under this sway
       * (measured at the trough: gain ≈1.28, well inside the rails) — its real job is
       * bounding the pulse when `push` is turned past the stability boundary.
       */
      node("sway", "lfo", [-1040, -200], {
        shape: "sine",
        frequency: 0.013,
        amplitude: 0.35,
        offset: 1,
        phase: 0,
      }),
      node("field", "noise", [-1040, 0], {
        type: "perlin4d",
        seed: 5,
        period: 0.26,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where frame 0 is unrepresentative
        s4d: 1,
        speed: 0.12,
      }, {
        parameters: { amp: drivenSlot("sway1", 1) },
      }),
      /**
       * THE ACTUATOR. The controller owns exactly one number in the picture: this
       * brightness. The window under it (0.42/1.05) is what puts the field's mean at a
       * plant slope the controller can work — without the window the slope tripled and
       * the same K sat on the edge of oscillation.
       */
      node("gain", "level", [-780, 0], {
        blacklevel: 0.42,
        whitelevel: 1.05,
        contrast: 1,
      }, {
        // §V107/§V108: the retained 1.3 is `lift`'s own base, so a host with no
        // channel renders the frame-0 picture, not a different example.
        parameters: { brightness: drivenSlot("gain1", 1.3) },
      }),
      // E4/E34's lesson, twice: `gain` and `cut` are signed pipelines whose black
      // points emit negatives into an rgba16float working format; the blur would smear
      // them and `add` would SUBTRACT the halo. Both clamps are load-bearing.
      node("clipbase", "limit", [-540, 0], { mode: "clamp", low: 0, high: 4, steps: 4 }),
      node("cut", "level", [-300, -160], { blacklevel: 0.46, whitelevel: 0.56, contrast: 1 }),
      node("clip", "limit", [-60, -160], { mode: "clamp", low: 0, high: 4, steps: 4 }),
      node("halo", "blur", [180, -160], { size: 40, filter: "gaussian", extend: "hold" }),
      /**
       * THE WRAP IS THE TRAP. A ramp is periodic: a NEGATIVE phase wraps the mask's
       * near-zero majority — the whole background — past 0 into the white top end.
       * Measured: phase −0.02 alone lifted the settled meter from 0.51 to 0.94, a
       * POSITIVE feedback loop through an art decision that saturated early builds to a
       * white frame in five frames. `swirlbias` and `swirlclamp`'s floor keep the phase
       * on the safe side; positive phase shifts the halo's palette gently and in the
       * CORRECTIVE direction, which is why the tap gets to exist.
       */
      node(
        "palette",
        "ramp",
        [180, 60],
        {
          type: "horizontal",
          interp: "smooth",
          period: 1,
          stops: [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 0.03, color: [0.24, 0.05, 0.4, 1] },
            { position: 0.09, color: [0.85, 0.2, 0.3, 1] },
            { position: 0.16, color: [1, 0.55, 0.16, 1] },
            { position: 0.28, color: [1, 0.9, 0.6, 1] },
            { position: 0.45, color: [1, 1, 0.95, 1] },
          ],
        },
        { definitionVersion: 2, parameters: { phase: drivenSlot("swirl1", 0.03) } },
      ),
      node("tint", "lookup", [420, -160], { channel: "luminance", row: 0.5, offset: 0, scale: 1 }),
      node("glow", "add", [660, 0], { opacity: 1 }),
      /**
       * THE SENSOR — and deliberately on the FINISHED frame, glow and palette included,
       * not on the raw field. Metering the input would regulate something the viewer
       * never sees; metering the output is what makes the palette tap part of the loop
       * gain and the whole argument honest. Its NAME is the channel (§V129).
       */
      node("meter", "analyze", [1180, -160], { channel: "luminance", operation: "average" }, { label: "meter1" }),
      node("out", "output", [920, 0]),

      /**
       * THE CONTROLLER. channelIn (T654) is the crossing that §V615 records: before it,
       * a measured channel could drive a slot but could not be SUBTRACTED from a target.
       * The fallback is the setpoint itself, so frame 0 — before any readback has
       * completed (§V144: the resolver answers with the last COMPLETED reduction, and on
       * frame 0 there is none) — renders at exactly `lift`'s base. The opening ring you
       * see is the one-frame latency taking hold, displayed rather than hidden; pause
       * the transport and the analyze node's §V329 staleness age counts up in its popup
       * while the picture stands still.
       */
      node("probe", "channelIn", [-1140, 320], { channel: "meter1", fallback: 0.18 }),
      node("neg", "valueMath", [-880, 320], { operation: "multiply", operand: -1 }),
      node("err", "valueMath", [-620, 320], { operation: "add", operand: 0.18 }, { label: "err1" }),
      node("push", "valueMath", [-360, 320], { operation: "multiply", operand: 2 }),
      node("lift", "valueMath", [-100, 320], { operation: "add", operand: 1.3 }),
      // The rails. Not exercised by the sway (measured); load-bearing at the
      // STABILITY BOUNDARY: past `push` ≈ 4 the loop pulses, and these bounds are
      // what keep the pulse between 0.11 and 0.41 instead of black-to-blown
      // (0.004–0.67 with the rails opened). Gated at that case, per §V461.
      node("clampg", "valueLimit", [160, 320], { minimum: 0.8, maximum: 1.8 }),
      /**
       * THE A/B SWITCH (§V461 for the reader, not only for the gates). index 0 is the
       * closed loop; flip it to 1 and the brightness is the bare base — the open loop,
       * one integer away. Under the same sway the meter swings 0.172 open against
       * 0.114 closed (measured): the difference IS the controller, and this switch is
       * how you see it without running anything offline. The constant is pinned equal
       * to `lift`'s base so the comparison changes exactly one thing: whether the
       * measurement is allowed to push back.
       */
      node("rest", "constant", [420, 560], { value: 1.3 }),
      node("engage", "valueSwitch", [420, 320], { index: 0 }, { label: "gain1" }),
      // The same error, spent twice: a small warm/cool lean on the halo's palette.
      node("swirl", "valueMath", [-360, 560], { operation: "multiply", operand: 0.15 }),
      node("swirlbias", "valueMath", [-100, 560], { operation: "add", operand: 0.03 }),
      node("swirlclamp", "valueLimit", [160, 560], { minimum: 0.005, maximum: 0.055 }, { label: "swirl1" }),
    ],
    [
      edge("e-field-gain", ["field", "out"], ["gain", "input"]),
      edge("e-gain-clipbase", ["gain", "out"], ["clipbase", "input"]),
      edge("e-clipbase-cut", ["clipbase", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-halo-tint", ["halo", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-glow", ["tint", "out"], ["glow", "in1"], 0),
      edge("e-clipbase-glow", ["clipbase", "out"], ["glow", "in2"], 1),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
      // Cut THIS edge and the loop opens: the channel vanishes, `probe` falls back to
      // the setpoint, the error reads zero, and the sway swings the picture unregulated.
      edge("e-glow-meter", ["glow", "out"], ["meter", "input"]),
      edge("v-probe-neg", ["probe", "out"], ["neg", "a"]),
      edge("v-neg-err", ["neg", "out"], ["err", "a"]),
      edge("v-err-push", ["err", "out"], ["push", "a"]),
      edge("v-push-lift", ["push", "out"], ["lift", "a"]),
      edge("v-lift-clampg", ["lift", "out"], ["clampg", "in"]),
      edge("v-clampg-engage", ["clampg", "out"], ["engage", "in1"], 0),
      edge("v-rest-engage", ["rest", "out"], ["engage", "in2"], 1),
      edge("v-err-swirl", ["err", "out"], ["swirl", "a"]),
      edge("v-swirl-swirlbias", ["swirl", "out"], ["swirlbias", "a"]),
      edge("v-swirlbias-swirlclamp", ["swirlbias", "out"], ["swirlclamp", "in"]),
    ],
  ),
);

/**
 * E35 — Nova-Torus (T660). The owner's second file, shipped as Corona's sibling.
 *
 * 41 of these 43 nodes are the owner's own (the audio-swap trio replaces one dead
 * blob: URL): the same eight gain-and-bias pairs, three renderPoints readings, bloom,
 * palette, feedback and hue drift §V471 already describes — so the docblocks here
 * teach only what DIFFERS from Corona, which is the whole reason it has a slot:
 * a torus whose TUBE thickness is the audio's way in, a noise-mottled palette read,
 * a starred tube profile, and a fast 0.5 Hz hue modulator against Corona's 29-second
 * cycle. Seed 11 in the kernel hash against Corona's 7.
 *
 * What was corrected before shipping, each with precedent: the persistence overshoot
 * (§B115, Corona's own bug, Corona's own fix), the dead tip pair (wired, §V624), the
 * half-degree hue wobble (T574), the inert 2D-noise speed (T518), and the blob URL
 * (T504's swap). The owner's look decisions — including the ×20 high-band brightness,
 * which is legal on a floor-ranged parameter and reads as the gold flash it is —
 * ship as saved.
 */
export const novaTorusDocument = document(
  "nova-torus",
  "E35 Nova-Torus",
  settings({ randomSeed: 1, previewFps: 20 }),
  graph(
    [
      node("add1", "add", [1145, -96], { opacity: 1 }, { label: "add1" }),
      node("blur1", "blur", [780, -280], { extend: "hold", filter: "gaussian", size: 34 }, { label: "blur1" }),
      node("feedback1", "feedback", [1880, 220], { clearColor: [0, 0, 0, 1], reset: false, source: "null2", substeps: 1 }, { label: "feedback1", parameters: { persistence: drivenSlot("valuemath14:level", 0) } }),
      node("hsv1", "hsv", [2320, -100], { saturation: 1.24, value: 1 }, { label: "hsv1", parameters: { hueoffset: drivenSlot("lfo1", 0) } }),
      node("level1", "level", [560, 200], { blacklevel: 0, contrast: 1, gamma1: 1, invert: 0, opacity: 1, whitelevel: 1 }, { label: "level1", parameters: { brightness: drivenSlot("valuemath8:low", 0) } }),
      node("level2", "level", [560, 460], { blacklevel: 0, contrast: 1, gamma1: 1, invert: 0, opacity: 1, whitelevel: 1 }, { label: "level2", parameters: { brightness: drivenSlot("valuemath10:high", 0) } }),
      node("level3", "level", [1000, -280], { blacklevel: 0.01, contrast: 1, gamma1: 1, invert: 0, opacity: 1, whitelevel: 1 }, { label: "level3", parameters: { brightness: drivenSlot("valuemath4:low", 0) } }),
      node("lookup1", "lookup", [1440, 112], { channel: "luminance", offset: 0, row: 0.5 }, { label: "lookup1", parameters: { scale: drivenSlot("valuemath12:highMid", 0) } }),
      node("multiply1", "multiply", [1340, -100], { opacity: 1 }, { label: "multiply1" }),
      /**
       * The `noise → multiply` stage Corona has no equivalent of: a gentle mottle
       * (amp 0.22 about offset 1) over the graded bloom before the palette reads it.
       * `perlin4d` rather than the saved perlin2d, deliberately: a 2D noise has no time
       * axis, so the saved `speed: 0.12` was inert (T518) and the file claimed motion
       * it could not perform. Measured honestly: the moving mask changes ~0.2% of the
       * frame's pixels — texture, not signal — and the docblock says so rather than
       * overselling it.
       */
      node("noise1", "noise", [1220, 380], { amp: 0.22, aspectcorrect: true, exp: 1, gain: 0.5, harmon: 2, mono: true, offset: 1, p: [0, 0, 0], period: 3.2, r: 0, rough: 0.5, s: [1, 1, 1], s4d: 1, seed: 1, speed: 0.12, spread: 2, t: [0, 0, 0], t4d: 0.37, type: "perlin4d", xord: "srt" }, { label: "noise1" }),
      node("null1", "null", [560, -100], {}, { label: "null1" }),
      node("null2", "null", [2540, -100], {}, { label: "null2" }),
      node("output1", "output", [2760, -100], { toneMap: "none" }, { label: "output1" }),
      /**
       * THE DIFFERENCE THAT EARNS THE SLOT. Corona drives a sphere's whole radius; here
       * the major radius stands at 1 and the audio drives the MINOR one — `radius2`,
       * lowMid, 0.18..0.52 — so what breathes is the TUBE'S THICKNESS, a different
       * mechanism rather than a different palette. The kernel then stars and ribbons
       * that tube (prof = 1 + 0.38·star + 0.15·field), which is why the ring reads as
       * braided cable rather than as a donut.
       */
      node("pointgenerator1", "pointGenerator", [-782, 44], { cols: 256, count: 65536, radius: 1, rows: 256, shape: "torus", sizeX: 2, sizeY: 2, sizeZ: 2 }, { label: "pointgenerator1", parameters: { radius2: drivenSlot("valuemath2:lowMid", 0.3) } }),
      node("pointkernel1", "pointKernel", [-153, 35], { attributes: "", capacity: 65536, group: "", kernel: "\nfn lm_hash(p: vec3f) -> f32 {\n  var q = fract(p * 0.1031);\n  q = q + vec3f(dot(q, q.zyx + 31.32));\n  return fract((q.x + q.y) * q.z);\n}\nfn lm_noise(x: vec3f) -> f32 {\n  let i = floor(x); let f = fract(x);\n  let u = f * f * (3.0 - 2.0 * f);\n  let a = mix(lm_hash(i + vec3f(0.0,0.0,0.0)), lm_hash(i + vec3f(1.0,0.0,0.0)), u.x);\n  let b = mix(lm_hash(i + vec3f(0.0,1.0,0.0)), lm_hash(i + vec3f(1.0,1.0,0.0)), u.x);\n  let c = mix(lm_hash(i + vec3f(0.0,0.0,1.0)), lm_hash(i + vec3f(1.0,0.0,1.0)), u.x);\n  let d = mix(lm_hash(i + vec3f(0.0,1.0,1.0)), lm_hash(i + vec3f(1.0,1.0,1.0)), u.x);\n  return mix(mix(a,b,u.y), mix(c,d,u.y), u.z) * 2.0 - 1.0;\n}\nfn lm_fbm(x: vec3f, oct: i32) -> f32 {\n  var v = 0.0; var a = 0.5; var q = x;\n  for (var k: i32 = 0; k < oct; k = k + 1) {\n    v = v + a * lm_noise(q);\n    q = q * 2.03 + vec3f(17.3, 9.1, 4.7);\n    a = a * 0.55;\n  }\n  return v;\n}\nfn lm_ridged(x: vec3f, oct: i32) -> f32 {\n  var v = 0.0; var a = 0.5; var q = x;\n  for (var k: i32 = 0; k < oct; k = k + 1) {\n    let n = 1.0 - abs(lm_noise(q));\n    v = v + a * n * n;\n    q = q * 2.07 + vec3f(11.1, 3.3, 7.7);\n    a = a * 0.52;\n  }\n  return v - 0.62;\n}\nfn lm_rotY(v: vec3f, a: f32) -> vec3f {\n  let c = cos(a); let s = sin(a);\n  return vec3f(v.x*c - v.z*s, v.y, v.x*s + v.z*c);\n}\nfn lm_rotX(v: vec3f, a: f32) -> vec3f {\n  let c = cos(a); let s = sin(a);\n  return vec3f(v.x, v.y*c - v.z*s, v.y*s + v.z*c);\n}\n\n\nfn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  // absolute clock: ctx.time is timeline-relative and snaps at the loop point.\n  // T683: ctx.absTime is SECONDS (the manifest says so). The saved file multiplied\n  // by 0.001 - a milliseconds assumption - which ran this whole kernel clock at\n  // 1/1000th speed: the tumble, the band sweep and the morphs below were all\n  // authored, and all frozen. The turntable the owner asked for was already here.\n  let t = ctx.absTime;\n\n  let R0 = 1.0; let RMIN = 0.18; let RSPAN = 0.34;\n  let pin = p.position;\n  let d = max(1.0e-4, length(pin.xz));\n  let r = length(vec2f(d - R0, pin.y));\n  let fromAudio = clamp((r - RMIN) / RSPAN, 0.0, 1.0);\n  let warp = clamp(fromAudio + 0.30 + 0.26 * sin(t * 0.087), 0.0, 1.35);\n\n  let u  = atan2(pin.z, pin.x);\n  let v0 = atan2(pin.y, d - R0);\n\n  // ---- three morph weights, smooth and normalised (no steps, no snapping) --\n  let m = t * 0.055;\n  var w0 = 0.5 + 0.5 * sin(m);\n  var w1 = 0.5 + 0.5 * sin(m * 0.73 + 2.1);\n  var w2 = 0.5 + 0.5 * sin(m * 0.51 + 4.2);\n  w0 = w0 * w0; w1 = w1 * w1; w2 = w2 * w2;      // sharpen so one mode leads\n  let ws = w0 + w1 + w2 + 1.0e-4;\n  w0 = w0 / ws; w1 = w1 / ws; w2 = w2 / ws;\n\n  // ---- twist as PERIODIC harmonics of u: closes seamlessly, morphs smoothly\n  let A1 = 0.60 + 0.90 * sin(t * 0.037);\n  let A2 = 0.80 * sin(t * 0.023 + 1.7);\n  let A3 = 0.50 * sin(t * 0.019 + 3.3);\n  var v = v0\n        + A1 * sin(u)\n        + A2 * sin(2.0 * u + t * 0.06)\n        + A3 * sin(3.0 * u - 0.4)\n        + (0.5 + 1.1 * warp) * sin(u + t * 0.12);\n  v = v + t * 0.50;\n\n  let sc = vec3f(cos(u) * 1.4, sin(u) * 1.4, v * 0.45);\n  let wv = vec3f(\n    lm_fbm(sc + vec3f(0.0, 0.0, t * 0.12), 4),\n    lm_fbm(sc + vec3f(4.1, 2.7, t * 0.10), 4),\n    lm_fbm(sc + vec3f(8.3, 6.1, t * 0.14), 4)\n  );\n  let lobes   = lm_fbm(sc * 1.6 + wv * 1.5, 5);\n  let creases = lm_ridged(sc * (2.2 + 2.4 * warp) + wv * 1.1 - vec3f(t * 0.2, 0.0, 0.0), 5);\n  let field   = mix(lobes, creases * 1.15, clamp(warp, 0.0, 1.0));\n\n  // ---- three genuinely different cross-section profiles ---------------------\n  // harmonic counts stay integer; only the CROSSFADE moves, so nothing tears\n  let sMix = 0.5 + 0.5 * sin(t * 0.020);\n  let star = mix(sin(4.0 * v), sin(7.0 * v), sMix);\n  let rMix = 0.5 + 0.5 * sin(t * 0.031 + 1.2);\n  let ripple = mix(sin(3.0 * u - t * 1.1), sin(7.0 * u - t * 0.7), rMix);\n\n  let prof0 = 1.0 + 0.30 * field;                      // smooth organic coil\n  let prof1 = 1.0 + 0.38 * star + 0.15 * field;        // star / ribbon tube\n  let prof2 = 1.0 + 0.95 * max(0.0, creases);    // spiny coral\n  let prof  = w0 * prof0 + w1 * prof1 + w2 * prof2;\n\n  let squash = mix(1.0, 0.58, w1);                     // flatten toward a ribbon\n\n  let rr = r * prof * (1.0 + 0.40 * warp * field + 0.16 * ripple);\n  let RR = R0 + 0.10 * sin(3.0 * u + t * 0.7)\n              + 0.14 * sin(2.0 * u - t * 0.60)\n              + 0.18 * lm_fbm(vec3f(cos(u) * 2.0, sin(u) * 2.0, t * 0.15), 3);\n\n  let cu = cos(u); let su = sin(u);\n  let cv = cos(v); let sv = sin(v);\n  var p3 = vec3f(cu * (RR + rr * cv), rr * sv * squash, su * (RR + rr * cv));\n  p3.y = p3.y + 0.22 * sin(2.0 * u + t * 0.45);\n\n  p3 = p3 * 0.70;\n  p3 = lm_rotY(p3, t * 0.09);\n  p3 = lm_rotX(p3, -0.58);\n\n  let dcam = 4.2; let zc = max(0.05, dcam - p3.z);\n  let ff = 3.6; let aspect = 16.0 / 9.0;\n  q.position = vec3f((p3.x * ff / zc) / aspect, p3.y * ff / zc, 0.5);\n\n  // travelling colour band + camera depth, read by the layer predicates\n  let band = 0.5 + 0.5 * sin(3.0 * u - t * 0.90 + 0.8 * field + 1.6 * sin(v * 0.5));\n  q.velocity = vec3f(band, creases, clamp(p3.z * 1.4 + 0.5, 0.0, 1.0));\n  return q;\n}\n", seed: 11, value1: 0, value2: 0, value3: 0, value4: 0 }, { label: "pointkernel1" }),
      node("ramp1", "ramp", [1220, 160], { interp: "smooth", period: 1, phase: 0, stops: [{ color: [0, 0, 0, 1], position: 0 }, { color: [0.01, 0.02, 0.07, 1], position: 0.1 }, { color: [0.06, 0.13, 0.42, 1], position: 0.3 }, { color: [0.48, 0.09, 0.64, 1], position: 0.52 }, { color: [0.98, 0.26, 0.22, 1], position: 0.72 }, { color: [1, 0.74, 0.3, 1], position: 0.89 }, { color: [1, 0.98, 0.93, 1], position: 1 }], type: "horizontal" }, { definitionVersion: 2, label: "ramp1" }),
      node("renderpoints1", "renderPoints", [240, -100], { accumulate: false, blend: "additive", color: [0.17, 0.27, 0.54, 1], count: 65536, group: "" }, { label: "renderpoints1", parameters: { sizePixels: drivenSlot("valuemath6:level", 0) } }),
      node("renderpoints2", "renderPoints", [240, 200], { accumulate: false, blend: "additive", color: [1, 0.42, 0.1, 1], count: 65536, group: "p.velocity.y > 0.06", sizePixels: 1.3 }, { label: "renderpoints2" }),
      /**
       * The cyan sparkle group — and its size is DRIVEN now (§V624). The owner's file
       * carried `valuemath15 ×9 → valuemath16 +1` wired to nothing; Corona's identical
       * tipG/tip pair drives ITS third renderPoints' size on the cyan tips, so the dead
       * pair here read as unfinished intent, not decoration. Wired and measured: the
       * sparkle layer's weight follows the high band, 1.5% of the frame moving with it
       * at a mid-pattern frame. A parameter that drives nothing is a lie in a document.
       */
      node("renderpoints3", "renderPoints", [240, 460], { accumulate: false, blend: "additive", color: [0.22, 0.88, 1, 1], count: 65536, group: "p.velocity.x > 0.66 && p.velocity.y < 0.04" }, { label: "renderpoints3", parameters: { sizePixels: drivenSlot("valuemath16:high", 1.5) } }),
      node("screen1", "screen", [1660, -100], { opacity: 1 }, { label: "screen1" }),
      node("screen2", "screen", [1880, -100], { opacity: 1 }, { label: "screen2" }),
      node("screen3", "screen", [2100, -100], { opacity: 1 }, { label: "screen3" }),
      node("audiofilein1", "audioFileIn", [-420, 700], { cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true, playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1 }, { label: "audiofilein1" }),
      /**
       * The FAST modulator — 0.5 Hz against Corona's 0.035, the deliberate tempo
       * difference (§V471.8 is Corona's idea; this file does something else on
       * purpose). The amplitude is the corrected half: the owner saved 0.5 on a
       * DEGREES parameter (T574's half-degree bug again — invisible), so the sweep is
       * ±18° now, a visible two-second hue shimmer over the magenta body.
       */
      node("lfo1", "lfo", [-420, 880], { amplitude: 18, frequency: 0.5, offset: 0, phase: 0, shape: "sine" }, { label: "lfo1" }),
      /**
       * T504/T508, Corona's exact treatment: the file opens PLAYING against a
       * deterministic pattern, and your own track is one drop away — both sources are
       * wired permanently, the Switch's index picks, and nothing downstream changes
       * because everything downstream reads `source1`. The owner's original carried a
       * session-local blob: URL that is dead outside the browser it was saved in; the
       * File parameter ships empty, its T493 transport kept.
       */
      node("music1", "audioPattern", [-420, 440], { amount: 1, bpm: 112 }, { label: "music1" }),
      node("source1", "valueSwitch", [-160, 570], { index: 0 }, { label: "source1" }),
      node("valuelag1", "valueLag", [-140, 798], { lag: 0.09 }, { label: "valuelag1" }),
      node("valuemath1", "valueMath", [140, 700], { operand: 1.0129, operation: "multiply" }, { label: "valuemath1" }),
      node("valuemath2", "valueMath", [340, 700], { operand: -0.3241, operation: "add" }, { label: "valuemath2" }),
      node("valuemath3", "valueMath", [140, 896], { operand: 5.0173, operation: "multiply" }, { label: "valuemath3" }),
      node("valuemath4", "valueMath", [340, 896], { operand: -2.5418, operation: "add" }, { label: "valuemath4" }),
      node("valuemath5", "valueMath", [140, 1092], { operand: 2.2, operation: "multiply" }, { label: "valuemath5" }),
      node("valuemath6", "valueMath", [340, 1092], { operand: 1.2, operation: "add" }, { label: "valuemath6" }),
      node("valuemath7", "valueMath", [140, 1288], { operand: 7.3587, operation: "multiply" }, { label: "valuemath7" }),
      node("valuemath8", "valueMath", [340, 1288], { operand: -4.7247, operation: "add" }, { label: "valuemath8" }),
      node("valuemath9", "valueMath", [140, 1484], { operand: 23.2749, operation: "multiply" }, { label: "valuemath9" }),
      node("valuemath10", "valueMath", [340, 1484], { operand: -7.5588, operation: "add" }, { label: "valuemath10" }),
      node("valuemath11", "valueMath", [140, 1680], { operand: 3.3773, operation: "multiply" }, { label: "valuemath11" }),
      node("valuemath12", "valueMath", [340, 1680], { operand: -0.2697, operation: "add" }, { label: "valuemath12" }),
      /**
       * §B115, CAUGHT BEFORE SHIPPING THIS TIME. The owner's gain here was 0.95 —
       * persistence 0.62..1.57 against feedback's bounded 0..1, the same numbers
       * Corona shipped with and the owner found within minutes. Corona's retune
       * (b3b0e36) applies wholesale: 0.30 tops the trail at 0.92, where a trail still
       * ends — a better look, not a compromise for a warning.
       */
      node("valuemath13", "valueMath", [140, 1876], { operand: 0.3, operation: "multiply" }, { label: "valuemath13" }),
      node("valuemath14", "valueMath", [340, 1876], { operand: 0.62, operation: "add" }, { label: "valuemath14" }),
      node("valuemath15", "valueMath", [140, 2072], { operand: 10.4737, operation: "multiply" }, { label: "valuemath15" }),
      node("valuemath16", "valueMath", [340, 2072], { operand: -2.4465, operation: "add" }, { label: "valuemath16" }),
    ],
    [
      edge("e0-music1-source1", ["music1", "out"], ["source1", "in1"]),
      edge("e1-source1-valuelag1", ["source1", "out"], ["valuelag1", "in"]),
      edge("e2-audiofilein1-source1", ["audiofilein1", "out"], ["source1", "in2"]),
      edge("e3-ramp1-lookup1", ["ramp1", "out"], ["lookup1", "lookup"]),
      edge("e4-lookup1-screen1", ["lookup1", "out"], ["screen1", "in1"]),
      edge("e5-level1-screen1", ["level1", "out"], ["screen1", "in2"], 0),
      edge("e6-screen1-screen2", ["screen1", "out"], ["screen2", "in1"]),
      edge("e7-level2-screen2", ["level2", "out"], ["screen2", "in2"], 0),
      edge("e8-feedback1-screen3", ["feedback1", "out"], ["screen3", "in2"], 0),
      edge("e9-screen3-hsv1", ["screen3", "out"], ["hsv1", "input"]),
      edge("e10-hsv1-null2", ["hsv1", "out"], ["null2", "in"]),
      edge("e11-null2-output1", ["null2", "out"], ["output1", "input"]),
      edge("e12-valuelag1-valuemath1", ["valuelag1", "out"], ["valuemath1", "a"]),
      edge("e13-valuemath1-valuemath2", ["valuemath1", "out"], ["valuemath2", "a"]),
      edge("e14-valuelag1-valuemath3", ["valuelag1", "out"], ["valuemath3", "a"]),
      edge("e15-valuemath3-valuemath4", ["valuemath3", "out"], ["valuemath4", "a"]),
      edge("e16-valuelag1-valuemath5", ["valuelag1", "out"], ["valuemath5", "a"]),
      edge("e17-valuemath5-valuemath6", ["valuemath5", "out"], ["valuemath6", "a"]),
      edge("e18-valuelag1-valuemath7", ["valuelag1", "out"], ["valuemath7", "a"]),
      edge("e19-valuemath7-valuemath8", ["valuemath7", "out"], ["valuemath8", "a"]),
      edge("e20-valuelag1-valuemath9", ["valuelag1", "out"], ["valuemath9", "a"]),
      edge("e21-valuemath9-valuemath10", ["valuemath9", "out"], ["valuemath10", "a"]),
      edge("e22-valuelag1-valuemath11", ["valuelag1", "out"], ["valuemath11", "a"]),
      edge("e23-valuemath11-valuemath12", ["valuemath11", "out"], ["valuemath12", "a"]),
      edge("e24-valuelag1-valuemath13", ["valuelag1", "out"], ["valuemath13", "a"]),
      edge("e25-valuemath13-valuemath14", ["valuemath13", "out"], ["valuemath14", "a"]),
      edge("e26-valuelag1-valuemath15", ["valuelag1", "out"], ["valuemath15", "a"]),
      edge("e27-valuemath15-valuemath16", ["valuemath15", "out"], ["valuemath16", "a"]),
      edge("e28-add1-multiply1", ["add1", "out"], ["multiply1", "in1"]),
      edge("e29-noise1-multiply1", ["noise1", "out"], ["multiply1", "in2"], 0),
      edge("e30-multiply1-lookup1", ["multiply1", "out"], ["lookup1", "source"]),
      edge("e31-screen2-screen3", ["screen2", "out"], ["screen3", "in1"]),
      edge("e32-pointgenerator1-pointkernel1", ["pointgenerator1", "out"], ["pointkernel1", "in"]),
      edge("e33-pointkernel1-renderpoints1", ["pointkernel1", "out"], ["renderpoints1", "points"]),
      edge("e34-pointkernel1-renderpoints2", ["pointkernel1", "out"], ["renderpoints2", "points"]),
      edge("e35-pointkernel1-renderpoints3", ["pointkernel1", "out"], ["renderpoints3", "points"]),
      edge("e36-renderpoints1-null1", ["renderpoints1", "out"], ["null1", "in"]),
      edge("e37-renderpoints2-level1", ["renderpoints2", "out"], ["level1", "input"]),
      edge("e38-renderpoints3-level2", ["renderpoints3", "out"], ["level2", "input"]),
      edge("e39-null1-blur1", ["null1", "out"], ["blur1", "input"]),
      edge("e40-blur1-level3", ["blur1", "out"], ["level3", "input"]),
      edge("e41-null1-add1", ["null1", "out"], ["add1", "in1"]),
      edge("e42-level3-add1", ["level3", "out"], ["add1", "in2"], 0),    ],
  ),
);

/**
 * E36 — Facade (T704). Projection-mapping PREVIZ: the two questions a site visit answers,
 * in one frame.
 *
 * A building facade at night. Two projectors stand on front-of-house positions below and
 * in front of it, throwing up at the wall — one carries a slowly scrolling warm gradient
 * (the content), the other a white alignment grid (the chart every install starts with).
 * Their beams overlap across the middle of the wall, and the overlap simply ADDS: the
 * grid lines glow through the gradient, brighter than either throw alone, which is what
 * two real projectors do in a blend zone before anyone feathers them (§V644 — a beam is
 * light, so a surface both beams reach carries both). Along the top of the wall runs a
 * dentil cornice, and because the throws come from BELOW, each block prints a shadow
 * finger on the wall ABOVE itself — the beam cannot reach what the architecture hides,
 * which is precisely the answer previz exists to give before a truck is booked.
 *
 * ## The lens does the aiming, not the tilt
 *
 * Both projectors LOOK at the wall mid-height and reach the cornice line anyway, through
 * `shiftY` — the off-axis lens shift a real install turns. Shift slides the image up the
 * wall while the throw axis stays level, so the rectangle stays a rectangle; tilting the
 * projector up instead would keystone it into a trapezoid and someone would then dial
 * `keystoneV` to fight it. That whole trade — shift first, keystone only when you ran out
 * of shift — is the reason these are separate parameters, and this file demonstrates the
 * correct half of it.
 *
 * ## What the numbers mean on site
 *
 * `throwRatio 1.8` at ~6.3 m of throw is a ~3.5 m image width per projector — the number
 * printed on the lens barrel, distance ÷ width. Aim points sit 1.6 m apart, so the two
 * 3.5 m images share a ~1.8 m central blend zone. `brightness` is nominal at the Look At
 * distance with inverse-square falloff beyond it (`falloff` stays on — the physical
 * default), and `occlusion` stays on so the cornice actually blocks: off, the beams would
 * paint THROUGH the blocks, a decal that lies about the site.
 *
 * ## §V617's placement rule, where the meshes are chosen
 *
 * Wall, ground and cornice all wear the default LIT material, and the cornice especially
 * must: an unlit geometry exchanges no light in either direction (§V666), so an unlit
 * cornice would cast no projector shadow and the whole occlusion story would silently
 * vanish — a failure that reads as "shadows don't work" when it is actually "the material
 * opted out of light". The moon key is dim and cool on purpose: enough to read the
 * architecture as architecture, never enough to compete with the throws.
 */
const facadeDocument = document(
  "e36-facade",
  "E36 Facade",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 36 }),
  graph(
    [
      // ---- the content: what each projector carries --------------------------------
      node("drive", "lfo", [-2160, 40], { shape: "sine", frequency: 0.05, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "drive1" }),
      node("warm", "ramp", [-1860, 40], {
        type: "horizontal", interp: "smooth", period: 1,
        stops: [
          { position: 0.0, color: [1, 0.45, 0.08, 1] },
          { position: 0.45, color: [1, 0.12, 0.28, 1] },
          { position: 1.0, color: [0.62, 0.1, 0.85, 1] },
        ],
      }, {
        label: "warm1",
        definitionVersion: 2,
        resolution: { mode: "fixed", width: 256, height: 144 },
        /* The content MOVES — a scroll of the gradient, driven as a value (§V5). The
           projector re-samples it every frame; nothing about the throw recompiles. */
        parameters: { phase: drivenSlot("drive1", 0) },
      }),
      // The alignment chart: the first thing a real install ever throws.
      node("chart", "checker", [-1860, 340], {
        size: [8, 5], offset: [0, 0],
        color1: [0.05, 0.05, 0.06, 1], color2: [0.85, 0.85, 0.9, 1],
      }, { label: "chart1" }),

      // ---- the site: wall, ground, cornice ------------------------------------------
      node("wallPts", "pointGrid", [-1560, 40], { cols: 32, rows: 18, count: 576, sizeX: 8, sizeY: 4.2 }, { label: "wallpts1" }),
      node("wallLay", "pointKernel", [-1260, 40], {
        capacity: 576,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the grid stands up: the facade, 8 wide, foot on the ground at y = 0 */\n  q.position = vec3f(p.position.x, p.position.y + 2.1, 0.0);\n  return q;\n}",
      }, { label: "walllay1" }),
      /* Default LIT material on purpose (§V617): an unlit surface takes no projector
         light at all (§V666), and an 0.8 grey lambert IS a projection surface. */
      node("wall", "geometry", [-960, 40], { mode: "surface" }, { label: "wall1" }),

      node("groundPts", "pointGrid", [-1560, 340], { cols: 24, rows: 16, count: 384, sizeX: 10, sizeY: 8 }, { label: "groundpts1" }),
      node("groundLay", "pointKernel", [-1260, 340], {
        capacity: 384,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the grid lies down: the forecourt, from the wall foot toward the camera */\n  q.position = vec3f(p.position.x, 0.0, p.position.y + 4.0);\n  return q;\n}",
      }, { label: "groundlay1" }),
      node("ground", "geometry", [-960, 340], { mode: "surface" }, { label: "ground1" }),

      node("cornPts", "pointGrid", [-1560, 640], { cols: 9, rows: 1, count: 9, sizeX: 6.4, sizeY: 1 }, { label: "cornpts1" }),
      node("cornLay", "pointKernel", [-1260, 640], {
        capacity: 9,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* nine dentil blocks along the cornice line, jutting off the wall face */\n  q.position = vec3f(p.position.x, 3.25, 0.42);\n  return q;\n}",
      }, { label: "cornlay1" }),
      /* LIT, and this line is the load-bearing one (§V617/§V666): an unlit cornice casts
         no shadow, and the occlusion this example exists to show silently vanishes —
         a failure that would read as "shadows broke", not "the material opted out". */
      node("cornice", "geometry", [-960, 640], { mode: "instances", shape: "box", scale: 0.22 }, { label: "cornice1" }),

      // ---- the rig: two throws, one blend zone ---------------------------------------
      /* Aim at wall mid-height and climb the facade by LENS SHIFT, not tilt: the image
         slides up while the throw axis stays level, so the rectangle stays a rectangle.
         Tilting instead would keystone it — that is what keystoneV is for, AFTER shift
         runs out. throwRatio 1.8 over ~6.3 units of throw = a ~3.5-wide image each. */
      node("projL", "projector", [-640, 40], {
        eye: [-2, 1.2, 6], lookAt: [-0.8, 2.3, 0], throwRatio: 1.8, shiftY: 0.35, brightness: 1.1,
      }, { label: "projL1" }),
      node("projR", "projector", [-640, 340], {
        eye: [2, 1.2, 6], lookAt: [0.8, 2.3, 0], throwRatio: 1.8, shiftY: 0.35, brightness: 1.1,
      }, { label: "projR1" }),

      // ---- the night ------------------------------------------------------------------
      /* Enough moon to read the architecture, never enough to compete with a throw. */
      node("moon", "light", [-640, 640], {
        kind: "directional", direction: [0.4, -0.7, -0.6], color: [0.5, 0.62, 0.95, 1], intensity: 0.16, shadows: false,
      }, { label: "moon1" }),
      node("drift", "lfo", [-960, 940], { shape: "sine", frequency: 0.03, amplitude: 0.35, offset: 3.4, phase: 0 }, { label: "drift1" }),
      node("view", "camera", [-640, 940], {
        eye: [3.4, 1.9, 9.5], lookAt: [0, 2.2, 0], fov: 38, near: 0.1, far: 60, ortho: false,
      }, { label: "view1", parameters: { "eye.x": drivenSlot("drift1", 3.4) } }),

      node("shot", "render", [-320, 340], {
        scenes: "wall1 ground1 cornice1", camera: "view1", lights: "moon1",
        projectors: "projL1 projR1",
        ambientColor: [0.55, 0.65, 1, 1], ambientIntensity: 0.07,
        background: [0.008, 0.012, 0.028, 1],
      }, { label: "shot1" }),
      node("out", "output", [0, 340], {}, { label: "out1" }),
    ],
    [
      edge("e-warm-projL", ["warm", "out"], ["projL", "cookie"]),
      edge("e-chart-projR", ["chart", "out"], ["projR", "cookie"]),
      edge("e-wallpts-walllay", ["wallPts", "out"], ["wallLay", "in"]),
      edge("e-walllay-wall", ["wallLay", "out"], ["wall", "points"]),
      edge("e-groundpts-groundlay", ["groundPts", "out"], ["groundLay", "in"]),
      edge("e-groundlay-ground", ["groundLay", "out"], ["ground", "points"]),
      edge("e-cornpts-cornlay", ["cornPts", "out"], ["cornLay", "in"]),
      edge("e-cornlay-cornice", ["cornLay", "out"], ["cornice", "points"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * §V688 — the constants the polar field is built from, derived rather than typed in.
 * `circle` in distance mode emits `k * (rNorm - 1)` with `k = min(0.5/aspect, 0.5)`, so a
 * Level with `blacklevel: -k, whitelevel: 0` recovers normalised radius EXACTLY; and the
 * circular Ramp's atan2 is computed in uv space, so sampling it through a transform scaled
 * by 1/aspect is what turns it into the angle in pixel space.
 */
const ROSETTE_ASPECT = 1280 / 720;
const ROSETTE_POLAR_K = Math.min(0.5 / ROSETTE_ASPECT, 0.5);
const ROSETTE_INV_ASPECT = 720 / 1280;

/**
 * E39 — Rosette (T729).
 *
 *   stand1(noise 4d) ─┐ order 0
 *                     ├─► pick1(switch) ─────────────────► warp1.source
 *   clip1(movieFileIn)┘ order 1                                 ▲
 *                                                               │
 *   ang1(ramp circular, phase ┄ spin1, period ┄ petal1) ─► angfix1(transform) ─┐
 *                                                                              ├─► field1(reorder) ─► warp1.map
 *   rad1(circle, distance) ─► depth1(level, gamma ┄ deep1) ─────────────────────┘
 *
 *   warp1(remap) ─► paint1(lookup ◄─ palette1) ─┬─► burn1(add) ─► trim1 ─► out1
 *                                               └─► halo1(blur) ─► haze1(level) ─┘
 *
 * ## A POLAR WARP IS NOT A NODE — it is six nodes we already had (§V688)
 *
 * The brief for this example called log-polar "probably the single most versatile missing
 * primitive". It is not missing. Remap takes a uv FIELD and samples the source at it, so
 * any warp at all is a question of who builds the field — and the catalogue can build this
 * one: a circular Ramp is theta, a Circle in distance mode is rho, Reorder packs one into
 * red and the other into green, and Remap applies it. Nothing here is a special case of
 * "polar"; the same four nodes build any coordinate map you can draw.
 *
 * Three details are load-bearing, and each was measured rather than reasoned (§V688):
 *
 * ASPECT. `ramp(circular)` computes its atan2 in UV space, so on 16:9 the rays come out
 * elliptically spaced. `angfix1` samples the ramp through a transform scaled by 1/aspect,
 * which is exactly atan2(dv, du * aspect) — the angle in PIXEL space. Delete it and the
 * rosette squashes into an ellipse.
 *
 * RADIUS COMES FROM CIRCLE, NOT FROM `ramp(radial)`. The radial ramp is
 * `clamp(length(uv - 0.5) * 2, 0, 1)`, so everything outside the inscribed circle — all
 * four corners, about a fifth of a 16:9 frame — pins to one flat value and renders as dead
 * blocks. Circle's distance mode is unclamped and already aspect-aware, and
 * `level(blacklevel = -k, whitelevel = 0)` with `k = min(0.5/aspect, 0.5)` recovers
 * normalised radius exactly, because the node emits `k * (rNorm - 1)`.
 *
 * EXTEND IS `mirror`, NOT `repeat`. Rho runs past 1 at the corners and has to come back
 * somehow. Repeat FRACTS it, which is a discontinuity, and it showed as a stair-stepped
 * arc wherever the map crossed 1.0. Mirror folds instead of jumping, so the rings reflect
 * and there is no seam to see. The float working format is what lets rho exceed 1 at all.
 *
 * ## Not a tunnel, deliberately
 *
 * E1 already puts a transform inside a feedback loop and E29 already zooms one past 1.0 to
 * fall down a corridor. A third tunnel would teach nothing. This is the other thing the
 * polar map is for: repetition AROUND the circle rather than travel INTO it, which is why
 * the driven parameter is the ramp's `period` — the count of times the source wraps the
 * axis — and not a scale.
 *
 * ## The bloom threshold is GAMMA, never a black level (§V694)
 *
 * `haze1` was a Level with `blacklevel: 0.68` — the obvious way to write "bloom only the
 * highlights", and a trap. A positive black level is a SUBTRACTION, `rgba16float` does not
 * clamp, and every pixel below 0.68 (nearly all of them) went negative as far as -2.1, so
 * `burn1` subtracted the bloom everywhere it was not blooming. At the liveness probe size
 * `paint1` spanned 0.545 and `burn1` came out at 0.115 — an ADD that reduced range, which
 * is the algebraic tell (§V698). `gamma1` below one crushes midtones and keeps highlights
 * without ever crossing zero, and the same picture then measures 0.970.
 *
 * `halo1` is 16px and not 34 for a separate reason (§V699): blur size is in PIXELS and the
 * contrast floor measures at 192x108, so a 2.7% glow at 1280 is an 18%-of-width wash there.
 *
 * ## The palette had to be balanced by LIGHT, not by numbers (§V695)
 *
 * Ramp stops are declared in display space and decode to linear, which costs a dark cool
 * colour most of its luminance while a bright warm one barely moves: the first version of
 * `palette1` looked balanced as authored numbers and played back as red over black,
 * because [0.05, 0.36, 0.55] lands at linear [0.004, 0.106, 0.267] and simply reads as
 * black. The cool half is lifted until it carries comparable light.
 */
const rosetteDocument = document(
  "rosette",
  "E39 Rosette",
  settings(),
  graph(
    [
      // ── the performer, and the seat kept warm for your own footage ──────────
      node("stand", "noise", [-1620, -200], {
        type: "perlin4d",
        seed: 5,
        period: 0.16,
        harmon: 4,
        spread: 2.1,
        gain: 0.58,
        rough: 0.5,
        exp: 1.2,
        amp: 2.6,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        speed: 0.19,
        t4d: 0.4,
        s4d: 1,
      }, { label: "stand1" }),
      node("clip", "movieFileIn", [-1620, 100], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("pick", "switch", [-1360, 150], { index: 0 }, { label: "pick1" }),

      // ── theta: a circular ramp, un-skewed by a transform in the ramp's own space ──
      node("ang", "ramp", [-1360, -420], {
        type: "circular",
        interp: "linear",
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 1, color: [1, 1, 1, 1] },
        ],
      }, { label: "ang1", definitionVersion: 2, parameters: { phase: drivenSlot("spin1", 0), period: drivenSlot("petal1:low", 6), } }),
      node("angfix", "transform", [-1100, -420], {
        t: [0, 0],
        r: 0,
        s: [ROSETTE_INV_ASPECT, 1],
        p: [0, 0],
        xord: "srt",
        extend: "hold",
        aspectcorrect: false,
      }, { label: "angfix1" }),

      // ── rho: an unclamped radius, curved by gamma ──────────────────────────
      node("rad", "circle", [-1360, -180], {
        mode: "distance",
        center: [0.5, 0.5],
        radius: [0.5, 0.5],
        softness: 0.005,
        fillcolor: [1, 1, 1, 1],
        bgcolor: [0, 0, 0, 0],
        aspectcorrect: true,
      }, { label: "rad1" }),
      node("depth", "level", [-1100, -180], {
        blacklevel: -ROSETTE_POLAR_K,
        whitelevel: 0,
        contrast: 1,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "depth1", parameters: { gamma1: drivenSlot("deep1:lowMid", 1.6), } }),

      // ── the uv field, and the warp ────────────────────────────────────────
      node("field", "reorder", [-840, -300], {
        outr: "in1r",
        outg: "in2r",
        outb: "zero",
        outa: "one",
      }, { label: "field1" }),
      node("warp", "remap", [-580, -80], {
        sourcex: "red",
        sourcey: "green",
        flipu: false,
        flipv: false,
        extend: "mirror",
      }, { label: "warp1" }),

      // ── the grade ─────────────────────────────────────────────────────────
      node("palette", "ramp", [-840, 300], {
        type: "horizontal",
        interp: "linear",
        phase: 0,
        period: 1,
        stops: [
          { position: 0, color: [0.01, 0.02, 0.06, 1] },
          { position: 0.2, color: [0.05, 0.16, 0.42, 1] },
          { position: 0.4, color: [0.1, 0.55, 0.78, 1] },
          { position: 0.58, color: [0.45, 0.35, 0.85, 1] },
          { position: 0.76, color: [0.92, 0.32, 0.48, 1] },
          { position: 0.9, color: [1, 0.72, 0.32, 1] },
          { position: 1, color: [1, 0.98, 0.92, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("paint", "lookup", [-320, -80], {
        channel: "luminance",
        row: 0.5,
        offset: 0,
      }, { label: "paint1", parameters: { scale: drivenSlot("hue1:highMid", 1), } }),

      // ── bloom ─────────────────────────────────────────────────────────────
      node("halo", "blur", [-60, 200], { size: 16, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haze", "level", [200, 200], {
        blacklevel: 0,
        whitelevel: 1,
        gamma1: 0.4,
        contrast: 1,
        brightness: 1.1,
        invert: 0,
        opacity: 1,
      }, { label: "haze1" }),
      node("burn", "add", [200, -80], { opacity: 1 }, { label: "burn1" }),
      node("trim", "level", [460, -80], {
        blacklevel: 0.015,
        whitelevel: 1.05,
        gamma1: 1,
        contrast: 1.15,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "trim1" }),
      node("out", "output", [720, -80], {}, { label: "out1" }),

      // ── the score ─────────────────────────────────────────────────────────
      node("beat", "audioPattern", [-1620, 600], { bpm: 118, amount: 1, beatsPerBar: 4 }, { label: "beat1" }),
      node("smooth", "valueLag", [-1360, 600], { lag: 0.09 }, { label: "smooth1" }),
      node("spin", "lfo", [-1620, 340], { shape: "saw", frequency: 0.037, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "spin1" }),

      node("petalg", "valueMath", [-1100, 620], { operation: "multiply", operand: 5.5 }, { label: "petalg1" }),
      node("petalb", "valueMath", [-840, 620], { operation: "add", operand: 4.2 }, { label: "petalb1" }),
      node("petal", "valueLimit", [-580, 620], { minimum: 3, maximum: 11 }, { label: "petal1" }),

      node("deepg", "valueMath", [-1100, 880], { operation: "multiply", operand: 2.4 }, { label: "deepg1" }),
      node("deepb", "valueMath", [-840, 880], { operation: "add", operand: 0.9 }, { label: "deepb1" }),
      node("deep", "valueLimit", [-580, 880], { minimum: 0.6, maximum: 4.5 }, { label: "deep1" }),

      node("hueg", "valueMath", [-1100, 1140], { operation: "multiply", operand: 0.9 }, { label: "hueg1" }),
      node("hueb", "valueMath", [-840, 1140], { operation: "add", operand: 0.72 }, { label: "hueb1" }),
      node("hue", "valueLimit", [-580, 1140], { minimum: 0.45, maximum: 1.9 }, { label: "hue1" }),
    ],
    [
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-ang-angfix", ["ang", "out"], ["angfix", "input"]),
      edge("e-rad-depth", ["rad", "out"], ["depth", "input"]),
      edge("e-angfix-field", ["angfix", "out"], ["field", "in1"]),
      edge("e-depth-field", ["depth", "out"], ["field", "in2"]),
      edge("e-pick-warp", ["pick", "out"], ["warp", "source"]),
      edge("e-field-warp", ["field", "out"], ["warp", "map"]),
      edge("e-warp-paint", ["warp", "out"], ["paint", "source"]),
      edge("e-palette-paint", ["palette", "out"], ["paint", "lookup"]),
      edge("e-paint-halo", ["paint", "out"], ["halo", "input"]),
      edge("e-halo-haze", ["halo", "out"], ["haze", "input"]),
      edge("e-paint-burn", ["paint", "out"], ["burn", "in1"], 0),
      edge("e-haze-burn", ["haze", "out"], ["burn", "in2"], 1),
      edge("e-burn-trim", ["burn", "out"], ["trim", "input"]),
      edge("e-trim-out", ["trim", "out"], ["out", "input"]),
      edge("e-beat-smooth", ["beat", "out"], ["smooth", "in"]),
      edge("e-smooth-petalg", ["smooth", "out"], ["petalg", "a"]),
      edge("e-petalg-petalb", ["petalg", "out"], ["petalb", "a"]),
      edge("e-petalb-petal", ["petalb", "out"], ["petal", "in"]),
      edge("e-smooth-deepg", ["smooth", "out"], ["deepg", "a"]),
      edge("e-deepg-deepb", ["deepg", "out"], ["deepb", "a"]),
      edge("e-deepb-deep", ["deepb", "out"], ["deep", "in"]),
      edge("e-smooth-hueg", ["smooth", "out"], ["hueg", "a"]),
      edge("e-hueg-hueb", ["hueg", "out"], ["hueb", "a"]),
      edge("e-hueb-hue", ["hueb", "out"], ["hue", "in"]),
    ],
  ),
);

/**
 * E40 — Wake (T729).
 *
 *   bed1(noise 4d, nearly still) ─┐
 *   orb1(circle ┄ pathx1/pathy1) ─┴─► stand1(add) ─┐ order 0
 *                                                   ├─► pick1(switch) ─┬─► past1(cache, 6 back)
 *   clip1(movieFileIn) ─────────────────────────────┘ order 1          │        │
 *                                                                      ▼        ▼
 *                                              under1(level) ◄─┐   moved1(difference)
 *                                                              │        │
 *   gain1(level, whitelevel ┄ bite1) ◄────────────────────────────────── ┘
 *        │
 *        ├─► shiftr1(transform ┄ tear1) ─► fuser1(reorder) ─┐
 *        └─► shiftb1(transform ┄ tearb1) ─► fuseb1(reorder) ┴─► born1(add) ◄─ loop1(feedback)
 *                                                                  │
 *                             born1 ─► paint1(lookup ◄─ palette1) ─┴─► lay1(add) ─► trim1 ─► out1
 *
 * ## What a Cache is FOR, other than a delay line
 *
 * E24 reads three cache taps as an RGB delay, which uses the ring as an echo. This uses it
 * as an INSTRUMENT: the difference between now and six frames ago is a motion field, and
 * everything downstream is a reading of that field rather than of the picture. It is the
 * one operation in the set that cannot be evaluated on a single frame — the subject of the
 * example is change itself, which is why its claims are asserted across FRAME PAIRS and not
 * from a still (§V681).
 *
 * ## The understudy has to MOVE, and that is not decoration (§V687)
 *
 * §V363 says a demo demonstrates itself. An example whose subject is change has no null
 * state that looks like anything: the first version of this graph used a `perlin3d` with no
 * driver, and since `speed` advances the FOURTH dimension and a 3D noise has none (T518,
 * §V624), the field never changed and the whole file rendered PURE BLACK. Not dim — black,
 * with every structural test green about it. So `bed1` is `perlin4d` with a real `speed`,
 * and the subject is `orb1` on two LFOs. The bed is nearly still ON PURPOSE: a bed evolving
 * as fast as the subject travels makes the detector see motion everywhere and the subject
 * never stands out. Something has to hold still for a wake to be a wake ON.
 *
 * ## Grade AFTER the accumulator, so the palette axis is AGE
 *
 * The obvious wiring puts the Lookup before the loop, and it is wrong: the loop then sums
 * GRADED colour, the head pins white, and the tail carries no hue at all. Feeding the raw
 * motion into the accumulator and grading what comes OUT makes the ramp a map of how long
 * ago a pixel moved — fresh reads warm, old reads cool — which is the picture this example
 * is for. So the loop closes on `born1`, not on the final output: §V471.5's shape inverted
 * for the same reason E34 inverts it, because a loop closing on the finished frame would
 * smear the bed along with the wake.
 *
 * ## NO subtractive offset inside a float loop (§V694)
 *
 * This graph had a Level in the loop with `blacklevel: 0.008`, copying E1's idiom for
 * terminating a trail. E1's docstring says blacklevel "crushes the dimmest survivors to
 * zero", which is true in a unorm format and FALSE in the `rgba16float` we ship: an empty
 * pixel goes to -0.008, the loop drives it further down every frame, and the downstream Add
 * then came out DARKER than its own base layer — the bed vanished completely and it read as
 * the compositor being broken. Persistence is already the decay and it cannot go negative,
 * so the node is gone rather than fixed.
 *
 * ## §V703 — the guard found two of these in this very file
 *
 * The structural claim "no Level on the feedback path carries a positive blacklevel" went
 * red on this document within an hour of §V694 being written. `gain1` had 0.02, which sent
 * a zero pixel to -0.00917 and compounded to a -0.1835 floor in the accumulator; `under1`
 * had 0.06, which sent a BLACK source pixel to -0.064 and subtracted it from the wake.
 *
 * They are not equally bad, and the difference is worth knowing. `gain1`'s negative was
 * CONTAINED — `paint1` is a Lookup, and a Lookup clamps by indexing, so a negative index
 * reads the first stop and the value never escapes `born1`. `under1`'s was not contained:
 * it feeds `lay1` directly, so it darkened the finished frame. And it was invisible here
 * because the synthetic bed sits near 0.6 luma; it would have appeared the moment someone
 * pointed `clip1` at footage with real blacks, as a wake that thins over the dark parts of
 * their video for no visible reason. Both are 0 now, and `whitelevel` and `brightness`
 * already carried the range each was nominally buying.
 *
 * ## The gain pairs are fitted to a MEASURED field (§V696)
 *
 * `bite1` sets `gain1.whitelevel`, and the honest number depends entirely on what the
 * difference actually measures — which changed by thirteen times when `orb1` was given a
 * faster path. Fitted by eye it was wrong by an order of magnitude twice, once mapping the
 * field's MEDIAN to 0.86 and blowing the frame white. Louder low band lowers the white
 * point, so the wake flares on the kick; `hold1` lengthens the trail on the same beat.
 */
const wakeDocument = document(
  "wake",
  "E40 Wake",
  settings(),
  graph(
    [
      node("bed", "noise", [-1620, -420], {
        type: "perlin4d",
        seed: 11,
        period: 0.11,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1.4,
        amp: 1.5,
        offset: 0.1,
        mono: true,
        aspectcorrect: true,
        speed: 0.035,
        t4d: 0,
        s4d: 1,
      }, { label: "bed1" }),
      node("orb", "circle", [-1620, -160], {
        mode: "fill",
        center: [0.5, 0.5],
        radius: [0.085, 0.085],
        softness: 0.09,
        fillcolor: [1, 0.97, 0.9, 1],
        bgcolor: [0, 0, 0, 0],
        aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("pathx1", 0.5), "center.y": drivenSlot("pathy1", 0.5), } }),
      node("stand", "add", [-1360, -70], { opacity: 1 }, { label: "stand1" }),
      node("pathx", "lfo", [-1620, 360], { shape: "sine", frequency: 0.29, amplitude: 0.33, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-1620, 600], { shape: "sine", frequency: 0.203, amplitude: 0.3, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("clip", "movieFileIn", [-1620, 100], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("pick", "switch", [-1360, 150], { index: 0 }, { label: "pick1" }),

      // ── the delay line and the difference against it ───────────────────────
      node("past", "cache", [-1100, 320], { frames: 8, index: 6, scale: 1 }, { label: "past1" }),
      node("moved", "difference", [-840, 150], {}, { label: "moved1" }),
      node("gain", "level", [-580, 150], {
        blacklevel: 0,
        gamma1: 1,
        contrast: 1,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "gain1", parameters: { whitelevel: drivenSlot("bite1:low", 2.2), } }),

      // ── chromatic split of the motion, not of the picture ──────────────────
      node("shiftr", "transform", [-320, -60], {
        t: [0.006, 0],
        r: 0,
        s: [1, 1],
        p: [0, 0],
        xord: "srt",
        extend: "hold",
        aspectcorrect: false,
      }, { label: "shiftr1", parameters: { "t.x": drivenSlot("tear1:high", 0.006), } }),
      node("shiftb", "transform", [-320, 360], {
        t: [-0.006, 0],
        r: 0,
        s: [1, 1],
        p: [0, 0],
        xord: "srt",
        extend: "hold",
        aspectcorrect: false,
      }, { label: "shiftb1", parameters: { "t.x": drivenSlot("tearb1:high", -0.006), } }),
      node("fuser", "reorder", [-60, 60], {
        outr: "in2r",
        outg: "in1g",
        outb: "in1b",
        outa: "one",
      }, { label: "fuser1" }),
      node("fuseb", "reorder", [200, 60], {
        outr: "in1r",
        outg: "in1g",
        outb: "in2b",
        outa: "one",
      }, { label: "fuseb1" }),

      // ── grade the motion ──────────────────────────────────────────────────
      node("palette", "ramp", [720, 420], {
        type: "horizontal",
        interp: "linear",
        phase: 0,
        period: 1,
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.22, color: [0.02, 0.09, 0.22, 1] },
          { position: 0.46, color: [0.05, 0.5, 0.62, 1] },
          { position: 0.68, color: [0.2, 0.92, 0.72, 1] },
          { position: 0.86, color: [0.85, 0.98, 0.55, 1] },
          { position: 1, color: [1, 1, 0.95, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("paint", "lookup", [980, 60], {
        channel: "luminance",
        row: 0.5,
        offset: 0,
        scale: 1.25,
      }, { label: "paint1" }),

      // ── the phosphor: only what MOVED enters the loop ─────────────────────
      node("loop", "feedback", [460, 380], {
        source: "born1",
        clearColor: [0, 0, 0, 0],
        reset: false,
        substeps: 1,
      }, { label: "loop1", parameters: { persistence: drivenSlot("hold1:level", 0.95), } }),
      node("born", "add", [720, 60], { opacity: 1 }, { label: "born1" }),

      // ── the subject, held down under its own wake ────────────────────────
      node("under", "level", [-1100, -140], {
        blacklevel: 0,
        whitelevel: 1,
        gamma1: 1,
        contrast: 1.4,
        brightness: 0.2,
        invert: 0,
        opacity: 1,
      }, { label: "under1" }),
      node("lay", "add", [1240, 60], { opacity: 1 }, { label: "lay1" }),
      node("trim", "level", [1500, 60], {
        blacklevel: 0,
        whitelevel: 1.25,
        gamma1: 1,
        contrast: 1.08,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "trim1" }),
      node("out", "output", [1760, 60], {}, { label: "out1" }),

      // ── the score ────────────────────────────────────────────────────────
      node("beat", "audioPattern", [-1620, 840], { bpm: 126, amount: 1, beatsPerBar: 4 }, { label: "beat1" }),
      node("smooth", "valueLag", [-1360, 840], { lag: 0.07 }, { label: "smooth1" }),

      node("biteg", "valueMath", [-1100, 620], { operation: "multiply", operand: -1.6 }, { label: "biteg1" }),
      node("biteb", "valueMath", [-840, 620], { operation: "add", operand: 3 }, { label: "biteb1" }),
      node("bite", "valueLimit", [-580, 620], { minimum: 1.6, maximum: 3.2 }, { label: "bite1" }),

      node("tearg", "valueMath", [-1100, 880], { operation: "multiply", operand: 0.03 }, { label: "tearg1" }),
      node("tearb", "valueMath", [-840, 880], { operation: "add", operand: 0.004 }, { label: "tearb1" }),
      node("tear", "valueLimit", [-580, 880], { minimum: 0.001, maximum: 0.03 }, { label: "tear1" }),
      node("tearng", "valueMath", [-1100, 1140], { operation: "multiply", operand: -0.03 }, { label: "tearng1" }),
      node("tearnb", "valueMath", [-840, 1140], { operation: "add", operand: -0.004 }, { label: "tearnb1" }),
      node("tearn", "valueLimit", [-580, 1140], { minimum: -0.03, maximum: -0.001 }, { label: "tearb1" }),

      node("holdg", "valueMath", [-1100, 1400], { operation: "multiply", operand: 0.032 }, { label: "holdg1" }),
      node("holdb", "valueMath", [-840, 1400], { operation: "add", operand: 0.93 }, { label: "holdb1" }),
      node("hold", "valueLimit", [-580, 1400], { minimum: 0.92, maximum: 0.972 }, { label: "hold1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"], 0),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"], 1),
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-pick-past", ["pick", "out"], ["past", "input"]),
      edge("e-pick-moved", ["pick", "out"], ["moved", "in1"], 0),
      edge("e-past-moved", ["past", "out"], ["moved", "in2"], 1),
      edge("e-moved-gain", ["moved", "out"], ["gain", "input"]),
      edge("e-gain-shiftr", ["gain", "out"], ["shiftr", "input"]),
      edge("e-gain-shiftb", ["gain", "out"], ["shiftb", "input"]),
      edge("e-gain-fuser", ["gain", "out"], ["fuser", "in1"]),
      edge("e-shiftr-fuser", ["shiftr", "out"], ["fuser", "in2"]),
      edge("e-fuser-fuseb", ["fuser", "out"], ["fuseb", "in1"]),
      edge("e-shiftb-fuseb", ["shiftb", "out"], ["fuseb", "in2"]),
      edge("e-fuseb-born", ["fuseb", "out"], ["born", "in1"], 0),
      edge("e-loop-born", ["loop", "out"], ["born", "in2"], 1),
      edge("e-born-paint", ["born", "out"], ["paint", "source"]),
      edge("e-palette-paint", ["palette", "out"], ["paint", "lookup"]),
      edge("e-pick-under", ["pick", "out"], ["under", "input"]),
      edge("e-under-lay", ["under", "out"], ["lay", "in1"], 0),
      edge("e-paint-lay", ["paint", "out"], ["lay", "in2"], 1),
      edge("e-lay-trim", ["lay", "out"], ["trim", "input"]),
      edge("e-trim-out", ["trim", "out"], ["out", "input"]),
      edge("e-beat-smooth", ["beat", "out"], ["smooth", "in"]),
      edge("e-smooth-biteg", ["smooth", "out"], ["biteg", "a"]),
      edge("e-biteg-biteb", ["biteg", "out"], ["biteb", "a"]),
      edge("e-biteb-bite", ["biteb", "out"], ["bite", "in"]),
      edge("e-smooth-tearg", ["smooth", "out"], ["tearg", "a"]),
      edge("e-tearg-tearb", ["tearg", "out"], ["tearb", "a"]),
      edge("e-tearb-tear", ["tearb", "out"], ["tear", "in"]),
      edge("e-smooth-tearng", ["smooth", "out"], ["tearng", "a"]),
      edge("e-tearng-tearnb", ["tearng", "out"], ["tearnb", "a"]),
      edge("e-tearnb-tearn", ["tearnb", "out"], ["tearn", "in"]),
      edge("e-smooth-holdg", ["smooth", "out"], ["holdg", "a"]),
      edge("e-holdg-holdb", ["holdg", "out"], ["holdb", "a"]),
      edge("e-holdb-hold", ["holdb", "out"], ["hold", "in"]),
    ],
  ),
);

/**
 * E37 — Sirocco (T727). The canonical TouchDesigner particle look, and the first example
 * in the set to draw `geometry` in `points` mode at all.
 *
 *   drift1(pointKernel · THE WIND) ─► streak1(pointKernel · THE READING) ─┬─► body1(geometry · BEAM)
 *      curl of a vector potential        trail = position − velocity·t     ├─► fast1(geometry · BEAM)
 *      + containment + inertia           size  = f(speed)                  └─► heads1(geometry · POINTS)
 *                                                                               ▲ haze1(materialUnlit)
 *   orbx1/orbz1(lfo) ─► eye1(camera) ─► shot1(render)
 *   shot1 ─┬──────────────────────────────► burn1(add) ─► hue1(hsv ┄ drift2) ─► out1
 *          └─► halo1(blur) ─► halolvl1(level) ─┘
 *
 * ## The streak is FREE, and that is T680's own claim collected
 *
 * `beam` mode takes a per-point FAR END, and its author named the generalisation when it
 * shipped: "velocity-scaled streaks for E16-Murmuration, spark trails for E9-Ember, a
 * previous-position trail anywhere." This is that, cashed: `streak1` writes
 * `trail = position − velocity × TRAIL`, so the ribbon IS the distance the mote covers in
 * a third of a second, and a fast mote draws a long one BY CONSTRUCTION. One attribute,
 * no history buffer, no second pass.
 *
 * Derived from VELOCITY rather than from the PREVIOUS POSITION deliberately: a
 * previous-position trail draws a false streak across the frame the instant anything moves
 * a point discontinuously, and a velocity trail cannot, because velocity does not jump
 * when position does.
 *
 * ## Three capabilities that had no witness (§V624's spirit, at the catalogue's scale)
 *
 * `geometry` mode `points` was drawn by NO shipped example — every scene used `surface`,
 * `instances` or `beam` — which is how §B132 (points-mode `scale` silently inert; every
 * authored size rendering as 0.05, live since T647) survived to be found by measurement
 * rather than by looking. `heads1` is that mode's first witness, and dropping it from the
 * render changes 9.0% of the frame. T721's mapped `scale` had none either; all three draws
 * take it off the `size` attribute, so the number on the node stays the object's size and
 * the attribute is a factor.
 *
 * ## FIVE channels where one kernel may declare FOUR (§V588)
 *
 * The ceiling is PER KERNEL, and a chain is how you spend more than one kernel's worth.
 * `drift1` owns position, velocity and tint; `streak1` declares position, velocity, trail
 * and size — exactly four, AT the ceiling — and does not declare `tint`, so the colour
 * travels past it by reference (§V197). Same split E16 makes between flock and part, and
 * E34 between cast and sight: the simulation in one kernel, the reading in another.
 *
 * ## Why the colour is authored in the KERNEL and there is no palette lookup
 *
 * E31 grades a luminance lookup because its three point layers are flat-coloured. Here the
 * kernel writes a per-point tint (§V471.2) and the draws WEAR it, so a lookup keyed on
 * luminance would discard the one thing the kernel is saying. The heat term is SQUARED,
 * measured: the median mote sits at heat ≈ 0.46, so squaring puts the body of the cloud in
 * deep blue and spends the amber on the genuinely fast few — a linear ramp washed every
 * streak to the same cream, which is what the first build looked like.
 *
 * ## §V681, which this example is a standing test of
 *
 * A streak field's whole claim is a CORRESPONDENCE — that each ribbon belongs to the mote
 * it is drawn from. `sirocco.gpu.test.ts` asserts it structurally because nothing else can:
 * flipping the trail's sign gives every ribbon the right length and the wrong owner, and
 * the look instrument moves by 0.1% of range (0.4129 → 0.4125) — straight through §V678's
 * 10% band. Freezing the simulation entirely still reads 0.026 motion, because the camera
 * and the hue drift are still running. Only a claim that names the correspondence sees it.
 */
/** Motes. Three draws of six vertices each ride this number. */
const SIROCCO_POINTS = 18000;

/** Camera orbit radius; the two LFO amplitudes are this number. */
const SIROCCO_ORBIT = 4.20;

const SIROCCO_DRIFT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", qualifier: "direction", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0.2, 0.3, 0.6, 1] },
]);

const SIROCCO_STREAK_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", qualifier: "direction", default: [0, 0, 0] },
  { name: "trail", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "size", type: "f32", semantic: "size", default: [1] },
]);

const SIROCCO_DRIFT_KERNEL = `const TAU: f32 = 6.28318530717958647692;

/* The radius the warm start fills, and the radius the containment starts pushing back
   at. Seeding INSIDE the containment means frame zero opens on a settled cloud rather
   than on a shell collapsing inward. */
const SEED_RADIUS: f32 = 1.05;
const BOUND: f32 = 1.05;

/* How hard the wind blows, and how fast a mote gives in to it. FLOW scales the curl to
   clip units per second; DRAG is the reciprocal of the time a mote takes to adopt the
   wind, so a small number is a heavy mote that keeps its own line through a gust. */
const FLOW: f32 = 0.20;
const DRAG: f32 = 1.35;

/* The reference speed the colour normalises against — the SAME number the streak
   kernel sizes against, so "fast" means one thing in this document (§V349). */
const SPEED_REFERENCE: f32 = 0.85;

/* The exposure, in ONE place. The draws are OPAQUE and depth-tested (a scene draw is
   not an additive splat), so brightness here is not accumulation — it is how light the
   cloud's own surface is, and the whole picture rides on it. */
const TINT_GAIN: f32 = 0.66;

/**
 * THE VECTOR POTENTIAL. What a mote feels is its CURL, below, and the curl of any field
 * is divergence-free BY CONSTRUCTION: this wind can stretch the cloud, fold it and shed
 * sheets off it, and it can never squeeze it into a knot or drain it into a point. That
 * property is the whole reason a flow field is authored as a potential and differentiated
 * rather than written down as three noises directly — three independent noises have
 * sources and sinks, and a cloud in one of them collects into blobs within seconds.
 *
 * Three terms at three scales, all moving. The broad term sets the sheets, the middle one
 * folds them, and the fine one is what stops the volume reading as a single slow swirl.
 */
fn potential(pos: vec3f, t: f32) -> vec3f {
  let broad = vec3f(
    sin(pos.y * 2.30 + t * 0.51) * cos(pos.z * 1.90 - t * 0.37),
    sin(pos.z * 2.10 - t * 0.44) * cos(pos.x * 2.60 + t * 0.29),
    sin(pos.x * 1.70 + t * 0.33) * cos(pos.y * 2.40 - t * 0.41)
  );
  let fold = vec3f(
    sin((pos.z + pos.x) * 4.30 - t * 0.83),
    sin((pos.x + pos.y) * 4.70 + t * 0.71),
    sin((pos.y + pos.z) * 3.90 - t * 0.62)
  ) * 0.34;
  let fine = vec3f(
    cos(pos.x * 8.10 - t * 1.13),
    cos(pos.y * 7.30 + t * 0.97),
    cos(pos.z * 8.90 - t * 1.07)
  ) * 0.11;
  return broad + fold + fine;
}

/* curl(P) = (dPz/dy - dPy/dz, dPx/dz - dPz/dx, dPy/dx - dPx/dy), central differences.
   Six potential evaluations per mote per frame, which is the price of the property
   above and is paid once here rather than approximated. */
fn curl3(pos: vec3f, t: f32) -> vec3f {
  let e = 0.045;
  let dx = (potential(pos + vec3f(e, 0.0, 0.0), t) - potential(pos - vec3f(e, 0.0, 0.0), t)) / (2.0 * e);
  let dy = (potential(pos + vec3f(0.0, e, 0.0), t) - potential(pos - vec3f(0.0, e, 0.0), t)) / (2.0 * e);
  let dz = (potential(pos + vec3f(0.0, 0.0, e), t) - potential(pos - vec3f(0.0, 0.0, e), t)) / (2.0 * e);
  return vec3f(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
}

/* How long the warm start runs before frame zero is shown, and at what step. FOUR
   SECONDS: the cloud needs about that long to fold, and a gallery thumbnail is frame 0
   (T535) — seeded cold, this file's card is a fuzzy ball that the piece never shows
   again. Measured: 22.3% of the frame lit and a uniform sphere at frame 0 without it. */
const PREROLL_STEPS: i32 = 120;
const PREROLL_DT: f32 = 1.0 / 30.0;

/* A ball filled BY VOLUME, not by radius: the cube root on the radial draw is what
   keeps the centre from being dense and the shell from being empty. */
fn seedBall(id: u32) -> vec3f {
  let u = pointRand(id, 11u);
  let v = pointRand(id, 23u);
  let w = pointRand(id, 37u);
  let cosT = 1.0 - 2.0 * v;
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = TAU * w;
  let r = SEED_RADIUS * pow(max(u, 1.0e-6), 1.0 / 3.0);
  return vec3f(r * sinT * cos(phi), r * sinT * sin(phi), r * cosT);
}

struct State {
  pos: vec3f,
  vel: vec3f,
};

/**
 * ONE STEP OF THE WIND — and it is one function because it is integrated in TWO places:
 * once per frame below, and PREROLL_STEPS times as the warm start. E9 states the rule and
 * this file obeys it: a warm start computed by different arithmetic from the simulation is
 * a warm start that opens on a picture the piece never shows.
 */
fn step(s: State, t: f32, dt: f32) -> State {
  let flow = curl3(s.pos, t) * FLOW;

  /* CONTAINMENT: zero inside the ball and rising outside it, so the cloud has an EDGE
     without a wall. Motes are turned back over about half a unit; nothing is clamped and
     nothing is teleported — a clamp parks a population on the boundary sphere and reads as
     a hard shell, and a teleport is a jump the streak cannot represent. */
  let d = length(s.pos);
  let outward = s.pos / max(d, 1.0e-5);
  let contain = -outward * smoothstep(BOUND, BOUND + 0.55, d) * 2.20;

  /* Motes are ACCELERATED toward the wind against their own inertia, never carried along
     it: the picture is the field INTEGRATED, which is the whole of §V427 — noise is smooth
     at every scale and a simulation is not. Turn DRAG up far enough and this degenerates
     into exactly the plain noise lookup it exists not to be. */
  let vel = s.vel + ((flow - s.vel) * DRAG + contain) * dt;
  return State(s.pos + vel * dt, vel);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* §V73 says a SLOT is not an identity, and here is why ctx.index is nonetheless the
     right identity to hash on: this is the BASIC kernel — no spawn, no kill, no
     compaction — so no slot ever moves for the life of the buffer. E9 carries a real id
     attribute because the ADVANCED kernel mints and compacts, which is exactly when the
     slot stops being stable. Spending an attribute here to restate a constant would cost
     a quarter of the four-attribute budget (§V588) for nothing. */
  let id = ctx.index;

  /* FREE-RUNNING (§V436): ctx.absTime, never ctx.time. The wind does not restart when the
     piece does — ctx.time wraps at the out point (T455) and would put every phase of the
     potential back where it was at frame zero, snapping the whole cloud at each lap.
     ctx.delta is untouched: a step is continuous across a lap by construction (T464). */
  let t = ctx.absTime;

  var s = State(p.position, p.velocity);

  /* THE SEEDING SIGNAL — ctx.firstRun, which means "my storage was just created or
     cleared" and NOTHING else (T510/§V495). frameIndex == 0 also means "the timeline
     lapped", and a lap KEEPS its buffers, so a simulation must survive it while a seek
     and a document load must rebuild it.

     The seed takes its velocity FROM THE FIELD rather than from zero, and that is a warm
     start rather than a nicety: a gallery thumbnail is frame 0 (T535), the streak length
     is the velocity, and a cloud seeded at rest opens on a frame with no streaks in it at
     all — the one picture this example exists to show. */
  if (ctx.firstRun == 1u) {
    /* THE WARM START. Seeded at rest and then RUN — four seconds of the same step the
       frame below takes, ending exactly at this frame's clock, so what frame zero shows is
       a cloud that has already folded rather than the sphere it started as. */
    s = State(seedBall(id), vec3f(0.0));
    for (var k: i32 = 0; k < PREROLL_STEPS; k = k + 1) {
      s = step(s, t - f32(PREROLL_STEPS - k) * PREROLL_DT, PREROLL_DT);
    }
  }

  s = step(s, t, ctx.delta);

  let pos = s.pos;
  let vel = s.vel;
  q.position = pos;
  q.velocity = vel;

  /* THE COLOUR IS DATA THE KERNEL WRITES (§V471.2), and the draws below select on it and
     wear it — there is no palette lookup downstream to discard it. Two ideas, not one: how
     fast this mote is going, and WHERE IT IS in a band travelling slowly through the
     volume. Speed alone reads as a speedometer; the band is what makes the cloud look lit
     from somewhere. LINEAR values, because attributes are data and nothing display-decodes
     a per-point colour (§V56). */
  let heat = clamp(length(vel) / SPEED_REFERENCE, 0.0, 1.0);
  let band = 0.5 + 0.5 * sin(pos.y * 2.20 - t * 0.23 + heat * 2.10);
  /* SQUARED heat, and that is what makes the picture read as a wind rather than as a
     gradient: the median mote sits at heat ~0.46, so heat*heat puts the whole BODY of the
     cloud in deep blue and spends the amber only on the genuinely fast few. A linear ramp
     here washes every streak to the same cream — measured, and it is the difference
     between the first render and this one. */
  let hue = mix(vec3f(0.020, 0.070, 0.340), vec3f(0.920, 0.400, 0.100), heat * heat);
  /* The band's own contribution is a SHIFT, not a second ramp: it tips the cold end
     toward teal and the hot end toward rose, so two motes at the same speed in different
     parts of the volume are not the same colour. */
  let shift = mix(vec3f(-0.010, 0.060, -0.070), vec3f(0.060, -0.050, 0.130), band);
  q.tint = vec4f(TINT_GAIN * max(vec3f(0.0), hue + shift), 1.0);
  return q;
}`;

const SIROCCO_STREAK_KERNEL = `/* The streak's length in SECONDS OF THIS MOTE'S OWN TRAVEL. It lives HERE and nowhere
   else (§V349): the structural gate reads this very declaration out of the shipped kernel
   rather than keeping a second copy that could drift away from it. */
const TRAIL: f32 = 0.34;
const SPEED_REFERENCE: f32 = 0.85;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T401: position and velocity arrive from the DRIFT kernel's pairs, fresh this frame,
     and ride through unchanged in the copy above. This node is the one the draws bind, so
     it owns the edge they read (§V197) — and tint is NOT in this schema, so it travels
     past this node BY REFERENCE. That is the whole reason five channels reach the draws
     when one kernel may declare only FOUR attributes (§V588): the ceiling is per kernel,
     and a chain is how you spend more than one kernel's worth.

     Nothing here integrates. This kernel is the READING, not the simulation — the split is
     E16's flock/part and E34's cast/sight, and it is what keeps the wind in one file's
     worth of arithmetic and the geometry in another. */

  /* THE STREAK, and T680 in one line. A beam takes a per-point FAR END, so a velocity-
     scaled trail costs ONE attribute and NO HISTORY: backwards along this mote's own
     velocity by TRAIL seconds. The ribbon therefore IS the distance the mote covers in
     that time, and a fast mote draws a long one BY CONSTRUCTION rather than by a rule
     somebody wrote.

     Derived from VELOCITY and not from the previous POSITION on purpose, and the
     difference is visible: a previous-position trail draws a false streak across the frame
     the instant anything moves a point discontinuously, and a velocity trail cannot, because
     velocity does not jump when position does. */
  q.trail = p.position - p.velocity * TRAIL;

  /* SIZE, normalised against the SAME reference speed the colour uses so the two readings
     agree about what "fast" means (§V349). T721's scale map MULTIPLIES the geometry's own
     Scale by this, so the number on the node stays the object's size and this stays a
     factor. The floor is 0.35 rather than 0: a mote at rest is small, never absent. */
  q.size = 0.35 + 1.65 * clamp(length(p.velocity) / SPEED_REFERENCE, 0.0, 1.0);
  return q;
}`;

/** The predicate splitting the one cloud into its two beam readings (§V471.1). */
const SIROCCO_FAST_GROUP = "p.size > 1.35";
const SIROCCO_BODY_GROUP = "p.size <= 1.35";

const siroccoDocument = document(
  "e37-sirocco",
  "E37 Sirocco",
  settings({ randomSeed: 37 }),
  graph(
    [
      // ---- the wind, and the reading taken off it ----------------------------------
      node("drift", "pointKernel", [-1500, 0], {
        capacity: SIROCCO_POINTS, seed: 37, group: "",
        attributes: SIROCCO_DRIFT_ATTRIBUTES, kernel: SIROCCO_DRIFT_KERNEL,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "drift1" }),
      node("streak", "pointKernel", [-1180, 0], {
        capacity: SIROCCO_POINTS, seed: 37, group: "",
        attributes: SIROCCO_STREAK_ATTRIBUTES, kernel: SIROCCO_STREAK_KERNEL,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "streak1" }),

      // ---- one material: the identity element, so the TINT is the colour ------------
      node("haze", "materialUnlit", [-1180, -420], { color: [1, 1, 1, 1] }, { label: "haze1" }),

      // ---- ONE cloud, THREE readings (§V471.1) --------------------------------------
      node("body", "geometry", [-860, 220], {
        mode: "beam", endpoint: "trail", taper: 0.35, scale: 0.0013,
        material: "haze1", group: SIROCCO_BODY_GROUP,
      }, {
        label: "body1",
        parameters: {
          tint: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: [1, 1, 1, 1] },
              map: { kind: "map", attribute: "tint" },
            },
          },
          scale: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 0.0013 },
              map: { kind: "map", attribute: "size" },
            },
          },
        },
      }),
      node("fast", "geometry", [-860, 0], {
        mode: "beam", endpoint: "trail", taper: 0.12, scale: 0.0020,
        material: "haze1", group: SIROCCO_FAST_GROUP,
      }, {
        label: "fast1",
        parameters: {
          tint: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: [1, 1, 1, 1] },
              map: { kind: "map", attribute: "tint" },
            },
          },
          scale: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 0.0020 },
              map: { kind: "map", attribute: "size" },
            },
          },
        },
      }),
      node("heads", "geometry", [-860, -220], {
        mode: "points", scale: 0.0034, material: "haze1", group: "",
      }, {
        label: "heads1",
        parameters: {
          tint: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: [1, 1, 1, 1] },
              map: { kind: "map", attribute: "tint" },
            },
          },
          scale: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 0.0034 },
              map: { kind: "map", attribute: "size" },
            },
          },
        },
      }),

      // ---- the shot -----------------------------------------------------------------
      node("orbx", "lfo", [-1500, 520], { shape: "sine", frequency: 0.021, amplitude: SIROCCO_ORBIT, offset: 0, phase: 0.25 }, { label: "orbx1" }),
      node("orbz", "lfo", [-1500, 700], { shape: "sine", frequency: 0.021, amplitude: SIROCCO_ORBIT, offset: 0, phase: 0 }, { label: "orbz1" }),
      node("eye", "camera", [-540, 0], {
        eye: [SIROCCO_ORBIT, 0.90, 0], lookAt: [0, 0, 0], fov: 42, near: 0.1, far: 24, ortho: false,
      }, {
        label: "eye1",
        parameters: { "eye.x": drivenSlot("orbx1", SIROCCO_ORBIT), "eye.z": drivenSlot("orbz1", 0) },
      }),
      node("shot", "render", [-220, 0], {
        scenes: "body1 fast1 heads1",
        camera: "eye1",
        lights: "",
        ambientColor: [1, 1, 1, 1],
        ambientIntensity: 1,
        background: [0.004, 0.006, 0.014, 1],
        environmentIntensity: 1,
        showEnvironment: false,
        ambientOcclusion: false,
      }, { label: "shot1" }),

      // ---- the post, one job per stage (§V471.4) ------------------------------------
      node("halo", "blur", [100, 220], { size: 24, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haloLvl", "level", [420, 220], {
        blacklevel: 0.04, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1, brightness: 0.55,
      }, { label: "halolvl1" }),
      node("burn", "add", [740, 0], {}, { label: "burn1" }),
      node("drift2", "lfo", [740, 320], { shape: "sine", frequency: 0.035, amplitude: 15, offset: 0, phase: 0 }, { label: "drift2" }),
      node("hue", "hsv", [1060, 0], { saturation: 1.05, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift2", 0) },
      }),
      node("out", "output", [1380, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-drift-streak", ["drift", "out"], ["streak", "in"]),
      edge("e-streak-body", ["streak", "out"], ["body", "points"]),
      edge("e-streak-fast", ["streak", "out"], ["fast", "points"]),
      edge("e-streak-heads", ["streak", "out"], ["heads", "points"]),
      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),
      edge("e-burn-hue", ["burn", "out"], ["hue", "input"]),
      edge("e-hue-out", ["hue", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E38 — Sigil (T727). A mark assembles itself out of a drifting population, holds, comes
 * apart, and comes back — and it is A PICTURE that decides which motes belong to it.
 *
 *   disc1(circle) ─┐                         cycle1(lfo) ─► shape1(valueMath) ─► hold1(valueLimit)
 *   hole1(circle) ─┴─► ring1(difference) ─┐                                            │ value1
 *   pip1(circle) ─────────────────────────┴─► emblem1(add) ─────────────► gather1(pointKernel)
 *                                                                            ▲ field    │
 *   grid1(pointGrid 384x216) ────────────────────────────────────────────────┘ in       │
 *                                                          ┌───────────────────────────-┘
 *                                       haze1(renderPoints  p.mark <= 0.5) ─┐
 *                                       glyph1(renderPoints p.mark >  0.5) ─┴─► both1(add)
 *   both1 ─┬────────────────────────────► burn1(add) ─► hue1(hsv ┄ drift1) ─► out1
 *          └─► halo1(blur) ─► halolvl1(level) ─┘
 *
 * ## What is new here: an image that decides TARGETS, not tint
 *
 * `textureToAttribute` has carried pictures into point graphs since T124, and E20, E27 and
 * E34 all use one — but always to COLOUR or DISPLACE points that were going to be there
 * anyway. This is the first example where the picture decides WHO BELONGS: `fieldAt` samples
 * the emblem at each mote's own grid cell, and that number scales the spring that gathers
 * it. The mark is drawn OUT OF the population rather than emitted from somewhere else, and
 * the motes it does not claim are the haze around it.
 *
 * ## The picture is built from PRIMITIVES, and that is §V684, not taste
 *
 * The obvious subject for this example is text, and text is unavailable: the harness does
 * not fake the `text` node (§V403 — "black is the honest output of a machine with no font
 * stack"), so a text-bearing document renders BLACK in every offline gate and its §V643
 * baseline would enshrine that black. Two circles differenced into a ring, plus a pip.
 *
 * ## A DISPLACEMENT, not a force — the second build
 *
 * The first version let the spring fall to zero and a wander force accumulate, which does
 * not scatter a glyph, it INFLATES one: members keep their relative positions and drift
 * outward together, so the mark balloons instead of coming apart, and the shared term
 * carries the whole population off the frame edges leaving black corners. The kernel now
 * springs to a BOUNDED target — nothing can leave a ball of SPREAD + CURRENT about its own
 * cell — and the grid runs 2.4 units wide against a 2-unit frame, so there are always motes
 * outside the picture to drift inward and fill its border.
 *
 * ## §V681, twice
 *
 * Both of this file's claims are about time and neither is in a frame. `sigil.gpu.test.ts`
 * asserts that not one slot changes sides across a whole cycle (sampling at the live
 * position instead takes 6528 members to 8302, with 3573 changing hands) and that every
 * member is back on its cell when the plateau comes round (mean |drift| 0.0011 against
 * 0.0962 with the gather removed). The look instrument reads range 0.8953 for the intact
 * file and for BOTH breakages, to four decimal places.
 *
 * ## And §V627, paid rather than discovered
 *
 * This file began with E31's luminance palette on the end of it. At the instrument's
 * 192x108 probe the same points land in 1/44th of the texels, every pixel clears the ramp's
 * last stop, and the measured frame is UNIFORM WHITE — range 0.0000, a straight failure of
 * the contrast floor that reads perfectly well at 1280x720. The layers carry their own
 * colour instead, and the grade is a hue drift that cannot saturate.
 */
/** 384 x 216 cells over a 2.4-unit square — deliberately WIDER than the frame. The mark has to be DENSE enough to read as a drawn shape, not as a
 *  constellation, and that is a point count rather than a size. */
const SIGIL_COLS = 384;
const SIGIL_ROWS = 216;
const SIGIL_POINTS = SIGIL_COLS * SIGIL_ROWS;

const SIGIL_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "drift", type: "vec3f", default: [0, 0, 0] },
  { name: "vel", type: "vec3f", qualifier: "direction", default: [0, 0, 0] },
  { name: "mark", type: "f32", default: [0] },
]);

const SIGIL_KERNEL = `const TAU: f32 = 6.28318530717958647692;

/* The mark's spring, and the damping that lands it. 2*sqrt(GATHER) = 10.2 is critical, so
   10.5 is a hair over — a member arrives at its cell and STOPS, with no ring of overshoot
   travelling back out through the glyph. */
const GATHER: f32 = 26.0;
const DRAG: f32 = 10.5;

/* How far a mote goes when the mark lets go, and how much shared weather rides on top.
   Both are DISPLACEMENTS in clip units, so the scattered state is bounded by their sum. */
const SPREAD: f32 = 0.50;
const CURRENT: f32 = 0.09;

/* Where the picture stops being background. The emblem is drawn with soft edges, so this
   is a THRESHOLD WITH A WIDTH, not a step: a hard cut leaves the glyph's rim aliased into
   the point population itself, which reads as a jagged edge no amount of blur downstream
   can fix. */
const THRESHOLD: f32 = 0.42;
const THRESHOLD_WIDTH: f32 = 0.09;

/* Just over one cell wide, so neighbouring cells' motes interleave. */
const CELL_JITTER: f32 = 0.011;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T401: this is the UPSTREAM GRID's position pair, regenerated every frame, so it is
     this mote's HOME CELL and not its own last frame. drift and vel are not in the grid's
     schema, so they are this node's own state and persist (§V197). */
  let home = p.position;
  let id = ctx.index;

  /* THE PICTURE DECIDES WHO BELONGS, and it is sampled at HOME - not at where the mote
     currently is. That is the whole correctness argument of this file: membership is a
     property of the CELL, so the same motes are the mark's for ever and the glyph that
     re-forms is the glyph that came apart.

     Sample at the live position (home + drift) instead and the mark's population CHANGES
     HANDS: motes that wander in are captured and motes that wander out are dropped.
     Measured on this document - 6528 members become 8302, with 3573 slots changing sides
     across one cycle - while the look instrument's range reads 0.8953 for both, to four
     decimal places. That is §V681 exactly: the damage is in the correspondence and no
     still frame contains it. sigil.gpu.test.ts is what sees it. */
  let picture = fieldAt(home);
  let mark = smoothstep(THRESHOLD - THRESHOLD_WIDTH, THRESHOLD + THRESHOLD_WIDTH, max(picture.r, max(picture.g, picture.b)));
  q.mark = mark;

  /* ASSEMBLY: 0 lets go, 1 holds the mark. It arrives as ctx.value1 - an ordinary DRIVABLE
     parameter on this node (T479) - so the cycle lives in the value graph, where it can be
     seen, retimed and driven by something else, instead of being buried in this text where
     only a recompile could reach it. */
  let assembly = clamp(ctx.value1, 0.0, 1.0);

  var drift = p.drift;
  var vel = p.vel;
  /* ctx.firstRun, not frameIndex == 0 (§V495/T510): a timeline lap KEEPS these buffers and
     the cloud must survive it; a seek and a load clear them and it must not. */
  if (ctx.firstRun == 1u) {
    drift = vec3f(0.0);
    vel = vec3f(0.0);
  }

  /* A FIXED sub-cell offset per mote, and it is not decoration: 320x180 cells land exactly
     four pixels apart on a 1280x720 frame, so without it the assembled mark is a regular
     LATTICE and reads as halftone dither rather than as a drawn shape. Fixed per mote, so
     the stipple is the same every time the glyph re-forms - a jitter re-drawn each frame
     would boil. */
  let jitter = vec3f(pointRand(id, 17u) - 0.5, pointRand(id, 29u) - 0.5, 0.0) * CELL_JITTER;
  let anchor = home + jitter;

  /* WHERE THIS MOTE GOES WHEN THE MARK LETS GO. A bounded DISPLACEMENT, not a force —
     and that distinction is the whole of the second build. A force that accumulates while
     the spring is off does not scatter the glyph, it INFLATES it: members keep their
     relative positions and drift outward together, so the mark balloons instead of coming
     apart, and the shared term carries the whole population off the frame edges leaving
     black corners. Measured, and visible in the frame that made this rewrite necessary.

     A heading that is CONSTANT for this mote and different for every other one, so the
     dispersal reads as a population coming apart rather than as a sheet being blown. */
  let heading = pointRand(id, 5u) * TAU;
  let loose = vec3f(cos(heading), sin(heading), 0.0) * (0.25 + 0.75 * pointRand(id, 9u)) * SPREAD;

  /* One shared, MOVING current on top, so the scattered state has weather in it. It must
     depend on TIME as well as on the cell: a rigid rotation about the origin gives every
     mote an offset that never changes, and the haze reads as frozen grain. ctx.absTime, so
     the current does not restart at a timeline lap (§V436). */
  let t = ctx.absTime;
  let current = vec3f(
    sin(home.y * 2.70 + t * 0.50) - 0.40 * sin(home.x * 1.90 - t * 0.37),
    sin(home.x * 2.30 - t * 0.44) + 0.40 * sin(home.y * 2.10 + t * 0.31),
    0.0
  ) * CURRENT;

  /* THE MECHANISM, in one line: a mote's target is its own cell to the extent that the
     PICTURE claims it and the cycle is holding, and its scattered place otherwise. The
     mark is therefore drawn OUT OF the population rather than emitted from somewhere
     else, and it is bounded by construction — nothing here can leave a ball of radius
     SPREAD + CURRENT around its own cell, whatever the cycle does. */
  /* Named rest and not target: target is a RESERVED KEYWORD in WGSL, and Dawn refuses
     the whole module by name for it. */
  let rest = (loose + current) * (1.0 - mark * assembly);

  vel = vel + ((rest - drift) * GATHER - vel * DRAG) * ctx.delta;
  drift = drift + vel * ctx.delta;

  q.drift = drift;
  q.vel = vel;
  q.position = anchor + drift;
  return q;
}`;


const sigilDocument = document(
  "e38-sigil",
  "E38 Sigil",
  settings({ randomSeed: 38 }),
  graph(
    [
      // ---- THE PICTURE, from primitives (§V684: `text` renders black offline) ---------
      node("disc", "circle", [-1720, -260], {
        mode: "fill", center: [0.5, 0.5], radius: [0.3, 0.3], softness: 0.035,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "disc1" }),
      node("hole", "circle", [-1720, -60], {
        mode: "fill", center: [0.5, 0.5], radius: [0.185, 0.185], softness: 0.035,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "hole1" }),
      node("ring", "difference", [-1420, -160], { opacity: 1 }, { label: "ring1" }),
      node("pip", "circle", [-1720, 140], {
        mode: "fill", center: [0.5, 0.5], radius: [0.072, 0.072], softness: 0.03,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "pip1" }),
      node("emblem", "add", [-1120, -60], { opacity: 1 }, { label: "emblem1" }),

      // ---- the cycle: one job per node ----------------------------------------------
      node("cycle", "lfo", [-1720, 420], { shape: "sine", frequency: 0.08, amplitude: 0.5, offset: 0.5, phase: 0.306 }, { label: "cycle1" }),
      /* A sine spends almost no time at its extremes, so on its own the glyph would never
         HOLD - it would pass through legible on its way somewhere. Gain then clamp is the
         standard shape for that: 2.1x flattens the top and the bottom into real dwells. */
      node("shape", "valueMath", [-1420, 420], { operation: "multiply", operand: 1.6 }, { label: "shape1" }),
      node("hold", "valueLimit", [-1120, 420], { minimum: 0, maximum: 1 }, { label: "hold1" }),

      // ---- the population -------------------------------------------------------------
      node("grid", "pointGrid", [-1420, 180], { cols: SIGIL_COLS, rows: SIGIL_ROWS, count: SIGIL_POINTS, sizeX: 2.4, sizeY: 2.4 }, { label: "grid1" }),
      node("gather", "pointKernel", [-820, 60], {
        capacity: SIGIL_POINTS, seed: 38, group: "",
        attributes: SIGIL_ATTRIBUTES, kernel: SIGIL_KERNEL,
        value2: 0, value3: 0, value4: 0,
      }, { label: "gather1", parameters: { value1: drivenSlot("hold1", 1) } }),

      // ---- ONE cloud, TWO readings (§V471.1) -------------------------------------------
      node("haze", "renderPoints", [-500, 240], {
        count: SIGIL_POINTS, blend: "additive", accumulate: false,
        color: [0.22, 0.38, 0.86, 1], sizePixels: 1.2,
        group: "p.mark <= 0.5",
      }, { label: "haze1" }),
      node("glyph", "renderPoints", [-500, -60], {
        count: SIGIL_POINTS, blend: "additive", accumulate: false,
        color: [1, 0.74, 0.40, 1], sizePixels: 1.7,
        group: "p.mark > 0.5",
      }, { label: "glyph1" }),
      node("both", "add", [-180, 60], { opacity: 1 }, { label: "both1" }),

      // ---- the post, one job per stage --------------------------------------------------
      node("halo", "blur", [140, 260], { size: 26, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haloLvl", "level", [460, 260], {
        blacklevel: 0.03, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1, brightness: 0.9,
      }, { label: "halolvl1" }),
      node("burn", "add", [780, 60], { opacity: 1 }, { label: "burn1" }),
      node("drift", "lfo", [780, 320], { shape: "sine", frequency: 0.041, amplitude: 18, offset: 0, phase: 0 }, { label: "drift1" }),
      node("hue", "hsv", [1100, 60], { saturation: 1.08, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      node("out", "output", [1420, 60], {}, { label: "out1" }),
    ],
    [
      edge("e-disc-ring", ["disc", "out"], ["ring", "in1"]),
      edge("e-hole-ring", ["hole", "out"], ["ring", "in2"]),
      edge("e-ring-emblem", ["ring", "out"], ["emblem", "in1"]),
      edge("e-pip-emblem", ["pip", "out"], ["emblem", "in2"], 0),
      edge("e-cycle-shape", ["cycle", "out"], ["shape", "a"]),
      edge("e-shape-hold", ["shape", "out"], ["hold", "in"]),
      edge("e-grid-gather", ["grid", "out"], ["gather", "in"]),
      edge("e-emblem-gather", ["emblem", "out"], ["gather", "field"]),
      edge("e-gather-haze", ["gather", "out"], ["haze", "points"]),
      edge("e-gather-glyph", ["gather", "out"], ["glyph", "points"]),
      edge("e-haze-both", ["haze", "out"], ["both", "in1"]),
      edge("e-glyph-both", ["glyph", "out"], ["both", "in2"], 0),
      edge("e-both-halo", ["both", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-both-burn", ["both", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),
      edge("e-burn-hue", ["burn", "out"], ["hue", "input"]),
      edge("e-hue-out", ["hue", "out"], ["out", "input"]),
    ],
  ),
);


export const EXAMPLE_DOCUMENTS: readonly ProjectDocument[] = [
  feedbackEchoDocument,
  reactionDiffusionDocument,
  animatedNoiseFieldDocument,
  bloomDocument,
  kaleidoscopeDocument,
  displacementStackDocument,
  lfoDissolveDocument,
  slitScanDocument,
  emberDocument,
  instancedTorusDocument,
  gradientRemapDocument,
  fluidDocument,
  prismDocument,
  selfRegulatingBloomDocument,
  murmurationDocument,
  gooeyballDocument,
  audioRdDocument,
  stageDocument,
  interferenceDocument,
  reliefDocument,
  sundialDocument,
  descentDocument,
  naveDocument,
  coronaDocument,
  obolDocument,
  pastureDocument,
  lidarDocument,
  novaTorusDocument,
  facadeDocument,
  siroccoDocument,
  sigilDocument,
  rosetteDocument,
  wakeDocument,
];
