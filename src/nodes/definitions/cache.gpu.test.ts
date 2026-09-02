import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
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
