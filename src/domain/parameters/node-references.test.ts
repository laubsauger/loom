import { describe, expect, it } from "vitest";

import { evaluateExpression } from "../expressions/index.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ParameterSchema } from "../types/parameters.ts";
import { createNodeReferenceReader } from "./node-references.ts";
import { resolveParameterSchema } from "./resolve.ts";

/**
 * The cross-node read path (T316, §V148, §V152).
 *
 * The round trip through the copy/paste commands is covered in
 * `commands/parameter-commands.test.ts`, and the compiler-and-inspector-agree claim at
 * the composed level. What is here is what a reader does when the reference is WRONG —
 * which is most of the surface area, because a reference is a name typed by a person into
 * a text field and every way of getting it wrong has to say so rather than produce a
 * number.
 */

const SCHEMA: ParameterSchema = {
  gain: { type: "number", label: "Gain", default: 1 },
  enabled: { type: "boolean", label: "Enabled", default: false },
  tint: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" },
};

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

const expression = (source: string) => ({
  mode: "expression" as const,
  bindings: { expression: { kind: "expression" as const, source } },
});

function readerFor(graph: GraphDocument) {
  return createNodeReferenceReader({ graph, schemaOf: () => SCHEMA });
}

/** What an expression on `subject` resolves to, with the reader attached. */
function resolve(graph: GraphDocument, subject: GraphNode, key = "gain") {
  return resolveParameterSchema(subject, SCHEMA, { nodes: readerFor(graph) }).get(key);
}

describe("reading op('name').par.key (T316)", () => {
  it("resolves to the referenced node's value", () => {
    const source = node("n1", "gain1", { gain: 7 });
    const subject = node("n2", "gain2", { gain: expression("op('gain1').par.gain") });
    const graph = graphOf(source, subject);

    const resolved = resolve(graph, subject);
    expect(resolved?.diagnostic).toBeNull();
    expect(resolved?.value).toBe(7);
  });

  it("resolves through a CHAIN, because the target's own value may be a reference", () => {
    // The reason a read is a resolve and not a lookup: `b` is worth what `a` is worth.
    const a = node("n1", "a", { gain: 3 });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const c = node("n3", "c", { gain: expression("op('b').par.gain * 2") });
    expect(resolve(graphOf(a, b, c), c)?.value).toBe(6);
  });

  it("names the LOOP rather than overflowing the stack (§V152)", () => {
    // Nothing refuses this at authoring time yet — `bindCycleDiagnostics` covers `bind`
    // mode only — so a document can carry it in from a file and this guard is the only
    // thing between it and infinite recursion.
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const resolved = resolve(graphOf(a, b), a);

    expect(resolved?.diagnostic?.code).toBe("parameter.expression");
    expect(resolved?.diagnostic?.message).toContain("cycle");
    // §V108: it falls back to a value rather than leaving the parameter undefined.
    expect(resolved?.value).toBe(1);
  });

  it("catches a node referencing ITSELF through op()", () => {
    const self = node("n1", "a", { gain: expression("op('a').par.gain") });
    expect(resolve(graphOf(self), self)?.diagnostic?.message).toContain("cycle");
  });

  it("is not fooled into calling two independent reads a cycle", () => {
    // The visited set is per PATH, not per reader. A reader that shared one set across a
    // resolution would call the second read of `src` a loop, and the bug would look like
    // "the third parameter I reference stops working".
    const src = node("n1", "src", { gain: 5 });
    const subject = node("n2", "both", {
      gain: expression("op('src').par.gain + op('src').par.gain"),
    });
    expect(resolve(graphOf(src, subject), subject)?.value).toBe(10);
  });

  it("says which name is missing when the node is not there", () => {
    const subject = node("n1", "a", { gain: expression("op('ghost').par.gain") });
    expect(resolve(graphOf(subject), subject)?.diagnostic?.message).toContain('no node named "ghost"');
  });

  it("says which parameter is missing when the node has no such key", () => {
    const source = node("n1", "src");
    const subject = node("n2", "a", { gain: expression("op('src').par.nope") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'has no parameter "nope"',
    );
  });

  it("refuses a non-numeric parameter instead of coercing one channel of it", () => {
    // §V71: an expression is arithmetic over numbers. Reading a colour and silently
    // taking its red channel would be a number that looks like an answer.
    const source = node("n1", "src", { tint: [1, 0.5, 0.25, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      "an expression reads a number",
    );
  });

  it("reads a boolean as 0 or 1, which is the documented bridge", () => {
    const source = node("n1", "src", { enabled: true });
    const subject = node("n2", "a", { gain: expression("op('src').par.enabled") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(1);
  });

  it("refuses a path it does not understand rather than guessing a namespace", () => {
    const source = node("n1", "src", { gain: 2 });
    const subject = node("n2", "a", { gain: expression("op('src').ports.out") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      "only .par is readable",
    );
  });

  it("still reports when NO reader is supplied — a caller without a graph invents nothing", () => {
    // The state every caller was in before this landed, and the state a bare evaluator is
    // still in. Resolving to 0 here would be the worst outcome: a plausible number.
    const result = evaluateExpression("op('a').par.gain");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("need a graph");
  });
});
