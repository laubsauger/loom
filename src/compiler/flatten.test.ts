import { describe, expect, it } from "vitest";
import type { GraphComponentDefinition, PublishedParameter } from "../domain/types/components.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { ComponentId } from "../domain/types/ids.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { ParameterSlot, ParameterValue } from "../domain/types/parameters.ts";
import { graphChannelResolver } from "../domain/channels/graph-channels.ts";
import {
  COMPONENT_OVERRIDES_STATE_KEY,
  PARENT_BINDINGS_STATE_KEY,
  componentNodeType,
  createComponentAwareRegistry,
  createComponentSystem,
} from "../domain/components/index.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import type { EffectPassDescriptor, PassDescriptor } from "../runtime/backend/plan.ts";
import { readExecutionPlan } from "../runtime/backend/plan.ts";
import { compileGraph } from "./compile.ts";
import { componentPathOf, flattenComponents } from "./flatten.ts";
import type { CompileRequest, CompiledGraph } from "./types.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testNode,
  testSettings,
} from "./test-support.ts";

/**
 * Component flattening (T134, T135, §V82, §V83).
 *
 * The test that matters most here is the one that would have caught a silent failure: an
 * instance the compiler forgot about does not render nothing, it fails loudly on the
 * synthesized manifest's `component.notFlattened` tripwire. Everything else checks that
 * the value and the NAME both survive the inlining — a plan that renders the right pixels
 * but reports `feedback1/blur2/warp` in the problems tab has only done half the job.
 */

const baseNodes = createCompilerTestRegistry().view();

const graphOf = (nodes: GraphNode[], edges: GraphDocument["edges"] = {}): GraphDocument => ({
  revision: 1,
  nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  edges,
  groups: {},
});

const instance = (id: string, componentId: ComponentId, version: number, node: Partial<GraphNode> = {}): GraphNode =>
  testNode(id, componentNodeType(componentId, version), { definitionVersion: version, ...node });

/** One published knob driving both internal radii — the §V80 fan-out, in miniature. */
const blurKnob: PublishedParameter = {
  key: "blur",
  definition: { type: "number", label: "Blur", default: 4, min: 0, max: 64 },
  targets: [
    { nodeId: "blurA", key: "radius" },
    { nodeId: "blurB", key: "radius" },
  ],
};

/**
 * `source -> blurA -> blurB -> out`, plus an orphan generator nothing reads: the §V25
 * check has to keep working through a flattening.
 */
function bloom(published: PublishedParameter[] = [blurKnob], version = 1): GraphComponentDefinition {
  return {
    componentId: "bloom",
    version,
    name: "Bloom",
    graph: graphOf(
      [
        testNode("blurA", "fx.blur", { parameters: { radius: 2 } }),
        testNode("blurB", "fx.blur", { parameters: { radius: 2 } }),
        testNode("orphan", "fx.generator"),
      ],
      { inner: testEdge("inner", ["blurA", "out"], ["blurB", "source"]) },
    ),
    inputs: [{ externalId: "source", label: "Source", nodeId: "blurA", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "blurB", portId: "out" }],
    parameters: published,
  };
}

/** A component whose only node reads the owning instance's knob as `parent.blur` (§V81). */
function scopeReader(): GraphComponentDefinition {
  return {
    componentId: "scoped",
    version: 1,
    name: "Scoped",
    graph: graphOf([
      testNode("warp", "fx.blur", {
        parameters: { radius: 1 },
        state: { [PARENT_BINDINGS_STATE_KEY]: { radius: "parent.blur" } },
      }),
    ]),
    inputs: [{ externalId: "source", label: "Source", nodeId: "warp", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "warp", portId: "out" }],
    // No targets: pure lexical scope, which §V81 exists for and the definition allows.
    parameters: [{ key: "blur", definition: { type: "number", label: "Blur", default: 3, min: 0, max: 64 }, targets: [] }],
  };
}

/** Wraps another component, so nesting is two deep. */
function wrapper(inner: ComponentId, version = 1): GraphComponentDefinition {
  return {
    componentId: "wrapper",
    version: 1,
    name: "Wrapper",
    graph: graphOf([instance("inner", inner, version)]),
    inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
    parameters: [],
  };
}

/** gen -> <instances...> -> out, wired in a chain. */
function chain(instances: GraphNode[]): GraphDocument {
  const nodes = [testNode("gen", "fx.generator"), ...instances, testNode("out", "fx.output")];
  const edges: GraphDocument["edges"] = {};
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index] as GraphNode;
    const to = nodes[index + 1] as GraphNode;
    edges[`e${index}`] = testEdge(`e${index}`, [from.id, "out"], [to.id, "source"]);
  }
  return graphOf(nodes, edges);
}

function compileWith(
  definitions: GraphComponentDefinition[],
  graph: GraphDocument,
  overrides: Partial<CompileRequest> = {},
): CompiledGraph {
  const system = createComponentSystem(baseNodes, definitions);
  return compileGraph({
    graph,
    settings: testSettings(),
    registry: system.nodes,
    capabilities: testCapabilities(),
    components: system.components.view(),
    ...overrides,
  });
}

const effects = (passes: ReadonlyArray<PassDescriptor>): EffectPassDescriptor[] =>
  passes.filter((pass): pass is EffectPassDescriptor => pass.kind === "effect");

const passFor = (compiled: CompiledGraph, nodeId: string): EffectPassDescriptor | undefined =>
  effects(compiled.passes).find((pass) => pass.nodeId === nodeId);

const sourcePathOf = (compiled: CompiledGraph, nodeId: string): string | undefined =>
  compiled.sources.find((source) => source.nodeId === nodeId)?.sourcePath;

describe("component flattening (§V82)", () => {
  it("inlines an instance's internal passes into the parent plan", () => {
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1)]));

    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.ok).toBe(true);
    // The instance itself is gone; what it contained is what runs.
    expect(compiled.order).toContain("c1/blurA");
    expect(compiled.order).toContain("c1/blurB");
    expect(compiled.order).not.toContain("c1");
    expect(passFor(compiled, "c1/blurA")).toBeDefined();
    expect(passFor(compiled, "c1/blurB")).toBeDefined();
  });

  it("rewires the parent's edges through the component's exposed ports", () => {
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1)]));

    // gen feeds the component's first internal node, and its last feeds the output.
    const first = passFor(compiled, "c1/blurA");
    expect(first?.textures?.[0]?.resourceId).toBe("target:gen:out");
    const output = passFor(compiled, "out");
    expect(output?.textures?.[0]?.resourceId).toBe("target:c1/blurB:out");
  });

  it("keeps two instances of the same component disjoint", () => {
    const compiled = compileWith(
      [bloom()],
      chain([instance("c1", "bloom", 1, { parameters: { blur: 8 } }), instance("c2", "bloom", 1, { parameters: { blur: 32 } })]),
    );

    expect(compiled.ok).toBe(true);
    expect(passFor(compiled, "c1/blurA")?.uniforms?.["radius"]).toBe(8);
    expect(passFor(compiled, "c2/blurA")?.uniforms?.["radius"]).toBe(32);
    // Two instances, two sets of resources: neither may reuse the other's target.
    expect(compiled.resources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining(["target:c1/blurA:out", "target:c2/blurA:out"]),
    );
  });

  it("carries the source path through two levels of nesting", () => {
    const compiled = compileWith([bloom(), wrapper("bloom")], chain([instance("w1", "wrapper", 1)]));

    expect(compiled.ok).toBe(true);
    expect(sourcePathOf(compiled, "w1/inner/blurA")).toBe("Main / Wrapper_1 / Bloom_1 / blurA");
    // The path is recoverable from the id alone, which is what makes it a namespace and
    // not just a prefix.
    expect(componentPathOf("w1/inner/blurA")).toEqual(["w1", "w1/inner"]);
    expect(sourcePathOf(compiled, "gen")).toBe("Main / gen");
  });

  it("stamps the source path onto a diagnostic about a node inside a component", () => {
    // A radius above the internal parameter's max: the value is refused where the user
    // cannot see the node, so the report has to say where that is.
    const compiled = compileWith(
      [bloom([])],
      chain([instance("c1", "bloom", 1, { state: { [COMPONENT_OVERRIDES_STATE_KEY]: { "blurA/radius": 9000 } } })]),
    );

    const reported = compiled.diagnostics.find((diagnostic) => diagnostic.nodeId === "c1/blurA");
    expect(reported?.message).toContain("Main / Bloom_1 / blurA");
  });

  it("passes the backend's own plan reader", () => {
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1)]));
    const read = readExecutionPlan({
      passes: compiled.passes,
      resources: compiled.resources,
      diagnostics: [],
    });

    expect(read.ok).toBe(true);
    expect(read.diagnostics).toEqual([]);
  });

  it("is deterministic: the same document compiles to the same plan", () => {
    const document = chain([instance("c1", "bloom", 1), instance("c2", "bloom", 1)]);
    const first = compileWith([bloom()], document);
    const second = compileWith([bloom()], document);

    expect(second.signature).toBe(first.signature);
    expect(JSON.stringify(second.passes)).toBe(JSON.stringify(first.passes));
    expect(second.sources).toEqual(first.sources);
  });
});

describe("published parameters through a flattening (§V80)", () => {
  it("drives every internal target from one published value", () => {
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1, { parameters: { blur: 21 } })]));

    expect(passFor(compiled, "c1/blurA")?.uniforms?.["radius"]).toBe(21);
    expect(passFor(compiled, "c1/blurB")?.uniforms?.["radius"]).toBe(21);
  });

  it("falls back to the published default rather than the internal stored value", () => {
    // blurA stores radius 2; the knob's default is 4 and the knob owns the parameter.
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1)]));

    expect(passFor(compiled, "c1/blurA")?.uniforms?.["radius"]).toBe(4);
  });

  it("lets an instance override win over the published fan-out", () => {
    const compiled = compileWith(
      [bloom()],
      chain([
        instance("c1", "bloom", 1, {
          parameters: { blur: 21 },
          state: { [COMPONENT_OVERRIDES_STATE_KEY]: { "blurB/radius": 5 } },
        }),
      ]),
    );

    expect(passFor(compiled, "c1/blurA")?.uniforms?.["radius"]).toBe(21);
    expect(passFor(compiled, "c1/blurB")?.uniforms?.["radius"]).toBe(5);
  });
});

describe("parent scope through a flattening (§V81)", () => {
  it("resolves parent.<key> from the owning instance", () => {
    const compiled = compileWith([scopeReader()], chain([instance("s1", "scoped", 1, { parameters: { blur: 13 } })]));

    expect(compiled.ok).toBe(true);
    expect(passFor(compiled, "s1/warp")?.uniforms?.["radius"]).toBe(13);
  });

  it("resolves it at any nesting depth, up the instance chain", () => {
    const outer: GraphComponentDefinition = {
      ...wrapper("scoped"),
      // The wrapper republishes the knob down to its own instance of the scoped component.
      parameters: [
        {
          key: "blur",
          definition: { type: "number", label: "Blur", default: 3, min: 0, max: 64 },
          targets: [{ nodeId: "inner", key: "blur" }],
        },
      ],
    };
    const compiled = compileWith([scopeReader(), outer], chain([instance("w1", "wrapper", 1, { parameters: { blur: 44 } })]));

    expect(compiled.ok).toBe(true);
    expect(passFor(compiled, "w1/inner/warp")?.uniforms?.["radius"]).toBe(44);
  });
});

describe("pruning after flattening (§V25)", () => {
  it("still removes an internal node no sink reaches", () => {
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1)]));

    expect(compiled.pruned).toContain("c1/orphan");
    expect(passFor(compiled, "c1/orphan")).toBeUndefined();
    expect(compiled.resources.map((resource) => resource.id)).not.toContain("target:c1/orphan:out");
  });

  it("follows a previewed instance into the flattening rather than pruning it away", () => {
    // The instance feeds nothing; only its pinned preview keeps it alive (§V28). The PIN
    // rather than the switch since T353 (§V297): the switch is default-on, and reading it
    // here would make every instance in every document an unconditional sink.
    const graph = graphOf(
      [testNode("gen", "fx.generator"), instance("c1", "bloom", 1, { ui: { previewPinned: true } }), testNode("out", "fx.output")],
      {
        e0: testEdge("e0", ["gen", "out"], ["c1", "source"]),
        e1: testEdge("e1", ["gen", "out"], ["out", "source"]),
      },
    );
    const compiled = compileWith([bloom()], graph);

    expect(compiled.pruned).not.toContain("c1/blurB");
    expect(passFor(compiled, "c1/blurB")).toBeDefined();
  });
});

describe("edge order through a flattening (§V131, B155)", () => {
  /**
   * B155 — the flattened edge copy dropped `order`, and the failure was invisible from
   * either side alone: the compiler's variadic sort is correct (declared order first,
   * id as tiebreak), and the harness compiles a component-free document WITHOUT
   * flattening, so every gate saw the declared order. The APP always flattens (it
   * passes `components`), so in the running app every variadic port fell back to the
   * id tiebreak — E43's Switch arrived inverted (`e-clip-pick` sorts before
   * `e-stand-pick`), index 0 presented the fileless movie clip, and the whole rack
   * behind it rendered black while `src/examples` stayed green on Dawn.
   *
   * The ids here are chosen so the ALPHABETICAL order contradicts the DECLARED order:
   * a test whose two orders agree cannot fail when the field is dropped.
   */
  it("a variadic port's DECLARED order survives — the id tiebreak must not decide", () => {
    const graph = graphOf(
      [
        testNode("gen", "fx.generator"),
        testNode("plate", "fx.generator"),
        testNode("mix", "fx.composite"),
        testNode("out", "fx.output"),
      ],
      {
        // Sorts FIRST by id, declared SECOND by order.
        "e-a": { ...testEdge("e-a", ["plate", "out"], ["mix", "layers"]), order: 1 },
        // Sorts second by id, declared FIRST.
        "e-z": { ...testEdge("e-z", ["gen", "out"], ["mix", "layers"]), order: 0 },
        "e-out": testEdge("e-out", ["mix", "out"], ["out", "source"]),
      },
    );
    const compiled = compileWith([], graph);
    const mix = passFor(compiled, "mix");
    const genTarget = passFor(compiled, "gen")?.target;
    const plateTarget = passFor(compiled, "plate")?.target;
    expect(genTarget).toBeDefined();
    expect(plateTarget).toBeDefined();
    // layer0 is the DECLARED first input (gen, order 0), not the alphabetical first.
    expect(mix?.textures?.map((texture) => texture.resourceId)).toEqual([genTarget, plateTarget]);
  });
});

describe("the not-flattened tripwire", () => {
  it("fails loudly when an instance reaches node compilation", () => {
    // The registry knows the component type, so the instance validates and compiles — but
    // no component catalogue was supplied, so nothing flattened it.
    const system = createComponentSystem(baseNodes, [bloom()]);
    const compiled = compileGraph({
      graph: chain([instance("c1", "bloom", 1)]),
      settings: testSettings(),
      registry: system.nodes,
      capabilities: testCapabilities(),
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain("component.notFlattened");
    expect(compiled.sources).toEqual([]);
  });
});

/**
 * A catalogue that skips `register`'s §V83 refusal, standing in for a project file whose
 * component library was hand-edited or written by an older build. The compiler may not
 * assume the editor got there first.
 */
function rawComponents(definitions: readonly GraphComponentDefinition[]): ComponentRegistryView {
  const key = (componentId: ComponentId, version: number): string => `${componentId}@${version}`;
  const byVersion = new Map(definitions.map((definition) => [key(definition.componentId, definition.version), definition]));
  const versions = (componentId: ComponentId): readonly number[] =>
    definitions
      .filter((definition) => definition.componentId === componentId)
      .map((definition) => definition.version)
      .sort((a, b) => a - b);
  const get = (componentId: ComponentId, version: number): GraphComponentDefinition | undefined =>
    byVersion.get(key(componentId, version));
  return {
    has: (componentId, version) =>
      version === undefined ? versions(componentId).length > 0 : byVersion.has(key(componentId, version)),
    get,
    latest: (componentId) => {
      const all = versions(componentId);
      const top = all[all.length - 1];
      return top === undefined ? undefined : get(componentId, top);
    },
    versions,
    list: () => definitions,
    all: () => definitions,
    graphOf: (componentId, version) => get(componentId, version)?.graph,
    subscribe: () => () => undefined,
  };
}

function compileRecursive(definitions: GraphComponentDefinition[], graph: GraphDocument): CompiledGraph {
  const components = rawComponents(definitions);
  return compileGraph({
    graph,
    settings: testSettings(),
    registry: createComponentAwareRegistry(baseNodes, components),
    capabilities: testCapabilities(),
    components,
  });
}

describe("recursion detection at compile (§V83)", () => {
  const selfContaining: GraphComponentDefinition = {
    componentId: "loop",
    version: 1,
    name: "Loop",
    graph: graphOf([instance("self", "loop", 1)]),
    inputs: [],
    outputs: [],
    parameters: [],
  };

  const a: GraphComponentDefinition = {
    componentId: "a",
    version: 1,
    name: "A",
    graph: graphOf([instance("toB", "b", 1)]),
    inputs: [],
    outputs: [],
    parameters: [],
  };
  const b: GraphComponentDefinition = {
    componentId: "b",
    version: 1,
    name: "B",
    graph: graphOf([instance("toA", "a", 1)]),
    inputs: [],
    outputs: [],
    parameters: [],
  };

  it("refuses direct recursion with the cycle named, rather than expanding for ever", () => {
    const compiled = compileRecursive([selfContaining], graphOf([instance("c1", "loop", 1)]));

    expect(compiled.ok).toBe(false);
    const recursion = compiled.diagnostics.find((d) => d.code === "compiler/component-recursion");
    expect(recursion?.message).toContain("loop → loop");
    // Nothing is emitted: a plan built from half an expansion is worse than no plan.
    expect(compiled.passes).toEqual([]);
  });

  it("refuses indirect recursion and names the whole chain", () => {
    const compiled = compileRecursive([a, b], graphOf([instance("c1", "a", 1)]));

    expect(compiled.ok).toBe(false);
    const recursion = compiled.diagnostics.find((d) => d.code === "compiler/component-recursion");
    expect(recursion?.message).toContain("a → b → a");
  });

  it("catches a loop that crosses component versions", () => {
    // §V83 is keyed on component identity, not on id@version: a@2 -> b -> a@1 expands for
    // ever just as surely as a@1 -> a@1 does.
    const a2: GraphComponentDefinition = { ...a, version: 2, graph: graphOf([instance("toB", "b", 1)]) };
    const compiled = compileRecursive([a2, b, a], graphOf([instance("c1", "a", 2)]));

    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.some((d) => d.code === "compiler/component-recursion")).toBe(true);
  });
});

describe("a component that is not installed (§V10)", () => {
  it("reports it and keeps compiling the rest of the graph", () => {
    const compiled = compileWith([], chain([instance("c1", "ghost", 1)]));

    expect(compiled.ok).toBe(false);
    // Reported as a missing component rather than expanded to nothing, and the rest of
    // the document still compiles around the hole (§V10).
    expect(compiled.diagnostics.some((d) => d.code === "compiler/component-missing")).toBe(true);
    expect(compiled.diagnostics.some((d) => d.code === "compiler/unknown-node-type")).toBe(true);
    expect(compiled.order).toContain("out");
  });
});

describe("a pinned instance previews its first PREVIEWABLE output (T609)", () => {
  // Post-T607 the sockets derive from boundary nodes in graph order, so a value or
  // event socket can land first by accident of layout. The pin's sink must skip it:
  // a sink naming a port with no picture materializes nothing, and §V25 then prunes
  // the very component the pin was meant to keep alive.
  const meter = (): GraphComponentDefinition => ({
    componentId: "meter" as ComponentId,
    version: 1,
    name: "Meter",
    graph: graphOf([
      testNode("sig", "lfo", { parameters: { shape: "sine", frequency: 1 } }),
      testNode("pic", "solid", {}),
    ]),
    inputs: [],
    outputs: [
      // The accident under test, made explicit: the VALUE socket is first.
      { externalId: "level", label: "Level", nodeId: "sig" as never, portId: "out" },
      { externalId: "picture", label: "Picture", nodeId: "pic" as never, portId: "out" },
    ],
    parameters: [],
  });

  it("skips the leading value socket and sinks the texture behind the second", async () => {
    const { allNodeDefinitions } = await import("../nodes/definitions/index.ts");
    const { createNodeRegistry } = await import("../nodes/registry/registry.ts");
    const real = createNodeRegistry(allNodeDefinitions);
    const system = createComponentSystem(real, [meter()]);
    const compiled = compileGraph({
      graph: graphOf([instance("c1", "meter" as ComponentId, 1, { ui: { previewPinned: true } })]),
      settings: testSettings(),
      registry: system.nodes,
      capabilities: testCapabilities(),
      components: system.components.view(),
    });

    // The pin kept the component alive THROUGH the drawable output: the inner solid
    // materialized and renders. Under the kind-blind pick the sink named "c1/sig:out"
    // — a value port — nothing materialized, and the whole instance pruned away.
    expect(compiled.resources.map((resource) => resource.id)).toContain("target:c1/pic:out");
    expect(compiled.outputs.some((output) => output.nodeId === ("c1/pic" as never))).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * T1017 — A PUBLISHED PARAMETER IS A PERFORMANCE KNOB, SO IT HAS TO MOVE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * The published page is the whole reason a component is an instrument: the owner exposes
 * a handful of knobs to the parent and drives them live. They could not move at all. The
 * measured symptom was that the flattened output of a frozen world was BYTE-IDENTICAL
 * across frames 30 / 150 / 260 — an `op()` in a published expression WARNED and a clock
 * expression silently read 0 — while the same component's INTERNAL animation was fine.
 *
 * §V837 for the fourth time (B8 → T593 → T1000 → here): `resolveNodeParameters` was called
 * from the flattener with no resolution context, and `flattenComponents` is memoized on the
 * document revision, so nothing re-evaluated per frame even if it could have. Both call
 * sites read correctly in isolation.
 *
 * The fix is §V5's split one layer up: the STRUCTURE a component flattens to is a pure
 * function of the document and stays memoized; a knob whose mode can move per frame travels
 * as its own UNRESOLVED slot and is evaluated at the internal parameter it drives, by the
 * per-frame values-only resolution that already exists (§V163). So every test here compiles
 * ONE document at two moments and asserts the uniform the shader receives — which is the
 * thing that used to be identical.
 */
describe("animated published parameters (T1017, §V837)", () => {
  const frameAt = (timeSeconds: number, frameIndex: number): FrameEvaluationInput => ({
    timeSeconds,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "offline",
    randomSeed: 7,
  });

  const expressionSlot = (source: string, retained: ParameterValue): ParameterSlot => ({
    mode: "expression",
    bindings: {
      expression: { kind: "expression", source },
      static: { kind: "static", value: retained },
    },
  });

  const drivenSlot = (channel: string, retained: ParameterValue): ParameterSlot => ({
    mode: "driven",
    bindings: {
      driven: { kind: "driven", channel },
      static: { kind: "static", value: retained },
    },
  });

  /** `chain`, with room for the value/reference nodes a published expression reads. */
  const chainWith = (
    instances: GraphNode[],
    extra: ReadonlyArray<GraphNode> = [],
    gen: GraphNode = testNode("gen", "fx.generator", { label: "gen" }),
  ): GraphDocument => {
    const spine = [gen, ...instances, testNode("out", "fx.output")];
    const edges: GraphDocument["edges"] = {};
    for (let index = 0; index < spine.length - 1; index += 1) {
      const from = spine[index] as GraphNode;
      const to = spine[index + 1] as GraphNode;
      edges[`e${index}`] = testEdge(`e${index}`, [from.id, "out"], [to.id, "source"]);
    }
    return graphOf([...spine, ...extra], edges);
  };

  /** The same document, compiled at one moment. Everything else is held constant. */
  const at = (
    definitions: GraphComponentDefinition[],
    graph: GraphDocument,
    frame: FrameEvaluationInput,
  ): CompiledGraph => compileWith(definitions, graph, { resolution: { frame } });

  it("moves an expression-driven knob across frames, at the exact value the clock implies", () => {
    // `time * 10` on a knob that fans out to BOTH internal radii (§V80).
    const document = chainWith([
      instance("c1", "bloom", 1, { parameters: { blur: expressionSlot("time * 10", 4) } }),
    ]);

    const zero = at([bloom()], document, frameAt(0, 0));
    const one = at([bloom()], document, frameAt(1, 60));
    const later = at([bloom()], document, frameAt(2.5, 150));

    // §V839: the exact number at each moment, not merely "it changed". A sign flip, a
    // frames/seconds mix-up, and a fallback to the retained 4 each fail here.
    expect(passFor(zero, "c1/blurA")?.uniforms?.["radius"]).toBe(0);
    expect(passFor(one, "c1/blurA")?.uniforms?.["radius"]).toBe(10);
    expect(passFor(later, "c1/blurA")?.uniforms?.["radius"]).toBe(25);
    // The fan-out still fans out: one knob, every target it drives.
    expect(passFor(later, "c1/blurB")?.uniforms?.["radius"]).toBe(25);

    // The measured defect, stated as the defect.
    expect(JSON.stringify(one.passes)).not.toBe(JSON.stringify(zero.passes));
  });

  it("keeps two instances of one component on their own published expressions", () => {
    // Per-instance state is what makes the published page an instrument rather than a
    // global. Flat ids are `c1/blurA` and `c2/blurA`, so the two slots never meet.
    const document = chainWith([
      instance("c1", "bloom", 1, { parameters: { blur: expressionSlot("time * 10", 4) } }),
      instance("c2", "bloom", 1, { parameters: { blur: expressionSlot("time * 4", 4) } }),
    ]);
    const compiled = at([bloom()], document, frameAt(3, 180));

    expect(passFor(compiled, "c1/blurA")?.uniforms?.["radius"]).toBe(30);
    expect(passFor(compiled, "c2/blurA")?.uniforms?.["radius"]).toBe(12);
  });

  it("resolves op() in a published expression against the flat graph, and stops warning", () => {
    // The measured symptom: `op()` WARNED, because the flattener resolved the published
    // page with no node reference reader. The read now happens where the reader exists.
    const document = chainWith(
      [instance("c1", "bloom", 1, { parameters: { blur: expressionSlot("op('gen').par.amount * 3", 4) } })],
      [],
      testNode("gen", "fx.generator", { label: "gen", parameters: { amount: 7 } }),
    );
    const compiled = at([bloom()], document, frameAt(0, 0));

    expect(passFor(compiled, "c1/blurA")?.uniforms?.["radius"]).toBe(21);
    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.message.includes("op('gen')"))).toEqual([]);
  });

  it("moves a channel-driven knob through the resolver the app actually builds", async () => {
    // The whole seam, in the order `use-graph-compile.ts` assembles it: flatten ONCE,
    // build the channel resolver over the FLAT graph, compile per frame against both. A
    // published knob driven by an LFO is the shape T999's owner asked for by name.
    const { allNodeDefinitions } = await import("../nodes/definitions/index.ts");
    const document = chainWith(
      [instance("c1", "bloom", 1, { parameters: { blur: drivenSlot("lfo1", 4) } })],
      [
        testNode("lfo", "lfo", {
          label: "lfo1",
          parameters: { shape: "sine", frequency: 1, amplitude: 10, offset: 20 },
        }),
      ],
    );

    const system = createComponentSystem(createCompilerTestRegistry(allNodeDefinitions).view(), [bloom()]);
    const flattened = flattenComponents({
      graph: document,
      registry: system.nodes,
      components: system.components.view(),
    });
    const channels = graphChannelResolver(flattened.graph, system.nodes);
    const compileAt = (frame: FrameEvaluationInput): CompiledGraph =>
      compileGraph({
        graph: document,
        settings: testSettings(),
        registry: system.nodes,
        capabilities: testCapabilities(),
        components: system.components.view(),
        flattened,
        resolution: { frame, channels },
      });

    // sin(2πt) at amplitude 10 about 20: the crest and the trough, exactly.
    expect(passFor(compileAt(frameAt(0.25, 15)), "c1/blurA")?.uniforms?.["radius"]).toBeCloseTo(30, 10);
    expect(passFor(compileAt(frameAt(0.75, 45)), "c1/blurA")?.uniforms?.["radius"]).toBeCloseTo(10, 10);
  });

  it("animates a knob republished through two levels of nesting", () => {
    const outer: GraphComponentDefinition = {
      ...wrapper("bloom"),
      parameters: [
        {
          key: "blur",
          definition: { type: "number", label: "Blur", default: 3, min: 0, max: 64 },
          targets: [{ nodeId: "inner", key: "blur" }],
        },
      ],
    };
    const document = chainWith([
      instance("w1", "wrapper", 1, { parameters: { blur: expressionSlot("time * 6", 3) } }),
    ]);

    expect(passFor(at([bloom(), outer], document, frameAt(0, 0)), "w1/inner/blurA")?.uniforms?.["radius"]).toBe(0);
    expect(passFor(at([bloom(), outer], document, frameAt(5, 300)), "w1/inner/blurA")?.uniforms?.["radius"]).toBe(30);
  });

  it("arms the frame loop's own gate, which the instance node used to take with it", async () => {
    // The half that would have made the rest of this describe block dead in the APP.
    // `use-graph-compile.ts` builds `animate` only when `hasAnimatedParameters(flatGraph)`
    // — and the instance node, which carried the slot, is INLINED AWAY. So a document
    // whose only animation was a published knob reported "nothing animates", `animate`
    // was null, and no per-frame values-only compile ran at all. The slot surviving into
    // the flat graph is what answers that question truthfully.
    const { hasAnimatedParameters } = await import("../domain/channels/graph-channels.ts");
    const document = chainWith([
      instance("c1", "bloom", 1, { parameters: { blur: expressionSlot("time * 10", 4) } }),
    ]);
    const system = createComponentSystem(baseNodes, [bloom()]);
    const flattened = flattenComponents({
      graph: document,
      registry: system.nodes,
      components: system.components.view(),
    });

    // The raw document says yes — the slot is right there on the instance node — and the
    // app does not read the raw document (T615, §V464c). The FLAT graph is the one asked,
    // and it answered no, because inlining the instance deleted the only slot in it.
    expect(hasAnimatedParameters(document)).toBe(true);
    expect(hasAnimatedParameters(flattened.graph)).toBe(true);
  });

  it("still bakes a bind at the boundary, whose ref means something else one level in", () => {
    // The hop hazard, and the reason the deferral is a WHITELIST rather than "any slot".
    // `parent.gain` written on an instance names the component that owns the instance;
    // carried inward unresolved it would name the instance itself and silently read a
    // different knob. So a bind resolves where its scope is, and the VALUE fans out.
    const bound: GraphComponentDefinition = {
      componentId: "wrapper" as ComponentId,
      version: 1,
      name: "Wrapper",
      graph: graphOf([
        instance("inner", "bloom", 1, {
          parameters: {
            blur: { mode: "bind", bindings: { bind: { kind: "bind", ref: "parent.gain" } } } satisfies ParameterSlot,
          },
        }),
      ]),
      inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [
        {
          key: "gain",
          definition: { type: "number", label: "Gain", default: 3, min: 0, max: 64 },
          targets: [],
        },
      ],
    };
    const compiled = compileWith([bloom(), bound], chainWith([instance("w1", "wrapper", 1, { parameters: { gain: 17 } })]));

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(passFor(compiled, "w1/inner/blurA")?.uniforms?.["radius"]).toBe(17);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * B8 / T187 / §V56 — THE PUBLISHED BOUNDARY STAYS IN STORED SPACE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * A published page crosses TWO resolutions: the flattener resolves it against the
 * component's own published definitions, then writes it onto internal parameters that
 * resolve again. So the boundary must hand over the number the DOCUMENT holds
 * (display-encoded), never the number EVALUATION consumes (already decoded to linear) —
 * a picked mid-grey handed over decoded reaches the shader at 0.0376 instead of 0.2140,
 * less than a fifth of the light asked for, and it reads as an art-direction choice.
 *
 * T1017 is the change most likely to bring that back, because it moves what crosses this
 * boundary. These pin the arithmetic on both of its paths: a resolved value (unchanged),
 * and a deferred slot (new) — which cannot be double-decoded because a value that was
 * never resolved was never decoded, but that is an argument, and this is the measurement.
 */
describe("published colour space through a flattening (§V56, B8)", () => {
  /** sRGB EOTF of 0.5 — the number B8 is about. Decoding it TWICE gives 0.0376. */
  const MID_GREY_LINEAR = 0.21404114048223255;
  // Measured by mutating the boundary to hand over `values` instead of `entries[].value`
  // — B8's own arithmetic, decoded twice — rather than derived on paper.
  const MID_GREY_TWICE = 0.0376494785571514;

  const painter = (published: PublishedParameter[]): GraphComponentDefinition => ({
    componentId: "painter" as ComponentId,
    version: 1,
    name: "Painter",
    graph: graphOf([testNode("fill", "solid", { parameters: { color: [0, 0, 0, 1] } })]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "fill", portId: "out" }],
    parameters: published,
  });

  const tint = (targets: Array<{ nodeId: string; key: string }>): PublishedParameter => ({
    key: "tint",
    definition: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" },
    targets,
  });

  const compileReal = async (
    definition: GraphComponentDefinition,
    node: GraphNode,
  ): Promise<CompiledGraph> => {
    const { allNodeDefinitions } = await import("../nodes/definitions/index.ts");
    const { createNodeRegistry } = await import("../nodes/registry/registry.ts");
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), [definition]);
    return compileGraph({
      graph: graphOf([node]),
      settings: testSettings(),
      registry: system.nodes,
      capabilities: testCapabilities(),
      components: system.components.view(),
    });
  };

  const filledWith = (compiled: CompiledGraph): readonly number[] | undefined => {
    const pass = effects(compiled.passes).find((candidate) => candidate.nodeId === "c1/fill");
    const color = pass?.uniforms?.["color"];
    return Array.isArray(color) ? (color as readonly number[]) : undefined;
  };

  it("decodes a published display colour exactly once", async () => {
    const compiled = await compileReal(
      painter([tint([{ nodeId: "fill", key: "color" }])]),
      instance("c1", "painter" as ComponentId, 1, {
        ui: { previewPinned: true },
        parameters: { tint: [0.5, 0.5, 0.5, 1] },
      }),
    );

    expect(filledWith(compiled)?.[0]).toBeCloseTo(MID_GREY_LINEAR, 10);
    expect(filledWith(compiled)?.[0]).not.toBeCloseTo(MID_GREY_TWICE, 4);
  });

  it("decodes it exactly once when a per-component slot drives one channel (§V113)", async () => {
    // The compound is published at the bare key while storage carries a slot PER
    // COMPONENT, so the boundary reassembles rather than deferring — the path where a
    // second decode would be easiest to reintroduce without noticing.
    const compiled = await compileReal(
      painter([tint([{ nodeId: "fill", key: "color" }])]),
      instance("c1", "painter" as ComponentId, 1, {
        ui: { previewPinned: true },
        parameters: {
          tint: [0, 0, 0, 1],
          "tint.r": {
            mode: "expression",
            bindings: { expression: { kind: "expression", source: "0.5" } },
          } satisfies ParameterSlot,
        },
      }),
    );

    expect(filledWith(compiled)?.[0]).toBeCloseTo(MID_GREY_LINEAR, 10);
    expect(filledWith(compiled)?.[0]).not.toBeCloseTo(MID_GREY_TWICE, 4);
  });
});

/**
 * T1030 — MUTE AND BYPASS ON AN INSTANCE SURVIVE FLATTENING. Inlining dissolves the
 * instance node, and its ui flags dissolved with it — so muting a whole component
 * changed nothing (owner-reported against E51's TimeGrid). A flagged instance is now
 * NOT inlined: the node stays, carrying its flags, and the compiler's ONE mute/bypass
 * splice treats it as it treats every node — no component-shaped second copy of that
 * rule to drift (§V109).
 */
describe("mute and bypass on a component instance (T1030)", () => {
  it("a MUTED instance contributes nothing: no interior, and downstream reads unconnected", () => {
    const compiled = compileWith(
      [bloom()],
      chain([instance("c1", "bloom", 1, { ui: { muted: true } } as never)]),
    );
    // The interior never entered the plan — not compiled-and-discarded, never minted.
    expect(compiled.order.filter((id) => id.startsWith("c1/"))).toEqual([]);
    expect(compiled.order).not.toContain("c1");
    // Downstream honestly reads its port as unconnected — the same consequence muting
    // any other mid-chain producer has (§V504's rule, reached through the same splice).
    expect(
      compiled.diagnostics.some(
        (d) => d.nodeId === "out" || d.message.includes('"out"'),
      ),
    ).toBe(true);
    // And the synthesized manifest's "notFlattened" tripwire never fires: the splice
    // removed the node before anything tried to compile it.
    expect(compiled.diagnostics.map((d) => d.code)).not.toContain("component.notFlattened");
  });

  it("a BYPASSED instance passes its input through — downstream reads the outer source", () => {
    const compiled = compileWith(
      [bloom()],
      chain([instance("c1", "bloom", 1, { ui: { bypassed: true } } as never)]),
    );
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.order.filter((id) => id.startsWith("c1/"))).toEqual([]);
    // The splice's passthrough: out consumes gen directly, the whole interior skipped.
    const output = passFor(compiled, "out");
    expect(output?.textures?.[0]?.resourceId).toBe("target:gen:out");
  });

  it("an UNFLAGGED instance still inlines exactly as before — the guard is inert at rest", () => {
    const compiled = compileWith([bloom()], chain([instance("c1", "bloom", 1)]));
    expect(compiled.order).toContain("c1/blurA");
    expect(compiled.order).not.toContain("c1");
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
