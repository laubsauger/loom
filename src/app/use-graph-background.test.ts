import { describe, expect, it } from "vitest";

import { backgroundRect, graphBackgroundMarks } from "./use-graph-background.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ResolvedOutput } from "@compiler/index.ts";

/**
 * T463 — the graph background's pure halves. The GPU half is the same preview system
 * every tile uses (T185/T252) on a second canvas; what is NEW and therefore pinned
 * here is which nodes qualify, in which order, and how the image sits in the pane.
 */

function doc(nodes: Record<string, { background?: boolean }>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, ui]) => [
        id,
        {
          id,
          type: "noise",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {},
          ...(ui.background === undefined ? {} : { ui: { background: ui.background } }),
        },
      ]),
    ),
    edges: {},
    groups: {},
  } as never;
}

const row = (nodeId: string): ResolvedOutput =>
  ({
    nodeId,
    portId: "out",
    resourceId: `target:${nodeId}:out`,
    resourceKind: "target",
    size: [640, 360],
    format: "rgba8unorm",
    space: "linear",
    temporal: false,
  }) as never;

describe("graphBackgroundMarks (T463)", () => {
  it("lists ONLY flagged nodes, in document order, with their materialized rows", () => {
    const graph = doc({ a: {}, b: { background: true }, c: { background: true }, d: { background: false } });
    const marks = graphBackgroundMarks(graph, [row("c")]);
    expect(marks.map((mark) => mark.nodeId)).toEqual(["b", "c"]);
    // b is flagged but not yet materialized — present with no row, so the caller can
    // still register its sink (T252's materialize-on-watch dance).
    expect(marks[0]?.output).toBeUndefined();
    expect(marks[1]?.output?.resourceId).toBe("target:c:out");
  });

  it("an unmarked document yields nothing — zero cost when nothing is flagged (V309)", () => {
    expect(graphBackgroundMarks(doc({ a: {}, b: {} }), [row("a")])).toEqual([]);
  });
});

describe("backgroundRect letterboxes, never stretches (§V118)", () => {
  it("centres a wide output in a taller pane", () => {
    const rect = backgroundRect({ width: 1000, height: 1000 }, [640, 360]);
    expect(rect.width).toBe(1000);
    expect(rect.height).toBe(562.5);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe((1000 - 562.5) / 2);
  });

  it("centres a tall output in a wider pane", () => {
    const rect = backgroundRect({ width: 1000, height: 500 }, [360, 640]);
    expect(rect.height).toBe(500);
    expect(rect.width).toBe(281.25);
    expect(rect.y).toBe(0);
  });
});
