import { describe, expect, it } from "vitest";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { blurNode, solidNode } from "@nodes/registry/test-nodes.ts";
import { DEFAULT_GROUP, groupParameters } from "./parameter-groups.ts";
import { resolveParameter, resolveParameters } from "./parameter-resolver.ts";

/**
 * The single parameter read path (doc §8.2).
 *
 * v1 behaviour is a passthrough, and these tests pin the two things that must stay true
 * when it stops being one: the effective value and the stored value are distinguishable,
 * and every reader gets the effective one.
 */

function nodeWith(parameters: GraphNode["parameters"], type = blurNode.type): GraphNode {
  return {
    id: "node-1" as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  };
}

describe("effective values", () => {
  it("returns the stored value when the document has a usable one", () => {
    const resolved = resolveParameters(nodeWith({ radius: 12 }), blurNode);
    expect(resolved.get("radius")).toMatchObject({ value: 12, stored: 12, source: "static" });
    expect(resolved.values).toEqual({ radius: 12 });
  });

  it("falls back to the manifest default when the document has nothing", () => {
    const resolved = resolveParameters(nodeWith({}), blurNode);
    expect(resolved.get("radius")).toMatchObject({ value: 4, stored: undefined, source: "default" });
  });

  it("falls back when the stored value does not fit the manifest", () => {
    // An older project, a renamed type, an agent patch built against a stale schema.
    const resolved = resolveParameters(nodeWith({ radius: "big" as unknown as number }), blurNode);
    expect(resolved.get("radius")).toMatchObject({ value: 4, source: "default" });
    expect(resolved.get("radius")?.stored).toBe("big");
  });

  it("keeps manifest order, which is the order the author chose", () => {
    const resolved = resolveParameters(nodeWith({}), solidNode);
    expect(resolved.entries.map((entry) => entry.key)).toEqual(Object.keys(solidNode.parameters));
  });

  it("resolves nothing for an unknown node type rather than guessing a schema (§V10)", () => {
    const resolved = resolveParameters(nodeWith({ anything: 1 }, "not.registered"), undefined);
    expect(resolved.entries).toEqual([]);
    expect(resolved.values).toEqual({});
  });

  it("copies array-valued defaults so two nodes never share one array", () => {
    const first = resolveParameters(nodeWith({}), solidNode).get("color")?.value;
    const second = resolveParameters(nodeWith({}), solidNode).get("color")?.value;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe("the driver seam (doc §8.2 — keyframes, expressions, MIDI, audio, links)", () => {
  const definition = blurNode.parameters["radius"];
  if (definition === undefined) throw new Error("fixture lost its radius parameter");

  it("prefers a driver's value over the stored one, and says the value is driven", () => {
    const node = nodeWith({ radius: 12 });
    const resolved = resolveParameter(node, "radius", definition, {
      drivers: { radius: () => 30 },
    });
    expect(resolved).toMatchObject({ value: 30, stored: 12, source: "driven", driven: true });
  });

  it("validates a driver's output against the manifest like any other value", () => {
    const node = nodeWith({ radius: 12 });
    const resolved = resolveParameter(node, "radius", definition, {
      drivers: { radius: () => "nonsense" as unknown as number },
    });
    expect(resolved.value).toBe(4);
  });

  it("falls back to the static value when a driver declines to produce one", () => {
    const node = nodeWith({ radius: 12 });
    const resolved = resolveParameter(node, "radius", definition, {
      drivers: { radius: () => undefined },
    });
    expect(resolved).toMatchObject({ value: 12, driven: false });
  });

  it("hands the frame to the driver rather than letting it read a clock (§V44)", () => {
    const node = nodeWith({ radius: 12 });
    const frame = {
      timeSeconds: 2,
      deltaSeconds: 0.016,
      frameIndex: 120,
      mode: "realtime" as const,
      randomSeed: 7,
    };
    const resolved = resolveParameter(node, "radius", definition, {
      frame,
      drivers: { radius: (ctx) => (ctx.frame?.frameIndex ?? 0) / 10 },
    });
    expect(resolved.value).toBe(12);
  });
});

describe("grouping (T38)", () => {
  it("puts ungrouped parameters under one default group", () => {
    const groups = groupParameters(resolveParameters(nodeWith({}), blurNode).entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe(DEFAULT_GROUP);
  });

  it("keeps groups in the order their first member appears in the manifest", () => {
    const entries = resolveParameters(
      nodeWith({}),
      {
        ...blurNode,
        parameters: {
          a: { type: "number", label: "A", default: 0, group: "Shape" },
          b: { type: "number", label: "B", default: 0 },
          c: { type: "number", label: "C", default: 0, group: "Shape" },
          d: { type: "number", label: "D", default: 0, group: "Colour" },
        },
      },
    ).entries;

    const groups = groupParameters(entries);
    expect(groups.map((group) => group.name)).toEqual(["Shape", DEFAULT_GROUP, "Colour"]);
    expect(groups[0]?.entries.map((entry) => entry.key)).toEqual(["a", "c"]);
  });
});
