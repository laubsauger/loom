import { describe, expect, it } from "vitest";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import { formatComponentPath } from "@domain/types/components.ts";
import { componentPathNames } from "@domain/components/navigation.ts";
import {
  createComponentHarness,
  graphOf,
  instanceNode,
  node,
} from "@domain/components/test-support.ts";
import { resolveComponentNavigation, resolveComponentParameters } from "./component-scope.ts";

/**
 * §V81 / T133 — `parent.<key>` resolved THROUGH the §V61 resolver, at any nesting depth.
 *
 * Three components deep on purpose: one level proves nothing about a chain walk, and the
 * two-and-three-hop cases are where a per-depth special case would show up.
 */

const numberParameter = (label: string, value: number) =>
  ({ type: "number", label, default: value, min: 0, max: 64 }) as const;

function nested() {
  const harness = createComponentHarness();

  const inner: GraphComponentDefinition = {
    componentId: "inner",
    version: 1,
    name: "Inner",
    graph: graphOf([
      node("b1", "test.blur", { radius: 4 }, { state: { parentBindings: { radius: "parent.blur" } } }),
      node("b2", "test.blur", { radius: 4 }, {
        state: { parentBindings: { radius: "parent.parent.gain" } },
      }),
      node("b3", "test.blur", { radius: 4 }, {
        state: { parentBindings: { radius: "parent.parent.parent.mix" } },
      }),
      node("b4", "test.blur", { radius: 4 }, { state: { parentBindings: { radius: "parent.nope" } } }),
    ]),
    inputs: [],
    outputs: [],
    // Published purely as lexical scope for the children: a knob a descendant reads is a
    // knob, even when it drives nothing directly (§V81).
    parameters: [{ key: "blur", definition: numberParameter("Blur", 4), targets: [] }],
  };

  const outer: GraphComponentDefinition = {
    componentId: "outer",
    version: 1,
    name: "Outer",
    graph: graphOf([instanceNode("innerInst", "inner", 1, { blur: 7 })]),
    inputs: [],
    outputs: [],
    parameters: [{ key: "gain", definition: numberParameter("Gain", 1), targets: [] }],
  };

  const outermost: GraphComponentDefinition = {
    componentId: "outermost",
    version: 1,
    name: "Outermost",
    graph: graphOf([instanceNode("outerInst", "outer", 1, { gain: 3 })]),
    inputs: [],
    outputs: [],
    parameters: [{ key: "mix", definition: numberParameter("Mix", 1), targets: [] }],
  };

  harness.components.register(inner);
  harness.components.register(outer);
  harness.components.register(outermost);

  const root = graphOf([instanceNode("rootInst", "outermost", 1, { mix: 2 })]);
  return { harness, root };
}

function navigate(path: string[]) {
  const { harness, root } = nested();
  return {
    harness,
    resolved: resolveComponentNavigation({
      root,
      path,
      components: harness.components.view(),
      nodes: harness.nodes,
    }),
  };
}

describe("parent scope through resolveParameters (§V61, §V81)", () => {
  it("resolves one, two and three hops out from three levels deep", () => {
    const { harness, resolved } = navigate(["rootInst", "outerInst", "innerInst"]);
    const blurManifest = harness.nodes.get("test.blur");

    const radiusOf = (nodeId: string): unknown => {
      const target = resolved.graph.nodes[nodeId];
      const { resolved: values } = resolveComponentParameters(target!, blurManifest, resolved.scope);
      return values.get("radius")?.value;
    };

    expect(radiusOf("b1")).toBe(7); // parent.blur          — the owning component
    expect(radiusOf("b2")).toBe(3); // parent.parent.gain   — two levels out
    expect(radiusOf("b3")).toBe(2); // parent.parent.parent.mix — three levels out
  });

  it("marks a resolved binding as DRIVEN, so a control can say the value is not its own", () => {
    const { harness, resolved } = navigate(["rootInst", "outerInst", "innerInst"]);
    const entry = resolveComponentParameters(
      resolved.graph.nodes.b1!,
      harness.nodes.get("test.blur"),
      resolved.scope,
    ).resolved.get("radius");
    expect(entry?.driven).toBe(true);
    // The document value is still there: an edit writes to the static value (§V61).
    expect(entry?.stored).toBe(4);
  });

  it("REPORTS an unknown key and keeps the stored value, rather than returning undefined", () => {
    const { harness, resolved } = navigate(["rootInst", "outerInst", "innerInst"]);
    const outcome = resolveComponentParameters(
      resolved.graph.nodes.b4!,
      harness.nodes.get("test.blur"),
      resolved.scope,
    );
    expect(outcome.resolved.get("radius")?.value).toBe(4);
    expect(outcome.resolved.get("radius")?.driven).toBe(false);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "component.parentScope.unknown-key",
    ]);
  });

  it("reports a binding evaluated in the root graph, where there is no parent", () => {
    const { harness } = nested();
    const orphan = node("b1", "test.blur", { radius: 4 }, {
      state: { parentBindings: { radius: "parent.blur" } },
    });
    const outcome = resolveComponentParameters(orphan, harness.nodes.get("test.blur"), undefined);
    expect(outcome.diagnostics[0]?.code).toBe("component.parentScope.no-scope");
    expect(outcome.resolved.get("radius")?.value).toBe(4);
  });

  it("leaves an unbound parameter alone", () => {
    const { harness, resolved } = navigate(["rootInst", "outerInst", "innerInst"]);
    const plain = node("plain", "test.blur", { radius: 9 });
    const outcome = resolveComponentParameters(plain, harness.nodes.get("test.blur"), resolved.scope);
    expect(outcome.resolved.get("radius")).toMatchObject({ value: 9, driven: false });
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("component navigation (T130, §V82)", () => {
  it("builds the scope chain outermost-last, one entry per level entered", () => {
    const depthTwo = navigate(["rootInst", "outerInst"]).resolved;
    expect(depthTwo.scope?.parameters).toEqual({ gain: 3 });
    expect(depthTwo.scope?.parent?.parameters).toEqual({ mix: 2 });
    expect(depthTwo.scope?.parent?.parent).toBeUndefined();
    expect(depthTwo.hostComponentId).toBe("outer");
  });

  it("shows the graph of the innermost component, not the root", () => {
    const { resolved } = navigate(["rootInst", "outerInst", "innerInst"]);
    expect(Object.keys(resolved.graph.nodes).sort()).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("names the trail the way a diagnostic path names it (§V82)", () => {
    const { resolved } = navigate(["rootInst", "outerInst", "innerInst"]);
    expect(resolved.breadcrumbs.map((crumb) => crumb.label)).toEqual([
      "Main",
      "Outermost_1",
      "Outer_1",
      "Inner_1",
    ]);
    expect(formatComponentPath(resolved.resolvedPath, componentPathNames(resolved.frames))).toBe(
      "Main / Outermost_1 / Outer_1 / Inner_1",
    );
  });

  it("truncates a stale path with a diagnostic instead of leaving the editor nowhere", () => {
    const { resolved } = navigate(["rootInst", "ghost"]);
    expect(resolved.resolvedPath).toEqual(["rootInst"]);
    expect(resolved.diagnostics[0]?.code).toBe("component.path.missingNode");
    expect(resolved.hostComponentId).toBe("outermost");
  });

  it("stops at an uninstalled component rather than pretending it is empty", () => {
    const { harness, root } = nested();
    harness.components.remove("inner");
    const resolved = resolveComponentNavigation({
      root,
      path: ["rootInst", "outerInst", "innerInst"],
      components: harness.components.view(),
      nodes: harness.nodes,
    });
    expect(resolved.resolvedPath).toEqual(["rootInst", "outerInst"]);
    expect(resolved.diagnostics[0]?.code).toBe("component.path.notInstalled");
  });

  it("has no scope at the root, which is what makes parent a lexical relationship", () => {
    const { resolved } = navigate([]);
    expect(resolved.scope).toBeUndefined();
    expect(resolved.hostComponentId).toBeNull();
    expect(resolved.breadcrumbs).toEqual([{ label: "Main", path: [] }]);
  });
});

/**
 * T187 / §V56 / B8 — a published DISPLAY colour must reach the child still encoded.
 *
 * The scope chain is not an evaluation result; it is an intermediate the child's own
 * resolution re-reads. `ResolvedParameters.values` is already decoded for evaluation, so
 * publishing it makes the child decode a second time and the rendered colour lands far
 * darker than the swatch the user picked. B8 is the same family: nobody reports it,
 * because a colour that is merely too dark reads as an art-direction choice.
 */
function tinted() {
  const harness = createComponentHarness();

  const inner: GraphComponentDefinition = {
    componentId: "tint",
    version: 1,
    name: "Tint",
    graph: graphOf([
      node("s1", "test.solid", { color: [0.25, 0.25, 0.25, 1] }, {
        state: { parentBindings: { color: "parent.tint" } },
      }),
    ]),
    inputs: [],
    outputs: [],
    parameters: [
      {
        key: "tint",
        definition: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" },
        targets: [{ nodeId: "s1", key: "color" }],
      },
    ],
  };
  harness.components.register(inner);

  const root = graphOf([instanceNode("tintInst", "tint", 1, { tint: [0.5, 0.5, 0.5, 1] })]);
  const resolved = resolveComponentNavigation({
    root,
    path: ["tintInst"],
    components: harness.components.view(),
    nodes: harness.nodes,
  });
  return { harness, resolved };
}

describe("T187 — a published display colour decodes ONCE (§V56, B8)", () => {
  /** srgbToLinear(0.5). What a picked mid-grey is worth as light. */
  const MID_GREY_LINEAR = 0.21404114048223255;

  it("publishes the STORED value into the scope, not the decoded one", () => {
    const { resolved } = tinted();
    // The instance's own page is display-encoded, exactly as the user picked it. Decoding
    // here is invisible: the number only looks wrong once a child has decoded it again.
    expect(resolved.scope?.parameters.tint).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it("decodes a bound child colour ONCE — it must not land at a fifth of its light", () => {
    const { harness, resolved } = tinted();
    const child = resolveComponentParameters(
      resolved.graph.nodes.s1!,
      harness.nodes.get("test.solid"),
      resolved.scope,
    );

    // What the inspector shows the user: the space they picked in (§V56, T148).
    expect(child.resolved.get("color")?.value).toEqual([0.5, 0.5, 0.5, 1]);
    expect(child.resolved.get("color")?.driven).toBe(true);

    // What the shader gets. The double decode put this at 0.0376 — dark enough to read as
    // an art-direction choice, which is precisely why B8 went unreported.
    const evaluated = child.resolved.values.color as readonly number[];
    expect(evaluated[0]).toBeCloseTo(MID_GREY_LINEAR, 12);
    expect(evaluated[1]).toBeCloseTo(MID_GREY_LINEAR, 12);
    expect(evaluated[2]).toBeCloseTo(MID_GREY_LINEAR, 12);
    expect(evaluated[3]).toBe(1); // alpha is coverage, never transferred
  });

  it("still decodes a colour the child holds itself, so the fix is not just a bypass", () => {
    const { harness, resolved } = tinted();
    const unbound = node("plain", "test.solid", { color: [0.5, 0.5, 0.5, 1] });
    const outcome = resolveComponentParameters(
      unbound,
      harness.nodes.get("test.solid"),
      resolved.scope,
    );
    expect((outcome.resolved.values.color as readonly number[])[0]).toBeCloseTo(
      MID_GREY_LINEAR,
      12,
    );
  });
});
