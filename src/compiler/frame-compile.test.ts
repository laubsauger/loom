import { describe, expect, it } from "vitest";

import { createComponentSystem } from "../domain/components/index.ts";
import { loadProject } from "../domain/project/index.ts";
import { hasAnimatedParameters, nodeHasAnimatedParameters, graphChannelResolver } from "../domain/channels/graph-channels.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { NodeDefinition, NodeCompileContext } from "../domain/types/node-definition.ts";
import type { ParameterDefinition, ParameterSlot, ParameterValue } from "../domain/types/parameters.ts";
import { RGBA_TEXTURE } from "../nodes/definitions/common-ports.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { minimalGraphFor } from "../nodes/definitions/test-support.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples } from "../examples/catalogue.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { compileGraph, compileGraphRetaining } from "./compile.ts";
import { flattenComponents } from "./flatten.ts";
import { animatedRootKeys, prepareFrameCompiler, structuralParameterKeys } from "./frame-compile.ts";
import { asCompilerContext } from "./types.ts";
import type { CompileRequest } from "./types.ts";

/**
 * T1182 / T1183 — the per-frame VALUES-ONLY compile is provably structure-preserving.
 *
 * The claim under test is not "the fast path is fast"; it is that what it hands the frame
 * loop is EXACTLY what the full compile at that frame would have handed it (`passes`,
 * uniform values and loop counts included), and that when it cannot prove that, it says
 * so and steps aside (§V936). Four derivations, none hand-listed:
 *
 *  1. every SHIPPED EXAMPLE that animates: spliced passes equal the full compile's at
 *     several frames — and at least one example's passes MOVE between frames, so the
 *     equality is not vacuous;
 *  2. every NON-`compileTime` parameter of every REGISTERED node type, driven across a
 *     frame threshold: the spliced plan equals the full one (§V453, the T1182 gate) — a
 *     definition whose structure depends on a parameter it did not declare structural
 *     fails here by name;
 *  3. every `compileTime` parameter of every registered node type, animated: the
 *     classifier refuses the document and names the key; and every key an
 *     `outputWhen` / `msaaWhen` predicate READS is in that structural set;
 *  4. a definition that LIES (structure from a non-compileTime parameter): the verifier
 *     catches the frame that crosses, returns null, and stays degraded — the caller's
 *     full compile is then the same plan it always was.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
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

/** `a` before frame `at`, `b` from it on — one expression, two moments. */
const stepExpression = (a: number, b: number, at: number): string => `${a} + (${b} - ${a}) * (frame >= ${at})`;

function withParameter(graph: GraphDocument, nodeId: string, key: string, slot: ParameterSlot): GraphDocument {
  const node = graph.nodes[nodeId] as GraphNode;
  return {
    ...graph,
    nodes: { ...graph.nodes, [nodeId]: { ...node, parameters: { ...node.parameters, [key]: slot } } },
  };
}

function requestFor(graph: GraphDocument, extra: Partial<CompileRequest> = {}): CompileRequest {
  return { graph, settings, registry, capabilities: TIER_B_CAPABILITIES, ...extra };
}

/* ------------------------------------------------------------------------------------ */
/* 1. shipped examples                                                                   */
/* ------------------------------------------------------------------------------------ */

describe("T1182: every animated shipped example splices to exactly the full compile", () => {
  const registryBase = createNodeRegistry(allNodeDefinitions).view();
  const animated = listExamples()
    .map((file) => {
      const system = createComponentSystem(registryBase);
      const loaded = loadProject(file.text, { nodes: system.nodes });
      if (!loaded.ok) return null;
      for (const definition of loaded.components) system.components.register(definition);
      const components = system.components.view();
      const flattened = flattenComponents({ graph: loaded.document.graph, registry: system.nodes, components });
      if (!hasAnimatedParameters(flattened.graph)) return null;
      const channels = graphChannelResolver(flattened.graph, system.nodes);
      const request: CompileRequest = {
        graph: loaded.document.graph,
        settings: loaded.document.settings,
        registry: system.nodes,
        capabilities: TIER_B_CAPABILITIES,
        components,
        flattened,
        resolution: { channels },
      };
      return { fileName: file.fileName, request, channels, flatGraph: flattened.graph };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  it("has animated examples to compare — the derivation is not silently empty", () => {
    expect(animated.length).toBeGreaterThan(10);
  });

  it("classifies every shipped animated example as values-only (or names a structural key)", () => {
    for (const entry of animated) {
      const prepared = prepareFrameCompiler(entry.request);
      if (!prepared.uniformOnly) {
        // A shipped document that animates a compileTime parameter is a real thing to
        // know about (the fast path is off for it) — but it is not a defect of this
        // path, which must refuse it. The refusal must name a node and a key.
        expect(prepared.reason, entry.fileName).toMatch(/Node ".+" \(.+\) animates ".+"/);
      }
    }
  });

  it("splices passes equal to the full compile at frames 1, 37 and 240, and at least one moves", () => {
    const frames = [1, 37, 240];
    let moved = 0;
    let compared = 0;
    for (const entry of animated) {
      const prepared = prepareFrameCompiler(entry.request);
      if (!prepared.uniformOnly) continue;
      for (const frameIndex of frames) {
        const resolution = { frame: frameAt(frameIndex), channels: entry.channels };
        const spliced = prepared.compileFrame(resolution);
        expect(spliced, `${entry.fileName} frame ${String(frameIndex)}: ${prepared.reason ?? ""}`).not.toBeNull();
        if (spliced === null) continue;
        const full = compileGraph({ ...entry.request, resolution });
        expect(spliced.passes, `${entry.fileName} frame ${String(frameIndex)}`).toEqual(full.passes);
        expect(spliced.signature, entry.fileName).toBe(full.signature);
        expect(spliced.signature, entry.fileName).toBe(prepared.base.signature);
        compared += 1;
        if (JSON.stringify(spliced.passes) !== JSON.stringify(prepared.base.passes)) moved += 1;
      }
    }
    expect(compared).toBeGreaterThan(10);
    // The equality above is worthless if nothing ever animates; the shipped set must
    // contain frames whose uniforms differ from the base's.
    expect(moved).toBeGreaterThan(5);
  });

  it("animatedRootKeys agrees with nodeHasAnimatedParameters on every shipped node", () => {
    let nodes = 0;
    for (const entry of animated) {
      for (const node of Object.values(entry.flatGraph.nodes)) {
        nodes += 1;
        expect(animatedRootKeys(node).size > 0, `${entry.fileName} ${node.id}`).toBe(nodeHasAnimatedParameters(node));
      }
    }
    expect(nodes).toBeGreaterThan(100);
  });
});

/* ------------------------------------------------------------------------------------ */
/* 2. every non-compileTime parameter of every node type (§V453)                         */
/* ------------------------------------------------------------------------------------ */

/**
 * The numbers an expression can take a parameter through, per type — an expression
 * evaluates to a NUMBER and `coerceExpressionResult` (§V107) is the bridge: boolean is
 * ≠0, enum is an index, string is `String(n)`, vector and colour broadcast. Curve and
 * asset cannot take an expression at all and are not animatable.
 */
function perturbations(parameter: ParameterDefinition): { from: number; to: number[] } | null {
  switch (parameter.type) {
    case "number": {
      const from = typeof parameter.default === "number" ? parameter.default : 0;
      const candidates = [parameter.min, parameter.max, from + 1, from * 2 + 1, 0].filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value) && value !== from,
      );
      return { from, to: [...new Set(candidates)] };
    }
    case "boolean":
    case "pulse": {
      // A pulse has no default; it rests at 0.
      const from = (parameter as { default?: boolean }).default === true ? 1 : 0;
      return { from, to: [1 - from] };
    }
    case "enum": {
      const from = Math.max(0, parameter.options.findIndex((option) => option.value === parameter.default));
      return { from, to: parameter.options.map((_, index) => index).filter((index) => index !== from) };
    }
    case "string":
      return { from: 0, to: [1] };
    case "vector":
      return { from: 0, to: [1, 3] };
    case "color":
      return { from: 0, to: [0.5, 1] };
    default:
      return null;
  }
}

describe("T1182 gate: a parameter that is not compileTime never changes the plan's structure", () => {
  const sweep = allNodeDefinitions.filter(
    (definition) => definition.valueChannel === undefined && definition.valueEvaluate === undefined,
  );

  it("sweeps a real catalogue", () => {
    expect(sweep.length).toBeGreaterThan(50);
  });

  for (const definition of sweep) {
    it(`${definition.type}: every value parameter splices to the full compile across a threshold`, () => {
      const base = minimalGraphFor(definition, registry) as unknown as GraphDocument;
      const schema = effectiveParameterSchema(definition, {});
      let checked = 0;
      for (const [key, parameter] of Object.entries(schema)) {
        if (parameter.compileTime === true) continue;
        const range = perturbations(parameter);
        if (range === null) continue;
        for (const to of range.to) {
          const retained = (parameter as { default?: ParameterValue }).default ?? 0;
          const graph = withParameter(base, "subject", key, expressionSlot(stepExpression(range.from, to, 1), retained));
          const prepared = prepareFrameCompiler(requestFor(graph));
          const label = `${definition.type}.${key} -> ${String(to)}`;
          expect(prepared.uniformOnly, `${label}: ${prepared.reason ?? ""}`).toBe(true);
          const resolution = { frame: frameAt(1) };
          const spliced = prepared.compileFrame(resolution);
          expect(spliced, `${label}: ${prepared.reason ?? ""}`).not.toBeNull();
          if (spliced === null) continue;
          const full = compileGraph(requestFor(graph, { resolution }));
          expect(spliced.passes, label).toEqual(full.passes);
          expect(spliced.signature, label).toBe(full.signature);
          checked += 1;
        }
      }
      // A node with no animatable value parameter checks nothing here, and that is fine
      // — but it is stated, so a sweep over an emptied schema cannot pass by accident.
      if (checked === 0) expect(Object.values(schema).every((p) => p.compileTime === true || perturbations(p) === null)).toBe(true);
    });
  }
});

/* ------------------------------------------------------------------------------------ */
/* 3. the classifier: structural keys, derived from the definitions                      */
/* ------------------------------------------------------------------------------------ */

describe("T1183: the structural parameter set is derived from the definitions", () => {
  it("every key an outputWhen / msaaWhen predicate reads is structural", () => {
    let predicates = 0;
    for (const definition of allNodeDefinitions) {
      const structural = structuralParameterKeys(definition, {});
      const hooks = [
        ...Object.values(definition.outputWhen ?? {}),
        ...Object.values(definition.msaaWhen ?? {}),
      ];
      for (const predicate of hooks) {
        predicates += 1;
        const read = new Set<string>();
        const probe = new Proxy<Record<string, unknown>>({}, {
          get: (_target, property) => {
            if (typeof property === "string") read.add(property);
            return undefined;
          },
          has: (_target, property) => {
            if (typeof property === "string") read.add(property);
            return false;
          },
        });
        predicate(probe as Record<string, ParameterValue>);
        expect(read.size, `${definition.type}: a predicate that reads nothing is not a predicate`).toBeGreaterThan(0);
        for (const key of read) {
          expect(structural.has(key), `${definition.type}.${key} is read by outputWhen/msaaWhen and must be compileTime`).toBe(true);
        }
      }
    }
    // The render node's two hooks at least; a registry with none would make this vacuous.
    expect(predicates).toBeGreaterThan(1);
  });

  it("animating any compileTime parameter of any node type turns the fast path off, by name", () => {
    let refused = 0;
    for (const definition of allNodeDefinitions) {
      if (definition.valueChannel !== undefined || definition.valueEvaluate !== undefined) continue;
      const base = minimalGraphFor(definition, registry) as unknown as GraphDocument;
      const schema = effectiveParameterSchema(definition, {});
      for (const [key, parameter] of Object.entries(schema)) {
        if (parameter.compileTime !== true) continue;
        const retained = (parameter as { default?: ParameterValue }).default ?? 0;
        const graph = withParameter(base, "subject", key, expressionSlot("1", retained));
        const prepared = prepareFrameCompiler(requestFor(graph));
        expect(prepared.uniformOnly, `${definition.type}.${key}`).toBe(false);
        expect(prepared.reason, `${definition.type}.${key}`).toContain(`Node "subject" (${definition.type}) animates "${key}"`);
        expect(prepared.compileFrame({ frame: frameAt(1) })).toBeNull();
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(30);
  });

  it("a cache whose frame depth crosses a threshold: the plan changes in full, and the fast path never runs", () => {
    const cache = allNodeDefinitions.find((definition) => definition.type === "cache");
    expect(cache).toBeDefined();
    const base = minimalGraphFor(cache as NodeDefinition, registry) as unknown as GraphDocument;
    const graph = withParameter(base, "subject", "frames", expressionSlot(stepExpression(4, 8, 30), 4));

    // Through the real compile: the ring is 4 deep before frame 30 and 8 deep from it.
    const before = compileGraph(requestFor(graph, { resolution: { frame: frameAt(29) } }));
    const after = compileGraph(requestFor(graph, { resolution: { frame: frameAt(30) } }));
    const ringFrames = (plan: typeof before): number[] =>
      plan.resources.flatMap((resource) => (resource.kind === "ring" ? [resource.frames] : []));
    expect(ringFrames(before)).toEqual([4]);
    expect(ringFrames(after)).toEqual([8]);
    expect(after.signature).not.toBe(before.signature);

    const prepared = prepareFrameCompiler(requestFor(graph));
    expect(prepared.uniformOnly).toBe(false);
    expect(prepared.reason).toContain('Node "subject" (cache) animates "frames"');
    expect(prepared.compileFrame({ frame: frameAt(29) })).toBeNull();
    expect(prepared.compileFrame({ frame: frameAt(30) })).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------ */
/* 4. the verifier: a definition that lies is caught per frame (§V936)                   */
/* ------------------------------------------------------------------------------------ */

describe("T1182 verifier: a structure change from a value parameter is caught, not spliced", () => {
  /** Shader text that depends on a parameter the manifest calls a plain value. */
  const liar: NodeDefinition = {
    type: "liar",
    version: 1,
    label: "Liar",
    category: "generators",
    description: "Its shader depends on `threshold`, which it does not declare compileTime.",
    inputs: [],
    outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
    parameters: {
      threshold: { type: "number", label: "Threshold", default: 0, min: 0, max: 1 },
      gain: { type: "number", label: "Gain", default: 1 },
    },
    resolutionPolicy: { kind: "project" },
    compile(raw: NodeCompileContext) {
      const context = asCompilerContext(raw);
      const threshold = context.parameters["threshold"] as number;
      const gain = context.parameters["gain"] as number;
      const shader = threshold > 0.5 ? "// branch B\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }" : "// branch A\n@fragment fn fs() -> @location(0) vec4f { return vec4f(0); }";
      return {
        passes: [{ kind: "effect", id: "main", shader, uniforms: { gain }, uniformBinding: "params" }],
      };
    },
  } as unknown as NodeDefinition;

  const liarRegistry = createNodeRegistry([...allNodeDefinitions, liar]).view();
  const graph = (): GraphDocument => {
    const base = minimalGraphFor(liar, liarRegistry) as unknown as GraphDocument;
    return withParameter(base, "subject", "threshold", expressionSlot(stepExpression(0, 1, 10), 0));
  };
  const request = (resolution?: CompileRequest["resolution"]): CompileRequest => ({
    graph: graph(),
    settings,
    registry: liarRegistry,
    capabilities: TIER_B_CAPABILITIES,
    ...(resolution === undefined ? {} : { resolution }),
  });

  it("splices while the lie is dormant, refuses the frame that crosses, and stays refused", () => {
    const prepared = prepareFrameCompiler(request());
    expect(prepared.uniformOnly).toBe(true);

    const early = prepared.compileFrame({ frame: frameAt(1) });
    expect(early).not.toBeNull();
    expect(early?.passes).toEqual(compileGraph(request({ frame: frameAt(1) })).passes);

    // The full compile at the crossing carries branch B: the fall-through is not optional.
    const shaderOf = (plan: typeof prepared.base): string | undefined => {
      const pass = plan.passes.find((candidate) => candidate.id === "subject#main");
      return pass !== undefined && "shader" in pass ? pass.shader : undefined;
    };
    const crossed = compileGraph(request({ frame: frameAt(10) }));
    expect(shaderOf(prepared.base)).toContain("branch A");
    expect(shaderOf(crossed)).toContain("branch B");

    expect(prepared.compileFrame({ frame: frameAt(10) })).toBeNull();
    expect(prepared.reason).toContain('Node "subject" (liar) emitted pass "subject#main" with a different structure');
    // Degraded for the life of the prepared compiler: a definition that lied once is
    // not trusted at frame 1 either.
    expect(prepared.compileFrame({ frame: frameAt(1) })).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------ */
/* 5. what travels: loop counts and scene payloads                                       */
/* ------------------------------------------------------------------------------------ */

describe("T1182: loop counts and scene payloads move with the frame", () => {
  const KERNEL_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv) + vec4f(0.01, 0.0, 0.0, 1.0);
}`;

  it("a driven substeps count reaches the loop-begin marker through the same clamp", () => {
    const graph = {
      revision: 1,
      groups: {},
      nodes: {
        state: {
          id: "state",
          type: "feedback",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { source: "kernel1", persistence: 1, substeps: expressionSlot(stepExpression(1, 3, 5), 1) },
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
        "e-state-kernel": { id: "e-state-kernel", source: { nodeId: "state", portId: "out" }, target: { nodeId: "kernel", portId: "input" } },
        "e-kernel-out": { id: "e-kernel-out", source: { nodeId: "kernel", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
    } as unknown as GraphDocument;
    const prepared = prepareFrameCompiler(requestFor(graph));
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    const countAt = (frameIndex: number): { spliced: number | undefined; full: number | undefined } => {
      const resolution = { frame: frameAt(frameIndex) };
      const spliced = prepared.compileFrame(resolution);
      expect(spliced, prepared.reason ?? "").not.toBeNull();
      const full = compileGraph(requestFor(graph, { resolution }));
      expect(spliced?.passes).toEqual(full.passes);
      const begin = (plan: typeof full) => plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
      const b = begin(spliced as typeof full);
      const f = begin(full);
      return { spliced: b?.kind === "loop" ? b.count : undefined, full: f?.kind === "loop" ? f.count : undefined };
    };
    expect(countAt(4)).toEqual({ spliced: 1, full: 1 });
    expect(countAt(5)).toEqual({ spliced: 3, full: 3 });
  });

  it("an animated camera moves the render's uniforms — the payload travels the scene edge", () => {
    const camera = allNodeDefinitions.find((definition) => definition.type === "camera") as NodeDefinition;
    const base = minimalGraphFor(camera, registry) as unknown as GraphDocument;
    const graph = withParameter(base, "subject", "fov", expressionSlot(stepExpression(40, 70, 1), 40));
    const prepared = prepareFrameCompiler(requestFor(graph));
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    const resolution = { frame: frameAt(1) };
    const spliced = prepared.compileFrame(resolution);
    expect(spliced, prepared.reason ?? "").not.toBeNull();
    const full = compileGraph(requestFor(graph, { resolution }));
    expect(spliced?.passes).toEqual(full.passes);
    // The render node ("observe") itself animates nothing; only the camera it names does.
    // Its uniforms must still differ from the base's, or the payload did not travel.
    const renderUniforms = (plan: typeof full) =>
      plan.passes.filter((pass) => "nodeId" in pass && pass.nodeId === "observe" && "uniforms" in pass).map((pass) => ("uniforms" in pass ? pass.uniforms : undefined));
    expect(renderUniforms(spliced as typeof full).length).toBeGreaterThan(0);
    expect(renderUniforms(spliced as typeof full)).not.toEqual(renderUniforms(prepared.base));
  });
});

/* ------------------------------------------------------------------------------------ */
/* 6. a supplied base: reused when it is this request's compile, refused when it is not  */
/* ------------------------------------------------------------------------------------ */

/**
 * T1254 — the app's structural memo has already compiled the request in full by the time
 * the first frame asks, so the frame compiler takes THAT result as its base rather than
 * compiling its own. Two claims:
 *
 *  - reuse is real: with a base supplied, no definition compiles a second time, and the
 *    plan the frames splice over IS the supplied one (identity);
 *  - a base compiled for some OTHER request — a different sink set, a graph with a
 *    different value, a base resolved AT a frame — is refused by name, never spliced
 *    over. A silently accepted foreign base would be a wrong plan wearing a fast path,
 *    and the per-frame verifier (§V936) compares against the base, so it cannot catch
 *    a base that is itself wrong.
 */
describe("T1254: a caller's own full compile is the base — reused, or refused by name", () => {
  const solidBlur = (blurSize: number): GraphDocument =>
    ({
      revision: 1,
      groups: {},
      nodes: {
        solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        blur: {
          id: "blur",
          type: "blur",
          definitionVersion: 1,
          position: { x: 200, y: 0 },
          parameters: { size: expressionSlot(`${String(blurSize)} + frame * 0.5`, 1) },
        },
      },
      edges: {
        "e-solid-blur": { id: "e-solid-blur", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "blur", portId: "input" } },
      },
    }) as unknown as GraphDocument;

  /** The catalogue with ONE definition's `compile` counted — the solid never animates here. */
  function countingRegistry(type: string): { view: typeof registry; compiles: () => number } {
    let compiles = 0;
    const counted = new Map<string, NodeDefinition>();
    const wrap = (definition: NodeDefinition | undefined): NodeDefinition | undefined => {
      if (definition === undefined || definition.type !== type) return definition;
      let wrapped = counted.get(definition.type);
      if (wrapped === undefined) {
        wrapped = {
          ...definition,
          compile: (context: NodeCompileContext) => {
            compiles += 1;
            return definition.compile(context);
          },
        };
        counted.set(definition.type, wrapped);
      }
      return wrapped;
    };
    const view: typeof registry = {
      ...registry,
      get: (name) => wrap(registry.get(name)),
      require: (name) => wrap(registry.require(name)) as NodeDefinition,
    };
    return { view, compiles: () => compiles };
  }

  const previewSinks: CompileRequest["sinks"] = [{ nodeId: "blur", portId: "out", kind: "preview" }];

  it("splices over the supplied base itself, and compiles nothing a second time", () => {
    const counting = countingRegistry("solid");
    const request = requestFor(solidBlur(2), { registry: counting.view, sinks: previewSinks });
    const base = compileGraphRetaining(request);
    expect(base.retained).not.toBeNull();
    expect(counting.compiles(), "the caller's own full compile").toBe(1);

    const prepared = prepareFrameCompiler(request, base);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    // Red-verify: `prepareFrameCompiler(request)` here — the compiler's own compile — reads 2.
    expect(counting.compiles(), "no second full compile with a base supplied").toBe(1);
    expect(prepared.base).toBe(base.compiled);

    const spliced = prepared.compileFrame({ frame: frameAt(15) });
    expect(spliced, prepared.reason ?? "").not.toBeNull();
    // The frame re-emits the blur only; the solid's pass is the supplied base's object.
    expect(counting.compiles()).toBe(1);
    expect(spliced?.signature).toBe(base.compiled.signature);
    const solidPass = (plan: { passes: ReadonlyArray<{ id: string }> }) => plan.passes.find((pass) => pass.id === "solid:fill");
    expect(solidPass(spliced as NonNullable<typeof spliced>)).toBe(solidPass(base.compiled));
    expect(spliced?.passes).toEqual(compileGraph({ ...request, resolution: { frame: frameAt(15) } }).passes);
  });

  it("refuses a base compiled for a different sink set, graph or moment — by name", () => {
    const graph = solidBlur(2);
    const request = requestFor(graph, { sinks: previewSinks });
    const cases: ReadonlyArray<{ label: string; base: CompileRequest; names: string }> = [
      { label: "sink set", base: requestFor(graph, { sinks: [{ nodeId: "solid", portId: "out", kind: "preview" }] }), names: "sinks" },
      { label: "graph", base: requestFor(solidBlur(3), { sinks: previewSinks }), names: "graph" },
      { label: "resolved at a frame", base: requestFor(graph, { sinks: previewSinks, resolution: { frame: frameAt(9) } }), names: "resolution.frame" },
    ];
    for (const entry of cases) {
      const foreign = compileGraphRetaining(entry.base);
      expect(foreign.retained, entry.label).not.toBeNull();
      expect(() => prepareFrameCompiler(request, foreign), entry.label).toThrow(new RegExp(`\\(${entry.names.replace(".", "\\.")} differs\\)`));
    }
    // The sink-set case is the one the app can hit (B95): the same graph, a different
    // kept set — the foreign base has one pass set, the request another, and the
    // verifier would happily splice frames over the wrong one.
    const foreignSinks = compileGraphRetaining(cases[0]!.base).compiled;
    expect(foreignSinks.signature).not.toBe(compileGraph(request).signature);
    // The same request compiled by anyone is accepted: value-equal sinks, not identical arrays.
    const twin = requestFor(graph, { sinks: [{ nodeId: "blur", portId: "out", kind: "preview" }] });
    expect(() => prepareFrameCompiler(request, compileGraphRetaining(twin))).not.toThrow();
  });
});
