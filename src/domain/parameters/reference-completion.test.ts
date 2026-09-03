import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSchema } from "../types/parameters.ts";
import {
  createNodeReferenceReader,
  nodeReferenceMembers,
  nodeReferenceNames,
} from "./node-references.ts";

/**
 * T990 — WHAT `op('…')` OFFERS, asserted against WHAT `op('…')` ACCEPTS.
 *
 * The enumerator lives beside the reader so the two cannot drift, and the load-bearing
 * test in this file is the one that checks exactly that: every member the menu offers is
 * walked back through the real reader, and none of them may come back "there is no such
 * thing". §V150's rule — a menu that offers what the grammar rejects teaches a wrong API
 * with the tool's own authority — is otherwise a promise rather than a property, and this
 * is the shape that makes it a property.
 */

const SCHEMA: ParameterSchema = {
  gain: { type: "number", label: "Gain", default: 2 },
  enabled: { type: "boolean", label: "Enabled", default: true },
  tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
  offset: { type: "vector", label: "Offset", size: 2, default: [0, 0] },
  caption: { type: "string", label: "Caption", default: "" },
  blend: {
    type: "enum",
    label: "Blend",
    default: "over",
    options: [{ value: "over", label: "Over" }],
  },
};

function node(id: string, label: string): GraphNode {
  return {
    id: id as NodeId,
    type: "test.thing",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    label,
  };
}

const GRAPH: GraphDocument = {
  revision: 1,
  groups: {},
  nodes: {
    // Ids deliberately unlike the labels: §B170's two examples shipped dead because
    // something matched on the id, and a fixture where the two agree cannot catch that.
    "addr-1": node("addr-1", "blur1"),
    "addr-2": node("addr-2", "lfo1"),
    // A node with NO label has no name (`nodeNames`), so it is not addressable and must
    // not be offered — the alternative is a menu entry whose only outcome is an error.
    "addr-3": { ...node("addr-3", ""), label: undefined },
  },
  edges: {},
} as unknown as GraphDocument;

const OPTIONS = { graph: GRAPH, schemaOf: () => SCHEMA };

const textsOf = (name: string, path: readonly string[]): string[] =>
  nodeReferenceMembers(OPTIONS, name, path).map((member) => member.text);

describe("T990 — the names `op('…')` can address", () => {
  it("offers LABELS, and every one of them (§B170)", () => {
    expect(nodeReferenceNames(GRAPH)).toEqual(["blur1", "lfo1"]);
  });

  it("offers no ids, which is the mistake two examples shipped", () => {
    expect(nodeReferenceNames(GRAPH)).not.toContain("addr-1");
  });

  it("leaves out an UNLABELLED node, which has no name to be addressed by", () => {
    expect(nodeReferenceNames(GRAPH)).toHaveLength(2);
  });
});

describe("T990 — the members under a name", () => {
  it("offers the two namespaces the reader honours, and only those", () => {
    expect(textsOf("blur1", [])).toEqual(["par", "chan"]);
  });

  it("offers the parameters an expression can READ, and not the ones it cannot", () => {
    // `caption` is a string and `blend` an enum: `asNumber` refuses both by name, so
    // offering them would be a suggestion with exactly one possible outcome.
    expect(textsOf("blur1", ["par"])).toEqual(["gain", "enabled", "tint", "offset"]);
  });

  it("carries the parameter LABEL as the detail, which is what the user saw", () => {
    const gain = nodeReferenceMembers(OPTIONS, "blur1", ["par"]).find((m) => m.text === "gain");
    expect(gain?.detail).toBe("Gain");
  });

  it("offers a compound's components, and the vector's SIZE decides how many (§V113)", () => {
    expect(textsOf("blur1", ["par", "tint"])).toEqual(["r", "g", "b", "a"]);
    expect(textsOf("blur1", ["par", "offset"])).toEqual(["x", "y"]);
  });

  it("offers nothing under a scalar, because nothing hangs off one", () => {
    expect(textsOf("blur1", ["par", "gain"])).toEqual([]);
  });

  it("offers the live channels, and only through the caller's enumerator", () => {
    // Nothing static can answer this: a bag is `valueEvaluate`'s return value.
    expect(textsOf("lfo1", ["chan"])).toEqual([]);
    const withChannels = { ...OPTIONS, channelsOf: (name: string) => (name === "lfo1" ? ["value"] : []) };
    expect(nodeReferenceMembers(withChannels, "lfo1", ["chan"]).map((m) => m.text)).toEqual(["value"]);
  });

  it("stops at a channel — the reader takes exactly one segment there", () => {
    const withChannels = { ...OPTIONS, channelsOf: () => ["value"] };
    expect(nodeReferenceMembers(withChannels, "lfo1", ["chan", "value"])).toEqual([]);
  });

  it("offers nothing for a name the graph does not have, or a namespace it does not know", () => {
    expect(textsOf("nosuch1", [])).toEqual([]);
    expect(textsOf("blur1", ["props"])).toEqual([]);
    expect(textsOf("blur1", ["par", "tint", "r"])).toEqual([]);
  });
});

/**
 * THE DRIFT GUARD, and the reason the enumerator is in this file rather than in the UI.
 *
 * Walked through `createNodeReferenceReader` — the real one, the one the compiler and the
 * inspector both build — because "the menu agrees with the reader" is only worth anything
 * if the reader is the one that answers in production. A refusal is fine; a refusal that
 * says the thing does not EXIST is the menu having invented an API.
 */
describe("§V150 — every offered path is one the reader knows about", () => {
  const read = createNodeReferenceReader(OPTIONS);
  const missing = /there is no node|only \.par|has no parameter|has no component|name one/;

  it("accepts every offered namespace, parameter and component", () => {
    const checked: string[] = [];
    for (const name of nodeReferenceNames(GRAPH)) {
      for (const namespace of textsOf(name, [])) {
        if (namespace !== "par") continue;
        for (const key of textsOf(name, [namespace])) {
          const scalar = read(name, [namespace, key]);
          checked.push(`${name}.${namespace}.${key}`);
          // A compound read whole is refused with "name a component" — a real refusal
          // about ARITY, not about existence, and the menu's next level answers it.
          if (!scalar.ok && textsOf(name, [namespace, key]).length === 0) {
            expect(scalar.reason, `${name}.${namespace}.${key}`).not.toMatch(missing);
          }
          for (const component of textsOf(name, [namespace, key])) {
            const leaf = read(name, [namespace, key, component]);
            checked.push(`${name}.${namespace}.${key}.${component}`);
            expect(leaf.ok, `${name}.${namespace}.${key}.${component}: ${leaf.ok ? "" : leaf.reason}`).toBe(true);
          }
        }
      }
    }
    // Non-vacuity: a walk that offered nothing would pass every assertion above.
    expect(checked.length).toBeGreaterThan(8);
  });

  it("is looking at a reader that CAN refuse, or it is measuring nothing", () => {
    expect(read("blur1", ["par", "nosuch"]).ok).toBe(false);
    expect(read("blur1", ["props", "gain"]).ok).toBe(false);
    expect(read("nosuch1", ["par", "gain"]).ok).toBe(false);
  });
});
