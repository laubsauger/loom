import { describe, expect, it } from "vitest";
import { readExecutionPlan } from "../runtime/backend/plan.ts";
import type { EffectPassDescriptor, PassDescriptor } from "../runtime/backend/plan.ts";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import {
  SHARED_SAMPLER_ID,
  SINK_TARGET_PORT,
  pingPongResourceId,
  scratchResourceId,
  swapPassId,
  targetResourceId,
} from "./resources.ts";
import type { CompileRequest } from "./types.ts";
import { asCompilerContext } from "./types.ts";
import type { CompiledNodeDescription, NodeDefinition } from "../domain/types/node-definition.ts";
import {
  FILTER_WGSL,
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";
import type { GraphDocument } from "../domain/types/graph.ts";

const registry = createCompilerTestRegistry().view();

const compile = (graph: GraphDocument, overrides: Partial<CompileRequest> = {}) =>
  compileGraph({
    graph,
    settings: testSettings(),
    registry,
    capabilities: testCapabilities(),
    ...overrides,
  });

const effects = (passes: ReadonlyArray<PassDescriptor>): EffectPassDescriptor[] =>
  passes.filter((pass): pass is EffectPassDescriptor => pass.kind === "effect");

/** gen -> blur -> composite -> output, with gen also feeding a half-res branch. */
const fanOutGraph = (): GraphDocument =>
  testGraph(
    [
      testNode("gen", "fx.generator"),
      testNode("blur", "fx.blur"),
      testNode("half", "fx.half"),
      testNode("comp", "fx.composite"),
      testNode("out", "fx.output"),
    ],
    [
      testEdge("e1", ["gen", "out"], ["blur", "source"]),
      testEdge("e2", ["gen", "out"], ["half", "source"]),
      testEdge("e3", ["blur", "out"], ["comp", "layers"]),
      testEdge("e4", ["half", "out"], ["comp", "layers"]),
      testEdge("e5", ["comp", "out"], ["out", "source"]),
    ],
  );

/** comp -> feedback -> blur -> comp: a cycle that is legal because it crosses fx.feedback. */
const feedbackGraph = (): GraphDocument =>
  testGraph(
    [
      testNode("gen", "fx.generator"),
      testNode("comp", "fx.composite"),
      testNode("fb", "fx.feedback"),
      testNode("blur", "fx.blur"),
      testNode("out", "fx.output"),
    ],
    [
      testEdge("e1", ["gen", "out"], ["comp", "layers"]),
      testEdge("e2", ["blur", "out"], ["comp", "layers"]),
      testEdge("e3", ["comp", "out"], ["fb", "source"]),
      testEdge("e4", ["fb", "out"], ["blur", "source"]),
      testEdge("e5", ["comp", "out"], ["out", "source"]),
    ],
  );

describe("compileGraph — the plan contract with the backend (T30)", () => {
  it("emits a plan the backend's own reader accepts", () => {
    const plan = compile(fanOutGraph());
    const read = readExecutionPlan(plan);

    expect(read.diagnostics).toEqual([]);
    expect(read.ok).toBe(true);
    expect(plan.ok).toBe(true);
  });

  it("emits a valid plan for a feedback graph too", () => {
    const plan = compile(feedbackGraph());
    expect(readExecutionPlan(plan).ok).toBe(true);
    expect(plan.ok).toBe(true);
  });

  it("is deterministic: the same document compiles to the same plan", () => {
    const first = compile(fanOutGraph());
    const second = compile(fanOutGraph());

    expect(second.order).toEqual(first.order);
    expect(second.signature).toBe(first.signature);
    expect(JSON.stringify(second.passes)).toBe(JSON.stringify(first.passes));
    expect(JSON.stringify(second.resources)).toBe(JSON.stringify(first.resources));
  });

  it("does not depend on the document's key insertion order", () => {
    const forward = compile(fanOutGraph());
    const nodes = fanOutGraph().nodes;
    const reversed: GraphDocument = {
      ...fanOutGraph(),
      nodes: Object.fromEntries(Object.entries(nodes).reverse()),
    };
    expect(compile(reversed).signature).toBe(forward.signature);
    expect(compile(reversed).order).toEqual(forward.order);
  });
});

describe("compileGraph — branch reuse (T32, §V6)", () => {
  it("renders a fan-out output exactly once", () => {
    const plan = compile(fanOutGraph());

    // Five kept nodes, one pass each. A per-branch model would emit six: gen twice.
    expect(plan.passes).toHaveLength(5);
    expect(effects(plan.passes).filter((pass) => pass.nodeId === "gen")).toHaveLength(1);
  });

  it("gives both consumers the same resource id", () => {
    const plan = compile(fanOutGraph());
    const source = targetResourceId("gen", "out");

    const consumers = effects(plan.passes).filter((pass) => pass.nodeId === "blur" || pass.nodeId === "half");
    expect(consumers).toHaveLength(2);
    for (const pass of consumers) {
      expect((pass.textures ?? []).map((texture) => texture.resourceId)).toContain(source);
    }
    expect(plan.resources.filter((resource) => resource.id === source)).toHaveLength(1);
  });

  it("allocates one persistent resource per materialized output, plus one shared sampler (§V8)", () => {
    const plan = compile(fanOutGraph());
    expect(plan.resources.map((resource) => resource.id).sort()).toEqual(
      [
        SHARED_SAMPLER_ID,
        targetResourceId("blur", "out"),
        targetResourceId("comp", "out"),
        targetResourceId("gen", "out"),
        targetResourceId("half", "out"),
        targetResourceId("out", "out"),
      ].sort(),
    );
  });
});

describe("compileGraph — active sinks and pruning (T26, §V25)", () => {
  it("prunes what no sink reaches and keeps a declared sink", () => {
    const graph = testGraph(
      [
        testNode("gen", "fx.generator"),
        testNode("out", "fx.output"),
        testNode("dbg", "fx.readback"),
        testNode("orphan", "fx.generator"),
      ],
      [
        testEdge("e1", ["gen", "out"], ["out", "source"]),
        testEdge("e2", ["gen", "out"], ["dbg", "source"]),
      ],
    );
    const plan = compile(graph);

    expect(plan.pruned).toEqual(["orphan"]);
    // The readback node has outputs and nothing consumes them: only its declared
    // sink-ness keeps it, which is the point of declaring rather than inferring.
    expect(plan.order).toContain("dbg");
    expect(plan.order).not.toContain("orphan");
  });

  it("gives a sink with no output ports somewhere to render", () => {
    // An Output node presents an image without publishing it as a port. It still needs a
    // target, or it could not emit a pass at all.
    const presenter = createCompilerTestRegistry([
      {
        type: "fx.present",
        version: 1,
        title: "Present",
        category: "output",
        inputs: [{ id: "source", label: "Source", type: { kind: "texture2d", sample: "float", channels: 4 } }],
        outputs: [],
        parameters: {},
        sink: true,
        resolutionPolicy: { kind: "project" },
        compile: () => ({ passes: [{ shader: "@fragment fn fs() {}" }] }),
      },
    ]).view();

    const plan = compileGraph({
      graph: testGraph(
        [testNode("gen", "fx.generator"), testNode("present", "fx.present")],
        [testEdge("e1", ["gen", "out"], ["present", "source"])],
      ),
      settings: testSettings(),
      registry: presenter,
      capabilities: testCapabilities(),
    });

    const target = targetResourceId("present", SINK_TARGET_PORT);
    expect(plan.resources.map((resource) => resource.id)).toContain(target);
    expect(effects(plan.passes).find((pass) => pass.nodeId === "present")?.target).toBe(target);
    expect(readExecutionPlan(plan).ok).toBe(true);
  });

  it("warns rather than failing when nothing is active", () => {
    const plan = compile(testGraph([testNode("gen", "fx.generator")]));

    expect(plan.order).toEqual([]);
    expect(plan.passes).toEqual([]);
    expect(plan.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.noActiveSinks);
    expect(plan.ok).toBe(true);
  });

  it("keeps a branch alive for a caller-supplied preview sink", () => {
    const graph = testGraph(
      [testNode("gen", "fx.generator"), testNode("blur", "fx.blur")],
      [testEdge("e1", ["gen", "out"], ["blur", "source"])],
    );
    const plan = compile(graph, { sinks: [{ nodeId: "blur", kind: "preview" }] });

    expect(plan.order).toEqual(["gen", "blur"]);
    expect(plan.pruned).toEqual([]);
  });
});

describe("compileGraph — feedback (T33, §V22)", () => {
  it("allocates a stable ping-pong pair for the temporal output", () => {
    const plan = compile(feedbackGraph());
    const pairId = pingPongResourceId("fb", "out");

    const pair = plan.resources.filter((resource) => resource.id === pairId);
    expect(pair).toHaveLength(1);
    expect(pair[0]?.kind).toBe("pingPong");
    // No separate `target` shadowing the pair: the pair IS the output's storage.
    expect(plan.resources.some((resource) => resource.id === targetResourceId("fb", "out"))).toBe(false);
    expect(plan.feedback.map((entry) => entry.resourceId)).toEqual([pairId]);
  });

  it("keeps the pair's identity across an unrelated edit", () => {
    const before = compile(feedbackGraph());
    const graph = feedbackGraph();
    graph.nodes["extra"] = testNode("extra", "fx.generator");
    graph.edges["e6"] = testEdge("e6", ["extra", "out"], ["comp", "layers"]);
    const after = compile(graph);

    const pairId = pingPongResourceId("fb", "out");
    const signatureOf = (plan: typeof before) =>
      plan.resourceSignatures.find((entry) => entry.id === pairId)?.signature;
    expect(signatureOf(after)).toBe(signatureOf(before));
    expect(after.feedback[0]?.resetSignature).toBe(before.feedback[0]?.resetSignature);
  });

  it("swaps only after every current-frame consumer has been encoded", () => {
    const plan = compile(feedbackGraph());
    const pairId = pingPongResourceId("fb", "out");

    const swapIndex = plan.passes.findIndex((pass) => pass.id === swapPassId(pairId));
    expect(swapIndex).toBeGreaterThanOrEqual(0);

    const lastConsumer = plan.passes.reduce(
      (latest, pass, index) =>
        pass.kind === "effect" &&
        (pass.target === pairId || (pass.textures ?? []).some((t) => t.resourceId === pairId))
          ? index
          : latest,
      -1,
    );
    expect(lastConsumer).toBeGreaterThanOrEqual(0);
    expect(swapIndex).toBeGreaterThan(lastConsumer);
  });

  it("resolves a consumer that reads the pair from the previous frame without falling back", () => {
    const plan = compile(feedbackGraph());

    // `blur` is ordered before `fb` (its only input is a temporal edge), so a single-sweep
    // propagation would have to guess its size. It must not have to.
    expect(plan.order.indexOf("blur")).toBeLessThan(plan.order.indexOf("fb"));
    expect(
      plan.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.resolutionInputMissing),
    ).toEqual([]);
    const blur = plan.outputs.find((output) => output.nodeId === "blur");
    expect(blur?.size).toEqual([1920, 1080]);
  });
});

describe("compileGraph — node compilation", () => {
  it("namespaces pass ids by node so two definitions cannot collide", () => {
    const plan = compile(fanOutGraph());
    expect(plan.passes.map((pass) => pass.id)).toEqual([
      "gen#0",
      "blur#0",
      "half#0",
      "comp#0",
      "out#0",
    ]);
  });

  it("reports a node whose compile throws and keeps the rest of the graph", () => {
    const exploding = {
      ...testGraph([testNode("boom", "fx.boom"), testNode("out", "fx.output")], [
        testEdge("e1", ["boom", "out"], ["out", "source"]),
      ]),
    };
    const brokenRegistry = createCompilerTestRegistry([
      {
        type: "fx.boom",
        version: 1,
        title: "Boom",
        category: "generator",
        inputs: [],
        outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 4 } }],
        parameters: {},
        resolutionPolicy: { kind: "project" },
        compile: () => {
          throw new Error("nope");
        },
      },
    ]).view();

    const plan = compileGraph({
      graph: exploding,
      settings: testSettings(),
      registry: brokenRegistry,
      capabilities: testCapabilities(),
    });

    expect(plan.ok).toBe(false);
    expect(plan.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.nodeCompileFailed);
    // The output node still compiled.
    expect(effects(plan.passes).map((pass) => pass.nodeId)).toEqual(["out"]);
  });

  it("refuses a swap pass emitted by a node definition (§V22 is the compiler's job)", () => {
    const registryWithCheat = createCompilerTestRegistry([
      {
        type: "fx.cheat",
        version: 1,
        title: "Cheat",
        category: "generator",
        inputs: [],
        outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 4 } }],
        parameters: {},
        sink: true,
        resolutionPolicy: { kind: "project" },
        compile: () => ({ passes: [{ kind: "swap", resourceId: "whatever" }] }),
      },
    ]).view();

    const plan = compileGraph({
      graph: testGraph([testNode("c", "fx.cheat")]),
      settings: testSettings(),
      registry: registryWithCheat,
      capabilities: testCapabilities(),
    });

    expect(plan.ok).toBe(false);
    expect(plan.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.passInvalid);
  });
});

describe("compileGraph — scratch targets (T147)", () => {
  /** A separable two-pass filter: horizontal into scratch, vertical into the output. */
  const separableNode: NodeDefinition = {
    type: "fx.separable",
    version: 1,
    title: "Separable",
    category: "filter",
    inputs: [{ id: "source", label: "Source", type: { kind: "texture2d", sample: "float", channels: 4 } }],
    outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 4 } }],
    parameters: {},
    resolutionPolicy: { kind: "inherit", input: "source" },
    formatPolicy: { kind: "inherit", input: "source" },
    compile: (raw) => {
      const context = asCompilerContext(raw);
      const source = context.inputs["source"]?.[0]?.resourceId;
      const out = context.outputs["out"]?.resourceId;
      if (source === undefined || out === undefined) return { passes: [] };
      const scratch = scratchResourceId(context.nodeId, "h");
      return {
        passes: [
          {
            shader: FILTER_WGSL,
            target: scratch,
            samplers: [{ binding: "inputSampler", resourceId: context.sampler }],
            textures: [{ binding: "sceneTexture", resourceId: source }, { binding: "historyTexture", resourceId: source }],
            uniformBinding: "params",
            uniforms: { decay: 0 },
          },
          {
            shader: FILTER_WGSL,
            target: out,
            samplers: [{ binding: "inputSampler", resourceId: context.sampler }],
            textures: [{ binding: "sceneTexture", resourceId: scratch }, { binding: "historyTexture", resourceId: scratch }],
            uniformBinding: "params",
            uniforms: { decay: 1 },
          },
        ],
        scratch: [{ key: "h" }],
      } as CompiledNodeDescription;
    },
  };

  const separableRegistry = createCompilerTestRegistry([separableNode]).view();

  const separableGraph = (): GraphDocument =>
    testGraph(
      [testNode("gen", "fx.generator"), testNode("fx", "fx.separable"), testNode("out", "fx.output")],
      [
        testEdge("e1", ["gen", "out"], ["fx", "source"]),
        testEdge("e2", ["fx", "out"], ["out", "source"]),
      ],
    );

  it("materializes a declared scratch target sized and formatted like the output", () => {
    const plan = compile(separableGraph(), { registry: separableRegistry });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    const scratch = plan.resources.find((resource) => resource.id === scratchResourceId("fx", "h"));
    expect(scratch?.kind).toBe("target");
    const output = plan.outputs.find((entry) => entry.nodeId === "fx");
    if (scratch?.kind === "target" && output) {
      expect(scratch.size).toEqual(output.size);
      expect(scratch.format).toBe(output.format);
    }
    // Both passes made it through the backend's reader — the scratch pass targets a
    // resource that genuinely exists in the plan.
    expect(plan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === "fx")).toHaveLength(2);
  });

  it("scales a scratch entry relative to the node's output", () => {
    const half: NodeDefinition = {
      ...separableNode,
      type: "fx.separable-half",
      compile: (raw) => {
        const base = separableNode.compile(raw);
        return { ...base, scratch: [{ key: "h", scale: 0.5 }] } as CompiledNodeDescription;
      },
    };
    const registry = createCompilerTestRegistry([half]).view();
    const graph = testGraph(
      [testNode("gen", "fx.generator"), testNode("fx", "fx.separable-half"), testNode("out", "fx.output")],
      [testEdge("e1", ["gen", "out"], ["fx", "source"]), testEdge("e2", ["fx", "out"], ["out", "source"])],
    );

    const plan = compile(graph, { registry });
    const scratch = plan.resources.find((resource) => resource.id === scratchResourceId("fx", "h"));
    const output = plan.outputs.find((entry) => entry.nodeId === "fx");
    if (scratch?.kind === "target" && output) {
      expect(scratch.size).toEqual([Math.round(output.size[0] / 2), Math.round(output.size[1] / 2)]);
    } else {
      expect.unreachable("scratch target missing");
    }
  });

  it("rejects invalid and duplicate scratch entries with a diagnostic", () => {
    const bad: NodeDefinition = {
      ...separableNode,
      type: "fx.separable-bad",
      compile: (raw) => {
        const base = separableNode.compile(raw);
        return {
          ...base,
          scratch: [{ key: "h" }, { key: "h" }, { scale: -1 }],
        } as CompiledNodeDescription;
      },
    };
    const registry = createCompilerTestRegistry([bad]).view();
    const graph = testGraph(
      [testNode("gen", "fx.generator"), testNode("fx", "fx.separable-bad"), testNode("out", "fx.output")],
      [testEdge("e1", ["gen", "out"], ["fx", "source"]), testEdge("e2", ["fx", "out"], ["out", "source"])],
    );

    const plan = compile(graph, { registry });
    const scratchErrors = plan.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.scratchInvalid);
    expect(scratchErrors).toHaveLength(2);
  });
});

describe("compileGraph — unfilterable bindings (T150/B5, §V57)", () => {
  const rgba: { kind: "texture2d"; sample: "float"; channels: 4 } = {
    kind: "texture2d",
    sample: "float",
    channels: 4,
  };

  /** Emits an r32float field — the classic data texture (displacement, SDF). */
  const fieldNode: NodeDefinition = {
    type: "fx.field",
    version: 1,
    title: "Field",
    category: "generator",
    inputs: [],
    outputs: [{ id: "out", label: "Out", type: { ...rgba, space: "data" } }],
    parameters: {},
    formatPolicy: { kind: "fixed", format: "r32float" },
    resolutionPolicy: { kind: "project" },
    compile: (raw) => {
      const context = asCompilerContext(raw);
      const out = context.outputs["out"]?.resourceId;
      return out === undefined
        ? { passes: [] }
        : { passes: [{ shader: "@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0); }", target: out }] };
    },
  };

  const consumer = (sampled: "filtered" | "unfiltered"): NodeDefinition => ({
    type: `fx.consume-${sampled}`,
    version: 1,
    title: "Consume",
    category: "filter",
    inputs: [{ id: "source", label: "Source", type: { ...rgba, space: "data" } }],
    outputs: [{ id: "out", label: "Out", type: rgba }],
    parameters: {},
    resolutionPolicy: { kind: "project" },
    formatPolicy: { kind: "project" },
    compile: (raw) => {
      const context = asCompilerContext(raw);
      const source = context.inputs["source"]?.[0]?.resourceId;
      const out = context.outputs["out"]?.resourceId;
      if (source === undefined || out === undefined) return { passes: [] };
      return {
        passes: [
          {
            shader: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }",
            target: out,
            textures: [{ binding: "fieldTexture", resourceId: source, sampled }],
          },
        ],
      };
    },
  });

  const graphFor = (kind: "filtered" | "unfiltered"): GraphDocument =>
    testGraph(
      [testNode("field", "fx.field"), testNode("use", `fx.consume-${kind}`), testNode("out", "fx.output")],
      [
        testEdge("e1", ["field", "out"], ["use", "source"]),
        testEdge("e2", ["use", "out"], ["out", "source"]),
      ],
    );

  const registryFor = () =>
    createCompilerTestRegistry([fieldNode, consumer("filtered"), consumer("unfiltered")]).view();

  it("refuses sampling r32float through a sampler on a device that cannot filter it", () => {
    const plan = compile(graphFor("filtered"), { registry: registryFor() });
    const error = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.bindingUnfilterable);
    expect(error?.severity).toBe("error");
    expect(error?.nodeId).toBe("use");
    expect(plan.ok).toBe(false);
  });

  it("accepts the same field read with textureLoad (sampled: unfiltered)", () => {
    const plan = compile(graphFor("unfiltered"), { registry: registryFor() });
    expect(plan.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.bindingUnfilterable)).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it("accepts filtered sampling when the device has float32-filterable", () => {
    const capabilities = { ...testCapabilities(), features: ["float32-filterable"] };
    const plan = compile(graphFor("filtered"), { registry: registryFor(), capabilities });
    expect(plan.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.bindingUnfilterable)).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it("carries an explicit output-port space claim through propagation (T83)", () => {
    const plan = compile(graphFor("unfiltered"), { registry: registryFor() });
    const field = plan.outputs.find((output) => output.nodeId === "field");
    expect(field?.space).toBe("data");
  });
});

describe("compileGraph — memory budget reporting (§V24)", () => {
  it("estimates plan texture memory and stays quiet inside the budget", () => {
    const plan = compile(fanOutGraph());
    expect(plan.estimatedResourceBytes).toBeGreaterThan(0);
    expect(plan.diagnostics.map((d) => d.code)).not.toContain(CompilerDiagnosticCode.memoryBudget);
  });

  it("warns — never refuses — when the estimate exceeds the project budget", () => {
    const settings = testSettings();
    const plan = compile(fanOutGraph(), {
      settings: {
        ...settings,
        limits: { ...settings.limits, memoryBudgetBytes: 1 },
      },
    });

    const budget = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.memoryBudget);
    expect(budget?.severity).toBe("warning");
    // §V24 says reported: the plan still compiles and renders.
    expect(plan.ok).toBe(true);
    expect(plan.passes.length).toBeGreaterThan(0);
  });
});
