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
      node("soften", "blur", [-360, 220], { size: 2.5, filter: "gaussian", extend: "zero" }),
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
 * E2 — Reaction-Diffusion (T154).
 *
 *   feedback.out ─► customWgsl(Gray-Scott) ─┬─► feedback.in
 *                                           └─► output
 *
 * CustomWGSL is single-input by manifest, so this is the only shape a one-texture
 * simulation can take: the state lives in the Feedback pair, the kernel reads the previous
 * frame and writes the next one, and the same output is also presented. `persistence` is 1
 * — a pure one-frame delay. Anything less would fade the simulation state itself, which is
 * not a look, it is a bug.
 *
 * The FORMAT and RESOLUTION overrides on the Feedback node are load-bearing rather than
 * decorative. Both nodes inherit from their input, and their inputs are each other, so the
 * inheritance has no ground to stand on; pinning them here breaks the cycle at a named
 * point and states the precision the simulation actually needs (§V51). rgba16float matters:
 * Gray-Scott increments are ~1e-3 per step, which rgba8unorm cannot represent at all.
 *
 * Seeded init, pause/step/reset: see the kernel's own header. Reset clears the pair, the
 * cleared alpha tells the kernel to re-seed, and pause/step are transport concerns that
 * need nothing from the graph — one frame advanced is one simulation step, by construction.
 */
export const reactionDiffusionDocument = document(
  "reaction-diffusion",
  "E2 Reaction-Diffusion",
  settings({ outputResolution: { width: 512, height: 512 } }),
  graph(
    [
      node(
        "state",
        "feedback",
        [-80, 0],
        // T350 (§V285): the simulation loop is a NAME too.
        { source: "kernel1", persistence: 1, clearColor: [0, 0, 0, 0] },
        {
          resolution: { mode: "fixed", width: 512, height: 512 },
          format: { mode: "fixed", format: "rgba16float" },
        },
      ),
      node("kernel", "customWgsl", [200, 0], { [SHADER_SOURCE_PARAMETER]: GRAY_SCOTT_WGSL }, { label: "kernel1" }),
      node("out", "output", [460, 120]),
    ],
    [
      edge("e-state-kernel", ["state", "out"], ["kernel", "input"]),
      edge("e-kernel-out", ["kernel", "out"], ["out", "input"]),
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
        [-1180, 580],
        // 0.14 either side of 0.32: the lens breathes between radius 0.18 and 0.46, both
        // well inside the manifest's range, so nothing is ever clamped on the way through.
        { shape: "square", frequency: 0.22, amplitude: 0.14, offset: 0.32, phase: 0 },
        { label: "pulse1" },
      ),
      node("ease", "valueLag", [-940, 580], { lag: 0.45 }, { label: "ease1" }),

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
];
