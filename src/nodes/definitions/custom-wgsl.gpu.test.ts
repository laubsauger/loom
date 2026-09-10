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
import { SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";

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

/**
 * T1286 ON A REAL DEVICE: AN IMPORT IS A PASTE, IN PIXELS.
 *
 * The string half of this claim is in `custom-wgsl.test.ts` — the expansion is byte-exactly
 * the module followed by the author's own text. That is necessary and not sufficient for
 * the row's actual promise, which is about what comes out of the GPU: a source that pulls a
 * module in has to render what the same source with the code pasted into it renders, or
 * "shared" means "similar" and every future module is a place a picture can drift.
 *
 * Byte-identical rather than close: both arms compile through Dawn, run the same pass on
 * the same input at the same seed, and the readback is compared with `Buffer.compare`. A
 * tolerance here would be a way of not noticing that the mechanism moved something.
 */
const GRID_BODY = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = gridCellAt(uv, vec2f(7.0, 5.0));
  let tint = textureSample(inputTexture, inputSampler, cell.origin + cell.size * 0.5);
  return vec4f(cell.local.x, cell.local.y, cell.index / cell.count, 1.0) * tint;
}`;

async function shadeWith(source: string): Promise<Uint8Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    const capabilities = await backend.initialize({});
    const document = graph();
    (document.nodes["fx"]!.parameters as Record<string, unknown>)["source"] = source;
    const plan = compileGraph({
      graph: document,
      settings,
      registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
      capabilities,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0.5, y: 0.5, buttons: 0 },
      resolution: [settings.outputResolution.width, settings.outputResolution.height],
    });
    const output = plan.outputs[0];
    if (output === undefined) throw new Error("no output resource");
    const readback = await backend.readOutput(output.resourceId);
    return new Uint8Array(readback.bytes);
  } finally {
    backend.dispose();
  }
}

describe("shared WGSL modules render what a paste renders (T1286)", () => {
  it("`// @use grid` is byte-identical to the module pasted in by hand", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const imported = await shadeWith(`// @use grid\n${GRID_BODY}`);
    const pasted = await shadeWith(`${SHARED_WGSL_MODULES["grid"]!.source}\n\n${GRID_BODY}`);
    expect(imported.length).toBeGreaterThan(0);
    // Not "the same mean", not "within a tolerance": the same bytes (§V147).
    expect(Buffer.compare(imported, pasted)).toBe(0);
  }, 120_000);
});
