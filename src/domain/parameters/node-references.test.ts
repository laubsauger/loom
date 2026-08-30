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
    // T331 refuses this at authoring time (`referenceCyclesThrough`), so a document that
    // went through the bus never holds it. A hand-edited file still can, and this guard
    // is what stands between that file and infinite recursion.
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

  it("refuses a compound read WHOLE, and says which components it has", () => {
    // §V71: an expression is arithmetic over numbers. Reading a colour and silently
    // taking its red channel would be a number that looks like an answer — and now that
    // the channel IS addressable (T332), the message points at the one keystroke that
    // fixes it rather than leaving the user to guess the spelling.
    const source = node("n1", "src", { tint: [1, 0.5, 0.25, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint") });
    const message = resolve(graphOf(source, subject), subject)?.diagnostic?.message;
    expect(message).toContain("an expression reads a number");
    expect(message).toContain("op('src').par.tint.r");
  });

  it("reads a boolean as 0 or 1, which is the documented bridge", () => {
    const source = node("n1", "src", { enabled: true });
    const subject = node("n2", "a", { gain: expression("op('src').par.enabled") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(1);
  });

  it("reads ONE COMPONENT of a compound (T332, §V113)", () => {
    // The point of storing colour as four independently-moded slots is that a channel can
    // be driven; a channel nothing outside its own node can read is half of that.
    const source = node("n1", "src", { tint: [1, 0.5, 0.25, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic).toBeNull();
    expect(resolved?.value).toBe(0.5);
  });

  it("reads a component whose OWN slot carries an expression", () => {
    // `tint.b` moving on its own while r, g and a stay put is the §V113 shape, and it is
    // what a reference to one channel has to see — not the compound's stored tuple.
    const source = node("n1", "src", { tint: [0, 0, 0, 1], "tint.b": expression("3 * 0.25") });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.b") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(0.75);
  });

  it("hands back the STORED-space channel, exactly as a local bind does (§V56, T148)", () => {
    // `tint` is `space: "display"`. The decode to linear happens once, where `values`
    // leaves the resolver as evaluation input; doing it here as well is T187's double
    // decode, which measured 0.5 → 0.0376 on the way to the shader.
    const source = node("n1", "src", { tint: [0.5, 0.5, 0.5, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.r") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(0.5);
  });

  it("names the components when the channel does not exist", () => {
    const source = node("n1", "src", { tint: [1, 1, 1, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.q") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'has no component "q" (it has r, g, b, a)',
    );
  });

  it("refuses a component OF A SCALAR rather than inventing one", () => {
    const source = node("n1", "src", { gain: 4 });
    const subject = node("n2", "a", { gain: expression("op('src').par.gain.x") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      "has no components",
    );
  });

  it("propagates a BROKEN component's diagnostic rather than its fallback (§V243)", () => {
    // The whole trap in one test: the component falls back to a usable number by design
    // (§V108), so reading the value would make a broken reference look healthy at the top
    // of the chain, which is where its author is looking.
    const source = node("n1", "src", { tint: [1, 1, 1, 1], "tint.g": expression("nope") });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic?.message).toContain('unknown name "nope"');
  });

  it("does NOT blame a healthy component for the compound's own problem", () => {
    // The other half of §V243: a component with its own slot resolved on its own terms.
    // Forwarding the compound's fallback here would be a false alarm on a good channel,
    // and a false alarm teaches people to ignore the real ones.
    const source = node("n1", "src", { tint: expression("nope"), "tint.g": 0.25 });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic).toBeNull();
    expect(resolved?.value).toBe(0.25);
  });

  it("carries the compound's diagnostic to a component that FOLLOWS it (§V243)", () => {
    // No slot of its own, so this channel's number came out of the compound's fallback.
    // Reporting the number without the reason is the fallback hiding the error, one
    // channel at a time — which is harder to see than the whole-parameter case.
    const source = node("n1", "src", { tint: expression("nope") });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'unknown name "nope"',
    );
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
