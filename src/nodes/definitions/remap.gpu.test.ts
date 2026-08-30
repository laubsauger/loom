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
 * T279 on a real device: the claim that made Remap worth building.
 *
 * Every other assertion about this node is about the PLAN — which channel drives u, which
 * policy inherits from which input. None of them can see the thing that actually matters:
 * that feeding our own UV generator into the map input reproduces the source pixel for
 * pixel. That is a statement about two shaders agreeing on which way v runs, and only
 * rendering both of them can check it. Before this node existed, `uv` produced coordinates
 * nothing in the catalogue could consume, so nothing could have caught a disagreement.
 *
 * The measurement is a Difference against the source reduced by Analyze, so the assertion
 * is a NUMBER — a maximum error — rather than a screenshot. The flipped case is measured
 * too: a test that only reports "small" without ever showing what "large" looks like is
 * not evidence that the measurement works.
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
 * uv -> Remap(source: uv, map: uv), differenced against uv and reduced to one number.
 *
 * Both inputs are the SAME generator, so a correct Remap is the identity and every channel
 * of the Difference is zero. `abs()` makes each channel non-negative, so the maximum
 * luminance bounds the per-channel error (the smallest weight is red's 0.2126).
 */
function identityGraph(flipv: boolean): GraphDocument {
  return {
    revision: 1,
    nodes: {
      uv: node("uv", "uv"),
      remap: node("remap", "remap", { flipv }),
      diff: node("diff", "difference"),
      meter: node("meter", "analyze", { channel: "luminance", operation: "maximum" }),
    },
    edges: {
      e1: edge("e1", ["uv", "out"], ["remap", "source"]),
      e2: edge("e2", ["uv", "out"], ["remap", "map"]),
      e3: edge("e3", ["remap", "out"], ["diff", "in1"]),
      e4: edge("e4", ["uv", "out"], ["diff", "in2"]),
      e5: edge("e5", ["diff", "out"], ["meter", "input"]),
    },
    groups: {},
  };
}

async function maxError(flipv: boolean): Promise<number> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compileGraph({
      graph: identityGraph(flipv),
      settings,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    // [average, minimum, maximum] of the analyzed channel (§V144's buffer).
    const raw = await backend.readBuffer(scratchResourceId("meter", ANALYZE_RESULT_KEY));
    return new Float32Array(raw, 0, 4)[2] ?? Number.NaN;
  } finally {
    backend.dispose();
  }
}

describe("Remap consumes the UV generator on a real device (T279)", () => {
  it("reproduces the source exactly, and visibly does not when v is flipped", async () => {
    // Dawn is required, not optional: skipping would turn the one test that can see this
    // failure mode into a green tick on every machine without a GPU.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Identity. The residual is half-float quantisation of the coordinates (~5e-4 in a
    // 0..1 field), nowhere near a texel, so a genuine off-by-one-texel error would fail.
    expect(await maxError(false)).toBeLessThan(0.01);

    // The same chain with `flipv` on: the map now reads v = 1 - v, so the error runs up to
    // a full unit in green. This is the number the identity case would produce if the two
    // shaders disagreed about which way v runs — which is exactly the mistake that would
    // otherwise ship silently, since both pictures look like plausible warps.
    expect(await maxError(true)).toBeGreaterThan(0.5);
  }, 60_000);
});
