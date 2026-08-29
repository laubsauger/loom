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
