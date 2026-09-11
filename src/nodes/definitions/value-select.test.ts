import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";

/**
 * T1298 — `valueSelect`, through the real value graph.
 *
 * The node is a thin projection over `domain/channels/channel-patterns.ts` (whose own table
 * test carries the pattern rules), so what is asserted here is what a USER of the node reads
 * back: which channels arrive downstream, with which values, in which order. The source is
 * `mouse` because it publishes a multi-channel bag with no configuration, and the pointer
 * sits OUTSIDE 0..1 on purpose — that is what separates the Select's `*` from the clamping
 * `valueLimit` E66 uses as a stand-in Null.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode {
  return { id: id as NodeId, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id } as GraphNode;
}

function through(type: string, parameters: Record<string, unknown> = {}) {
  const graph = {
    revision: 1,
    nodes: { mouse1: node("mouse1", "mouse"), tap1: node("tap1", type, parameters) },
    edges: { e0: { id: "e0", source: { nodeId: "mouse1", portId: "out" }, target: { nodeId: "tap1", portId: "in" } } },
    groups: {},
  } as unknown as GraphDocument;
  const frame: FrameEvaluationInput = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 };
  const result = createValueGraphSession(registry).evaluate(graph, frame, { pointer: { x: 1.7, y: -0.4, buttons: 1 } });
  expect(result.diagnostics).toEqual([]);
  const bag = result.byName.get("tap1") ?? {};
  return { values: bag, order: Object.keys(bag) };
}

describe("valueSelect — which channels, with their values, in pattern order (T1298)", () => {
  it("at its default `*` passes the bag through unchanged — the value lane's Null", () => {
    const tap = through("valueSelect");
    expect(tap.values).toEqual({ x: 1.7, y: -0.4, buttons: 1 });
    expect(tap.order).toEqual(["x", "y", "buttons"]);
    // The contrast that makes it a Null and a Limit not one: the Limit cuts both axes.
    expect(through("valueLimit").values).toEqual({ x: 1, y: 0, buttons: 1 });
  });

  it("keeps only what matches, in the order the patterns are written", () => {
    expect(through("valueSelect", { channels: "y x" })).toEqual({ values: { y: -0.4, x: 1.7 }, order: ["y", "x"] });
    expect(through("valueSelect", { channels: "b*" }).values).toEqual({ buttons: 1 });
  });

  it("removes what a ^ pattern matches, and an empty field passes nothing", () => {
    expect(through("valueSelect", { channels: "^buttons" }).values).toEqual({ x: 1.7, y: -0.4 });
    expect(through("valueSelect", { channels: "" }).values).toEqual({});
  });
});
