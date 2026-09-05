import { describe, expect, it } from "vitest";

import { createUniformAnimator } from "../../app/animate-parameters.ts";
import { compileGraph } from "../../compiler/index.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { graphChannelResolver } from "../../domain/channels/graph-channels.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions, ANALYZE_RESULT_KEY } from "./index.ts";

/**
 * T237 on a real device: a tap of 1 IS the previous frame.
 *
 * Every other test here is about the plan — which slice a pass binds, where the rotation
 * lands. None can see the thing that decides whether the node works: that the rotation and
 * the tap agree about which slice holds which frame, ACROSS frames. That is a claim about
 * time, so it needs several real frames to be false in.
 *
 * The reference is Feedback, which has been a one-frame delay since T152 and is backed by
 * a mechanism the ring generalises. Cache(index 1) and Feedback fed the same animated
 * source must produce the same picture; the difference is reduced to one number by
 * Analyze. If the ring rotated at the wrong time, or a tap resolved off by one slice, this
 * is where it shows up — everywhere else the two just look like plausible delays.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function edge(id: string, from: [string, string], to: [string, string]) {
  return {
    id,
    source: { nodeId: from[0], portId: from[1] },
    target: { nodeId: to[0], portId: to[1] },
  };
}

/**
 * An animated noise into both a Cache (tap 1) and a Feedback, differenced and measured.
 *
 * The source has to CHANGE per frame or the test passes with the ring never rotating —
 * time-driven Perlin gives a different picture every frame from the shared frame block,
 * with no wall clock anywhere (§V44).
 */
function delayGraph(index: number): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: node("src", "noise", { type: "perlin4d", speed: 1.5, period: 0.35 }),
      cache: node("cache", "cache", { frames: 4, index, scale: 1 }),
      // persistence 1 is a pure one-frame delay — no fade, nothing to subtract out.
      delay: node("delay", "feedback", { persistence: 1 }),
      diff: node("diff", "difference"),
      meter: node("meter", "analyze", { channel: "luminance", operation: "maximum" }),
    },
    edges: {
      e1: edge("e1", ["src", "out"], ["cache", "input"]),
      e2: edge("e2", ["src", "out"], ["delay", "in"]),
      e3: edge("e3", ["cache", "out"], ["diff", "in1"]),
      e4: edge("e4", ["delay", "out"], ["diff", "in2"]),
      e5: edge("e5", ["diff", "out"], ["meter", "input"]),
    },
    groups: {},
  };
}

/**
 * B160 — a Cache tapped against its own SOURCE, differenced and metered. On frame 0 the
 * ring holds nothing, so §V229's "never black" can only be true if the tap reads the
 * write target (the frame just composed): an empty cache must be a zero-delay
 * passthrough, so `cache − source` is zero. Before B160 it was `black − source` = the
 * whole picture, and frame 0 is the gallery thumbnail (§V769).
 */
function passthroughGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: node("src", "noise", { type: "perlin4d", speed: 1.5, period: 0.35 }),
      cache: node("cache", "cache", { frames: 4, index: 1, scale: 1 }),
      diff: node("diff", "difference"),
      meter: node("meter", "analyze", { channel: "luminance", operation: "maximum" }),
    },
    edges: {
      e1: edge("e1", ["src", "out"], ["cache", "input"]),
      e3: edge("e3", ["cache", "out"], ["diff", "in1"]),
      e4: edge("e4", ["src", "out"], ["diff", "in2"]),
      e5: edge("e5", ["diff", "out"], ["meter", "input"]),
    },
    groups: {},
  };
}

/** The metered value after rendering exactly `frames` frames (reads the last). */
async function passthroughDiffAt(frames: number): Promise<number> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compileGraph({
      graph: passthroughGraph(),
      settings,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(plan);
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      backend.render(compiled, {
        frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
    }
    const raw = await backend.readBuffer(scratchResourceId("meter", ANALYZE_RESULT_KEY));
    return new Float32Array(raw, 0, 4)[2] ?? Number.NaN;
  } finally {
    backend.dispose();
  }
}

/** Renders `frames` frames of advancing time and returns the last measured difference. */
async function maxDifference(index: number, frames: number): Promise<number> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compileGraph({
      graph: delayGraph(index),
      settings,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const compiled = await backend.compile(plan);
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      backend.render(compiled, {
        frame: {
          timeSeconds: frameIndex / 60,
          deltaSeconds: 1 / 60,
          frameIndex,
          mode: "offline",
          randomSeed: 1,
        },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
    }
    const raw = await backend.readBuffer(scratchResourceId("meter", ANALYZE_RESULT_KEY));
    return new Float32Array(raw, 0, 4)[2] ?? Number.NaN;
  } finally {
    backend.dispose();
  }
}

describe("Cache holds frames on a real device (T237)", () => {
  it("returns the previous frame at tap 1, and a different one deeper in", async () => {
    // Dawn is required, not optional: skipping would turn the only test that can see this
    // failure mode into a green tick on every machine without a GPU.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Six frames: enough for the 4-slice ring to have wrapped, so this measures the
    // rotation's arithmetic and not just its first pass through. The comparison starts
    // after warm-up by construction — the reading is the LAST frame's.
    expect(await maxDifference(1, 6)).toBeLessThan(0.01);

    // The control, and the reason the first number means something: three frames back is
    // NOT the previous frame, so the same measurement against the same reference has to
    // come back large. Without this, a Cache that returned its input unchanged — or a ring
    // that never rotated — would pass the assertion above on a slow-moving source.
    expect(await maxDifference(3, 6)).toBeGreaterThan(0.02);
  }, 120_000);

  it("is a PASSTHROUGH on frame 0, never black — §V229 made true where the ring is empty (B160)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Frame 0: the ring holds nothing, so a correct cache reads its write target and the
    // difference against the source is zero. This is the exact frame every existing cache
    // gate skipped (they read from frame 1), which is why the black-frame-0 defect
    // survived — three examples carried private workarounds for it.
    expect(await passthroughDiffAt(1)).toBeLessThan(0.01);

    // The control: by frame 3 the ring has archived real history, so tap 1 is genuinely
    // the PREVIOUS frame and differs from the live source on an animated noise. Without
    // this, a cache that always returned its input would pass the line above.
    expect(await passthroughDiffAt(3)).toBeGreaterThan(0.02);
  }, 120_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * T1204 — THE DRIVEN TAP, AND THE ALIGNMENT IT EXISTS FOR
 *
 * The owner's problem, verbatim: "if the mask is part of the cycle we need to apply the
 * latency the mask introduces onto the RGB feed also, before compositing them together —
 * otherwise the mask is going to be behind the RGB". An async source (person matte,
 * monocular depth, pose) hands back a result computed from a frame that is already N
 * frames old, and N MOVES — matte inference measured 30-400 ms across execution providers
 * (T1044, T1085). The alignment is: delay the sibling branch by the same N, every frame.
 *
 * The claim these tests make is a claim about PIXELS, not about a uniform holding the
 * right number: the picture the delayed branch shows at frame N is BYTE-IDENTICAL to the
 * picture the late branch shows at frame N. A test that read `tap` back out of the plan
 * would have been green throughout the four months the docblock said this was impossible.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The `expression` slot as the document stores it — `builders.ts`'s shape, spelled here. */
function expression(source: string, retained: number): GraphNode["parameters"][string] {
  return {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: retained },
      expression: { kind: "expression", source },
    },
  } as unknown as GraphNode["parameters"][string];
}

/**
 * ONE source into TWO cache branches, differenced and metered.
 *
 * `late` stands in for the async result: a picture that is `lateBy` frames behind the live
 * feed. `aligned` is the sibling branch — the RGB — delayed by a tap driven off a CHANNEL,
 * which is what `op('mask1').chan.lagFrames` drives in a real graph. When the two agree the
 * difference is exactly zero: both rings archive the same blit of the same source, so the
 * same slice is the same bytes, and §V147's "exact or analytically derived" is satisfied
 * by construction rather than by a tolerance band.
 *
 * THE TAP IS NEVER SPELLED AS A LITERAL, deliberately. A literal expression resolves at the
 * STRUCTURAL compile too, so the animator would find nothing changed and write nothing —
 * and the test would pass on the static path this task already had, proving none of the
 * new capability. Every run here drives the tap through the channel resolver, whose value
 * the structural compile does not have: the retained static is 1, so a tap of anything else
 * on the GPU can only have arrived as a per-frame uniform write.
 */
function alignmentGraph(lateBy: number, lfo: Readonly<Record<string, number | string>>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: node("src", "noise", { type: "perlin4d", speed: 1.5, period: 0.35 }),
      // §V129: the LFO's NAME is its channel, and that is the whole addressing story —
      // the same one `op('depth1').chan.lagFrames` uses. A real graph points the tap at an
      // inference node's published lag (T976); this test points it at a shape whose value
      // at every frame is known analytically, so the expected picture is derivable.
      lfo: { ...node("lfo", "lfo", { shape: "sine", phase: 0, ...lfo }), label: "lfo1" },
      late: node("late", "cache", { frames: 8, index: lateBy, scale: 1 }),
      aligned: node("aligned", "cache", {
        frames: 8,
        index: expression("op('lfo1').chan.value", 1),
        scale: 1,
      }),
      diff: node("diff", "difference"),
      meter: node("meter", "analyze", { channel: "luminance", operation: "maximum" }),
    },
    edges: {
      e1: edge("e1", ["src", "out"], ["late", "input"]),
      e2: edge("e2", ["src", "out"], ["aligned", "input"]),
      e3: edge("e3", ["late", "out"], ["diff", "in1"]),
      e4: edge("e4", ["aligned", "out"], ["diff", "in2"]),
      e5: edge("e5", ["diff", "out"], ["meter", "input"]),
    },
    groups: {},
  };
}

interface AlignmentRun {
  /** The metered maximum difference between the two branches on the last frame. */
  readonly difference: number;
  /** The tap the plan actually used, per frame — read off the per-frame compile. */
  readonly taps: readonly number[];
  /** How many uniform blocks the animator wrote. Zero would mean nothing was driven. */
  readonly written: number;
}

/**
 * Renders the alignment graph the way the app renders a driven parameter: ONE structural
 * compile, one `backend.compile`, and per frame a values-only re-resolve pushed through
 * `createUniformAnimator`. Nothing here re-runs `backend.compile` — the animator refuses
 * to write at all unless the per-frame plan is a values-only variation (§V5), so a version
 * of the tap that still moved the plan's STRUCTURE could not reach these assertions.
 */
async function runAlignment(graph: GraphDocument, frames: number): Promise<AlignmentRun> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const base = compileGraph({ graph, settings, registry, capabilities });
    expect(base.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(base);
    const builds = backend.status.resourceBuilds;

    const channels = graphChannelResolver(graph, registry);
    const animator = createUniformAnimator();
    const taps: number[] = [];
    let written = 0;

    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      const frame = {
        timeSeconds: frameIndex / 60,
        deltaSeconds: 1 / 60,
        frameIndex,
        mode: "offline" as const,
        randomSeed: 1,
      };
      const next = compileGraph({ graph, settings, registry, capabilities, resolution: { frame, channels } });
      const count = animator.push(backend, base, next);
      // Null = the per-frame plan was NOT a values-only variation, i.e. the tap had moved
      // the plan's structure and the frame loop was being asked to recompile at frame rate.
      // That is exactly what the pass id carrying the tap used to do (§V5).
      expect(count, "a driven tap changed the plan's structure").not.toBeNull();
      written += count ?? 0;
      taps.push(tapOf(next));
      backend.render(compiled, {
        frame,
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
    }

    // §V5 on the observable the invariant is actually about: no resource was rebuilt while
    // the tap swept. A drivable tap that reallocated the ring would still pass every
    // assertion above and would throw the history away sixty times a second.
    expect(backend.status.resourceBuilds).toBe(builds);

    const raw = await backend.readBuffer(scratchResourceId("meter", ANALYZE_RESULT_KEY));
    return { difference: new Float32Array(raw, 0, 4)[2] ?? Number.NaN, taps, written };
  } finally {
    backend.dispose();
  }
}

/** The tap the `aligned` cache's read pass carries in this compile. */
function tapOf(plan: { passes: ReadonlyArray<{ id: string }> }): number {
  // The compiler namespaces a node's pass ids as `<nodeId>#<nodeId>:<label>`; the tail is
  // what the node itself spelled, and T1204 is the reason it no longer ends in the tap.
  const read = plan.passes.find((pass) => pass.id.endsWith("aligned:cache-read")) as
    | { uniforms?: { tap?: number } }
    | undefined;
  const tap = read?.uniforms?.tap;
  if (typeof tap !== "number")
    throw new Error(
      `the aligned cache has no tap uniform. passes: ${plan.passes.map((p) => p.id).join(", ")}`,
    );
  return tap;
}

describe("T1204 — a cache tap you can DRIVE, so two branches with different latencies line up", () => {
  it("puts the delayed branch on exactly the frame the late branch is showing", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // The late branch is 3 frames behind. The driven branch is told, per frame, to go back
    // 3 — the shape a published `lagFrames` takes. Ten frames: past the 8-slice ring's
    // fill, so this measures the rotation arithmetic under a live uniform and not just the
    // first pass through.
    const matched = await runAlignment(alignmentGraph(3, { amplitude: 0, offset: 3, frequency: 1 }), 10);
    // EXACT. Both branches archive the same blit of the same source into their own ring, so
    // the same slice is the same bytes and the difference is a hard zero — not a band.
    expect(matched.difference).toBe(0);
    // The tap really was pushed rather than merely compiled in: the structural plan's own
    // value is 1 (the expression's retained static), and every frame drove it to 3.
    expect(matched.taps).toEqual(Array.from({ length: 10 }, () => 3));
    expect(matched.written).toBeGreaterThan(0);

    // THE CONTROL, and the reason the zero above means anything. Off by ONE frame — the
    // exact error the owner described, the mask sitting behind the RGB — and the branches
    // no longer agree at all. Without this, a cache that ignored its tap entirely, or a
    // difference that was always zero, would pass the assertion above.
    const offByOne = await runAlignment(alignmentGraph(3, { amplitude: 0, offset: 4, frequency: 1 }), 10);
    expect(offByOne.taps).toEqual(Array.from({ length: 10 }, () => 4));
    expect(offByOne.difference).toBeGreaterThan(0.02);
  }, 180_000);

  it("tracks a tap that MOVES, which is the half a static offset cannot express", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // A 5 Hz sine about 2 with amplitude 1, sampled at 60 fps: the tap rounds to 1, 2 and 3
    // across twelve frames. This is the case the whole task exists for — an inference lag
    // that is 30 ms on one execution provider and 400 ms on another does not hold still,
    // and a hand-typed offset is wrong the moment it moves.
    const moving = await runAlignment(alignmentGraph(3, { amplitude: 1, offset: 2, frequency: 5 }), 12);

    // The tap genuinely swept. Asserted because everything below is vacuous if it did not:
    // a "dynamic" tap that happened to sit on one value all run would prove nothing.
    expect(new Set(moving.taps).size).toBeGreaterThan(1);
    expect([...new Set(moving.taps)].every((tap) => tap >= 1 && tap <= 3)).toBe(true);
    // Values only. A structural rebuild per frame is what `push` returning null would mean,
    // and `runAlignment` asserts that per frame; the resource-build count asserts the ring
    // survived the sweep.
    expect(moving.written).toBeGreaterThan(0);

    // And it lands on the RIGHT frames while it moves: on the last frame the tap is what
    // the plan says it is, and the branch differs from the fixed-3 branch exactly when the
    // two taps disagree. `taps` is read off the same compile the GPU was handed, so this
    // compares the picture against the number that produced it rather than against a
    // number the test made up.
    const last = moving.taps.at(-1);
    if (last === undefined) throw new Error("no frames rendered");
    expect(moving.difference === 0).toBe(last === 3);
  }, 180_000);
});
