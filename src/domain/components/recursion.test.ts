import { describe, expect, it } from "vitest";
import { componentNodeType } from "./component-type.ts";
import { componentReferences, detectComponentRecursion, wouldRecurse } from "./recursion.ts";
import type { ComponentGraphSource } from "./recursion.ts";
import { graphOf, instanceNode, node } from "./test-support.ts";

/**
 * §V83 — component recursion is forbidden, direct AND indirect.
 *
 * The point of these tests is that a recursive project must be IMPOSSIBLE TO CREATE, not
 * merely detected late: once saved it would fail at compile with no way back.
 */

function sourceOf(graphs: Record<string, ReturnType<typeof graphOf>>): ComponentGraphSource {
  return { graphOf: (componentId) => graphs[componentId] };
}

describe("detectComponentRecursion (§V83)", () => {
  it("accepts a component that contains no components at all", () => {
    const graphs = { a: graphOf([node("blur", "test.blur")]) };
    expect(
      detectComponentRecursion({ componentId: "a", graph: graphs.a, source: sourceOf(graphs) }),
    ).toBeNull();
  });

  it("accepts nesting that terminates", () => {
    const graphs = {
      leaf: graphOf([node("blur", "test.blur")]),
      mid: graphOf([instanceNode("n1", "leaf", 1)]),
      top: graphOf([instanceNode("n2", "mid", 1)]),
    };
    expect(
      detectComponentRecursion({ componentId: "top", graph: graphs.top, source: sourceOf(graphs) }),
    ).toBeNull();
  });

  it("catches DIRECT recursion: A contains A", () => {
    const graphs = { a: graphOf([instanceNode("n1", "a", 1)]) };
    const found = detectComponentRecursion({
      componentId: "a",
      graph: graphs.a,
      source: sourceOf(graphs),
    });
    expect(found).not.toBeNull();
    expect(found?.cycle).toEqual(["a", "a"]);
  });

  it("catches INDIRECT recursion: A contains B, B contains A", () => {
    // The case people miss. Nobody drops A inside A by accident; everybody builds the
    // two-hop version eventually, and it expands for ever just the same.
    const graphs = {
      a: graphOf([instanceNode("n1", "b", 1)]),
      b: graphOf([instanceNode("n2", "a", 1)]),
    };
    const found = detectComponentRecursion({
      componentId: "a",
      graph: graphs.a,
      source: sourceOf(graphs),
    });
    expect(found).not.toBeNull();
    // The whole loop is reported, not just the id it closed on: a user can act on
    // "a → b → a" and cannot act on "a is recursive".
    expect(found?.cycle).toEqual(["a", "b", "a"]);
  });

  it("catches a three-hop loop from a root project graph with no component of its own", () => {
    const graphs = {
      a: graphOf([instanceNode("n1", "b", 1)]),
      b: graphOf([instanceNode("n2", "c", 1)]),
      c: graphOf([instanceNode("n3", "a", 1)]),
    };
    const found = detectComponentRecursion({
      componentId: null,
      graph: graphOf([instanceNode("root", "a", 1)]),
      source: sourceOf(graphs),
    });
    expect(found?.cycle).toEqual(["a", "b", "c", "a"]);
  });

  it("treats two versions of one component as the same component", () => {
    // `a@2 -> b@1 -> a@1` expands for ever exactly as `a@1 -> a@1` does. Bookkeeping
    // keyed on componentId@version would let it through.
    const source: ComponentGraphSource = {
      graphOf: (componentId, version) => {
        if (componentId === "a" && version === 2) return graphOf([instanceNode("n1", "b", 1)]);
        if (componentId === "a" && version === 1) return graphOf([node("blur", "test.blur")]);
        if (componentId === "b") return graphOf([instanceNode("n2", "a", 1)]);
        return undefined;
      },
    };
    const found = detectComponentRecursion({
      componentId: "a",
      graph: graphOf([instanceNode("n1", "b", 1)]),
      source,
    });
    expect(found?.cycle).toEqual(["a", "b", "a"]);
  });

  it("does not call an uninstalled component a cycle (§V10 placeholder)", () => {
    const found = detectComponentRecursion({
      componentId: "a",
      graph: graphOf([instanceNode("n1", "missing", 1)]),
      source: sourceOf({}),
    });
    expect(found).toBeNull();
  });

  it("does not blow the stack on a diamond, where one component is visited twice", () => {
    const graphs = {
      leaf: graphOf([node("blur", "test.blur")]),
      left: graphOf([instanceNode("n1", "leaf", 1)]),
      right: graphOf([instanceNode("n2", "leaf", 1)]),
      top: graphOf([instanceNode("n3", "left", 1), instanceNode("n4", "right", 1)]),
    };
    expect(
      detectComponentRecursion({ componentId: "top", graph: graphs.top, source: sourceOf(graphs) }),
    ).toBeNull();
  });
});

describe("wouldRecurse — the check at instantiate (§V83)", () => {
  it("refuses putting a component inside itself", () => {
    const graphs = { a: graphOf([node("blur", "test.blur")]) };
    expect(wouldRecurse("a", "a", 1, sourceOf(graphs))?.cycle).toEqual(["a", "a"]);
  });

  it("refuses putting B inside A when B already contains A", () => {
    const graphs = {
      a: graphOf([node("blur", "test.blur")]),
      b: graphOf([instanceNode("n1", "a", 1)]),
    };
    expect(wouldRecurse("a", "b", 1, sourceOf(graphs))?.cycle).toEqual(["a", "b", "a"]);
  });

  it("allows anything in the root graph, which no component can contain", () => {
    const graphs = { a: graphOf([node("blur", "test.blur")]) };
    expect(wouldRecurse(null, "a", 1, sourceOf(graphs))).toBeNull();
  });
});

describe("componentReferences", () => {
  it("lists each referenced component version once", () => {
    const graph = graphOf([
      instanceNode("n1", "a", 1),
      instanceNode("n2", "a", 1),
      instanceNode("n3", "a", 2),
      node("blur", "test.blur"),
    ]);
    expect(componentReferences(graph)).toEqual([
      { componentId: "a", version: 1 },
      { componentId: "a", version: 2 },
    ]);
  });

  it("ignores a node whose type merely starts with the prefix but has no version", () => {
    const graph = graphOf([node("odd", "component:broken")]);
    expect(componentReferences(graph)).toEqual([]);
  });

  it("round-trips a component node type", () => {
    expect(componentNodeType("bloom", 3)).toBe("component:bloom@3");
  });
});
