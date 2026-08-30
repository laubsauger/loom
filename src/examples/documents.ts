import { SHADER_SOURCE_PARAMETER } from "../domain/commands/apply-patch.ts";
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  ProjectDocument,
  ProjectSettings,
} from "../domain/types/graph.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../domain/types/schemas.ts";
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
      node("over", "over", [40, -60], { opacity: 1 }),
      node("echo", "feedback", [40, 140], {
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
      edge("e-over-feedback", ["over", "out"], ["echo", "in"]),
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
        { persistence: 1, clearColor: [0, 0, 0, 0] },
        {
          resolution: { mode: "fixed", width: 512, height: 512 },
          format: { mode: "fixed", format: "rgba16float" },
        },
      ),
      node("kernel", "customWgsl", [200, 0], { [SHADER_SOURCE_PARAMETER]: GRAY_SCOTT_WGSL }),
      node("out", "output", [460, 120]),
    ],
    [
      edge("e-state-kernel", ["state", "out"], ["kernel", "input"]),
      edge("e-kernel-state", ["kernel", "out"], ["state", "in"]),
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
 * parameter (§V113), spinning the whole formation without a recompile (§V5: rotation
 * is sixteen uniform floats and one integer away from any other frame).
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
];
