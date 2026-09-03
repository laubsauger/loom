import { describe, expect, it } from "vitest";
import { readKernelAttribute } from "../../../nodes/definitions/test-support.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T900 on a REAL device, on VALUES, and TURNED (§V147, §V812).
 *
 * §V812's whole finding is that a new control surface is not verified by rendering — it must
 * be MOVED, through the real path, by whoever announces it. §T880's reflected controls shipped
 * looking correct and refusing every write, and no gate that asked "does the knob appear?"
 * could have caught it. So this test does the thing the feature exists for:
 *
 *   1. a point kernel declares its OWN `struct Params { push: f32, lift: vec2f }`,
 *   2. Dawn compiles the generated module and runs it,
 *   3. the positions read back are the EXACT arithmetic of those parameter values (§V218 —
 *      an exact claim, not a range that would tolerate a knob wired to the wrong member),
 *   4. and then the knob is TURNED through `updateUniforms` — the §V5 path, values only, no
 *      recompile, no new pipeline — and the points move to the new exact answer.
 *
 * Step 4 is the one that matters. A reflected member bound to the wrong offset, or a uniform
 * mirror that named `push` where the module declared `p_push`, reads zero in silence: the
 * points would sit at a plausible place and stay there. Moving them proves the whole chain.
 */

const PARAM_KERNEL = `struct Params {
  push: f32,
  lift: vec2f,
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  q.position = vec3f(f32(q.id) * 0.1 + ctx.params.push, ctx.params.lift.x, ctx.params.lift.y);
  q.velocity = vec3f(0.0);
  return q;
}`;

const CAPACITY = 8;

function paramPlan() {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  return compileGraph({
    graph: {
      revision: 1,
      nodes: {
        sim: {
          id: "sim",
          type: "pointKernel",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { capacity: CAPACITY, seed: 7, kernel: PARAM_KERNEL, push: 0.25, lift: [0.5, -0.5] },
        },
        draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: CAPACITY, sizePixels: 6 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    },
    settings: {
      outputResolution: { width: 64, height: 64 },
      workingFormat: "rgba8unorm",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    },
    registry,
    capabilities: {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    },
  });
}

describe("T900 — a kernel's own struct Params on Dawn", () => {
  it("reaches the GPU by value, and TURNING the knob moves the points with no recompile", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const plan = paramPlan();
    expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((diagnostic) => {
      // A warning is a failure here too: `updateUniforms` answers an unknown pass or an
      // unknown member with a WARNING, which is exactly how a mis-named mirror would hide.
      if (diagnostic.severity !== "info") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    });
    // The flattener namespaces pass ids by component path; ask the plan rather than guess.
    const kernelPassId = plan.passes.find((pass) => pass.id.endsWith(":kernel"))?.id ?? "";
    expect(kernelPassId).not.toBe("");
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const render = (frameIndex: number): void => {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      };
      const positions = async (): Promise<Float32Array> =>
        (
          await readKernelAttribute(
            backend.readBuffer,
            { type: "pointKernel", parameters: { capacity: CAPACITY } },
            "sim",
            "position",
          )
        ).floats;

      render(0);
      render(1);
      expect(errors).toEqual([]);

      // The author's own struct, read as `ctx.params.*`, landing as exact arithmetic.
      const before = await positions();
      for (let id = 0; id < CAPACITY; id += 1) {
        expect(before[id * 4], `id ${id} x`).toBeCloseTo(id * 0.1 + 0.25, 5);
        expect(before[id * 4 + 1], `id ${id} y`).toBeCloseTo(0.5, 5);
        expect(before[id * 4 + 2], `id ${id} z`).toBeCloseTo(-0.5, 5);
      }

      // TURN IT. Values only, through the §V5 path — no compile() call, the same pipeline.
      // `p_` is the wire name the generator gives a reflected member; the node's parameter
      // key stays the author's bare `push`.
      backend.updateUniforms({ passId: kernelPassId, values: { p_push: -0.75, p_lift: [0.25, 0.125] } });
      render(2);
      render(3);
      expect(errors).toEqual([]);

      const after = await positions();
      for (let id = 0; id < CAPACITY; id += 1) {
        expect(after[id * 4], `id ${id} x after`).toBeCloseTo(id * 0.1 - 0.75, 5);
        expect(after[id * 4 + 1], `id ${id} y after`).toBeCloseTo(0.25, 5);
        expect(after[id * 4 + 2], `id ${id} z after`).toBeCloseTo(0.125, 5);
      }
      // And it really moved — an assertion that would pass on a frozen buffer is no gate.
      expect(after[0]).not.toBeCloseTo(before[0] ?? 0, 5);
    } finally {
      backend.dispose();
    }
  });
});
