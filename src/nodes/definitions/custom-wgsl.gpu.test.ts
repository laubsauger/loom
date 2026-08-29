import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { customWgslNode } from "./custom-wgsl.ts";
import { outputNode } from "./output.ts";
import { solidNode } from "./solid.ts";

/**
 * B7 / T166 on a real device.
 *
 * Every other test for this node checks the PLAN — that the pass carries `uniformBinding`
 * and `sharedBinding`. That is necessary and not sufficient: the runtime resolves both by
 * NAME against the shader's own reflection and refuses a value whose name the source never
 * declared. So a default source and a compile() that agree with each other but disagree
 * with the runtime would pass every plan-level assertion and then fail at the one moment
 * that matters — the first time anyone drops a Custom WGSL node into a graph.
 *
 * Building the plan on Dawn is what closes that gap: `backend.compile` reflects the source,
 * builds the bind group and compiles the pipeline, so a wrong name, a malformed struct or a
 * binding declared in the shader but never bound all surface here as a diagnostic.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
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

/** Solid -> CustomWGSL (default source) -> Output. */
function graph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      source: { id: "source", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "source", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("the default custom kernel builds on a real device (B7/T166)", () => {
  it("binds inputTexture, inputSampler, params and the shared frame block", async () => {
    // Dawn is required, not optional: skipping here would turn the one test that can see
    // this failure mode into a green tick on every machine that lacks a GPU.
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const plan = compileGraph({
        graph: graph(),
        settings,
        registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
        capabilities,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      // The claim under test. A name the shader does not declare, or a declared block the
      // pass forgets to bind, fails inside here.
      await backend.compile(plan);
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
