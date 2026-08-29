import { describe, expect, it } from "vitest";
import { buildParentScope, parentScopeDrivers } from "../components/parent-scope.ts";
import type { ParentScope } from "../types/components.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import { resolveParameter, resolveParameters, srgbToLinear } from "./resolve.ts";

/**
 * The promoted §V61 resolver (T168, closing B8).
 *
 * These are the claims that must hold for the compiler and the inspector alike, because
 * after T168 there is one function and they are the same claims. What made B8 possible
 * was that they were only ever asserted against the editor's copy.
 */

const solidLike: NodeDefinition = {
  type: "test.solid",
  version: 1,
  title: "Solid",
  category: "generator",
  inputs: [],
  outputs: [],
  parameters: {
    color: { type: "color", label: "Color", default: [0, 0, 0, 1], space: "display" },
    linearColor: { type: "color", label: "Linear", default: [0, 0, 0, 1], space: "linear" },
    gain: { type: "number", label: "Gain", default: 4, min: 0, max: 64 },
  },
  compile: () => ({ passes: [] }),
};

function nodeWith(parameters: GraphNode["parameters"], id = "node-1"): GraphNode {
  return {
    id: id as NodeId,
    type: solidLike.type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  };
}

describe("display→linear decode reaches evaluation (T148, §V56, B8)", () => {
  it("decodes a display-space colour into `values`, leaving alpha alone", () => {
    const resolved = resolveParameters(nodeWith({ color: [0.5, 0.5, 0.5, 0.7] }), solidLike);
    const [r, g, b, a] = resolved.values["color"] as readonly number[];

    expect(r).toBeCloseTo(0.2140, 4);
    expect(g).toBeCloseTo(0.2140, 4);
    expect(b).toBeCloseTo(0.2140, 4);
    // Alpha is coverage, not light: encoding it would make 50% opacity compose wrong.
    expect(a).toBe(0.7);
  });

  it("leaves a space:\"linear\" colour untouched — it is already the working space", () => {
    const resolved = resolveParameters(nodeWith({ linearColor: [0.5, 0.5, 0.5, 0.7] }), solidLike);
    expect(resolved.values["linearColor"]).toEqual([0.5, 0.5, 0.5, 0.7]);
  });

  it("keeps the display/evaluation split: the entry a control renders is undecoded", () => {
    // If the per-entry value were decoded too, the picker would show a different number
    // than the one the user chose, every time the document round-tripped.
    const resolved = resolveParameters(nodeWith({ color: [0.5, 0.5, 0.5, 0.7] }), solidLike);
    expect(resolved.get("color")?.value).toEqual([0.5, 0.5, 0.5, 0.7]);
    expect(resolved.get("color")?.stored).toEqual([0.5, 0.5, 0.5, 0.7]);
    expect(resolved.values["color"]).not.toEqual([0.5, 0.5, 0.5, 0.7]);
  });

  it("decodes the manifest default too, not only a stored value", () => {
    const white: NodeDefinition = {
      ...solidLike,
      parameters: {
        color: { type: "color", label: "Color", default: [0.5, 0.5, 0.5, 1], space: "display" },
      },
    };
    const [r] = resolveParameters(nodeWith({}), white).values["color"] as readonly number[];
    expect(r).toBeCloseTo(srgbToLinear(0.5), 10);
  });
});

describe("validation decides the value, so it lives in the resolver (§V61)", () => {
  it("falls back to the default and says why when the manifest refuses the stored value", () => {
    const resolved = resolveParameters(nodeWith({ gain: "big" as unknown as number }), solidLike);
    const entry = resolved.get("gain");

    expect(entry?.value).toBe(4);
    expect(entry?.source).toBe("default");
    expect(entry?.stored).toBe("big");
    expect(entry?.diagnostic?.code).toBe("parameter.type");
    expect(resolved.diagnostics).toHaveLength(1);
  });

  it("treats an out-of-range number as unusable, the same way on both call sites", () => {
    // The one rule the two old implementations could still have disagreed about: the
    // editor's copy checked shape only, the compiler's checked range as well.
    const resolved = resolveParameters(nodeWith({ gain: 999 }), solidLike);
    expect(resolved.get("gain")?.value).toBe(4);
    expect(resolved.get("gain")?.diagnostic?.code).toBe("parameter.range");
  });

  it("reports nothing when the document is simply silent — a default is not a fault", () => {
    const resolved = resolveParameters(nodeWith({}), solidLike);
    expect(resolved.get("gain")).toMatchObject({ value: 4, source: "default", diagnostic: null });
    expect(resolved.diagnostics).toEqual([]);
  });

  it("copies array defaults so two nodes never share one array", () => {
    const first = resolveParameters(nodeWith({}), solidLike).get("color")?.value;
    const second = resolveParameters(nodeWith({}), solidLike).get("color")?.value;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("resolves nothing for an unknown node type rather than guessing a schema (§V10)", () => {
    const resolved = resolveParameters(nodeWith({ anything: 1 }), undefined);
    expect(resolved.entries).toEqual([]);
    expect(resolved.values).toEqual({});
  });
});

describe("the driver seam survives the promotion (§V61 injection point)", () => {
  const gain = solidLike.parameters["gain"];
  if (gain === undefined) throw new Error("fixture lost its gain parameter");

  it("prefers a driver's value and marks the parameter driven", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      drivers: { gain: () => 30 },
    });
    expect(resolved).toMatchObject({ value: 30, stored: 12, source: "driven", driven: true });
  });

  it("checks a driver's output against the manifest like any other value", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      drivers: { gain: () => "nonsense" as unknown as number },
    });
    expect(resolved.value).toBe(4);
    expect(resolved.diagnostic).not.toBeNull();
  });

  it("falls back to the stored value when a driver declines to produce one", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      drivers: { gain: () => undefined },
    });
    expect(resolved).toMatchObject({ value: 12, driven: false });
  });

  it("hands the frame to the driver rather than letting it read a clock (§V44)", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      frame: {
        timeSeconds: 2,
        deltaSeconds: 0.016,
        frameIndex: 120,
        mode: "realtime",
        randomSeed: 7,
      },
      drivers: { gain: (context) => (context.frame?.frameIndex ?? 0) / 10 },
    });
    expect(resolved.value).toBe(12);
  });
});

/**
 * §V81 through the promoted resolver. `parent.<key>` is the one driver that already
 * exists, so it is the one that proves the seam did not become decorative in the move.
 */
describe("parent.<key> bindings, at depth (§V81, T133)", () => {
  const bound = (reference: string): GraphNode => ({
    ...nodeWith({ gain: 1 }, "inner"),
    state: { parentBindings: { gain: reference } },
  });

  /** Outermost first: the outer component publishes 9, the inner one 5. */
  const scope: ParentScope | undefined = buildParentScope([{ gain: 9 }, { gain: 5 }]);

  it("reads one hop out", () => {
    const node = bound("parent.gain");
    const resolved = resolveParameters(node, solidLike, {
      drivers: parentScopeDrivers(node, scope),
    });
    expect(resolved.get("gain")).toMatchObject({ value: 5, source: "driven", driven: true });
  });

  it("reads two hops out — nesting is lexical, not a per-depth special case", () => {
    const node = bound("parent.parent.gain");
    const resolved = resolveParameters(node, solidLike, {
      drivers: parentScopeDrivers(node, scope),
    });
    expect(resolved.get("gain")?.value).toBe(9);
  });

  it("keeps the node's own value and reports when the binding cannot resolve", () => {
    const node = bound("parent.parent.parent.gain");
    const diagnostics: string[] = [];
    const resolved = resolveParameters(node, solidLike, {
      drivers: parentScopeDrivers(node, scope, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      }),
    });
    expect(resolved.get("gain")).toMatchObject({ value: 1, driven: false });
    expect(diagnostics).toEqual(["component.parentScope.too-deep"]);
  });

  it("decodes a parent-driven display colour for evaluation, like any other source", () => {
    const node: GraphNode = {
      ...nodeWith({ color: [0, 0, 0, 1] }, "inner"),
      state: { parentBindings: { color: "parent.tint" } },
    };
    const resolved = resolveParameters(node, solidLike, {
      drivers: parentScopeDrivers(node, buildParentScope([{ tint: [0.5, 0.5, 0.5, 1] }])),
    });
    expect(resolved.get("color")?.value).toEqual([0.5, 0.5, 0.5, 1]);
    expect((resolved.values["color"] as readonly number[])[0]).toBeCloseTo(0.2140, 4);
  });
});
