import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { pointPairId } from "./points.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * T401 (B57): `pointKernel` as a PROCESSOR — the SOP-chain shape.
 *
 * The catalogue had generators and consumers and no processors: `torus1 → kernel →
 * instances1` was a graph nobody could draw. The mechanism is buffer resolution alone
 * (codegen untouched): a `role:"in"` binding whose attribute the incoming payload
 * carries binds the UPSTREAM half; writes stay on the node's own pairs, which is
 * §V197's ownership rule — you own what you write — and everything the schema does not
 * declare passes through by reference.
 *
 * Chaining is the entire point, so the gate runs a two-node AND a three-node chain
 * (§V321's lesson: a single link proves the shallowest case).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

function node(id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters } as never;
}

function chainGraph(nodes: GraphNode[], links: Array<[string, string, string, string]>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(
      links.map(([from, fromPort, to, toPort], index) => [
        `e${index}`,
        { id: `e${index}`, source: { nodeId: from, portId: fromPort }, target: { nodeId: to, portId: toPort } },
      ]),
    ),
    groups: {},
  } as never;
}

function compile(graph: GraphDocument) {
  return compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
  } as never);
}

const kernelPass = (compiled: { passes: ReadonlyArray<unknown> }, nodeId: string): DispatchPassDescriptor =>
  compiled.passes.find(
    (pass): pass is DispatchPassDescriptor => (pass as { id?: string }).id === `${nodeId}#${nodeId}:kernel`,
  ) as DispatchPassDescriptor;

const bindingOf = (pass: DispatchPassDescriptor, name: string) =>
  pass.buffers?.find((binding) => binding.binding === name);

/** torus feeds a kernel feeds the renderer: the graph the owner could not draw. */
function processorChain(kernels: number): GraphDocument {
  const capacity = 64 * 64; // the torus default: cols × rows
  const nodes: GraphNode[] = [node("gen", "pointTorus")];
  const links: Array<[string, string, string, string]> = [];
  let previous = "gen";
  for (let index = 1; index <= kernels; index += 1) {
    nodes.push(node(`k${index}`, "pointKernel", { capacity }));
    links.push([previous, "out", `k${index}`, "in"]);
    previous = `k${index}`;
  }
  nodes.push(node("draw", "renderPoints", { count: capacity }), node("out", "output"));
  links.push([previous, "out", "draw", "points"], ["draw", "out", "out", "input"]);
  return chainGraph(nodes, links);
}

describe("pointKernel as a processor (T401, B57)", () => {
  it("two-node chain: the kernel READS the generator's pair and WRITES its own (§V197)", () => {
    const compiled = compile(processorChain(1));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.ok).toBe(true);

    const pass = kernelPass(compiled, "k1");
    expect(pass).toBeDefined();
    // The upstream pair, the half holding THIS frame's data (the generator writes its
    // "write" half every frame) — not this node's own last frame.
    expect(bindingOf(pass, "in_position")).toEqual({
      binding: "in_position",
      resourceId: pointPairId("gen", "position"),
      half: "write",
    });
    // Writes are the kernel's OWN — ownership follows the write (§V197).
    expect(bindingOf(pass, "out_position")?.resourceId).toBe(pointPairId("k1", "position"));
    // An attribute the upstream does not carry starts from this node's own state.
    expect(bindingOf(pass, "in_velocity")?.resourceId).toBe(pointPairId("k1", "velocity"));

    // And the renderer downstream draws the KERNEL's positions, not the generator's.
    const draw = compiled.passes.find(
      (pass): pass is DrawPassDescriptor => (pass as { nodeId?: string }).nodeId === "draw",
    ) as DrawPassDescriptor;
    expect(draw.buffers?.[0]?.resourceId).toBe(pointPairId("k1", "position"));
  });

  it("three-node chain: each link reads its immediate upstream — chaining composes (§V321)", () => {
    const compiled = compile(processorChain(2));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    expect(bindingOf(kernelPass(compiled, "k1"), "in_position")?.resourceId).toBe(pointPairId("gen", "position"));
    expect(bindingOf(kernelPass(compiled, "k2"), "in_position")?.resourceId).toBe(pointPairId("k1", "position"));
    expect(bindingOf(kernelPass(compiled, "k2"), "out_position")?.resourceId).toBe(pointPairId("k2", "position"));
    const draw = compiled.passes.find(
      (pass): pass is DrawPassDescriptor => (pass as { nodeId?: string }).nodeId === "draw",
    ) as DrawPassDescriptor;
    expect(draw.buffers?.[0]?.resourceId).toBe(pointPairId("k2", "position"));
  });

  it("an attribute the schema does not declare passes through BY REFERENCE (§V197)", () => {
    // Upstream kernel authors a `tint`; the downstream kernel's default schema does not
    // declare it. The downstream payload must still carry tint — as the UPSTREAM's pair.
    const schema =
      '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]},{"name":"tint","type":"vec4f","default":[1,1,1,1]}]';
    const graph = chainGraph(
      [
        node("author", "pointKernel", { capacity: 4096, attributes: schema }),
        node("k", "pointKernel", { capacity: 4096 }),
        node("draw", "renderInstances", {
          count: 4096,
          color: { mode: "map", bindings: { map: { kind: "map", attribute: "tint" } } },
        }),
        node("out", "output"),
      ],
      [
        ["author", "out", "k", "in"],
        ["k", "out", "draw", "points"],
        ["draw", "out", "out", "input"],
      ],
    );
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = compiled.passes.find(
      (pass): pass is DrawPassDescriptor => (pass as { nodeId?: string }).nodeId === "draw",
    ) as DrawPassDescriptor;
    // The mapped colour binds the AUTHOR's tint pair — one buffer, zero copies.
    expect(draw.buffers?.some((binding) => binding.resourceId === pointPairId("author", "tint"))).toBe(true);
  });

  it("unconnected input compiles exactly as before — the port is optional (§V309)", () => {
    const compiled = compile(
      chainGraph(
        [node("k", "pointKernel", { capacity: 4096 }), node("draw", "renderPoints", { count: 4096 }), node("out", "output")],
        [
          ["k", "out", "draw", "points"],
          ["draw", "out", "out", "input"],
        ],
      ),
    );
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const pass = kernelPass(compiled, "k");
    for (const binding of pass.buffers ?? []) {
      expect(binding.resourceId.startsWith("scratch:k:")).toBe(true);
    }
  });

  describe("refusals name the numbers and what the pointset carries (§V288)", () => {
    it("capacity mismatch is refused with both numbers and the fix", () => {
      const graph = processorChain(1);
      (graph.nodes["k1"] as { parameters: Record<string, unknown> }).parameters["capacity"] = 1000;
      const compiled = compile(graph);
      const found = compiled.diagnostics.find((d) => d.code === "node.points.input");
      expect(found?.message).toContain("1000");
      expect(found?.message).toContain("4096");
      expect(found?.message).toContain("position: vec3f");
      expect(found?.suggestion).toContain("4096");
    });

    it("a shared attribute with a different type is refused, naming both types", () => {
      const schema = '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]},{"name":"tint","type":"vec3f","default":[0,0,0]}]';
      const downstream =
        '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]},{"name":"tint","type":"f32","default":[0]}]';
      const graph = chainGraph(
        [
          node("author", "pointKernel", { capacity: 4096, attributes: schema }),
          node("k", "pointKernel", { capacity: 4096, attributes: downstream }),
          node("draw", "renderPoints", { count: 4096 }),
          node("out", "output"),
        ],
        [
          ["author", "out", "k", "in"],
          ["k", "out", "draw", "points"],
          ["draw", "out", "out", "input"],
        ],
      );
      const compiled = compile(graph);
      const found = compiled.diagnostics.find((d) => d.code === "node.points.input");
      expect(found?.message).toContain('"tint"');
      expect(found?.message).toContain("vec3f");
      expect(found?.message).toContain("f32");
    });

    it("a counted upstream is refused by name — a fixed-capacity kernel would resurrect the dead", () => {
      const graph = chainGraph(
        [
          node("sim", "pointKernelAdvanced", { capacity: 4096 }),
          node("k", "pointKernel", { capacity: 4096 }),
          node("draw", "renderPoints", { count: 4096 }),
          node("out", "output"),
        ],
        [
          ["sim", "out", "k", "in"],
          ["k", "out", "draw", "points"],
          ["draw", "out", "out", "input"],
        ],
      );
      const compiled = compile(graph);
      const found = compiled.diagnostics.find((d) => d.code === "node.points.input");
      expect(found?.message).toContain("live count");
      expect(found?.suggestion).toContain("advanced");
    });
  });
});
