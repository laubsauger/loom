import { describe, expect, it } from "vitest";
import { readExecutionPlan } from "../runtime/backend/plan.ts";
import type { EffectPassDescriptor, PassDescriptor } from "../runtime/backend/plan.ts";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import {
  SHARED_SAMPLER_ID,
  SINK_TARGET_PORT,
  pingPongResourceId,
  swapPassId,
  targetResourceId,
} from "./resources.ts";
import type { CompileRequest } from "./types.ts";
import {
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
