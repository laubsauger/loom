import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import {
  countNodeNameReferences,
  nameBaseFor,
  nodeByName,
  resolveRename,
  rewriteNodeNameReferences,
  uniqueNodeName,
} from "./names.ts";

/**
 * Names as identifiers (T221/T222, §V127-§V129): unique per graph, numbered on create,
 * auto-suffixed on collision, and a rename rewrites every stored reference (§V128).
 */

function graphWith(nodes: Record<string, Partial<GraphNode> & { label?: string }>): GraphDocument {
  const built: Record<string, GraphNode> = {};
  for (const [id, node] of Object.entries(nodes)) {
    built[id] = {
      id: id as NodeId,
      type: node.type ?? "test.noise",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: node.parameters ?? {},
      ...(node.label === undefined ? {} : { label: node.label }),
    };
  }
  return { revision: 0, nodes: built, edges: {}, groups: {} } as unknown as GraphDocument;
}

describe("naming (§V129)", () => {
  it("derives the base from the type's last segment", () => {
    expect(nameBaseFor("core.noise")).toBe("noise");
    expect(nameBaseFor("blur")).toBe("blur");
    expect(nameBaseFor("vendor.Fancy-Glow")).toBe("fancyglow");
    expect(nameBaseFor("...")).toBe("node");
  });

  it("numbers new nodes even when alone, and skips taken numbers", () => {
    expect(uniqueNodeName(graphWith({}), "noise")).toBe("noise1");
    const graph = graphWith({ a: { label: "noise1" }, b: { label: "noise2" } });
    expect(uniqueNodeName(graph, "noise")).toBe("noise3");
  });

  it("keeps a requested rename verbatim when free, suffixes on collision", () => {
    const graph = graphWith({ a: { label: "glow" }, b: { label: "noise1" } });
    expect(resolveRename(graph, "sparkle", "b" as NodeId)).toBe("sparkle");
    expect(resolveRename(graph, "glow", "b" as NodeId)).toBe("glow2");
    // Renaming a node to its own name is a no-op, not a collision with itself.
    expect(resolveRename(graph, "glow", "a" as NodeId)).toBe("glow");
  });

  it("looks nodes up by name", () => {
    const graph = graphWith({ a: { label: "noise1" }, b: {} });
    expect(nodeByName(graph, "noise1")).toBe("a");
    expect(nodeByName(graph, "nope")).toBeUndefined();
  });
});

describe("reference rewriting (§V128)", () => {
  const expressionSlot = (source: string) => ({
    mode: "expression" as const,
    bindings: { expression: { kind: "expression" as const, source } },
  });

  it("rewrites op('name') references across the graph, counting touched sources", () => {
    const graph = graphWith({
      a: { label: "noise1" },
      b: { parameters: { gain: expressionSlot("op('noise1').par.period * 2") } },
      c: { parameters: { amount: expressionSlot('op("noise1").par.gain + op(\'noise1\').par.x') } },
      d: { parameters: { other: expressionSlot("op('noise12').par.gain") } },
    });
    const rewritten = rewriteNodeNameReferences(graph, "noise1", "clouds");
    expect(rewritten).toBe(2);
    const sourceOf = (nodeId: string, key: string): string => {
      const stored = graph.nodes[nodeId]?.parameters[key] as {
        bindings: { expression: { source: string } };
      };
      return stored.bindings.expression.source;
    };
    expect(sourceOf("b", "gain")).toBe("op('clouds').par.period * 2");
    expect(sourceOf("c", "amount")).toBe('op("clouds").par.gain + op(\'clouds\').par.x');
    // A LONGER name sharing the prefix is untouched — noise12 is not noise1.
    expect(JSON.stringify(graph.nodes["d"]?.parameters["other"])).toContain("noise12");
  });

  it("counts stranded references for a cleared name", () => {
    const graph = graphWith({
      b: { parameters: { gain: expressionSlot("op('noise1').par.period") } },
    });
    expect(countNodeNameReferences(graph, "noise1")).toBe(1);
    expect(countNodeNameReferences(graph, "other")).toBe(0);
  });
});

/**
 * B88 (T485) — the COUNT walks the same four kinds the rewrite does, because they are
 * now literally the same walk (one clause list, rename === null counts). Clearing a
 * label used to report zero stranded references while driven, source and list
 * references all pointed at the vanished name — the info-severity twin of B40.
 */
describe("count and rewrite are one walk (T485, B88)", () => {
  const graphWithEveryKind = (): GraphDocument =>
    ({
      revision: 1,
      nodes: {
        target: { id: "target", type: "lfo", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "sig1" },
        expr: {
          id: "expr", type: "level", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: {
            brightness: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('sig1') * 2" } } },
          },
        },
        driven: {
          id: "driven", type: "level", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: {
            opacity: { mode: "driven", bindings: { driven: { kind: "driven", channel: "sig1:value" } } },
          },
        },
        scalarRef: {
          id: "scalarRef", type: "geometry", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: { material: "sig1" },
        },
        listRef: {
          id: "listRef", type: "render", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: { scenes: "other1 sig1 other2", camera: "", lights: "" },
        },
      },
      edges: {},
      groups: {},
    }) as never;

  it("counts all four kinds — expression, driven, scalar source ref, list source ref", () => {
    expect(countNodeNameReferences(graphWithEveryKind(), "sig1")).toBe(4);
    expect(countNodeNameReferences(graphWithEveryKind(), "other")).toBe(0);
  });

  it("count equals what a rewrite touches, on the same graph", () => {
    const graph = graphWithEveryKind();
    const counted = countNodeNameReferences(graph, "sig1");
    const rewritten = rewriteNodeNameReferences(graph, "sig1", "sig9");
    expect(counted).toBe(rewritten);
    // And after the rewrite the old name strands nothing — the two answers agree again.
    expect(countNodeNameReferences(graph, "sig1")).toBe(0);
    expect(countNodeNameReferences(graph, "sig9")).toBe(4);
  });

  it("counting mutates nothing", () => {
    const graph = graphWithEveryKind();
    const before = JSON.stringify(graph);
    countNodeNameReferences(graph, "sig1");
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("rename rewrites EVERY reference kind (§V128, §V316)", () => {
  const graphWith = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      revision: 1,
      nodes: {
        lfo: { id: "lfo", type: "lfo", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "lfo1" },
        user: { id: "user", type: "cross", definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...extra },
      },
      edges: {},
      groups: {},
    }) as never;

  it("kind 2 (B40): a driven channel follows the rename — with and without a :channel", () => {
    const graph = graphWith({
      a: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } },
      b: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1:x" } } },
      c: { mode: "driven", bindings: { driven: { kind: "driven", channel: "other1" } } },
    });
    const rewritten = rewriteNodeNameReferences(graph, "lfo1", "wobble");
    expect(rewritten).toBe(2);
    const parameters = (graph as { nodes: Record<string, { parameters: Record<string, { bindings: { driven: { channel: string } } }> }> })
      .nodes["user"]!.parameters;
    expect(parameters["a"]?.bindings.driven.channel).toBe("wobble");
    expect(parameters["b"]?.bindings.driven.channel).toBe("wobble:x");
    expect(parameters["c"]?.bindings.driven.channel).toBe("other1");
  });

  it("kind 3 (T350): a feedback source follows the rename", () => {
    const graph = {
      revision: 1,
      nodes: {
        mix: { id: "mix", type: "over", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "over1" },
        echo: { id: "echo", type: "feedback", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source: "over1" } },
      },
      edges: {},
      groups: {},
    } as never;
    expect(rewriteNodeNameReferences(graph, "over1", "blend")).toBe(1);
    expect(
      (graph as { nodes: Record<string, { parameters: Record<string, unknown> }> }).nodes["echo"]!.parameters["source"],
    ).toBe("blend");
  });
});
