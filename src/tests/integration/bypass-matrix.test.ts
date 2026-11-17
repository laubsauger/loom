import { describe, expect, it } from "vitest";

import { compileGraph, compileGraphRetaining, flattenComponents } from "@compiler/index.ts";
import { testCapabilities, testSettings } from "@compiler/test-support.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType, createComponentSystem } from "@domain/components/index.ts";
import { bypassPassesKind, bypassPassthroughPairs } from "@domain/graph/bypass.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { expressionSlot } from "@/examples/documents/builders.ts";
import { instanceValueChannels } from "@/app/instance-value-channels.ts";
import { mappingTargetsOf } from "@/app/perform-mapping.ts";

/**
 * B301 (§V1035) — BYPASS AND MUTE, EVERY NODE CLASS, EVERY SEAM, ONE RULE.
 *
 * The owner: "definitely need to figure out the bypass, that's essential loom core that
 * needs to work." A node switched off from a Panel or a preset is bypassed (§T1770b), so
 * what bypass DOES is what the show does. The rule:
 *
 *  - BYPASS replaces the node by wires. Output k of a kind passes input k of that kind,
 *    unchanged; an output with no partner passes nothing and reads disconnected.
 *  - MUTE produces nothing on any output.
 *
 * Two seams carry it and must give the same answer: the compiler (textures and pointsets:
 * which resource a consumer's pass reads) and the value graph (which bag a consumer gets).
 * Before this row they did not, for a component instance: the value graph passed nothing
 * through one (the literal B301), and the compiler handed EVERY output the first output's
 * input, whatever its kind.
 *
 * Each case below is one cell of the matrix: a subject (a plain node, or an instance with
 * the given input and output kinds), a distinct source wired to each input, a consumer on
 * each output, and what each consumer must read while the subject is live, bypassed and
 * muted. Real flattener, real compiler, real value graph. What a consumer reads is the
 * observable: the resource its pass samples, or its value bag.
 */

type Kind = "texture2d" | "pointset" | "value";
const T: Kind = "texture2d";
const P: Kind = "pointset";
const V: Kind = "value";
const short = (kind: Kind): string => (kind === T ? "T" : kind === P ? "P" : "V");

const IN: Record<Kind, string> = { texture2d: "componentIn", pointset: "componentInPoints", value: "componentInValue" };
const OUT: Record<Kind, string> = { texture2d: "componentOut", pointset: "componentOutPoints", value: "componentOutValue" };
/** What an instance does to an input on its way to an output: something that changes it. */
const PROCESS: Record<Kind, readonly [string, Record<string, unknown>]> = {
  texture2d: ["level", { brightness: 0.5 }],
  pointset: ["pointTransform", {}],
  value: ["valueLimit", { minimum: 0, maximum: 1 }],
};
/** What an output with no input of its kind is made from inside the instance. */
const INNER_SOURCE: Record<Kind, readonly [string, Record<string, unknown>]> = {
  texture2d: ["solid", { color: [1, 0, 0, 1] }],
  pointset: ["pointGrid", {}],
  value: ["constant", { value: 9 }],
};

const FRAME: FrameEvaluationInput = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 1 };

const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
const registry = system.nodes;

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, ui?: GraphNode["ui"], y = 0): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y }, parameters, label: id, ...(ui === undefined ? {} : { ui }) }) as never;

/** The nth port of a kind on a node type, in declaration order. */
function portOf(type: string, side: "inputs" | "outputs", kind: Kind, nth: number): string {
  const port = registry.get(type)?.[side].filter((each) => each.type.kind === kind)[nth];
  if (port === undefined) throw new Error(`${type} has no ${side} #${String(nth)} of kind ${kind}`);
  return port.id;
}

class Wiring {
  readonly nodes: Record<string, GraphNode> = {};
  readonly edges: Record<string, GraphEdge> = {};
  add(each: GraphNode): void {
    this.nodes[each.id] = each;
  }
  wire(from: string, to: string, kind: Kind, fromNth = 0, toNth = 0): void {
    const id = `e${String(Object.keys(this.edges).length)}`;
    this.edges[id] = {
      id,
      source: { nodeId: from, portId: portOf(this.nodes[from]!.type, "outputs", kind, fromNth) },
      target: { nodeId: to, portId: portOf(this.nodes[to]!.type, "inputs", kind, toNth) },
    } as never;
  }
}

/** Registers a component: output k processes the first input of its kind, else an inner source. */
function component(ins: readonly Kind[], outs: readonly Kind[]): string {
  const componentId = `c${ins.map(short).join("") || "0"}x${outs.map(short).join("")}`.toLowerCase();
  const inner = new Wiring();
  ins.forEach((kind, index) => inner.add(node(`in${String(index)}`, IN[kind], {}, undefined, index * 100)));
  outs.forEach((kind, index) => {
    inner.add(node(`out${String(index)}`, OUT[kind], {}, undefined, index * 100));
    const feeder = ins.indexOf(kind);
    const [type, parameters] = feeder >= 0 ? PROCESS[kind] : INNER_SOURCE[kind];
    inner.add(node(`p${String(index)}`, type, parameters));
    if (feeder >= 0) inner.wire(`in${String(feeder)}`, `p${String(index)}`, kind);
    inner.wire(`p${String(index)}`, `out${String(index)}`, kind);
  });
  system.components.register({
    componentId,
    version: 1,
    name: componentId,
    graph: { revision: 1, groups: {}, nodes: inner.nodes, edges: inner.edges },
    inputs: [],
    outputs: [],
    parameters: [],
  } as never);
  return componentNodeType(componentId, 1);
}

/**
 * What one consumer reads: `"src1"` — the source wired to the subject's input #1, passed
 * through; `"own"` — what the subject itself makes; `null` — nothing (no pass, no bag).
 */
type Reads = string | null;

interface Cell {
  readonly name: string;
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
  readonly ins: readonly Kind[];
  readonly outs: readonly Kind[];
  /** Per output, while BYPASSED. Live is always "own" and muted always null. */
  readonly bypassed: readonly Reads[];
  /** The compiler says the bypass passes nothing at all (`compiler/bypass-incoherent`). */
  readonly incoherent?: true;
}

const plain = (name: string, type: string, ins: readonly Kind[], outs: readonly Kind[], bypassed: readonly Reads[], extra: Partial<Cell> = {}): Cell => ({
  name: `${name} (${type})`,
  type,
  ins,
  outs,
  bypassed,
  ...extra,
});
const instance = (ins: readonly Kind[], outs: readonly Kind[], bypassed: readonly Reads[], extra: Partial<Cell> = {}): Cell => ({
  name: `instance in[${ins.map(short).join(",")}] out[${outs.map(short).join(",")}]`,
  type: component(ins, outs),
  ins,
  outs,
  bypassed,
  ...extra,
});

const CELLS: readonly Cell[] = [
  // A node with one output: the rule every node has always answered to.
  plain("texture filter", "level", [T], [T], ["src0"], { parameters: { brightness: 0.5 } }),
  plain("texture source", "solid", [], [T], [null]),
  plain("converter", "renderPoints", [P], [T], [null], { incoherent: true }),
  plain("point filter", "pointTransform", [P], [P], ["src0"]),
  plain("point source", "pointGrid", [], [P], [null]),
  plain("value filter", "valueLimit", [V], [V], ["src0"], { parameters: { minimum: 0, maximum: 1 } }),
  plain("value source", "constant", [], [V], [null], { parameters: { value: 9 } }),
  // An instance with one input and one output, per kind. `V → V` is the literal B301.
  instance([T], [T], ["src0"]),
  instance([P], [P], ["src0"]),
  instance([V], [V], ["src0"]),
  // A source has nothing to pass.
  instance([], [T], [null]),
  instance([], [P], [null]),
  instance([], [V], [null]),
  // No input of the output's kind: nothing to pass, and the compiler says so.
  instance([T], [V], [null], { incoherent: true }),
  instance([V], [T], [null], { incoherent: true }),
  instance([P], [T], [null], { incoherent: true }),
  // Several outputs: each passes the input of ITS kind, in whatever order they are declared.
  instance([T, V], [T, V], ["src0", "src1"]),
  instance([T, V], [V, T], ["src1", "src0"]),
  instance([T, P, V], [T, P, V], ["src0", "src1", "src2"]),
  instance([T], [V, T], [null, "src0"]),
  // Several outputs of ONE kind pair by position; one past the inputs passes nothing.
  instance([T, T], [T, T], ["src0", "src1"]),
  instance([T], [T, T], ["src0", null]),
  instance([V, V], [V, V], ["src0", "src1"]),
  instance([V], [V, V], ["src0", null]),
];

/** The value a source wired to input #index publishes: distinct per input. */
const sourceValue = (index: number): number => 3 + index;

function build(cell: Cell, ui: GraphNode["ui"], cut?: number): GraphDocument {
  const host = new Wiring();
  host.add(node("x", cell.type, cell.parameters ?? {}, ui));
  const nthIn = new Map<Kind, number>();
  cell.ins.forEach((kind, index) => {
    const nth = nthIn.get(kind) ?? 0;
    nthIn.set(kind, nth + 1);
    const id = `src${String(index)}`;
    host.add(kind === V ? node(id, "constant", { value: sourceValue(index) }) : kind === T ? node(id, "solid", { color: [0, 1, 0, 1] }) : node(id, "pointGrid"));
    if (cut !== index) host.wire(id, "x", kind, 0, nth);
  });
  const nthOut = new Map<Kind, number>();
  cell.outs.forEach((kind, index) => {
    const nth = nthOut.get(kind) ?? 0;
    nthOut.set(kind, nth + 1);
    const id = `con${String(index)}`;
    if (kind === V) {
      host.add(node(id, "valueLimit", { minimum: -99, maximum: 99 }));
    } else {
      host.add(node(id, kind === T ? "level" : "renderPoints"));
      host.add(node(`sink${String(index)}`, "output"));
      host.wire(id, `sink${String(index)}`, T);
    }
    host.wire("x", id, kind, nth, 0);
  });
  return { revision: 1, groups: {}, nodes: host.nodes, edges: host.edges } as never;
}

interface Observed {
  /** Per output: what its consumer reads. */
  readonly reads: readonly Reads[];
  readonly codes: readonly string[];
}

/** Flattens, evaluates the value graph, compiles, and reads each consumer. */
function observe(cell: Cell, ui: GraphNode["ui"], cut?: number): Observed {
  const graph = build(cell, ui, cut);
  const components = system.components.view();
  const flattened = flattenComponents({ graph, registry, components });
  const evaluated = createValueGraphSession(registry).evaluate(flattened.graph, FRAME, { flattening: flattened });
  const plan = compileGraph({
    graph,
    settings: testSettings(),
    registry,
    capabilities: testCapabilities(),
    components,
    flattened,
    resolution: { frame: FRAME, channels: evaluated.resolver },
  });
  const reads = cell.outs.map((kind, index): Reads => {
    const consumer = `con${String(index)}`;
    if (kind === V) {
      const bag = evaluated.byId.get(consumer);
      if (bag === undefined) return null;
      const from = cell.ins.findIndex((each, at) => each === V && bag["value"] === sourceValue(at));
      return from >= 0 ? `src${String(from)}` : "own";
    }
    const passes = plan.passes.filter((pass) => (pass as { nodeId?: string }).nodeId === consumer);
    if (passes.length === 0) return null;
    const resources = JSON.stringify(passes).match(/"resourceId":"[^"]+"/g) ?? [];
    const from = cell.ins.findIndex((_each, at) => resources.some((each) => each.includes(`:src${String(at)}:`)));
    return from >= 0 ? `src${String(from)}` : "own";
  });
  return { reads, codes: [...new Set(plan.diagnostics.filter((each) => each.severity !== "info").map((each) => each.code))].sort() };
}

describe("B301 — the pairing rule, as one function both seams read (§V1035)", () => {
  it("pairs output k of a kind with input k of that kind, and leaves the rest unpaired", () => {
    const pairs = (type: string): Array<[string, string]> => [...bypassPassthroughPairs(registry.get(type)!)];
    // Declared [texture, value] in, [value, texture] out: each output finds its own kind.
    const crossed = registry.get(component([T, V], [V, T]))!;
    expect([...bypassPassthroughPairs(crossed)]).toEqual([
      [crossed.outputs[0]!.id, crossed.inputs[1]!.id],
      [crossed.outputs[1]!.id, crossed.inputs[0]!.id],
    ]);
    // Six texture outputs and ONE texture input: the first output passes it, the others nothing.
    expect(pairs("render")).toEqual([["out", "environment"]]);
    // No input at all, and no input of the kind: nothing.
    expect(pairs("solid")).toEqual([]);
    expect(pairs("renderPoints")).toEqual([]);
  });
});

describe("B301 — bypass and mute across node classes, in the compiler and the value graph", () => {
  for (const cell of CELLS) {
    describe(cell.name, () => {
      it("live: every consumer reads what the node itself makes", () => {
        expect(observe(cell, undefined).reads).toEqual(cell.outs.map(() => "own"));
      });

      it(`bypassed: ${cell.bypassed.map((each) => each ?? "nothing").join(", ")}`, () => {
        const observed = observe(cell, { bypassed: true });
        expect(observed.reads).toEqual(cell.bypassed);
        expect(observed.codes.includes("compiler/bypass-incoherent")).toBe(cell.incoherent === true);
        // A wire joins two ports of one kind: no consumer is ever handed another kind (T356).
        expect(observed.codes).not.toContain("node.points.edge");
        expect(observed.codes).not.toContain("compiler/port-incompatible");
        // Where every output passes, the bypassed graph is a whole graph: nothing is in error.
        if (cell.bypassed.every((each) => each !== null) && cell.outs.some((kind) => kind !== V)) {
          expect(observe(cell, { bypassed: true }).codes.filter((code) => code.includes("missing"))).toEqual([]);
        }
      });

      it("muted: no consumer reads anything, and muted wins over bypassed", () => {
        expect(observe(cell, { muted: true }).reads).toEqual(cell.outs.map(() => null));
        expect(observe(cell, { muted: true, bypassed: true }).reads).toEqual(cell.outs.map(() => null));
      });

      if (cell.bypassed.some((each) => each !== null)) {
        it("bypassed with an input's wire cut: the output that passed it reads nothing, the others are unmoved", () => {
          const through = cell.bypassed.find((each): each is string => each !== null)!;
          const cut = Number(through.slice(3));
          expect(observe(cell, { bypassed: true }, cut).reads).toEqual(cell.bypassed.map((each) => (each === through ? null : each)));
        });
      }
    });
  }
});

describe("B301 — the literal report, and a chain of bypassed instances", () => {
  /** `constant(3) → [instance: value in, value out]… → reader`, with `count` instances in a row. */
  function chain(count: number, ui: GraphNode["ui"]) {
    const type = component([V], [V]);
    const host = new Wiring();
    host.add(node("three", "constant", { value: 3 }));
    host.add(node("reader", "valueLimit", { minimum: -99, maximum: 99 }));
    let previous = "three";
    for (let index = 0; index < count; index += 1) {
      const id = `fx${String(index)}`;
      host.add(node(id, type, {}, ui));
      host.wire(previous, id, V);
      previous = id;
    }
    host.wire(previous, "reader", V);
    const graph = { revision: 1, groups: {}, nodes: host.nodes, edges: host.edges } as never as GraphDocument;
    const flattened = flattenComponents({ graph, registry, components: system.components.view() });
    return createValueGraphSession(registry).evaluate(flattened.graph, FRAME, { flattening: flattened }).byId.get("reader");
  }

  it("a bypassed instance with a value input and a value output passes the input bag, unchanged", () => {
    // Live, the instance clamps 3 to 1. Bypassed, the reader used to get NO bag at all.
    expect(chain(1, undefined)).toEqual({ value: 1 });
    expect(chain(1, { bypassed: true })).toEqual({ value: 3 });
    expect(chain(1, { muted: true })).toBeUndefined();
  });

  it("three bypassed instances in a row are three wires: the reader still gets the source's bag", () => {
    expect(chain(3, { bypassed: true })).toEqual({ value: 3 });
  });
});

/* ------------------------------------------------- the same rule, asked by NAME and by the surfaces (T1779b) */

describe("T1779b — op('<instance>').chan reads a bypassed instance as the wires it is", () => {
  /** Value in `signal`; `result` clamps it to 0.25; a second value output `extra` has no input to pair with. */
  const type = (() => {
    const inner = new Wiring();
    inner.add(node("signal", "componentInValue"));
    inner.add(node("limit_in", "valueLimit", { minimum: 0, maximum: 0.25 }));
    inner.add(node("result", "componentOutValue", {}, undefined, 0));
    inner.add(node("expr_k", "valueExpression", { expressions: "other = 0.9" }));
    inner.add(node("extra", "componentOutValue", {}, undefined, 100));
    inner.wire("signal", "limit_in", V);
    inner.wire("limit_in", "result", V);
    inner.wire("expr_k", "extra", V);
    system.components.register({ componentId: "byname", version: 1, name: "byname", graph: { revision: 1, groups: {}, nodes: inner.nodes, edges: inner.edges }, inputs: [], outputs: [], parameters: [] } as never);
    return componentNodeType("byname", 1);
  })();
  const RETAINED = 0.5;

  /** What `fx.amount = op('look').chan.<channel>` resolves to in the compile, and what it says. */
  function read(ui: GraphNode["ui"], channel: string, wired = true) {
    const host = new Wiring();
    host.add(node("src", "constant", { value: 0.75 }));
    host.add(node("look", type, {}, ui));
    host.add(node("solid", "solid", { color: [1, 1, 1, 1] }));
    host.add(node("fx", "customWgsl", { amount: expressionSlot(`op('look').chan.${channel}`, RETAINED) }));
    host.add(node("out", "output"));
    if (wired) host.wire("src", "look", V);
    host.wire("solid", "fx", T);
    host.wire("fx", "out", T);
    const graph = { revision: 1, groups: {}, nodes: host.nodes, edges: host.edges } as never as GraphDocument;
    const components = system.components.view();
    const flattened = flattenComponents({ graph, registry, components });
    const evaluated = createValueGraphSession(registry).evaluate(flattened.graph, FRAME, { flattening: flattened });
    const result = compileGraphRetaining({ graph, settings: testSettings(), registry, capabilities: testCapabilities(), components, flattened, resolution: { frame: FRAME, channels: evaluated.resolver } });
    return {
      amount: result.retained?.nodes.get("fx")?.context.parameters["amount"],
      codes: result.compiled.diagnostics.filter((each) => each.nodeId === "fx" && each.code.startsWith("parameter.")).map((each) => each.code),
      plot: instanceValueChannels(flattened, registry, evaluated.byId).find((each) => each.nodeId === "look")?.channels,
    };
  }

  it("live: the instance's own output (the clamp), and the second output's channel", () => {
    expect(read(undefined, "value")).toMatchObject({ amount: 0.25, codes: [] });
    expect(read(undefined, "other")).toMatchObject({ amount: 0.9, codes: [] });
  });

  it("bypassed: the bag wired INTO the paired input, unchanged", () => {
    // Before: no entry for an un-inlined instance, so this read fell back to 0.5 with a warning.
    expect(read({ bypassed: true }, "value")).toMatchObject({ amount: 0.75, codes: [] });
  });

  it("bypassed: an output with no partner publishes nothing, so its channel is refused and the stored value stands", () => {
    expect(read({ bypassed: true }, "other")).toMatchObject({ amount: RETAINED, codes: ["parameter.reference.channel"] });
  });

  it("bypassed with the input's wire cut, and muted: nothing to read", () => {
    expect(read({ bypassed: true }, "value", false)).toMatchObject({ amount: RETAINED, codes: ["parameter.reference.channel"] });
    expect(read({ muted: true }, "value")).toMatchObject({ amount: RETAINED, codes: ["parameter.reference.channel"] });
  });

  it("the instance's value plot shows the same channels the expression reads", () => {
    // Live, two publishers: each prefixed by the port that exposes it.
    expect(read(undefined, "value").plot).toEqual({ "result:value": 0.25, "extra:other": 0.9 });
    // Bypassed, one wire: the passed bag, unprefixed. Before: no plot at all ("no signal yet").
    expect(read({ bypassed: true }, "value").plot).toEqual({ value: 0.75 });
    expect(read({ bypassed: true }, "value", false).plot).toBeUndefined();
    expect(read({ muted: true }, "value").plot).toBeUndefined();
  });
});

describe("T1779b — the surfaces that ask the rule of ONE port", () => {
  it("a value plot is silent under bypass exactly when no VALUE output passes anything", () => {
    const passes = (ins: readonly Kind[], outs: readonly Kind[]): boolean => bypassPassesKind(registry.get(component(ins, outs))!, V);
    // Its first output passes a texture, and its value output passes a value: live.
    expect(passes([T, V], [T, V])).toBe(true);
    // Its first output passes a texture and its value output has no partner: silent.
    // (The first-output question answered "passes", and the plot waited for a signal for ever.)
    expect(passes([T], [T, V])).toBe(false);
    // Its first output has no partner but a later value output does: live.
    expect(passes([V], [T, V])).toBe(true);
    expect(bypassPassesKind(registry.get("valueLimit")!, V)).toBe(true);
    expect(bypassPassesKind(registry.get("constant")!, V)).toBe(false);
  });

  it("the mapping chain follows a bypassed instance by the output the window reads", () => {
    // Two pictures through one two-in, two-out instance; the window reads its SECOND output.
    const type = component([T, T], [T, T]);
    const host = new Wiring();
    for (const id of ["pinA", "pinB"]) {
      host.add(node(`src_${id}`, "checker"));
      host.add(node(id, "cornerPin"));
      host.wire(`src_${id}`, id, T);
    }
    host.add(node("x", type, {}, { bypassed: true }));
    host.add(node("win", "window"));
    host.wire("pinA", "x", T, 0, 0);
    host.wire("pinB", "x", T, 0, 1);
    host.wire("x", "win", T, 1, 0);
    const graph = { revision: 1, groups: {}, nodes: host.nodes, edges: host.edges } as never as GraphDocument;
    // Bypassed, output 1 is input 1: the pin on the SECOND picture, placed exactly.
    expect(mappingTargetsOf(graph, registry, "win")).toEqual([expect.objectContaining({ nodeId: "pinB", kind: "cornerPin", refusal: null })]);
  });
});
