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

/**
 * Nodes are stamped with the registry's CURRENT version. A hardcoded `1` made every
 * node that ever bumps its version fail this suite with a stale-version warning that has
 * nothing to do with what the suite is about (§V10's check is `node-migrations`' job).
 */
function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  const definitionVersion = registry.get(type)?.version ?? 1;
  return { id, type, definitionVersion, position: { x: 0, y: 0 }, parameters };
}

function edge(id: string, from: [string, string], to: [string, string], order?: number) {
  return {
    id,
    source: { nodeId: from[0], portId: from[1] },
    target: { nodeId: to[0], portId: to[1] },
    ...(order === undefined ? {} : { order }),
  };
}

function errorsOf(diagnostics: ReadonlyArray<{ severity: string; message: string }>): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

/**
 * Nodes whose entire compiled output is an EDGE PAYLOAD — no passes. pointTopology's
 * claim rewrite (T302), and the scene THINGS (T447): a camera, a light or a geometry
 * publishes resolved CPU values the Render consumes; the render pass is the Render's.
 */
const PAYLOAD_ONLY: ReadonlySet<string> = new Set(["pointTopology", "camera", "light", "projector", "geometry", "materialUnlit", "materialPhong", "materialPbr"]);

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
      "over#over:over:1",
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
      // A value source (§V143) has no ports and no passes: its output is a NUMBER read
      // through the channel seam, so a texture-graph sweep has nothing to compile.
      // values.test.ts covers it where it actually runs — the parameter resolver.
      if (definition.valueChannel !== undefined || definition.valueEvaluate !== undefined) continue;
      const graph = minimalGraphFor(definition);
      const plan = compile(graph);
      // Not just errors: a warning here means an unknown parameter, a version mismatch or
      // a colour-space clash, all of which are real mistakes in a manifest.
      expect(plan.diagnostics.map((d) => d.message), definition.type).toEqual([]);
      expect(plan.ok, definition.type).toBe(true);

      const read = readExecutionPlan(plan);
      expect(errorsOf(read.diagnostics), definition.type).toEqual([]);
      expect(read.ok, definition.type).toBe(true);

      // A passthrough definition (§V130) is a WIRE: it must contribute NO pass, and its
      // output must alias its producer's resource. Everything else must contribute one —
      // a node that compiles to nothing "passes" every structural check while rendering
      // nothing at all. Any kind counts: point nodes contribute dispatch/draw passes.
      // T302: an EDGE-PAYLOAD transform contributes no pass BY DESIGN — its whole
      // output is the pointset claim on the edge, which this plan-level sweep cannot
      // observe. It must still survive pruning; the payload itself (pairs aliased,
      // topology rewritten, capacity checked) is pinned in point-topology.test.ts.
      if (PAYLOAD_ONLY.has(definition.type)) {
        expect(
          read.passes.some((pass) => "nodeId" in pass && pass.nodeId === "subject"),
          definition.type,
        ).toBe(false);
        expect(plan.pruned, definition.type).not.toContain("subject");
        continue;
      }
      if (definition.passthrough !== undefined) {
        expect(
          read.passes.some((pass) => "nodeId" in pass && pass.nodeId === "subject"),
          definition.type,
        ).toBe(false);
        const alias = plan.outputs.find((output) => output.nodeId === "subject");
        const producer = plan.outputs.find((output) => output.nodeId === "feed0");
        expect(alias?.resourceId, definition.type).toBe(producer?.resourceId);
        continue;
      }
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
      if (definition.passthrough !== undefined) continue; // a wire has no uniforms to check (§V130)
      if (definition.valueChannel !== undefined || definition.valueEvaluate !== undefined) continue; // a value source has no passes (§V143)
      if (PAYLOAD_ONLY.has(definition.type)) continue; // an edge-payload transform has no passes (T302)
      const plan = compile(minimalGraphFor(definition));
      const passes = plan.passes.filter(
        (pass) =>
          (pass.kind === "effect" || pass.kind === "dispatch" || pass.kind === "draw") &&
          pass.nodeId === "subject",
      );
      expect(passes.length, definition.type).toBeGreaterThan(0);

      for (const pass of passes) {
        if (pass.kind === "swap" || pass.kind === "counter" || pass.kind === "loop") continue;
        if (pass.uniforms === undefined) continue;
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

  /**
   * T226/§V131 end to end: a Composite folds its layers in the order the DOCUMENT declares.
   *
   * The three edges here are numbered so that their declared order (b, c, a) disagrees with
   * their id order (a, b, c) — which is what the compiler used to sort by. If anything in
   * the chain falls back to ids, the bindings come out in the wrong sequence and an Over
   * renders the wrong layer on top. Nothing in a unit fixture can catch that: it needs the
   * real compiler, because the sort lives there.
   */
  it("folds a variadic composite in the document's declared order, not edge-id order", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        a: node("a", "checker"),
        b: node("b", "noise"),
        c: node("c", "ramp"),
        front: node("front", "circle"),
        over: node("over", "over"),
        out: node("out", "output"),
      },
      edges: {
        e0: edge("e0", ["front", "out"], ["over", "in1"]),
        // ids sort a, b, c — the declared order is deliberately the other way round.
        ea: edge("ea", ["a", "out"], ["over", "in2"], 2),
        eb: edge("eb", ["b", "out"], ["over", "in2"], 0),
        ec: edge("ec", ["c", "out"], ["over", "in2"], 1),
        e4: edge("e4", ["over", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const plan = compile(graph);
    expect(errorsOf(plan.diagnostics)).toEqual([]);
    const pass = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === "over");
    const textures = pass?.kind === "effect" ? pass.textures : undefined;
    const resourceOf = (nodeId: string) =>
      plan.outputs.find((output) => output.nodeId === nodeId)?.resourceId;

    expect(textures?.map((texture) => texture.binding)).toEqual([
      "frontTexture",
      "backTexture0",
      "backTexture1",
      "backTexture2",
    ]);
    expect(textures?.map((texture) => texture.resourceId)).toEqual([
      resourceOf("front"),
      resourceOf("b"),
      resourceOf("c"),
      resourceOf("a"),
    ]);
  });

  /**
   * T237/§V22: the ring rotates AFTER everything that reads it, this frame.
   *
   * The same hazard a ping-pong swap has, and the geometry track's answer to it (T297):
   * find the consumers by WHO BINDS THE ID, never by graph reachability. Rotate one pass
   * too early and every tap points one slice off — for one frame, then it corrects itself,
   * which is precisely the kind of wrongness that survives a casual look. Only the real
   * compiler places the pass, so only a real compile can check it.
   */
  it("rotates a cache's ring after the last pass that touches it", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        src: node("src", "checker"),
        cache: node("cache", "cache", { frames: 4, index: 2, scale: 1 }),
        // A SECOND reader downstream of the cache, so "after the writer" is not enough on
        // its own — the rotation has to come after this one too.
        grade: node("grade", "level", { brightness: 2 }),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["src", "out"], ["cache", "input"]),
        e2: edge("e2", ["cache", "out"], ["grade", "input"]),
        e3: edge("e3", ["grade", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const plan = compile(graph);
    expect(errorsOf(plan.diagnostics)).toEqual([]);

    const ringId = plan.resources.find((resource) => resource.kind === "ring")?.id;
    expect(ringId).toBeDefined();

    const ids = plan.passes.map((pass) => pass.id);
    const rotateAt = plan.passes.findIndex(
      (pass) => pass.kind === "swap" && pass.resourceId === ringId,
    );
    expect(rotateAt, `no rotation for the ring in ${ids.join(", ")}`).toBeGreaterThan(-1);

    // Every pass that names the ring — as a render target or as a texture binding — runs
    // before the rotation.
    plan.passes.forEach((pass, index) => {
      if (pass.kind === "swap") return;
      const target = "target" in pass ? pass.target : undefined;
      const bound = ("textures" in pass ? (pass.textures ?? []) : []).some(
        (texture) => texture.resourceId === ringId,
      );
      if (target === ringId || bound) {
        expect(index, `${pass.id} touches the ring after it rotates`).toBeLessThan(rotateAt);
      }
    });
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
  // Comments come out FIRST: a `// 0 none, 1 circle` line inside the struct carries commas,
  // and splitting before stripping turns each fragment into a member name that does not
  // exist. The failure looked like a node setting eleven imaginary uniforms.
  return body
    .replace(/\/\/[^\n]*/g, "")
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
    subject: { ...node("subject", definition.type), label: "subject1" },
  };
  // A node WITH outputs is observed through an Output sink; an output-less node
  // (Analyze, §V144) declares `sink: true` and observes itself.
  if (definition.outputs.length > 0) nodes["sink"] = node("sink", "output");
  const edges: Record<string, ReturnType<typeof edge>> = {};

  // T447: reference-fed inputs are CONNECT-REFUSED by design — the harness must not
  // wire what the editor forbids. Their feeders arrive by NAME through the parameter.
  const referenceInputs = new Set((definition.sourceReferences ?? []).map((spec) => spec.input));

  definition.inputs.forEach((port, index) => {
    if (referenceInputs.has(port.id)) return;
    const feedId = `feed${index}`;
    // Feeders match the port FAMILY: textures come from a checker, pointsets from a
    // point GRID (T298) — wiring a texture into a pointset port is exactly the §V13
    // mismatch this sweep would otherwise report as a false failure. The grid rather
    // than a kernel because it publishes analytic topology on the edge (T296), which
    // renderSurface (T301) REQUIRES and every other pointset consumer ignores.
    nodes[feedId] = node(feedId, port.type.kind === "pointset" ? "pointGrid" : "checker");
    edges[`in${index}`] = edge(`in${index}`, [feedId, "out"], ["subject", port.id]);
  });

  // T447: reference parameters name kind-matched feeders — a camera for a camera slot,
  // a light for lights, a grid-backed geometry for scenes.
  for (const spec of definition.sourceReferences ?? []) {
    const port = definition.inputs.find((candidate) => candidate.id === spec.input);
    if (port === undefined) continue;
    if (port.type.kind === "texture2d") {
      // Feedback's source: a texture node, named (T350).
      nodes["refsrc"] = { ...node("refsrc", "checker"), label: "refsrc1" };
      nodes.subject = { ...nodes.subject, parameters: { ...nodes.subject?.parameters, [spec.parameter]: "refsrc1" } } as GraphNode;
    } else if (port.type.kind === "camera") {
      nodes["refcam"] = { ...node("refcam", "camera"), label: "refcam1" };
      nodes.subject = { ...nodes.subject, parameters: { ...nodes.subject?.parameters, [spec.parameter]: "refcam1" } } as GraphNode;
    } else if (port.type.kind === "light") {
      nodes["reflight"] = { ...node("reflight", "light"), label: "reflight1" };
      nodes.subject = { ...nodes.subject, parameters: { ...nodes.subject?.parameters, [spec.parameter]: "reflight1" } } as GraphNode;
    } else if (port.type.kind === "scene") {
      nodes["refgrid"] = node("refgrid", "pointGrid");
      nodes["refgeo"] = { ...node("refgeo", "geometry"), label: "refgeo1" };
      edges["refgeo-in"] = edge("refgeo-in", ["refgrid", "out"], ["refgeo", "points"]);
      nodes.subject = { ...nodes.subject, parameters: { ...nodes.subject?.parameters, [spec.parameter]: "refgeo1" } } as GraphNode;
    }
    // material references stay empty: the parameter is optional and the default
    // material is the documented fallback (T428 adds material nodes).
  }

  const firstOutput = definition.outputs[0];
  if (firstOutput !== undefined) {
    if (firstOutput.type.kind === "pointset") {
      // A pointset is observed by drawing it: subject -> renderPoints -> output.
      nodes["observe"] = node("observe", "renderPoints");
      edges["observe-in"] = edge("observe-in", ["subject", firstOutput.id], ["observe", "points"]);
      edges["sink"] = edge("sink", ["observe", "out"], ["sink", "input"]);
    } else if (
      firstOutput.type.kind === "camera" ||
      firstOutput.type.kind === "light" ||
      firstOutput.type.kind === "projector" ||
      firstOutput.type.kind === "scene" ||
      firstOutput.type.kind === "material"
    ) {
      // T447: a scene THING is observed by rendering with it — assembled by NAME, the
      // only way scene assembly travels (V372).
      nodes["obsgrid"] = node("obsgrid", "pointGrid");
      nodes["obsgeo"] = { ...node("obsgeo", "geometry"), label: "obsgeo1" };
      edges["obsgeo-in"] = edge("obsgeo-in", ["obsgrid", "out"], ["obsgeo", "points"]);
      nodes["obscam"] = { ...node("obscam", "camera"), label: "obscam1" };
      nodes["obslight"] = { ...node("obslight", "light"), label: "obslight1" };
      if (firstOutput.type.kind === "material") {
        nodes["obsgeo"] = { ...(nodes["obsgeo"] as GraphNode), parameters: { material: "subject1" } };
      }
      const scenes = firstOutput.type.kind === "scene" ? "subject1" : "obsgeo1";
      const camera = firstOutput.type.kind === "camera" ? "subject1" : "obscam1";
      const lights = firstOutput.type.kind === "light" ? "subject1" : "obslight1";
      // T704: a projector is observed the same way — a render that names it.
      nodes["observe"] = node("observe", "render", {
        scenes,
        camera,
        lights,
        ...(firstOutput.type.kind === "projector" ? { projectors: "subject1" } : {}),
      });
      edges["sink"] = edge("sink", ["observe", "out"], ["sink", "input"]);
    } else {
      edges["sink"] = edge("sink", ["subject", firstOutput.id], ["sink", "input"]);
    }
  }

  return { revision: 1, nodes, edges, groups: {} };
}
