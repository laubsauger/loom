import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { isValueOnlyPatch, operationClass, overlappingEntities, touchedEntities } from "./patch-scope.ts";

/**
 * §V33 / T107: patch operations are classified, and the classification decides what an
 * operation can contend with.
 *
 * These are unit tests over the classifier itself. The behaviour it produces — a 60Hz
 * drag not starving an agent patch — is tested through the bus in `apply-patch.test.ts`.
 */

const graph = (): GraphDocument => ({
  revision: 5,
  nodes: {
    a: { id: "a", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    b: { id: "b", type: "test.blur", definitionVersion: 1, position: { x: 100, y: 0 }, parameters: {} },
    c: { id: "c", type: "test.blur", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
  },
  edges: {
    e1: { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "source" } },
    e2: { id: "e2", source: { nodeId: "b", portId: "out" }, target: { nodeId: "c", portId: "source" } },
  },
  groups: {
    g1: { id: "g1", label: "Chain", bounds: { x: 0, y: 0, width: 1, height: 1 }, members: ["a", "b"] },
  },
});

const scope = (operation: GraphPatchOperation): string[] => [...touchedEntities(operation, graph())].sort();

describe("operation classification (§V33)", () => {
  it("classifies value edits and structural edits apart", () => {
    const value: GraphPatchOperation[] = [
      { op: "setParameters", nodeId: "a", parameters: { amount: 1 } },
      { op: "setShaderSource", nodeId: "a", source: "" },
      { op: "moveNodes", positions: { a: { x: 1, y: 1 } } },
      { op: "setNodeUi", nodeId: "a", ui: { bypassed: true } },
      { op: "setNodeLabel", nodeId: "a", label: "x" },
      { op: "setNodeResolution", nodeId: "a", resolution: null },
      { op: "setNodeFormat", nodeId: "a", format: null },
      { op: "setGroup", groupId: "g1", label: "x" },
      { op: "setViewport", viewport: null },
    ];
    const structural: GraphPatchOperation[] = [
      { op: "addNode", ref: "$n", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "removeNodes", nodeIds: ["a"] },
      { op: "connect", source: { nodeId: "a", portId: "out" }, target: { nodeId: "c", portId: "source" } },
      { op: "disconnect", edgeIds: ["e1"] },
      { op: "addGroup", ref: "$g", label: "x", bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { op: "removeGroups", groupIds: ["g1"] },
    ];

    for (const operation of value) expect(operationClass(operation)).toBe("value");
    for (const operation of structural) expect(operationClass(operation)).toBe("structural");
    expect(isValueOnlyPatch(value)).toBe(true);
    expect(isValueOnlyPatch([...value, ...structural])).toBe(false);
  });
});

describe("entity scope (§V33)", () => {
  it("scopes a value edit to the one entity whose value changes", () => {
    expect(scope({ op: "setParameters", nodeId: "a", parameters: { amount: 1 } })).toEqual(["node:a"]);
    expect(scope({ op: "moveNodes", positions: { a: { x: 0, y: 0 }, c: { x: 0, y: 0 } } })).toEqual([
      "node:a",
      "node:c",
    ]);
    // The viewport has no entity identity: two actors framing the canvas differently is
    // not a conflict, so it contends with nothing.
    expect(scope({ op: "setViewport", viewport: { x: 0, y: 0, zoom: 1 } })).toEqual([]);
  });

  it("scopes a delete to the edges and groups it cascades into (§V40)", () => {
    expect(scope({ op: "removeNodes", nodeIds: ["b"] })).toEqual([
      "edge:e1",
      "edge:e2",
      "group:g1",
      "node:b",
    ]);
  });

  it("scopes a connect to the edges already landing on the target port (§V14)", () => {
    // e1 already occupies b.source, so a second connect there contends with it even
    // though the caller never named that edge.
    expect(scope({ op: "connect", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "source" } })).toEqual([
      "edge:e1",
      "node:a",
      "node:b",
    ]);
  });

  it("gives a $temp ref no scope: it names something nobody else can have touched", () => {
    expect(scope({ op: "addNode", ref: "$new", type: "test.solid", position: { x: 0, y: 0 } })).toEqual([]);
    expect(scope({ op: "addGroup", ref: "$g", label: "x", bounds: { x: 0, y: 0, width: 1, height: 1 }, members: ["$new"] })).toEqual([]);
    // A STABLE ref means "create this exact id", which can collide.
    expect(scope({ op: "addNode", ref: "fixed", type: "test.solid", position: { x: 0, y: 0 } })).toEqual([
      "node:fixed",
    ]);
  });
});

describe("overlap against the store's owner map", () => {
  const owners = { "node:a": { revision: 9 }, "node:b": { revision: 3 } };

  it("reports only the entities changed after the base revision", () => {
    const operations: GraphPatchOperation[] = [
      { op: "setNodeLabel", nodeId: "a", label: "x" },
      { op: "setNodeLabel", nodeId: "b", label: "y" },
    ];
    expect(overlappingEntities(operations, graph(), owners, 5)).toEqual(["node:a"]);
    // Built against a revision newer than both edits: nothing is in the way.
    expect(overlappingEntities(operations, graph(), owners, 9)).toEqual([]);
  });

  it("treats an entity with no owner row as unchanged", () => {
    // T103 evicts the OLDEST owner rows first, so a missing row can only mean an edit
    // older than any patch a live caller could still be holding.
    expect(
      overlappingEntities([{ op: "setNodeLabel", nodeId: "c", label: "x" }], graph(), owners, 0),
    ).toEqual([]);
  });
});
