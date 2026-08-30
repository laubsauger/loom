import { describe, expect, it } from "vitest";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { MAX_SUBSTEPS, expandLoops, readExecutionPlan } from "../runtime/backend/plan.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";

/**
 * SUBSTEPS at the plan level (T387).
 *
 * What is being defended here is the SHAPE of the region, because everything downstream
 * depends on it and every way of getting it wrong renders a picture. A region that misses
 * the swap iterates a loop that never advances. A region that swallows the Output's blit
 * presents fifty times. A region that swallows the noise feeding the loop makes an
 * animated field cost fifty passes for one visible result. None of those crash, and the
 * device cannot tell you which one you have — the plan can.
 *
 * The pixels are the other half of the claim and live in `substeps.gpu.test.ts`, where a
 * real device is asked whether N frames at S substeps equals N*S frames at one.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const KERNEL_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv) + vec4f(0.01, 0.0, 0.0, 1.0);
}`;

/** E2's shape: state -> kernel -> state, with an Output watching the kernel. */
function loopGraph(substeps: number, extra: Partial<GraphDocument> = {}): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      state: {
        id: "state",
        type: "feedback",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        resolution: { mode: "fixed", width: 64, height: 64 },
        format: { mode: "fixed", format: "rgba16float" },
        parameters: { source: "kernel1", persistence: 1, substeps },
      },
      kernel: {
        id: "kernel",
        type: "customWgsl",
        label: "kernel1",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: { source: KERNEL_WGSL },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      "e-state-kernel": {
        id: "e-state-kernel",
        source: { nodeId: "state", portId: "out" },
        target: { nodeId: "kernel", portId: "input" },
      },
      "e-kernel-out": {
        id: "e-kernel-out",
        source: { nodeId: "kernel", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
    ...extra,
  } as GraphDocument;
}

function compile(graph: GraphDocument) {
  return compileGraph({
    graph,
    settings,
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

function kinds(passes: ReadonlyArray<PassDescriptor>): string[] {
  return passes.map((pass) => (pass.kind === "loop" ? `loop:${pass.edge}` : `${pass.kind}:${pass.id}`));
}

describe("substeps (T387)", () => {
  it("emits no loop markers at all when every feedback runs one step per frame", () => {
    const plan = compile(loopGraph(1));
    expect(plan.ok, plan.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    expect(plan.passes.filter((pass) => pass.kind === "loop")).toEqual([]);
    // The unchanged plan is the SAME ARRAY: a graph that asks for nothing pays nothing,
    // including the repartition.
    expect(expandLoops(plan.passes)).toBe(plan.passes);
  });

  it("wraps exactly the kernel, the feedback write and the swap — and nothing else", () => {
    const plan = compile(loopGraph(12));
    expect(plan.ok, plan.diagnostics.map((d) => d.message).join("; ")).toBe(true);

    expect(kinds(plan.passes)).toEqual([
      "loop:begin",
      "effect:kernel#kernel:custom",
      "effect:state#state:feedback",
      "swap:swap:pingpong:state:out",
      "loop:end",
      // The Output's blit is OUTSIDE, and after: it presents the twelfth substep, not the
      // first, and it presents it once.
      "effect:out#out:present",
    ]);

    const begin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
    expect(begin).toMatchObject({ kind: "loop", edge: "begin", count: 12, loopId: "pingpong:state:out", nodeId: "state" });
  });

  it("expands the region into count iterations of the same pass objects", () => {
    const plan = compile(loopGraph(12));
    const expanded = expandLoops(plan.passes);

    // 3 passes in the body, twelve times, plus the Output's single blit.
    expect(expanded).toHaveLength(3 * 12 + 1);
    expect(expanded.filter((pass) => pass.kind === "swap")).toHaveLength(12);
    expect(expanded.filter((pass) => pass.kind === "loop")).toEqual([]);

    // IDENTITY, not equality: an iteration re-encodes the pass that already exists, which
    // is what makes fifty substeps allocate nothing.
    const kernel = plan.passes.find((pass) => pass.id === "kernel#kernel:custom");
    expect(expanded.filter((pass) => pass === kernel)).toHaveLength(12);
  });

  it("keeps the substep count in the plan signature — it is structure, not a uniform value", () => {
    const four = compile(loopGraph(4));
    const forty = compile(loopGraph(40));
    expect(four.signature).not.toEqual(forty.signature);

    // …and the PAIR is untouched, so raising Substeps does not wipe the state being
    // watched (T143, §V22).
    const pairOf = (plan: ReturnType<typeof compile>) =>
      plan.resourceSignatures.find((entry) => entry.id === "pingpong:state:out")?.signature;
    expect(pairOf(four)).toEqual(pairOf(forty));
  });

  it("refuses a count past the ceiling by NAME, and runs one step rather than the number asked for", () => {
    // The ceiling lives in the manifest (`max: MAX_SUBSTEPS`), so it is enforced where the
    // user meets it. Asserted here because the plan reader ALSO refuses a count above it:
    // if the two ever disagreed the whole plan would go black over one bad parameter.
    const plan = compile(loopGraph(MAX_SUBSTEPS + 40));
    const range = plan.diagnostics.find((d) => d.code === "parameter.range");
    expect(range?.message).toContain(`above its maximum ${MAX_SUBSTEPS}`);
    expect(range?.nodeId).toBe("state");
    expect(plan.passes.filter((pass) => pass.kind === "loop")).toEqual([]);

    // At the ceiling exactly, it runs.
    const atMax = compile(loopGraph(MAX_SUBSTEPS));
    expect(atMax.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin")).toMatchObject({
      count: MAX_SUBSTEPS,
    });
    expect(readExecutionPlan({ passes: atMax.passes, resources: atMax.resources, diagnostics: [] }).ok).toBe(true);
  });

  it("refuses — by name — when there is no loop to iterate (§V288)", () => {
    // A Feedback recording a generator that never reads it back: legal, useful (a one-frame
    // delay), and iterating it would cost twelve times as much and change nothing.
    const graph: GraphDocument = {
      revision: 1,
      groups: {},
      nodes: {
        gen: { id: "gen", type: "solid", label: "solid1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        state: {
          id: "state",
          type: "feedback",
          definitionVersion: 1,
          position: { x: 200, y: 0 },
          parameters: { source: "solid1", substeps: 12 },
        },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
      },
      edges: {
        "e-state-out": {
          id: "e-state-out",
          source: { nodeId: "state", portId: "out" },
          target: { nodeId: "out", portId: "input" },
        },
      },
    } as GraphDocument;

    const plan = compile(graph);
    expect(plan.passes.filter((pass) => pass.kind === "loop")).toEqual([]);
    const refusal = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.substepsRefused);
    expect(refusal?.message).toContain("nothing reads its output back into it");
    expect(refusal?.nodeId).toBe("state");
    expect(refusal?.suggestion).toContain("substeps");
  });

  it("refuses a malformed region at the plan reader rather than running the body once", () => {
    const body: PassDescriptor[] = [
      { kind: "loop", id: "a:begin", edge: "begin", loopId: "a", count: 4 },
      { kind: "swap", id: "s", resourceId: "pair" },
    ];
    const unclosed = readExecutionPlan({
      passes: body,
      resources: [{ kind: "pingPong", id: "pair", size: [4, 4], format: "rgba8unorm" }],
      diagnostics: [],
    });
    expect(unclosed.ok).toBe(false);
    expect(unclosed.diagnostics.map((d) => d.message).join(" ")).toContain("never closed");

    const nested = readExecutionPlan({
      passes: [
        { kind: "loop", id: "a:begin", edge: "begin", loopId: "a", count: 4 },
        { kind: "loop", id: "b:begin", edge: "begin", loopId: "b", count: 4 },
        { kind: "loop", id: "b:end", edge: "end", loopId: "b" },
        { kind: "loop", id: "a:end", edge: "end", loopId: "a" },
      ],
      resources: [],
      diagnostics: [],
    });
    expect(nested.ok).toBe(false);
    expect(nested.diagnostics.map((d) => d.message).join(" ")).toContain("do not nest");
  });
});
