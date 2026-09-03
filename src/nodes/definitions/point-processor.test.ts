import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { DEFAULT_POINT_ATTRIBUTES } from "./points.ts";
import { pointStorageId } from "./point-storage.ts";
import { packAttributes } from "../../points/packing.ts";
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
    /* T1076: THREE storage buffers, whatever the schema's size — the upstream's packed
       buffer at the half holding THIS frame's data (the generator writes its "write" half
       every frame), this node's own read half for the attributes upstream does not carry,
       and its own write half for the results. §V197's narrowing survives packing: it is
       one binding PER PRODUCER now, not one per attribute. */
    expect(pass.buffers?.map((binding) => `${binding.resourceId}:${binding.half}`)).toEqual([
      `${pointStorageId("gen")}:write`,
      `${pointStorageId("k1")}:read`,
      `${pointStorageId("k1")}:write`,
    ]);
    // The kernel addresses regions INSIDE those buffers, so nothing is bound at an offset.
    expect(pass.buffers?.every((binding) => binding.offset === undefined)).toBe(true);

    // And the renderer downstream draws the KERNEL's positions, not the generator's.
    const draw = compiled.passes.find(
      (pass): pass is DrawPassDescriptor => (pass as { nodeId?: string }).nodeId === "draw",
    ) as DrawPassDescriptor;
    expect(draw.buffers?.[0]?.resourceId).toBe(pointStorageId("k1"));
  });

  it("three-node chain: each link reads its immediate upstream — chaining composes (§V321)", () => {
    const compiled = compile(processorChain(2));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const bufferIds = (nodeId: string) =>
      kernelPass(compiled, nodeId).buffers?.map((binding) => `${binding.resourceId}:${binding.half}`);
    expect(bufferIds("k1")).toEqual([
      `${pointStorageId("gen")}:write`,
      `${pointStorageId("k1")}:read`,
      `${pointStorageId("k1")}:write`,
    ]);
    /* k2 reads k1's buffer, never the generator's — each link reads its immediate
       upstream. TWO bindings here, not three: k1 publishes k2's WHOLE schema, so k2 never
       reaches for its own read half at all. */
    expect(bufferIds("k2")).toEqual([
      `${pointStorageId("k1")}:write`,
      `${pointStorageId("k2")}:write`,
    ]);
    const draw = compiled.passes.find(
      (pass): pass is DrawPassDescriptor => (pass as { nodeId?: string }).nodeId === "draw",
    ) as DrawPassDescriptor;
    expect(draw.buffers?.[0]?.resourceId).toBe(pointStorageId("k2"));
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
    /* The mapped colour binds the AUTHOR's tint REGION — one buffer, zero copies. The
       OFFSET is what makes the claim: the author's schema is position then tint, so tint
       starts one 16 B × 4096 region in. Binding the author's buffer at zero would colour
       every instance by its own coordinates and look entirely plausible. */
    const authorTint = packAttributes(
      [
        { name: "position", type: "vec3f", default: [0, 0, 0] },
        { name: "tint", type: "vec4f", default: [1, 1, 1, 1] },
      ],
      4096,
    );
    if (!authorTint.ok) throw new Error(authorTint.errors.join("; "));
    expect(draw.buffers).toContainEqual({
      binding: "mapColors",
      resourceId: pointStorageId("author"),
      half: "write",
      offset: authorTint.byName.get("tint")?.offset,
      bytes: 16 * 4096,
    });
    // …while `positions` comes off the DOWNSTREAM kernel, which owns what it writes.
    expect(draw.buffers?.[0]?.resourceId).toBe(pointStorageId("k"));
    const downstream = packAttributes(DEFAULT_POINT_ATTRIBUTES, 4096);
    if (!downstream.ok) throw new Error(downstream.errors.join("; "));
    expect(draw.buffers?.[0]?.offset).toBe(downstream.byName.get("position")?.offset);
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

describe("the field input reaches the kernel's pass (T477)", () => {
  const advect = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position += fieldAt(p.position).xyz * ctx.delta;
  return q;
}`;
  const attrs = JSON.stringify([
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  ]);

  it("a wired field binds as the pass's texture; the plan compiles end to end", () => {
    const compiled = compile(
      chainGraph(
        [
          node("flow", "noise", {}),
          node("sim", "pointKernel", { capacity: 64, attributes: attrs, kernel: advect }),
          node("draw", "renderPoints", { count: 64 }),
          node("out", "output", {}),
        ],
        [
          ["flow", "out", "sim", "field"],
          ["sim", "out", "draw", "points"],
          ["draw", "out", "out", "input"],
        ],
      ),
    );
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const pass = kernelPass(compiled, "sim");
    const texture = pass.textures?.find((entry) => entry.binding === "fieldTexture");
    expect(texture).toBeDefined();
    expect(texture?.resourceId).toContain("flow");
  });

  it("the same kernel with no field wired refuses by name — never zeros (§V288)", () => {
    const compiled = compile(
      chainGraph(
        [
          node("sim", "pointKernel", { capacity: 64, attributes: attrs, kernel: advect }),
          node("draw", "renderPoints", { count: 64 }),
          node("out", "output", {}),
        ],
        [
          ["sim", "out", "draw", "points"],
          ["draw", "out", "out", "input"],
        ],
      ),
    );
    const refusal = compiled.diagnostics.find((d) => d.code === "node.points.kernel");
    expect(refusal?.message).toContain("fieldAt");
    expect(refusal?.message).toContain("field input");
  });
});

describe("the Ray POP casts against a height field (T483)", () => {
  const attrs = JSON.stringify([
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  ]);
  const rayGraph = (kernelAttrs = attrs) =>
    chainGraph(
      [
        node("terrain", "noise", {}),
        node("src", "pointKernel", { capacity: 64, attributes: kernelAttrs, kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}" }),
        node("ray", "pointRay", {}),
        node("draw", "renderPoints", { count: 64 }),
        node("out", "output", {}),
      ],
      [
        ["src", "out", "ray", "points"],
        ["terrain", "out", "ray", "field"],
        ["ray", "out", "draw", "points"],
        ["draw", "out", "out", "input"],
      ],
    );

  it("emits one march pass and publishes the four hit attributes on the edge", () => {
    const compiled = compile(rayGraph());
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const pass = compiled.passes.find(
      (entry): entry is DispatchPassDescriptor => (entry as { id?: string }).id === "ray#ray:ray",
    ) as DispatchPassDescriptor;
    expect(pass).toBeDefined();
    // The cost knob is baked: 32 steps default appears as the loop bound.
    expect(pass.shader).toContain("step <= 32u");
    expect(pass.textures?.[0]?.binding).toBe("fieldTexture");
    // No direction attribute upstream: the parameter's uniform aims every ray.
    expect(pass.shader).toContain("rayFrame.direction.xyz");
    expect(pass.buffers?.some((binding) => binding.binding === "in_direction")).toBe(false);
  });

  it("a carried vec3f direction attribute aims each ray itself", () => {
    const withDirection = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "direction", type: "vec3f", default: [0, -1, 0] },
    ]);
    const compiled = compile(rayGraph(withDirection));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const pass = compiled.passes.find(
      (entry): entry is DispatchPassDescriptor => (entry as { id?: string }).id === "ray#ray:ray",
    ) as DispatchPassDescriptor;
    expect(pass.shader).toContain("in_direction[index]");
    expect(pass.buffers?.some((binding) => binding.binding === "in_direction")).toBe(true);
  });

  it("a wrongly-typed direction attribute refuses rather than quietly using the parameter (§V288)", () => {
    const withBadDirection = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "direction", type: "f32", default: [0] },
    ]);
    const compiled = compile(rayGraph(withBadDirection));
    const refusal = compiled.diagnostics.find((d) => d.code === "node.points.input");
    expect(refusal?.message).toContain("direction");
    expect(refusal?.message).toContain("vec3f");
  });
});
