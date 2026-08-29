import { describe, expect, it } from "vitest";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { componentNodeType } from "./component-type.ts";
import { ComponentDefinitionError, createComponentSystem } from "./registry.ts";
import { bloomComponent, blurKnob, graphOf, instanceNode, node } from "./test-support.ts";

/** T128 — the catalogue, and the node-registry view that makes an instance an ordinary node. */

function system() {
  return createComponentSystem(createTestRegistry().view());
}

describe("component registry", () => {
  it("keeps versions side by side, because instances pin one (§V84)", () => {
    const { components } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    components.register(bloomComponent("bloom", 2, [blurKnob]));

    expect(components.versions("bloom")).toEqual([1, 2]);
    expect(components.get("bloom", 1)?.version).toBe(1);
    expect(components.latest("bloom")?.version).toBe(2);
    // The library lists one entry per component, at its newest version.
    expect(components.list().map((definition) => definition.version)).toEqual([2]);
  });

  it("REPLACES a definition registered at the same version — that is how a fix lands (§V79)", () => {
    const { components } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    const fixed = bloomComponent("bloom", 1, [blurKnob]);
    fixed.graph.nodes.blurA = { ...fixed.graph.nodes.blurA!, parameters: { radius: 30 } };
    components.register(fixed);

    expect(components.versions("bloom")).toEqual([1]);
    expect(components.get("bloom", 1)?.graph.nodes.blurA?.parameters.radius).toBe(30);
  });

  it("refuses a recursive definition at register time — which is save and load (§V83)", () => {
    const { components } = system();
    const selfReferential = {
      ...bloomComponent("loop", 1),
      graph: graphOf([instanceNode("inner", "loop", 1)]),
      inputs: [],
      outputs: [],
    };
    expect(() => components.register(selfReferential)).toThrow(ComponentDefinitionError);
  });

  it("refuses an exposed port that does not exist inside", () => {
    const { components } = system();
    const broken = {
      ...bloomComponent("bad", 1),
      inputs: [{ externalId: "source", label: "Source", nodeId: "nope", portId: "source" }],
    };
    expect(() => components.register(broken)).toThrow(/not in the component/);
  });

  it("notifies subscribers so a pane can re-render when a component is re-authored", () => {
    const { components } = system();
    let calls = 0;
    const stop = components.subscribe(() => {
      calls += 1;
    });
    components.register(bloomComponent());
    expect(calls).toBe(1);
    stop();
    components.register(bloomComponent("bloom", 2));
    expect(calls).toBe(1);
  });
});

describe("component-aware node registry", () => {
  it("types an exposed port from the internal port it maps to", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));

    const port = nodes.port(componentNodeType("bloom", 1), "source", "input");
    // Same type as test.blur's own input, so §V13 connection rules apply unchanged.
    expect(port?.type).toEqual({ kind: "texture2d", sample: "float", channels: 4 });
    expect(nodes.port(componentNodeType("bloom", 1), "out", "output")).toBeDefined();
  });

  it("gives each version its own manifest, so a pinned instance sees its own ports", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    components.register({ ...bloomComponent("bloom", 2, [blurKnob]), inputs: [] });

    expect(nodes.port(componentNodeType("bloom", 1), "source", "input")).toBeDefined();
    // v2 dropped the port; the v1 instance must not be validated against v2.
    expect(nodes.port(componentNodeType("bloom", 2), "source", "input")).toBeUndefined();
  });

  it("exposes the published parameter page as the manifest's parameters", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    const manifest = nodes.get(componentNodeType("bloom", 1));
    expect(manifest?.parameters.blur).toMatchObject({ type: "number", label: "Blur", max: 64 });
    expect(manifest?.title).toBe("Bloom");
  });

  it("still answers for ordinary node types, and for neither when unknown", () => {
    const { nodes } = system();
    expect(nodes.get("test.blur")?.title).toBe("Blur");
    expect(nodes.get("component:nope@1")).toBeUndefined();
    expect(nodes.has("component:nope@1")).toBe(false);
  });

  it("reflects a re-authored definition without any invalidation step (§V79)", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    expect(nodes.get(componentNodeType("bloom", 1))?.title).toBe("Bloom");

    components.register({ ...bloomComponent("bloom", 1, [blurKnob]), name: "Glow" });
    expect(nodes.get(componentNodeType("bloom", 1))?.title).toBe("Glow");
  });

  it("types a component nested inside a component", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    components.register({
      componentId: "outer",
      version: 1,
      name: "Outer",
      graph: graphOf([instanceNode("inner", "bloom", 1)]),
      inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [],
    });

    const port = nodes.port(componentNodeType("outer", 1), "source", "input");
    expect(port?.type).toEqual({ kind: "texture2d", sample: "float", channels: 4 });
  });

  it("drops an exposure whose internal node was deleted rather than failing to save", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    // Simulates the user deleting blurC inside the component.
    const definition = components.get("bloom", 1)!;
    const nodesWithout = { ...definition.graph.nodes };
    delete nodesWithout.blurC;
    expect(() =>
      components.register({ ...definition, graph: { ...definition.graph, nodes: nodesWithout } }),
    ).toThrow(/not in the component/);

    // ...which is why a session prunes first. Pruned, the same edit registers cleanly.
    const pruned = {
      ...definition,
      graph: { ...definition.graph, nodes: nodesWithout },
      outputs: [],
      parameters: [
        { ...blurKnob, targets: blurKnob.targets.filter((target) => target.nodeId !== "blurC") },
      ],
    };
    expect(() => components.register(pruned)).not.toThrow();
    expect(nodes.get(componentNodeType("bloom", 1))?.outputs).toEqual([]);
  });

  it("keeps a component out of the ordinary node categories only by its own category", () => {
    const { components, nodes } = system();
    components.register(bloomComponent("bloom", 1, [blurKnob]));
    expect(nodes.categories()).toContain("component");
    expect(nodes.list().some((definition) => definition.type === componentNodeType("bloom", 1))).toBe(true);
  });

  it("reports no §V46 stateful declaration for a component, rather than inventing one", () => {
    const { components, nodes } = system();
    components.register({
      ...bloomComponent("stateful", 1),
      graph: graphOf([node("fb", "test.feedback", { decay: 0.9 })]),
      inputs: [],
      outputs: [],
    });
    expect(nodes.statefulDeclaration(componentNodeType("stateful", 1))).toBeUndefined();
    expect(nodes.statefulDeclaration("test.feedback")).toBeDefined();
  });
});
