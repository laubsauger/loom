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

function edge(id: string, from: readonly [string, string], to: readonly [string, string]): GraphEdge {
  return {
    id,
    source: { nodeId: from[0] as string, portId: from[1] as string },
    target: { nodeId: to[0] as string, portId: to[1] as string },
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
 * The fade lives on the Feedback node itself (`persistence` 0.94, `clearColor` transparent
 * black) rather than in an extra Level: that is what `persistence` is for. Level is still
 * in the loop doing real work — `blacklevel` crushes the dimmest survivors to zero so a
 * trail actually terminates instead of asymptoting toward a permanent smear.
 */
export const feedbackEchoDocument = document(
  "feedback-echo",
  "E1 Feedback Echo",
  settings(),
  graph(
    [
      node("source", "circle", [-360, -120], {
        mode: "fill",
        center: [0.5, 0.32],
        radius: [0.045, 0.045],
        softness: 0.02,
        fillcolor: [1, 0.72, 0.28, 1],
        bgcolor: [0, 0, 0, 0],
      }),
      node("over", "over", [40, -60], { opacity: 1 }, { label: "over1" }),
      node("echo", "feedback", [40, 140], {
        // T350 (§V285): the loop is a NAME — no wired back-edge, edges stay a DAG.
        source: "over1",
        persistence: 0.94,
        clearColor: [0, 0, 0, 0],
      }),
      node("drift", "transform", [-160, 220], {
        t: [0, -0.006],
        r: 3.5,
        s: [0.985, 0.985],
        p: [0, 0],
        xord: "srt",
        extend: "zero",
        aspectcorrect: true,
      }),
      node("soften", "blur", [-360, 240], { size: 2.5, filter: "gaussian", extend: "zero" }),
      node("decay", "level", [-360, 60], { blacklevel: 0.015, whitelevel: 1, opacity: 1 }),
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
        t4d: 0,
        s4d: 1,
        speed: 0.05,
      }, { label: "broad1" }),
      node("detail", "noise", [-900, 100], {
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
        t4d: 0,
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
      node("cycle", "lfo", [140, 560], { shape: "sine", frequency: 0.05, amplitude: 0.06, offset: 0 }, {
        label: "lfo1",
      }),
      node("tint", "lookup", [400, 380], { channel: "green", row: 0.5, scale: 2.4 }, {
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
        t4d: 0,
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
 *   noise ─► level(hot) ─┬─► threshold ─► blur ─► add.in1 ─► add ─► output
 *                        └──────────────────────► add.in2
 *
 * The project working format is rgba8unorm — deliberately, because that is what makes the
 * per-node override mean something (§V51). `level` pushes highlights past 1.0 and the four
 * nodes from there to the composite carry `format: { mode: "fixed", format: "rgba16float" }`,
 * so the over-range values survive the threshold and the blur instead of being clipped at
 * the first target. Delete those four overrides and the bloom flattens: that is the
 * example's whole point, and it is a one-line experiment.
 *
 * Two branches converging on one Add, with `hot` fanning out to both, is also the §V6 case
 * again — the expensive half of the chain is computed once.
 */
export const bloomDocument = document(
  "bloom",
  "E4 Bloom",
  settings({ workingFormat: "rgba8unorm" }),
  graph(
    [
      node("source", "noise", [-520, 0], {
        type: "perlin2d",
        seed: 11,
        period: 0.16,
        harmon: 4,
        exp: 2.2,
        amp: 1,
        mono: true,
      }),
      node(
        "hot",
        "level",
        [-280, 0],
        { blacklevel: 0.35, whitelevel: 0.72, contrast: 1.2 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "bright",
        "threshold",
        [-40, -120],
        { threshold: 0.9, softness: 0.12, channel: "luminance", compare: "greater" },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "glow",
        "blur",
        [200, -120],
        { size: 36, filter: "gaussian", extend: "hold" },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "combine",
        "add",
        [440, 0],
        { opacity: 0.85 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node("out", "output", [680, 0]),
    ],
    [
      edge("e-source-hot", ["source", "out"], ["hot", "input"]),
      edge("e-hot-bright", ["hot", "out"], ["bright", "input"]),
      edge("e-bright-glow", ["bright", "out"], ["glow", "input"]),
      edge("e-glow-combine", ["glow", "out"], ["combine", "in1"]),
      edge("e-hot-combine", ["hot", "out"], ["combine", "in2"]),
      edge("e-combine-out", ["combine", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E5 — Kaleidoscope (T156).
 *
 *   circle ─► transform(mirror) ─► tile(mirror x+y) ─► transform(repeat) ─► output
 *
 * Three extend modes in one chain — `mirror` on the fold, the Tile node's own mirroring,
 * `repeat` on the spin — which is what makes a kaleidoscope a kaleidoscope rather than a
 * rotated image with black corners. Getting `extend` wrong is invisible in the middle of
 * the frame and obvious at the edges, so the edges ARE the test.
 *
 * The source carries a fixed 2048x2048 resolution override (§V50) and every node after it
 * inherits, so the whole chain runs at 2048x2048 while the project is set to 1280x720. A
 * chain of pure-sampling nodes is cheap enough to run above the project resolution, and
 * doing so is what keeps the mirrored seams from aliasing.
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
      node(
        "source",
        "circle",
        [-520, 0],
        {
          mode: "distance",
          center: [0.32, 0.42],
          radius: [0.18, 0.11],
          softness: 0.05,
          fillcolor: [0.95, 0.4, 0.15, 1],
          bgcolor: [0.03, 0.05, 0.12, 1],
          aspectcorrect: true,
        },
        { resolution: { mode: "fixed", width: 2048, height: 2048 } },
      ),
      node("fold", "transform", [-260, 0], {
        t: [0.12, 0],
        r: 30,
        s: [0.5, 0.5],
        p: [0, 0],
        xord: "srt",
        extend: "mirror",
        aspectcorrect: true,
      }),
      node("facets", "tile", [0, 0], {
        repeat: [3, 3],
        offset: [0.15, 0.05],
        mirrorx: true,
        mirrory: true,
      }),
      node("spin", "transform", [260, 0], {
        t: [0, 0],
        r: -15,
        s: [1, 1],
        p: [0, 0],
        xord: "rst",
        extend: "repeat",
        aspectcorrect: true,
      }),
      node("out", "output", [520, 0]),
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
 *   noise ─► level ─► transform ─► displace.disp
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
      node("field", "noise", [-520, 120], {
        type: "simplex2d",
        seed: 5,
        period: 0.3,
        harmon: 2,
        gain: 0.55,
        mono: true,
        aspectcorrect: true,
      }),
      node("shape", "level", [-260, 120], {
        blacklevel: 0.2,
        whitelevel: 0.8,
        gamma1: 1.2,
        contrast: 1.1,
      }),
      node("place", "transform", [0, 120], {
        t: [0.05, -0.03],
        r: 12,
        s: [1.4, 1.4],
        p: [0, 0],
        xord: "srt",
        extend: "mirror",
        aspectcorrect: true,
      }),
      node("warp", "displace", [260, -60], {
        weight: [0.08, 0.05],
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
          t4d: 0,
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
 * Per-pixel time: a 48-frame history of an evolving noise field, read back through a
 * vertical ramp so every ROW shows a different moment — the classic slit-scan smear,
 * newest at the black end of the ramp, ~1.6 seconds ago at the white end.
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
      node(
        "field",
        "noise",
        [-640, -120],
        {
          type: "perlin4d",
          period: 0.5,
          harmon: 3,
          spread: 2,
          gain: 0.5,
          rough: 0.5,
          exp: 1,
          amp: 1,
          offset: 0,
          mono: false,
          aspectcorrect: true,
          seed: 9,
          s4d: 1,
          t4d: 0,
          // Fast enough that 48 frames of history span a visible evolution.
          speed: 0.8,
        },
        { label: "noise1" },
      ),
      node("gradient", "ramp", [-640, 140], { type: "vertical" }, { label: "ramp1", definitionVersion: 2 }),
      node("scan", "slitScan", [-260, 0], { frames: 48, depth: 1 }, { label: "slitscan1" }),
      node("out", "output", [120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-field-scan", ["field", "out"], ["scan", "input"]),
      edge("e-gradient-scan", ["gradient", "out"], ["scan", "map"]),
      edge("e-scan-out", ["scan", "out"], ["out", "input"]),
    ],
  ),
);

/**
 * E9 — Particle Fountain (T322, T323, T339).
 *
 * The whole lifecycle in one graph: slot 0 is a pinned EMITTER that spawns two
 * children a frame; everyone else flies ballistically and DIES leaving the frame.
 * Frame zero kills all but the emitter, so the population you see grew entirely from
 * births — compacted deterministically, ids minted from the monotone cursor, each
 * child's launch angle drawn from pointRand(id, salt) in the spawn hook, so the same
 * seed is the same fountain on every machine (§V74).
 *
 * If spawning, compaction, the counted indirect draw or the hook's newborn-range
 * guard regress, this file is where it shows: a fountain that freezes, doubles, or
 * sprays identical particles.
 *
 * AND IT IS PLAYABLE (T367). The kernel reads `ctx.pointer`, so the cursor parts the
 * spray — the first thing anyone tries with a particle system, and until T367 the one
 * thing a point kernel structurally could not do: `PointCtx` carried index, count, time,
 * delta and frameIndex, and no pointer at all. The push is a Gaussian rather than a
 * radius with an edge, because a cutoff reads as a bug and a fade reads as air.
 *
 * The pointer costs the other examples NOTHING. A kernel that does not name it generates
 * the text it generated before the member existed, block for block (§V309), so E1's and
 * E13's plans are untouched by this file having grown a cursor.
 *
 * Determinism is unchanged in the sense §V45 means it — nothing reads a wall clock and the
 * RNG is still hash(seed, id, frame) — but the fountain is now a function of the POINTER
 * STREAM as well as the seed, exactly as E12's stirring force is. A replay feeds the same
 * pointer and gets the same frames; a live run with a moving mouse does not reproduce a
 * still one, and that is what "playable" costs.
 */
const PARTICLE_FOUNTAIN_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
    if (ctx.index > 0u) {
      q.alive = 0u; /* the population grows from births alone */
      return q;
    }
  }
  if (q.id == 0u) {
    /* The emitter: pinned at the base, feeding the fountain. */
    q.position = vec3f(0.0, -0.85, 0.0);
    q.velocity = vec3f(0.0);
    q.spawnCount = 2u;
    return q;
  }
  q.velocity = q.velocity + vec3f(0.0, -0.9, 0.0) * ctx.delta;
  /* T367: the CURSOR parts the spray. \`ctx.pointer\` is the same four numbers the value
     graph's Mouse node publishes and every fragment shader reads (§V182) — viewer-
     normalised, v DOWN (§V236) — and the one conversion into this graph's clip space is
     written HERE, because a kernel cannot see how it will be viewed. */
  let cursor = vec3f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0, 0.0);
  let away = q.position - cursor;
  let distance = max(length(away), 0.0001);
  /* Gaussian, not a cutoff radius: a hard edge reads as a bug, a fading push reads as air. */
  let falloff = exp(-(distance * distance) / 0.09);
  q.velocity = q.velocity + (away / distance) * (7.0 * falloff) * ctx.delta;
  q.position = q.position + q.velocity * ctx.delta;
  if (q.position.y < -1.1 || abs(q.position.x) > 1.25) {
    q.alive = 0u;
  }
  return q;
}`;

const PARTICLE_FOUNTAIN_SPAWN = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  /* Identity is already the child's own: distinct ids, distinct draws (§V74). */
  let angle = (pointRand(q.id, 1u) - 0.5) * 1.1;
  let speed = 0.9 + pointRand(q.id, 2u) * 0.6;
  q.velocity = vec3f(sin(angle) * 0.45, speed, 0.0);
  return q;
}`;

const particleFountainDocument = document(
  "e9-particle-fountain",
  "E9 Particle Fountain",
  settings({ randomSeed: 13 }),
  graph(
    [
      node(
        "sim",
        "pointKernelAdvanced",
        [-640, 0],
        { capacity: 4096, seed: 13, kernel: PARTICLE_FOUNTAIN_KERNEL, spawn: PARTICLE_FOUNTAIN_SPAWN },
        { label: "fountain1" },
      ),
      node(
        "draw",
        "renderPoints",
        [-260, 0],
        { count: 4096, sizePixels: 3, color: [0.55, 0.8, 1, 1], blend: "additive" },
        { label: "renderpoints1" },
      ),
      node("out", "output", [120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-sim-draw", ["sim", "out"], ["draw", "points"]),
      edge("e-draw-out", ["draw", "out"], ["out", "input"]),
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
 *   noise1(noise) ──► lookup1.source ─┐
 *   ramp1(ramp, 5 stops) ─► .lookup ──┴─► lookup1(lookup) ─► out1(output)
 *
 * Ramp into Lookup is the standard way to recolour an image through a palette, and it is
 * the pairing multi-stop Ramp (T270) was built for: with two colours it is a tinted
 * greyscale and barely worth wiring: the fifth stop is what makes it a PALETTE. The noise
 * supplies structure, its luminance is read as a POSITION along the gradient, and the
 * colour found there is the output — so every pixel's brightness becomes a hue.
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
          type: "perlin2d",
          // Large, soft features: the palette needs broad areas to show a hue in, and a
          // fine field would dither five colours into visual mud.
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
          t4d: 0,
          speed: 0,
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
           * Five stops with real hue movement — indigo to magenta to red to amber to a
           * pale highlight. Stored in DISPLAY space (§V56), which is what a colour picker
           * hands over, and decoded per entry on the way to the shader (§V196).
           */
          stops: [
            { position: 0, color: [0.04, 0.03, 0.18, 1] },
            { position: 0.3, color: [0.45, 0.09, 0.52, 1] },
            { position: 0.55, color: [0.86, 0.24, 0.29, 1] },
            { position: 0.8, color: [0.98, 0.62, 0.16, 1] },
            { position: 1, color: [1, 0.95, 0.78, 1] },
          ],
        },
        { label: "ramp1", definitionVersion: 2 },
      ),
      node(
        "remap",
        "lookup",
        [-260, 0],
        // Luminance is the index: a mono field's brightness IS its position along the
        // palette. `row` picks the middle of the gradient image, which is the whole of it
        // for a horizontal ramp.
        { channel: "luminance", row: 0.5, offset: 0, scale: 1 },
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
        [-40, 60],
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
 * E13 — Prism (T363, T364).
 *
 *   swarm1(pointKernel) ─► sparks1(renderPoints) ─► roll1(transform) ─► field1.in1
 *   backdrop1(ramp) ───────────────────────────────────────────────────► field1.in2
 *   field1(over) ─┬─► bendR1(displace) ─┐
 *                 ├─► bendG1(displace) ─┴─► fuse1(reorder) ─┐
 *                 └─► bendB1(displace) ──────────────────────┴─► prism1(reorder) ─► out1
 *   lens1(circle) ─► normals1(slope) ─► the `disp` input of all three
 *
 *   mouse1 ─► follow1(lag) ┄drives┄► lens1.center.x/.y
 *   pulse1(lfo, square) ─► ease1(lag) ┄drives┄► lens1.radius.x/.y
 *   roll1.r = "time * 7 % 360"   (an expression, §V71)
 *   sparks1.color ← the `tint` attribute, sparks1.sizePixels ← `pscale` (map mode, T364)
 *
 * THE ONE THAT IS SUPPOSED TO SHOW THE WHOLE TOOL. Every other example demonstrates one
 * mechanism. This one exists because someone who has read twelve single-mechanism files
 * still has not seen them in one frame, and "in one frame" is the actual product claim.
 *
 * THE LOOK: DISPERSION. A lens bends blue further than red, so a coloured edge seen
 * through one comes apart into a spectrum. There is no per-channel Displace and none is
 * needed: the same scene is refracted THREE TIMES at three strengths and reassembled
 * channel by channel through two Reorders. Reorder exists for exactly this, and one image
 * feeding three Displaces is §V6 — the scene and the normal field are each rendered once.
 *
 * COLOUR COMES FROM THE POINTS, WHICH IS WHY THE PRISM HAS ANYTHING TO BEND (T364, §V313).
 * `sparks1` maps its whole `color` compound onto the kernel's `tint` attribute and its
 * `sizePixels` onto `pscale`, so 2400 sprites carry 2400 colours and 2400 sizes and the
 * draw pass ends up carrying NO uniform block at all — with both mapped the params struct
 * would be empty, and WGSL refuses an empty struct, so it vanishes. A uniform-coloured
 * swarm would disperse into grey fringes; a spectral one disperses into a spectrum.
 *
 * Those attribute values are LINEAR (§V313). A point attribute is DATA — nothing
 * display-decodes it — so the kernel's cosine palette writes linear light directly and
 * must not be authored as if it were a colour picker's swatch.
 *
 * THE LENS IS A SOFT DOME, not a hard disc. `softness` roughly twice the radius makes the
 * Circle a smooth bump; Slope's `normal` mode turns the bump into a normal field, largest
 * tilt at the rim and none at the centre. That is what a real lens does, and it is why the
 * fringe appears around the edge of the glass rather than uniformly over the frame.
 *
 * THREE WAYS TO MOVE A PARAMETER, doing three different jobs:
 *
 *   THE VALUE GRAPH (§V179), twice, and both times it is the owner's canonical chain.
 *   `mouse1 → follow1(Lag) → lens1.center` gives the glass weight: the pointer is the
 *   target, the Lag is the mass. `pulse1(LFO) → ease1(Lag) → lens1.radius` breathes it.
 *   The LFO is a SQUARE wave deliberately — a square through a one-pole smoother is an
 *   EASE, so the Lag's contribution is visible rather than theoretical. Delete `ease1` and
 *   the lens snaps between two sizes like a shutter; that is the whole argument for the node.
 *
 *   AN EXPRESSION (§V71) rolls the light field. `time * 7 % 360` is written where it is
 *   read — no node, no channel, no wire — and the `%` is load-bearing: Transform's `r` is
 *   clamped to ±360 by its manifest, so the wrap belongs in the expression. Being honest
 *   about the scope: the v1 grammar is arithmetic only, so an LFO could produce this same
 *   ramp. What the expression buys here is locality, not reach.
 *
 *   A KERNEL (§V45) animates the swarm. `ctx.time` reaches the GPU through the same frame
 *   contract everything else does, and the kernel is STATELESS — position and colour are
 *   functions of the slot index and the clock — so frame N is the same picture whether it
 *   was replayed from zero or arrived at live.
 *
 * WHICH WAY THE POINTER GOES. v runs DOWN (§V236), and the lens follows the pointer 1:1
 * because a lens centre and a pointer are the same unit. E12 drives the same kind of
 * parameter with no chain at all (channel liveness with no edge, §V173b); here it goes
 * through a real value EDGE into a Lag, which is the difference worth seeing side by side.
 */
const PRISM_SWARM_KERNEL = `const TAU: f32 = 6.28318530717958647692;

/** A cosine spectral wheel. LINEAR by declaration (§V313): an attribute is DATA, so
    nothing decodes this on the way to the sprite and nothing should author it as sRGB. */
fn spectrum(t: f32) -> vec3f {
  return vec3f(0.5) + (vec3f(0.5) * cos(TAU * (vec3f(t) + vec3f(0.0, 0.33, 0.67))));
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* Stateless: nothing here integrates, so a replay and a live run agree exactly (§V45). */
  q.id = ctx.index;
  let t = f32(ctx.index) / max(f32(ctx.count), 1.0);

  /* Three interleaved lobes, breathing — a woven band rather than a plain ring. */
  let angle = (t * TAU * 3.0) + (ctx.time * 0.22);
  let breathe = 0.22 * sin((t * TAU * 7.0) - (ctx.time * 0.55));
  let radius = 0.56 + breathe;
  q.position = vec3f(cos(angle) * radius, sin(angle) * radius * 0.88, 0.0);

  /* Hue runs along the band and drifts, so the prism always has a spectrum to take apart. */
  q.tint = vec4f(spectrum(t + (ctx.time * 0.04)), 1.0);
  /* Per-point size, deterministic per id (§V73): the swarm sparkles instead of tiling. */
  q.pscale = 1.6 + (pointRand(q.id, 5u) * 3.4);
  return q;
}`;

/** The swarm's schema. `tint` is `color`-QUALIFIED (§V313/T287) — it is what a colour-space
 *  operation would convert and what a spatial transform must leave alone. */
const PRISM_SWARM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "pscale", type: "f32", semantic: "size", default: [3] },
]);

const prismDocument = document(
  "e13-prism",
  "E13 Prism",
  settings({ randomSeed: 23 }),
  graph(
    [
      // ---- the value graph -------------------------------------------------------
      node("mouse", "mouse", [-1180, 420], {}, { label: "mouse1" }),
      node("follow", "valueLag", [-940, 420], { lag: 0.14 }, { label: "follow1" }),
      node(
        "pulse",
        "lfo",
        [-1180, 600],
        // 0.14 either side of 0.32: the lens breathes between radius 0.18 and 0.46, both
        // well inside the manifest's range, so nothing is ever clamped on the way through.
        { shape: "square", frequency: 0.22, amplitude: 0.14, offset: 0.32, phase: 0 },
        { label: "pulse1" },
      ),
      node("ease", "valueLag", [-940, 600], { lag: 0.45 }, { label: "ease1" }),

      // ---- the light -------------------------------------------------------------
      node(
        "swarm",
        "pointKernel",
        [-1180, 100],
        {
          capacity: 2400,
          seed: 23,
          attributes: PRISM_SWARM_ATTRIBUTES,
          kernel: PRISM_SWARM_KERNEL,
          group: "",
        },
        { label: "swarm1" },
      ),
      node(
        "sparks",
        "renderPoints",
        [-880, 100],
        { count: 2400, blend: "additive", accumulate: false },
        {
          label: "sparks1",
          // T364: the map mode, on a COMPOUND HEAD and on a scalar. With both mapped the
          // draw carries no uniform block at all — see the note above.
          parameters: {
            color: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                map: { kind: "map", attribute: "tint" },
              },
            },
            sizePixels: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: 4 },
                map: { kind: "map", attribute: "pscale" },
              },
            },
          },
        },
      ),
      node(
        "roll",
        "transform",
        [-580, 100],
        { t: [0, 0], s: [1, 1], p: [0, 0], xord: "srt", extend: "zero", aspectcorrect: true },
        {
          label: "roll1",
          // The `%` is not decoration: `r` is clamped to ±360, so the wrap lives here.
          parameters: { r: expressionSlot("time * 7 % 360", 0) },
        },
      ),
      node(
        "backdrop",
        "ramp",
        [-880, -140],
        {
          type: "radial",
          interp: "smooth",
          phase: 0,
          period: 1,
          // Dark, never black. Dispersion moves WHERE a colour is read from, so a field
          // with no colour in it disperses into nothing.
          stops: [
            { position: 0, color: [0.13, 0.08, 0.3, 1] },
            { position: 0.55, color: [0.05, 0.04, 0.13, 1] },
            { position: 1, color: [0.01, 0.01, 0.04, 1] },
          ],
        },
        { label: "backdrop1", definitionVersion: 2 },
      ),
      node("field", "over", [-300, 0], { opacity: 1 }, { label: "field1" }),

      // ---- the lens --------------------------------------------------------------
      node(
        "lens",
        "circle",
        [-580, -320],
        {
          mode: "fill",
          center: [0.5, 0.5],
          // Softness past the radius: a DOME, not a disc. The dome's gradient is the lens
          // profile; a disc's gradient is a ring one pixel wide and refracts nothing.
          softness: 0.62,
          fillcolor: [1, 1, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: true,
        },
        {
          label: "lens1",
          parameters: {
            "center.x": drivenSlot("follow1:x", 0.5),
            "center.y": drivenSlot("follow1:y", 0.5),
            "radius.x": drivenSlot("ease1", 0.32),
            "radius.y": drivenSlot("ease1", 0.32),
          },
        },
      ),
      node(
        "normals",
        "slope",
        [-300, -320],
        // The dome's slope is gentle — one unit of luminance across 0.6 uv — so the Sobel
        // result needs the manifest's full strength to tilt the normal far enough to bend.
        { mode: "normal", channel: "luminance", strength: 20, zeropoint: 0.5, angle: 45, extend: "hold" },
        { label: "normals1" },
      ),

      // ---- dispersion: one scene, three refractive indices ------------------------
      node(
        "bendR",
        "displace",
        [0, -220],
        { weight: [-0.75, -0.75], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold" },
        { label: "bendR1" },
      ),
      node(
        "bendG",
        "displace",
        [0, -20],
        { weight: [-1.05, -1.05], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold" },
        { label: "bendG1" },
      ),
      node(
        "bendB",
        "displace",
        [0, 180],
        // Blue bends furthest, as it does through glass. Order the three the other way and
        // the fringe reverses: the picture stays plausible and the physics does not.
        { weight: [-1.4, -1.4], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold" },
        { label: "bendB1" },
      ),
      node(
        "fuse",
        "reorder",
        [300, -120],
        { outr: "in1r", outg: "in2g", outb: "in1b", outa: "in1a" },
        { label: "fuse1" },
      ),
      node(
        "prism",
        "reorder",
        [560, -20],
        { outr: "in1r", outg: "in1g", outb: "in2b", outa: "in1a" },
        { label: "prism1" },
      ),
      node("out", "output", [820, -20], {}, { label: "out1" }),
    ],
    [
      edge("e-mouse-follow", ["mouse", "out"], ["follow", "in"]),
      edge("e-pulse-ease", ["pulse", "out"], ["ease", "in"]),

      edge("e-swarm-sparks", ["swarm", "out"], ["sparks", "points"]),
      edge("e-sparks-roll", ["sparks", "out"], ["roll", "input"]),
      edge("e-roll-field", ["roll", "out"], ["field", "in1"]),
      edge("e-backdrop-field", ["backdrop", "out"], ["field", "in2"]),

      edge("e-lens-normals", ["lens", "out"], ["normals", "input"]),

      edge("e-field-bendR", ["field", "out"], ["bendR", "source"]),
      edge("e-field-bendG", ["field", "out"], ["bendG", "source"]),
      edge("e-field-bendB", ["field", "out"], ["bendB", "source"]),
      edge("e-normals-bendR", ["normals", "out"], ["bendR", "disp"]),
      edge("e-normals-bendG", ["normals", "out"], ["bendG", "disp"]),
      edge("e-normals-bendB", ["normals", "out"], ["bendB", "disp"]),

      edge("e-bendR-fuse", ["bendR", "out"], ["fuse", "in1"]),
      edge("e-bendG-fuse", ["bendG", "out"], ["fuse", "in2"]),
      edge("e-fuse-prism", ["fuse", "out"], ["prism", "in1"]),
      edge("e-bendB-prism", ["bendB", "out"], ["prism", "in2"]),
      edge("e-prism-out", ["prism", "out"], ["out", "input"]),
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
  let t = ctx.time * 0.6;
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
 * every point along the surface NORMAL by that sample, and renderSurface shades the
 * grid as a closed ball whose seam the wrap flag heals.
 *
 * WHY THE SURFACE SURVIVES — the doc's teaching, stated here for the tests:
 *  - displacement is ALONG THE NORMAL, and on a sphere the normal is free:
 *    normalize(position) IS the outward normal, no neighbours needed. A radial push
 *    moves a point toward or away from the centre and never sideways past its grid
 *    neighbours, so cells stretch but never fold or self-intersect.
 *  - the noise is CONTINUOUS in uv and in time, so neighbouring points sample nearly
 *    the same displacement and the surface stays a surface — white noise here would
 *    shred the ball into spikes.
 *  - the seam is a TOPOLOGY claim, not geometry: the ball kernel maps u = col/COLS so
 *    column 0 and a hypothetical column COLS coincide, and `pointTopology`'s wrapU adds
 *    the seam CELL that stitches the last column to the first (T302). Remove the wrap
 *    and the ball shows a slit; the points never move.
 *
 * The chain is FIVE point nodes — grid → ball → sample → goo → claim → surface — and
 * every link is T401's processor mechanism or an edge-payload edit. `sample` is
 * authored by the bridge and read by `goo` as an upstream-bound attribute; topology
 * flows generator → kernels → claim by passthrough.
 */
const GOOEY_COLS = 64;
const GOOEY_ROWS = 64;

const GOOEY_BALL_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The grid is an INDEX SHEET; the sphere comes from the index, not the plane.
     u runs col/COLS (not cols-1): column 0 and "column COLS" coincide, which is what
     the wrapU seam cell downstream stitches together. v runs pole to pole. */
  let col = f32(ctx.index % ${GOOEY_COLS}u);
  let row = f32(ctx.index / ${GOOEY_COLS}u);
  let u = col / ${GOOEY_COLS}.0;
  let v = row / ${GOOEY_ROWS - 1}.0;
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
 *  · KICK → COLOUR. onsetCount (T437: rising events, not a beat claim) through
 *    Trigger, then a Lag turns each pulse into a decaying envelope that bumps the
 *    palette row — the gradient jumps warm on a hit and eases back.
 *  · WIND. A Transform INSIDE the loop (state → wind → rd), rotating a hair per
 *    iteration. Substeps multiply it, so the bass literally stirs faster — the T350
 *    reference keeps the loop a name (`source: "pack1"`) while the body grows a node.
 *  · SILENCE IS A PICTURE, NOT A FAILURE (§V329). Unbound audio reads all-zero
 *    channels: substeps rest at their base, the chemistry sits mid-band, the palette
 *    breathes on its own LFO — the example ANIMATES (T402) with no track bound, and
 *    binding one adds the instrument on top.
 */
const audioRdDocument = document(
  "e24-audio-reaction-diffusion",
  "E24 Audio Reaction-Diffusion",
  settings({ outputResolution: { width: 512, height: 512 } }),
  graph(
    [
      // ---- the sound ------------------------------------------------------------
      /*
       * T442 (B74, §V363): the flagship PLAYS on first open. Assets are session-only,
       * so no example can ship a bound audio file — and an audio-reactive graph whose
       * null state is indistinguishable from a broken one demos nothing. The pattern
       * node is the deterministic stand-in: swap this ONE node for an audioFileIn or
       * audioIn (keep the label) and every mapping downstream drives from real sound.
       */
      node("music", "audioPattern", [-1460, 420], { bpm: 112, amount: 1 }, { label: "music1" }),
      node("env", "valueLag", [-1220, 420], { lag: 0.12 }, { label: "env1" }),
      // Substeps: low band, scaled 0..20 over a base of 14, fenced 1..34.
      node("sgain", "valueMath", [-980, 340], { operation: "multiply", operand: 20 }, { label: "sgain1" }),
      node("sbase", "valueMath", [-740, 340], { operation: "add", operand: 14 }, { label: "sbase1" }),
      node("scap", "valueLimit", [-500, 340], { minimum: 1, maximum: 34 }, { label: "steps1" }),
      // Chemistry: lowMid nudges the white point 0.64..0.80, hard-fenced to the band
      // where the pattern SURVIVES (the tutorial's "so the pattern doesn't disappear").
      node("wgain", "valueMath", [-980, 540], { operation: "multiply", operand: 0.16 }, { label: "wgain1" }),
      node("wbase", "valueMath", [-740, 540], { operation: "add", operand: 0.64 }, { label: "wbase1" }),
      node("wcap", "valueLimit", [-500, 540], { minimum: 0.62, maximum: 0.8 }, { label: "wlevel1" }),
      // Kick: onset EVENTS through Trigger, then Lag makes each pulse a decaying bump.
      node("trig", "valueTrigger", [-1220, 600], { threshold: 0.5 }, { label: "trig1" }),
      node("kick", "valueLag", [-980, 740], { lag: 0.35 }, { label: "kick1" }),
      node("kgain", "valueMath", [-740, 740], { operation: "multiply", operand: 0.9 }, { label: "kgain1" }),
      node("kscale", "valueMath", [-500, 740], { operation: "add", operand: 2.4 }, { label: "kscale1" }),

      // ---- the chemistry map (E2's, verbatim in spirit) -------------------------
      node("broad", "noise", [-1460, -140], {
        type: "perlin4d", seed: 5, period: 0.55, harmon: 2, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0, s4d: 1, speed: 0.05,
      }, { label: "broad1" }),
      node("detail", "noise", [-1460, 100], {
        type: "perlin4d", seed: 19, period: 0.13, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.6, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0, s4d: 1, speed: 0.09,
      }, { label: "detail1" }),
      node("warp", "displace", [-1180, -60], {
        weight: [0.22, 0.22], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, { label: "warp1" }),
      node("shape", "level", [-940, -60], {
        blacklevel: 0.28, contrast: 1.6, brightness: 1, gamma1: 1,
      }, {
        label: "shape1",
        parameters: { whitelevel: drivenSlot("wlevel1:lowMid", 0.72) },
      }),

      // ---- the simulation loop, with wind ---------------------------------------
      node("state", "feedback", [-680, 120], { source: "pack1", persistence: 1, clearColor: [0, 0, 0, 0] }, {
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
      node("pack", "reorder", [60, 120], {
        outr: "in1r", outg: "in1g", outb: "in2lum", outa: "in1a",
      }, { label: "pack1" }),

      // ---- colour, then TIME ----------------------------------------------------
      node("palette", "ramp", [-200, 380], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.01, 0.02, 0.07, 1] },
          { position: 0.32, color: [0.03, 0.2, 0.38, 1] },
          { position: 0.58, color: [0.24, 0.6, 0.5, 1] },
          { position: 0.8, color: [0.95, 0.62, 0.24, 1] },
          { position: 1, color: [1, 0.95, 0.85, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("cycle", "lfo", [-200, 560], { shape: "sine", frequency: 0.05, amplitude: 0.06, offset: 0 }, {
        label: "lfo1",
      }),
      node("tint", "lookup", [60, 380], { channel: "green", row: 0.5 }, {
        label: "tint1",
        parameters: {
          offset: drivenSlot("lfo1", 0),
          // The kick PUNCHES the lookup's gain: every front shifts down-ramp for the
          // length of the lag's decay — a colour pulse the whole image shares.
          scale: drivenSlot("kscale1:onsetCount", 2.4),
        },
      }),
      // The RGB delay: three taps into time, one per channel. Full scale — this ring
      // is read for its colour, not just its motion.
      node("tapR", "cache", [320, 300], { frames: 4, index: 2, scale: 1 }, { label: "tapr1" }),
      node("tapG", "cache", [320, 480], { frames: 7, index: 5, scale: 1 }, { label: "tapg1" }),
      node("tapB", "cache", [320, 660], { frames: 10, index: 9, scale: 1 }, { label: "tapb1" }),
      // Reorder is two-input, so the three taps braid in two steps: red-with-green
      // first, then the blue tap joins.
      node("fringeRG", "reorder", [580, 370], {
        outr: "in1r", outg: "in2g", outb: "in1b", outa: "in1a",
      }, { label: "fringerg1" }),
      node("fringe", "reorder", [820, 440], {
        outr: "in1r", outg: "in1g", outb: "in2b", outa: "in1a",
      }, { label: "fringe1" }),
      node("out", "output", [1080, 440]),
    ],
    [
      // sound
      edge("e-music-env", ["music", "out"], ["env", "in"]),
      edge("e-env-sgain", ["env", "out"], ["sgain", "a"]),
      edge("e-sgain-sbase", ["sgain", "out"], ["sbase", "a"]),
      edge("e-sbase-scap", ["sbase", "out"], ["scap", "in"]),
      edge("e-env-wgain", ["env", "out"], ["wgain", "a"]),
      edge("e-wgain-wbase", ["wgain", "out"], ["wbase", "a"]),
      edge("e-wbase-wcap", ["wbase", "out"], ["wcap", "in"]),
      edge("e-music-trig", ["music", "out"], ["trig", "in"]),
      edge("e-trig-kick", ["trig", "out"], ["kick", "in"]),
      edge("e-kick-kgain", ["kick", "out"], ["kgain", "a"]),
      edge("e-kgain-kscale", ["kgain", "out"], ["kscale", "a"]),
      // chemistry map
      edge("e-broad-warp", ["broad", "out"], ["warp", "source"]),
      edge("e-detail-warp", ["detail", "out"], ["warp", "disp"]),
      edge("e-warp-shape", ["warp", "out"], ["shape", "input"]),
      edge("e-shape-pack", ["shape", "out"], ["pack", "in2"]),
      // the loop, wind inside it
      edge("e-state-wind", ["state", "out"], ["wind", "input"]),
      edge("e-wind-rd", ["wind", "out"], ["rd", "input"]),
      edge("e-rd-pack", ["rd", "out"], ["pack", "in1"]),
      // colour then time
      edge("e-rd-tint", ["rd", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-tapr", ["tint", "out"], ["tapR", "input"]),
      edge("e-tint-tapg", ["tint", "out"], ["tapG", "input"]),
      edge("e-tint-tapb", ["tint", "out"], ["tapB", "input"]),
      edge("e-tapr-fringerg", ["tapR", "out"], ["fringeRG", "in1"]),
      edge("e-tapg-fringerg", ["tapG", "out"], ["fringeRG", "in2"]),
      edge("e-fringerg-fringe", ["fringeRG", "out"], ["fringe", "in1"]),
      edge("e-tapb-fringe", ["tapB", "out"], ["fringe", "in2"]),
      edge("e-fringe-out", ["fringe", "out"], ["out", "input"]),
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
          t4d: 0,
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
      node("matFloor", "materialPhong", [-410, 420], {
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

/** Every example, in the order they are meant to be read. */
export const EXAMPLE_DOCUMENTS: readonly ProjectDocument[] = [
  feedbackEchoDocument,
  reactionDiffusionDocument,
  animatedNoiseFieldDocument,
  bloomDocument,
  kaleidoscopeDocument,
  displacementStackDocument,
  lfoDissolveDocument,
  slitScanDocument,
  particleFountainDocument,
  instancedTorusDocument,
  gradientRemapDocument,
  fluidDocument,
  prismDocument,
  murmurationDocument,
  gooeyballDocument,
  audioRdDocument,
  stageDocument,
];
