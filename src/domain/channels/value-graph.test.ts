import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createValueGraphSession } from "./value-graph.ts";

/**
 * The value graph (T273-T277, §V179): `mouse1 → lag1 → parameter` as a GRAPH — ordered,
 * cycle-rejecting, stateful where declared, deterministic always.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    label: id,
    ...extra,
  };
}

function graphOf(nodes: GraphNode[], edges: Array<[string, string, string, string]>): GraphDocument {
  const edgeRecord: Record<string, unknown> = {};
  edges.forEach(([sn, sp, tn, tp], index) => {
    edgeRecord[`e${index}`] = { id: `e${index}`, source: { nodeId: sn, portId: sp }, target: { nodeId: tn, portId: tp } };
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edgeRecord,
    groups: {},
  } as unknown as GraphDocument;
}

const frameAt = (timeSeconds: number, deltaSeconds = 1 / 60): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 7,
});

describe("value graph evaluation (T273/T274)", () => {
  it("evaluates a chain in topological order, channel bags flowing through", () => {
    // mouse → math(×2) → limit(0..1): per-channel through the whole chain.
    const graph = graphOf(
      [
        node("mouse1", "mouse"),
        node("math1", "valueMath", { parameters: { operation: "multiply", operand: 2 } }),
        node("limit1", "valueLimit"),
      ],
      [
        ["mouse1", "out", "math1", "a"],
        ["math1", "out", "limit1", "in"],
      ],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0), { pointer: { x: 0.3, y: 0.9, buttons: 1 } });

    expect(result.diagnostics).toEqual([]);
    expect(result.byName.get("mouse1")).toEqual({ x: 0.3, y: 0.9, buttons: 1 });
    expect(result.byName.get("math1")).toEqual({ x: 0.6, y: 1.8, buttons: 2 });
    expect(result.byName.get("limit1")).toEqual({ x: 0.6, y: 1, buttons: 1 });

    // T274 addressing: `name:channel` reads a named channel; bare `name` needs `value`.
    expect(result.resolver("limit1:y", {} as never)).toBe(1);
    expect(result.resolver("limit1:x", {} as never)).toBe(0.6);
    expect(result.resolver("nope:x", {} as never)).toBeUndefined();
  });

  it("keeps the trio addressable as the degenerate case — an LFO is a one-channel bag", () => {
    const graph = graphOf([node("lfo1", "lfo", { parameters: { shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0 } })], []);
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0.25));
    expect(result.resolver("lfo1", {} as never)).toBeCloseTo(1, 10);
    expect(result.resolver("lfo1:value", {} as never)).toBeCloseTo(1, 10);
  });

  it("rejects a cycle with a diagnostic; the members emit nothing, nothing hangs (§V152)", () => {
    const graph = graphOf(
      [node("m1", "valueMath"), node("m2", "valueMath")],
      [
        ["m1", "out", "m2", "a"],
        ["m2", "out", "m1", "a"],
      ],
    );
    const session = createValueGraphSession(registry);
    const result = session.evaluate(graph, frameAt(0));
    expect(result.diagnostics.some((d) => d.code === "valueGraph.cycle")).toBe(true);
    expect(result.byName.get("m1")).toBeUndefined();
  });
});

describe("stateful stages (T276/T277, §V181)", () => {
  it("lag eases toward the input across frames, and reset() clears the trajectory", () => {
    const graph = graphOf(
      [node("mouse1", "mouse"), node("lag1", "valueLag", { parameters: { lag: 0.1 } })],
      [["mouse1", "out", "lag1", "in"]],
    );
    const session = createValueGraphSession(registry);
    const at = (t: number, x: number) =>
      session.evaluate(graph, frameAt(t), { pointer: { x, y: 0, buttons: 0 } }).byName.get("lag1")?.["x"] ?? NaN;

    expect(at(0, 0)).toBe(0); // first sight starts ON the input — no swoop-in
    const step1 = at(1 / 60, 1); // input jumps to 1; the lag chases
    const step2 = at(2 / 60, 1);
    expect(step1).toBeGreaterThan(0);
    expect(step1).toBeLessThan(1);
    expect(step2).toBeGreaterThan(step1); // monotone convergence

    session.reset();
    expect(at(0, 1)).toBe(1); // §V181: state cleared; first sight again
  });

  it("slope differentiates per channel; trigger pulses exactly once per crossing", () => {
    const graph = graphOf(
      [
        node("mouse1", "mouse"),
        node("slope1", "valueSlope"),
        node("trig1", "valueTrigger", { parameters: { threshold: 0.5 } }),
      ],
      [
        ["mouse1", "out", "slope1", "in"],
        ["mouse1", "out", "trig1", "in"],
      ],
    );
    const session = createValueGraphSession(registry);
    const step = (t: number, x: number) => session.evaluate(graph, frameAt(t), { pointer: { x, y: 0, buttons: 0 } });

    step(0, 0);
    const rising = step(1 / 60, 0.6);
    expect(rising.byName.get("slope1")?.["x"]).toBeCloseTo(0.6 * 60, 6);
    expect(rising.byName.get("trig1")?.["x"]).toBe(1); // the crossing frame
    const held = step(2 / 60, 0.7);
    expect(held.byName.get("trig1")?.["x"]).toBe(0); // a pulse, not a level
  });

  it("drops state for nodes that left the document — no inherited trajectories", () => {
    const withLag = graphOf(
      [node("mouse1", "mouse"), node("lag1", "valueLag", { parameters: { lag: 1 } })],
      [["mouse1", "out", "lag1", "in"]],
    );
    const session = createValueGraphSession(registry);
    session.evaluate(withLag, frameAt(0), { pointer: { x: 1, y: 0, buttons: 0 } });

    const without = graphOf([node("mouse1", "mouse")], []);
    session.evaluate(without, frameAt(1 / 60), { pointer: { x: 0, y: 0, buttons: 0 } });

    // lag1 comes back: fresh state, first sight is ON the new input, not the old 1.0.
    const returned = session.evaluate(withLag, frameAt(2 / 60), { pointer: { x: 0, y: 0, buttons: 0 } });
    expect(returned.byName.get("lag1")?.["x"]).toBe(0);
  });
});

describe("value nodes and the GPU plan (T273, §V179)", () => {
  it("a value chain compiles alongside a texture chain: no passes, no resources, no dead badges", async () => {
    const { compileGraph } = await import("../../compiler/compile.ts");
    const graph = graphOf(
      [
        node("gen", "solid"),
        node("sink", "output"),
        node("mouse1", "mouse"),
        node("lag1", "valueLag"),
      ],
      [
        ["gen", "out", "sink", "input"],
        ["mouse1", "out", "lag1", "in"],
      ],
    );
    const compiled = compileGraph({
      graph,
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba16float",
        randomSeed: 1,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Never in the GPU plan: no pass, no resource carries a value node's id...
    expect(compiled.passes.some((p) => "nodeId" in p && (p["nodeId"] === "mouse1" || p["nodeId"] === "lag1"))).toBe(false);
    // ...and never reported dead either (§V173): by-design non-residents.
    expect(compiled.pruned).toEqual([]);
  });
});
