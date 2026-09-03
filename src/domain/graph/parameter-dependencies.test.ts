import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import { channelTargetName, opReferenceNames, parameterDependencies } from "./parameter-dependencies.ts";

/**
 * The ONE traversal behind the cycle gate, liveness, and the reference lines (T248).
 *
 * What is asserted here is mostly about AGREEMENT: the same walk answers "is this a
 * cycle", "is this node dead" and "is there a line between these two", so a case that
 * one consumer sees and another does not is the class of bug this module exists to make
 * impossible.
 */

const expression = (source: string) => ({
  mode: "expression" as const,
  bindings: { expression: { kind: "expression" as const, source } },
});
const driven = (channel: string) => ({
  mode: "driven" as const,
  bindings: { driven: { kind: "driven" as const, channel } },
});

function node(id: string, label: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type: "test.node", definitionVersion: 1, position: { x: 0, y: 0 }, label, parameters };
}

function graphOf(...nodes: GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {},
    groups: {},
  };
}

describe("channelTargetName", () => {
  it("takes the node name out of a channel address", () => {
    expect(channelTargetName("mouse1")).toBe("mouse1");
    expect(channelTargetName("mouse1:x")).toBe("mouse1");
    // Everything after the FIRST colon is the channel, whatever it contains.
    expect(channelTargetName("lfo1:a:b")).toBe("lfo1");
  });
});

describe("parameterDependencies (§V154)", () => {
  it("finds an op() reference and labels it", () => {
    const src = node("n1", "src");
    const subject = node("n2", "a", { gain: expression("op('src').par.gain * 2") });
    const found = parameterDependencies(graphOf(src, subject)).get("n2");
    expect(found).toEqual([
      { from: "n2", parameterKey: "gain", kind: "reference", address: "src", to: "n1" },
    ]);
  });

  it("finds a driven channel and labels it differently", () => {
    // Both are "this parameter reads that node" for the PICTURE; only one of them is a
    // cycle the reference gate rules on, which is what `kind` is carrying.
    const lfo = node("n1", "lfo1");
    const subject = node("n2", "a", { gain: driven("lfo1") });
    const found = parameterDependencies(graphOf(lfo, subject)).get("n2");
    expect(found?.[0]).toMatchObject({ kind: "driven", address: "lfo1", to: "n1" });
  });

  it("resolves a driven channel addressed with an explicit channel", () => {
    const mouse = node("n1", "mouse1");
    const subject = node("n2", "a", { gain: driven("mouse1:x") });
    const found = parameterDependencies(graphOf(mouse, subject)).get("n2");
    // The dependency is on the NODE; the address keeps the channel, because a line's
    // tooltip and a diagnostic both want to say which channel was named.
    expect(found?.[0]).toMatchObject({ address: "mouse1:x", to: "n1" });
  });

  it("walks COMPONENT slots, so a channel-driven colour is a dependency (§V113)", () => {
    const lfo = node("n1", "lfo1");
    const subject = node("n2", "a", { "color.g": driven("lfo1") });
    const found = parameterDependencies(graphOf(lfo, subject)).get("n2");
    expect(found?.[0]).toMatchObject({ parameterKey: "color.g", to: "n1" });
  });

  it("ignores a RETAINED binding on a parameter in another mode (§V108)", () => {
    const src = node("n1", "src");
    const subject = node("n2", "a", {
      gain: {
        mode: "static",
        bindings: {
          static: { kind: "static", value: 1 },
          expression: { kind: "expression", source: "op('src').par.gain" },
        },
      },
    });
    expect(parameterDependencies(graphOf(src, subject)).get("n2")).toBeUndefined();
  });

  it("drops a dependency whose name resolves to nothing", () => {
    // Reported on the parameter, at resolution. It cannot close a cycle and there is
    // nowhere to draw a line TO.
    const subject = node("n1", "a", { gain: expression("op('ghost').par.gain") });
    expect(parameterDependencies(graphOf(subject)).get("n1")).toBeUndefined();
  });

  it("keeps both relationships from one node, in parameter order", () => {
    const src = node("n1", "src");
    const lfo = node("n2", "lfo1");
    const subject = node("n3", "a", {
      amount: driven("lfo1"),
      gain: expression("op('src').par.gain"),
    });
    const found = parameterDependencies(graphOf(src, lfo, subject)).get("n3");
    expect(found?.map((entry) => entry.parameterKey)).toEqual(["amount", "gain"]);
    expect(found?.map((entry) => entry.kind)).toEqual(["driven", "reference"]);
  });
});

describe("the feedback kind (T350/§V285)", () => {
  it("a source reference is a dependency the walk reports — liveness and the lines read it", () => {
    const graph = {
      revision: 1,
      nodes: {
        mix: { id: "mix", type: "over", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "over1" },
        echo: { id: "echo", type: "feedback", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source: "over1" } },
      },
      edges: {},
      groups: {},
    } as never;
    const deps = [...parameterDependencies(graph).values()].flat();
    expect(deps).toContainEqual({
      from: "echo",
      parameterKey: "source",
      kind: "feedback",
      address: "over1",
      to: "mix",
    });
  });

  it("a dangling name is dropped, like every other unresolved address", () => {
    const graph = {
      revision: 1,
      nodes: {
        echo: { id: "echo", type: "feedback", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source: "ghost1" } },
      },
      edges: {},
      groups: {},
    } as never;
    expect([...parameterDependencies(graph).values()].flat()).toEqual([]);
  });
});

describe("a reference nested inside a call is still a reference (T1021)", () => {
  /*
   * E51 Chorus drove a radius every frame through
   * `clamp((op('beat1').chan.low - 0.7) / 0.28, 0, 1)` and the canvas drew NO reference
   * line, because the walk handled `opRef`/`unary`/`binary` and returned at `default` —
   * so the only `opRef` in the source, sitting in `clamp`'s arguments, was never seen.
   * The owner read the audio node as wired to nothing.
   *
   * Asserted at three depths because one level of nesting is the case a careless fix
   * covers; a reference inside a call inside a call is the one that proves recursion.
   */
  it("finds an op() reference inside call arguments, at any depth", () => {
    expect(opReferenceNames("clamp(op('beat1').chan.low, 0, 1)")).toEqual(["beat1"]);
    expect(opReferenceNames("0.085 + 0.075 * clamp((op('beat1').chan.low - 0.7) / 0.28, 0, 1)")).toEqual(["beat1"]);
    expect(opReferenceNames("max(0, min(1, op('lfo1').chan.value))")).toEqual(["lfo1"]);
  });

  it("finds EVERY reference in a call, not just the first", () => {
    expect(opReferenceNames("mix(op('a1').chan.value, op('b1').chan.value, 0.5)")).toEqual(["a1", "b1"]);
  });

  /*
   * The consequence that makes this more than a drawing bug: `reference-cycles.ts` walks
   * this same function, so a cycle routed through a call was undetectable.
   */
  it("a cycle routed through a call is visible to the same walk", () => {
    const a = node("n1", "a1", { gain: expression("clamp(op('b1').par.gain, 0, 1)") });
    const b = node("n2", "b1", { gain: expression("clamp(op('a1').par.gain, 0, 1)") });
    const found = [...parameterDependencies(graphOf(a, b)).values()].flat();
    expect(found.map((entry) => entry.address).sort()).toEqual(["a1", "b1"]);
  });
});
