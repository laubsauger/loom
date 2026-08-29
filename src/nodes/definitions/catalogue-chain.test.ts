import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions, coreNodeDefinitions } from "./index.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";

/**
 * The catalogue against the REAL compiler (T70, T40).
 *
 * `src/tests/integration/compile-real-nodes.test.ts` exists because two tracks were each
 * green against their own fixtures and still disagreed about the compile context — a
 * fixture is an assumption written twice, and only a test that uses both sides for real
 * catches that. This is the same test for the catalogue: every node here is compiled by
 * the actual compiler, into a plan the actual backend reader accepts, in graphs that a
 * user would plausibly build.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
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
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
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

function errorsOf(diagnostics: ReadonlyArray<{ severity: string; message: string }>): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

describe("the catalogue compiles through the real compiler", () => {
  it("registers the whole catalogue in one registry with no type collisions", () => {
    const types = createNodeRegistry(allNodeDefinitions)
      .list()
      .map((definition) => definition.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain("noise");
    expect(types).toContain("over");
  });

  /**
   * The chain the brief names: Noise -> Level -> Over -> Output, with a Ramp underneath.
   * If this compiles and orders correctly, the catalogue is wired into the real pipeline.
   */
  it("compiles Noise -> Level -> Over -> Output and orders it correctly", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        noise: node("noise", "noise", { type: "simplex2d", period: 0.2 }),
        level: node("level", "level", { contrast: 1.4 }),
        ramp: node("ramp", "ramp", { type: "radial" }),
        over: node("over", "over", { opacity: 0.8 }),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["noise", "out"], ["level", "input"]),
        e2: edge("e2", ["level", "out"], ["over", "in1"]),
        e3: edge("e3", ["ramp", "out"], ["over", "in2"]),
        e4: edge("e4", ["over", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const plan = compile(graph);
    expect(errorsOf(plan.diagnostics)).toEqual([]);
    expect(plan.ok).toBe(true);

    const read = readExecutionPlan(plan);
    expect(errorsOf(read.diagnostics)).toEqual([]);
    expect(read.ok).toBe(true);

    const { order } = plan;
    expect(order.indexOf("noise")).toBeLessThan(order.indexOf("level"));
    expect(order.indexOf("level")).toBeLessThan(order.indexOf("over"));
    expect(order.indexOf("ramp")).toBeLessThan(order.indexOf("over"));
    expect(order.indexOf("over")).toBeLessThan(order.indexOf("out"));
    expect(plan.pruned).not.toContain("out");

    // One pass per node in the chain, plus the Output node's present pass.
    expect(read.passes.map((pass) => pass.id)).toEqual([
      "noise#noise:noise",
      "level#level:level",
      "ramp#ramp:ramp",
      "over#over:over",
      "out#out:present",
    ]);
  });

  /**
   * The other half of the brief's PoC chain (T49): a Displace driven by noise, whose
   * displacement input is DATA, and a Lookup whose two inputs mean different things.
   * Both are two-input filters, which is where an input-port name typo shows up.
   */
  it("compiles a Displace + Lookup chain with two-input nodes wired correctly", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        checker: node("checker", "checker"),
        noise: node("noise", "noise", { type: "perlin4d", speed: 0.5 }),
        displace: node("displace", "displace", { weight: [0.05, 0.05] }),
        ramp: node("ramp", "ramp"),
        lookup: node("lookup", "lookup", { channel: "luminance" }),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["checker", "out"], ["displace", "source"]),
        e2: edge("e2", ["noise", "out"], ["displace", "disp"]),
        e3: edge("e3", ["displace", "out"], ["lookup", "source"]),
        e4: edge("e4", ["ramp", "out"], ["lookup", "lookup"]),
        e5: edge("e5", ["lookup", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const plan = compile(graph);
    expect(errorsOf(plan.diagnostics)).toEqual([]);
    expect(readExecutionPlan(plan).ok).toBe(true);
    expect(plan.order.indexOf("displace")).toBeLessThan(plan.order.indexOf("lookup"));
  });

  /**
   * Every node, compiled for real, with its inputs fed and its output observed.
   *
   * This is the sweep that catches the boring fatal mistakes a per-node fixture cannot: a
   * port id in the manifest that `compile()` does not read, a policy naming an input that
   * does not exist, a pass the backend rejects. Adding a node to the catalogue adds it here
   * automatically.
   */
  it("compiles every catalogue node in a minimal graph with no diagnostics", () => {
    for (const definition of coreNodeDefinitions) {
      const graph = minimalGraphFor(definition);
      const plan = compile(graph);
      // Not just errors: a warning here means an unknown parameter, a version mismatch or
      // a colour-space clash, all of which are real mistakes in a manifest.
      expect(plan.diagnostics.map((d) => d.message), definition.type).toEqual([]);
      expect(plan.ok, definition.type).toBe(true);

      const read = readExecutionPlan(plan);
      expect(errorsOf(read.diagnostics), definition.type).toEqual([]);
      expect(read.ok, definition.type).toBe(true);

      // The node under test must actually contribute a pass — a node that compiles to
      // nothing "passes" every structural check while rendering nothing at all. Any
      // kind counts: point nodes contribute dispatch/draw passes (T121/T122).
      expect(
        read.passes.some(
          (pass) => pass.kind !== "swap" && "nodeId" in pass && pass.nodeId === "subject",
        ),
        definition.type,
      ).toBe(true);
      expect(plan.pruned, definition.type).not.toContain("subject");
    }
  });

  /**
   * Every uniform a node sets must exist in its shader's uniform struct, and vice versa.
   *
   * This is the failure mode nothing else in the suite can see: `uniforms` is a plain
   * record and the shader is a string, so a renamed field (or a WGSL member the node
   * forgets to fill) type-checks, compiles, emits a valid plan — and renders with a zero
   * where the value should be. vgpu writes uniform values BY NAME into the reflected
   * layout, so a name that does not match is silently dropped, not reported.
   */
  it("sets exactly the uniforms its shader declares", () => {
    for (const definition of coreNodeDefinitions) {
      const plan = compile(minimalGraphFor(definition));
      const passes = plan.passes.filter(
        (pass) =>
          (pass.kind === "effect" || pass.kind === "dispatch" || pass.kind === "draw") &&
          pass.nodeId === "subject",
      );
      expect(passes.length, definition.type).toBeGreaterThan(0);

      for (const pass of passes) {
        if (pass.kind === "swap" || pass.kind === "counter" || pass.uniforms === undefined) continue;
        const binding = pass.uniformBinding;
        expect(binding, definition.type).toBeTypeOf("string");
        const declared = uniformStructMembers(pass.shader, binding as string);
        expect(declared.length, `${definition.type}: no uniform struct found`).toBeGreaterThan(0);
        expect(Object.keys(pass.uniforms).sort(), definition.type).toEqual(declared.sort());

        // A shared-block binding must name a real declaration too, or the runtime binds a
        // value the shader never reads and vgpu rejects the whole pass.
        if (pass.kind !== "dispatch" && pass.sharedBinding !== undefined) {
          expect(pass.shader, definition.type).toContain(`var<uniform> ${pass.sharedBinding}:`);
        }
      }
    }
  });

  /** §V21: a filter's resolved size is its input's, all the way down a chain. */
  it("propagates resolution and format through a filter chain", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        src: node("src", "checker"),
        blur: node("blur", "blur", { size: 12 }),
        hsv: node("hsv", "hsv"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["src", "out"], ["blur", "input"]),
        e2: edge("e2", ["blur", "out"], ["hsv", "input"]),
        e3: edge("e3", ["hsv", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const plan = compile(graph);
    expect(errorsOf(plan.diagnostics)).toEqual([]);
    for (const output of plan.outputs) {
      expect(output.size, output.nodeId).toEqual([1280, 720]);
    }

    // The blur's texel size must match the resolution it actually resolved to (§V21) —
    // a stale or defaulted size here would blur by the wrong amount at every resolution
    // but the fixture's.
    const blurPass = plan.passes.find((pass) => pass.kind === "effect" && pass.nodeId === "blur");
    expect(blurPass?.kind === "effect" ? blurPass.uniforms?.["texel"] : undefined).toEqual([
      1 / 1280,
      1 / 720,
    ]);
  });

  /** §V6: one output feeding two consumers is rendered once. */
  it("renders a fan-out generator only once", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        noise: node("noise", "noise"),
        a: node("a", "level"),
        b: node("b", "hsv"),
        add: node("add", "add"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["noise", "out"], ["a", "input"]),
        e2: edge("e2", ["noise", "out"], ["b", "input"]),
        e3: edge("e3", ["a", "out"], ["add", "in1"]),
        e4: edge("e4", ["b", "out"], ["add", "in2"]),
        e5: edge("e5", ["add", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const plan = compile(graph);
    expect(errorsOf(plan.diagnostics)).toEqual([]);
    expect(plan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === "noise")).toHaveLength(1);
  });
});

/**
 * Member names of the WGSL struct a pass's uniform binding points at.
 *
 * Follows the `var<uniform> <binding>: <Struct>;` declaration to the struct rather than
 * assuming it is called `Params`, so a node that names its block differently is still
 * checked instead of silently skipped.
 */
function uniformStructMembers(shader: string, binding: string): string[] {
  const declaration = new RegExp(`var<uniform>\\s+${binding}\\s*:\\s*(\\w+)\\s*;`).exec(shader);
  const structName = declaration?.[1];
  if (structName === undefined) return [];
  const body = new RegExp(`struct\\s+${structName}\\s*\\{([^}]*)\\}`).exec(shader)?.[1];
  if (body === undefined) return [];
  return body
    .split(",")
    .map((entry) => entry.split(":")[0]?.trim() ?? "")
    .filter((name) => name.length > 0 && !name.startsWith("//"));
}

/**
 * One graph per node: a Checker per input port, the node under test, and an Output.
 *
 * Checker is the feed because it is a generator with no inputs of its own, so the graph
 * cannot recurse, and its output type matches every input port in the catalogue.
 */
function minimalGraphFor(definition: NodeDefinition): GraphDocument {
  const nodes: Record<string, GraphNode> = {
    subject: node("subject", definition.type),
    sink: node("sink", "output"),
  };
  const edges: Record<string, ReturnType<typeof edge>> = {};

  definition.inputs.forEach((port, index) => {
    const feedId = `feed${index}`;
    // Feeders match the port FAMILY: textures come from a checker, pointsets from a
    // point kernel (T121) — wiring a texture into a pointset port is exactly the §V13
    // mismatch this sweep would otherwise report as a false failure.
    nodes[feedId] = node(feedId, port.type.kind === "pointset" ? "pointKernel" : "checker");
    edges[`in${index}`] = edge(`in${index}`, [feedId, "out"], ["subject", port.id]);
  });

  const firstOutput = definition.outputs[0];
  if (firstOutput !== undefined) {
    if (firstOutput.type.kind === "pointset") {
      // A pointset is observed by drawing it: subject -> renderPoints -> output.
      nodes["observe"] = node("observe", "renderPoints");
      edges["observe-in"] = edge("observe-in", ["subject", firstOutput.id], ["observe", "points"]);
      edges["sink"] = edge("sink", ["observe", "out"], ["sink", "input"]);
    } else {
      edges["sink"] = edge("sink", ["subject", firstOutput.id], ["sink", "input"]);
    }
  }

  return { revision: 1, nodes, edges, groups: {} };
}
