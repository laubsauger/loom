import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import type { BackendCapabilities, FrameInputs } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "./index.ts";
import { feedbackNode } from "./feedback.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

/**
 * The Feedback node (T152): the one node that legalises a cycle (§V4) and reaches the
 * temporal machinery the compiler and backend have carried since wave 2 (§V22).
 *
 * The last block is the test that matters: a real feedback GRAPH, compiled by the real
 * compiler, rendered by the real backend across frames — and its history surviving an
 * unrelated structural edit, which is the behavioural end of T143's carry-over.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 640, height: 360 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
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
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();
const compile = (graph: GraphDocument) => compileGraph({ graph, settings, registry, capabilities });

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
 * The classic trails patch: the composite's own output, delayed one frame, is its back
 * layer. `noise → over.in1`, `over.out → feedback.in`, `feedback.out → over.in2`,
 * `over.out → output`. A cycle — legal only because feedback's output is temporal.
 */
function feedbackLoopGraph(extraNode = false): GraphDocument {
  const nodes: Record<string, GraphNode> = {
    noise: node("noise", "noise"),
    over: node("over", "over"),
    fb: node("fb", "feedback", { persistence: 0.9 }),
    out: node("out", "output"),
  };
  const edges: Record<string, ReturnType<typeof edge>> = {
    e1: edge("e1", ["noise", "out"], ["over", "in1"]),
    e2: edge("e2", ["over", "out"], ["fb", "in"]),
    e3: edge("e3", ["fb", "out"], ["over", "in2"]),
    e4: edge("e4", ["over", "out"], ["out", "input"]),
  };
  if (extraNode) {
    // Reachable, or the compiler prunes it and the plan would not change at all (§V25).
    nodes["unrelated"] = node("unrelated", "solid");
    nodes["out2"] = node("out2", "output");
    edges["e5"] = edge("e5", ["unrelated", "out"], ["out2", "input"]);
  }
  return { revision: 1, nodes, edges, groups: {} };
}

function frameInputs(frameIndex: number): FrameInputs {
  return {
    frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [640, 360],
  };
}

describe("feedback node — manifest and emitted pass", () => {
  it("declares its output temporal with the full resetOn set (§V4, §V22)", () => {
    expect(feedbackNode.temporal?.outputs).toEqual(["out"]);
    expect(feedbackNode.temporal?.resetOn).toEqual([
      "resolution",
      "format",
      "shader-interface",
      "device",
      "load",
    ]);
    expect(feedbackNode.stateful).toEqual({
      reset: true,
      deterministicReplay: true,
      checkpoint: false,
      randomAccess: false,
    });
  });

  it("emits one write pass the backend's reader accepts", () => {
    const result = feedbackNode.compile(
      compileContext({ inputs: ["in"], parameters: { persistence: 0.5, clearColor: [0, 0, 0, 1] } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toHaveLength(1);
    const read = readNodePlan(result.passes, { inputs: ["in"] });
    expect(read.ok).toBe(true);
    const pass = read.passes[0];
    expect(pass?.kind).toBe("effect");
    if (pass?.kind === "effect") {
      expect(pass.uniforms).toEqual({ clearColor: [0, 0, 0, 1], persistence: 0.5 });
    }
  });

  it("reports missing wiring instead of emitting an unusable pass", () => {
    const result = feedbackNode.compile(compileContext({ inputs: [] }));
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });
});

describe("feedback node — the real compiler accepts the loop (§V4, T25, T33)", () => {
  it("compiles a cyclic graph into a plan with a ping-pong pair and a late swap", () => {
    const plan = compile(feedbackLoopGraph());
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    const pingPongs = plan.resources.filter((resource) => resource.kind === "pingPong");
    expect(pingPongs).toHaveLength(1);
    expect(plan.feedback).toHaveLength(1);

    // §V22: the swap comes after every current-frame consumer.
    const swapIndex = plan.passes.findIndex((pass) => pass.kind === "swap");
    const lastEffectIndex = plan.passes.map((pass) => pass.kind).lastIndexOf("effect");
    expect(swapIndex).toBeGreaterThan(lastEffectIndex);
  });

  it("rejects the same loop without the Feedback node (control case)", () => {
    const graph = feedbackLoopGraph();
    // Replace feedback with a Blur: same wiring, no temporal declaration -> illegal cycle.
    graph.nodes["fb"] = node("fb", "blur");
    graph.edges["e2"] = edge("e2", ["over", "out"], ["fb", "input"]);
    graph.edges["e3"] = edge("e3", ["fb", "out"], ["over", "in2"]);
    const plan = compile(graph);
    expect(plan.ok).toBe(false);
    expect(plan.diagnostics.some((d) => d.code === "compiler/cycle")).toBe(true);
  });
});

describe("feedback node — history behaves across frames and edits (T143, §V22)", () => {
  it("advances across frames, and its contents survive an unrelated structural edit", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(d.message);
    });
    await backend.initialize({});

    const first = compile(feedbackLoopGraph());
    expect(first.ok).toBe(true);
    const compiled = await backend.compile(first);
    backend.render(compiled, frameInputs(0));
    backend.render(compiled, frameInputs(1));
    backend.render(compiled, frameInputs(2));

    const resets = backend.status.temporalResets;

    // The unrelated edit: one more solid node, nowhere near the loop.
    const second = compile(feedbackLoopGraph(true));
    expect(second.ok).toBe(true);
    const recompiled = await backend.compile(second);

    // The pair was carried, not recreated: history survived the edit.
    expect(backend.status.lastBuild?.resourcesReused).toBeGreaterThan(0);
    expect(backend.status.temporalResets).toBe(resets);

    backend.render(recompiled, frameInputs(3));
    expect(errors).toEqual([]);
    expect(backend.status.framesSubmitted).toBe(4);
    backend.dispose();
  });
});
