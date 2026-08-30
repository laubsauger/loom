import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import { referenceCycleDiagnostics, referenceCyclesThrough } from "./reference-cycles.ts";

/**
 * The authoring-time `op()` cycle gate (T331, §V152, §V244).
 *
 * The runtime reader already NAMES such a loop instead of overflowing the stack, and
 * §V244 is about exactly that comfort: a document should never hold the cycle for the
 * guard to catch. So what is asserted here is refusal — with the path in the message,
 * because a user who joined two nodes has to be told which two.
 */

const expression = (source: string) => ({
  mode: "expression" as const,
  bindings: { expression: { kind: "expression" as const, source } },
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

describe("op() reference cycles (§V152)", () => {
  it("names the path of a two-node loop", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });

    const [found] = referenceCyclesThrough(graphOf(a, b), "n1");
    expect(found?.code).toBe("parameter.referenceCycle");
    // The PATH, not just the fact: "somewhere in your document" is not actionable.
    expect(found?.message).toContain("a.gain → b.gain → a");
  });

  it("catches a node referencing itself", () => {
    const self = node("n1", "a", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(self), "n1")).toHaveLength(1);
  });

  it("catches a loop that closes through a third node", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('c').par.gain") });
    const c = node("n3", "c", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b, c), "n2")).toHaveLength(1);
  });

  it("sees a reference carried by a COMPONENT slot (§V113)", () => {
    // `color.r` is an ordinary carrier of an expression, so a loop can close through one
    // — and a gate that only walked bare keys would let exactly that through.
    const a = node("n1", "a", { "color.r": expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b), "n1")).toHaveLength(1);
  });

  it("leaves a node that only READS a cycle alone", () => {
    // Reachability is not membership: `reader` is not part of the loop, and refusing its
    // edits would spread one document's damage over the nodes near it.
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const reader = node("n3", "reader", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b, reader), "n3")).toEqual([]);
  });

  it("is not fooled by a diamond: two paths to one node are not a loop", () => {
    const src = node("n1", "src", { gain: 1 });
    const left = node("n2", "left", { gain: expression("op('src').par.gain") });
    const right = node("n3", "right", { gain: expression("op('src').par.gain") });
    const join = node("n4", "join", { gain: expression("op('left').par.gain + op('right').par.gain") });
    const graph = graphOf(src, left, right, join);
    expect(referenceCycleDiagnostics(graph)).toEqual([]);
    expect(referenceCyclesThrough(graph, "n4")).toEqual([]);
  });

  it("ignores a RETAINED expression on a parameter that is not in expression mode (§V108)", () => {
    // The corner mark's promise: an inactive payload is data, not a dependency. Counting
    // it would make flipping to Constant fail to break a loop the user just broke.
    const a = node("n1", "a", {
      gain: { mode: "static", bindings: { static: { kind: "static", value: 1 }, expression: { kind: "expression", source: "op('b').par.gain" } } },
    });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b), "n1")).toEqual([]);
  });

  it("does not call a DANGLING reference a cycle", () => {
    // `op('ghost')` is reported at resolution, on the parameter that carries it. Refusing
    // the patch would make an expression unwritable until its target exists.
    const a = node("n1", "a", { gain: expression("op('ghost').par.gain") });
    expect(referenceCyclesThrough(graphOf(a), "n1")).toEqual([]);
  });

  it("reports a loop ONCE for the whole document, not once per member", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    expect(referenceCycleDiagnostics(graphOf(a, b))).toHaveLength(1);
  });

  it("reports two independent loops separately", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const c = node("n3", "c", { gain: expression("op('d').par.gain") });
    const d = node("n4", "d", { gain: expression("op('c').par.gain") });
    expect(referenceCycleDiagnostics(graphOf(a, b, c, d))).toHaveLength(2);
  });

  it("counts a reference to a DIFFERENT parameter of the same node as the same loop", () => {
    /**
     * Not a conservative approximation — the reader resolves the target node's whole
     * schema, so reading `b.y` resolves `b.z` on the way past and the recursion is real.
     * The gate is keyed to the node for that reason, and this test is what fails if
     * someone makes one of the two halves finer without the other (§V61).
     */
    const a = node("n1", "a", { gain: expression("op('b').par.gain"), other: 2 });
    const b = node("n2", "b", { other: expression("op('a').par.other") });
    expect(referenceCyclesThrough(graphOf(a, b), "n1")).toHaveLength(1);
  });
});

describe("the feedback kind is EXEMPT (T350/§V285)", () => {
  it("a feedback reference closing a loop is not a refusable cycle — closing it is its job", () => {
    // over reads op('echo') in an expression; echo names over as its source. Through
    // the walk that is a cycle — and it is exactly the legal one the temporal split
    // exists for. The gate rules on `reference` chains only.
    const graph = {
      revision: 1,
      nodes: {
        mix: {
          id: "mix",
          type: "over",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {
            opacity: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('echo1').par.persistence" } } },
          },
          label: "over1",
        },
        echo: {
          id: "echo",
          type: "feedback",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { source: "over1" },
          label: "echo1",
        },
      },
      edges: {},
      groups: {},
    } as never;
    expect(referenceCycleDiagnostics(graph)).toEqual([]);
  });
});
