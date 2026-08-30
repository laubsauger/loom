import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { ColorStop } from "../../domain/types/parameters.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions, ANALYZE_RESULT_KEY } from "./index.ts";

/**
 * The multi-stop Ramp on a real device (T270, §V147).
 *
 * Everything else about this node is a claim about the PLAN — that the pack function put
 * sixteen colours and a count in a uniform block. None of it can see the two things that
 * would actually break:
 *
 *  - the shader is a rewrite, and a WGSL error in it does not fail a mock (B9: vgpu raises
 *    from an async pipeline path, `compile()` resolves, the picture "looks retained");
 *  - the stop table is twenty flat `vec4f` members reassembled into local arrays, so a
 *    packing mistake — the wrong group, an off-by-one in the position vectors — produces
 *    a perfectly plausible gradient made of the wrong colours.
 *
 * So the assertion is a MEASUREMENT of the picture: a middle stop that reaches the GPU
 * changes the average of the channel it colours, and one that does not, does not. The
 * two-stop case is measured beside it, because a number with nothing to be different from
 * is not evidence (§V147, B15).
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

const BLACK: ColorStop["color"] = [0, 0, 0, 1];
const RED: ColorStop["color"] = [1, 0, 0, 1];

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  const definitionVersion = createNodeRegistry(allNodeDefinitions).view().get(type)?.version ?? 1;
  return { id, type, definitionVersion, position: { x: 0, y: 0 }, parameters };
}

/** ramp -> analyze(red), so the whole picture reduces to one number (§V144). */
function rampGraph(stops: readonly ColorStop[], operation: "average" | "maximum"): GraphDocument {
  return {
    revision: 1,
    nodes: {
      ramp: node("ramp", "ramp", { type: "horizontal", stops: [...stops] }),
      meter: node("meter", "analyze", { channel: "r", operation }),
    },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "ramp", portId: "out" },
        target: { nodeId: "meter", portId: "input" },
      },
    },
    groups: {},
  };
}

async function measure(
  stops: readonly ColorStop[],
  operation: "average" | "maximum",
): Promise<number> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compileGraph({
      graph: rampGraph(stops, operation),
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
    // [average, minimum, maximum] of the analyzed channel.
    const raw = await backend.readBuffer(scratchResourceId("meter", ANALYZE_RESULT_KEY));
    const results = new Float32Array(raw, 0, 4);
    return (operation === "average" ? results[0] : results[2]) ?? Number.NaN;
  } finally {
    backend.dispose();
  }
}

describe("Ramp renders every stop it was given (T270, §V147)", () => {
  it("a middle stop reaches the picture, and a two-stop ramp proves it had to", async () => {
    // Dawn is required, not optional: skipping would turn the one test that can see a
    // WGSL error or a packing mistake into a green tick on every machine without a GPU.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Black at both ends: red exists in this picture only if the MIDDLE stop was packed,
    // decoded and reached by the shader's segment walk.
    const withMiddle = [
      { position: 0, color: BLACK },
      { position: 0.5, color: RED },
      { position: 1, color: BLACK },
    ];
    // A triangle from 0 up to 1 and back: the mean over the width is ~0.5.
    expect(await measure(withMiddle, "average")).toBeGreaterThan(0.4);
    expect(await measure(withMiddle, "maximum")).toBeGreaterThan(0.95);

    // The same ramp WITHOUT the middle stop is black end to end. This is the number the
    // case above produces if the stop never leaves the CPU — which is exactly how a
    // packing bug would ship, since a black-to-black ramp is a perfectly valid picture.
    const withoutMiddle = [
      { position: 0, color: BLACK },
      { position: 1, color: BLACK },
    ];
    expect(await measure(withoutMiddle, "maximum")).toBeLessThan(0.01);
  }, 60_000);

  it("uses stop FIVE, so the table's second vec4 group is exercised too", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Positions live four to a `vec4f`, so a group index computed wrongly would still pass
    // a three-stop test and fail here. Stop five is the first one in `p1`.
    const stops: ColorStop[] = [
      { position: 0, color: BLACK },
      { position: 0.1, color: BLACK },
      { position: 0.2, color: BLACK },
      { position: 0.3, color: BLACK },
      { position: 0.5, color: RED },
      { position: 1, color: BLACK },
    ];
    expect(await measure(stops, "maximum")).toBeGreaterThan(0.95);
  }, 60_000);
});
