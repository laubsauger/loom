import { beforeEach, describe, expect, it } from "vitest";
import { alice, contextFor } from "../commands/test-support.ts";
import type { GraphDocument } from "../types/graph.ts";
import { componentNodeType } from "./component-type.ts";
import { readComponentInstance } from "./instance.ts";
import { internalParameterValues } from "./flatten.ts";
import { openComponentSession } from "./session.ts";
import {
  blurKnob,
  bloomComponent,
  createComponentHarness,
  graphOf,
  instanceNode,
  node,
  type ComponentHarness,
} from "./test-support.ts";

const ctx = contextFor(alice);

function radiiOf(graph: GraphDocument): number[] {
  return ["blurA", "blurB", "blurC"].map((id) => graph.nodes[id]?.parameters.radius as number);
}

describe("component.setPublishedParameter — one knob, N internal targets (§V80)", () => {
  let harness: ComponentHarness;

  beforeEach(() => {
    harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
  });

  it("writes every target in ONE patch and undoes as ONE step", async () => {
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });

    const before = session.store.view.getHistory(alice).undo.length;
    const result = await session.bus.execute(
      "component.setPublishedParameter",
      { key: "blur", value: 12 },
      ctx,
    );

    expect(result.status).toBe("applied");
    // Three internal radii, one edit.
    expect(radiiOf(session.store.view.getGraph())).toEqual([12, 12, 12]);
    // Merged into a single operation per node and a single patch overall (§V32).
    expect(result.output.appliedOperations).toBe(3);

    const history = session.store.view.getHistory(alice);
    expect(history.undo.length).toBe(before + 1);

    // The headline: undo once, and all three go back together. Three commands would be
    // three undo steps, and one undo would leave a component nobody authored.
    await session.bus.execute("graph.undo", {}, ctx);
    expect(radiiOf(session.store.view.getGraph())).toEqual([4, 4, 4]);

    session.dispose();
  });

  it("rejects a value the internal parameters cannot hold, writing none of them", async () => {
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });
    const result = await session.bus.execute(
      "component.setPublishedParameter",
      { key: "blur", value: 1000 },
      ctx,
    );
    expect(result.status).toBe("rejected");
    // §V32: all operations apply, or none do.
    expect(radiiOf(session.store.view.getGraph())).toEqual([4, 4, 4]);
    session.dispose();
  });

  it("is refused from the root graph, where there is no component to publish for", async () => {
    const result = await harness.bus.execute(
      "component.setPublishedParameter",
      { key: "blur", value: 12 },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("component.notInsideComponent");
  });

  it("fans a published value out to every target for an INSTANCE, which stores only its own value", () => {
    const definition = harness.components.get("bloom", 1);
    expect(definition).toBeDefined();
    // The instance's page holds one value; flattening expands it to three internal ones.
    const values = internalParameterValues(definition!, { blur: 9 });
    expect(values).toEqual({
      "blurA/radius": 9,
      "blurB/radius": 9,
      "blurC/radius": 9,
    });
  });
});

describe("component.publishParameter (T132)", () => {
  it("publishes a RE-AUTHORED control rather than a copy of the internal one", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent());
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });

    const result = await session.bus.execute(
      "component.publishParameter",
      {
        key: "blur",
        // Narrower range, friendlier label and unit than the internal 0..64 "Radius".
        definition: { type: "number", label: "Blur", default: 4, min: 0, max: 16, unit: "px" },
        targets: [
          { nodeId: "blurA", key: "radius" },
          { nodeId: "blurB", key: "radius" },
        ],
      },
      ctx,
    );

    expect(result.status).toBe("applied");
    const published = harness.components.get("bloom", 1)?.parameters[0];
    expect(published?.key).toBe("blur");
    expect(published?.definition.label).toBe("Blur");
    expect(published?.definition.type === "number" ? published.definition.max : null).toBe(16);
    expect(published?.targets).toHaveLength(2);

    // And it becomes a real parameter on the instance's manifest.
    const manifest = harness.nodes.get(componentNodeType("bloom", 1));
    expect(Object.keys(manifest?.parameters ?? {})).toEqual(["blur"]);
    session.dispose();
  });

  it("refuses a published type that no target can hold", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent());
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });
    const result = await session.bus.execute(
      "component.publishParameter",
      {
        key: "blur",
        definition: { type: "boolean", label: "Blur", default: true },
        targets: [{ nodeId: "blurA", key: "radius" }],
      },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toContain("component.parameter.typeMismatch");
    expect(harness.components.get("bloom", 1)?.parameters).toEqual([]);
    session.dispose();
  });
});

describe("instances reference, they never copy (§V79)", () => {
  it("stores only identity, version and its own values", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));

    const placed = await harness.bus.execute(
      "component.instantiate",
      { componentId: "bloom", position: { x: 10, y: 20 } },
      ctx,
    );
    expect(placed.status).toBe("applied");

    const graph = harness.store.view.getGraph();
    // One node in the document, not four: the three internal blurs live in the
    // definition and are not duplicated per instance.
    expect(Object.keys(graph.nodes)).toHaveLength(1);
    const instance = graph.nodes[placed.output.nodeId as string];
    expect(readComponentInstance(instance!)).toEqual({
      componentId: "bloom",
      version: 1,
      parameters: { blur: 4 },
    });
  });

  it("propagates a definition edit to every LINKED instance, and to no DETACHED copy", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));

    const linked = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    const detached = await harness.bus.execute(
      "component.instantiate",
      { componentId: "bloom", mode: "detached", position: { x: 400, y: 0 } },
      ctx,
    );
    expect(detached.output.nodeIds).toHaveLength(3);

    // Fix the component: one edit, inside the definition.
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });
    await session.bus.execute("component.setPublishedParameter", { key: "blur", value: 20 }, ctx);
    session.dispose();

    // The linked instance's internals ARE the definition, so it already has the fix.
    const instance = harness.store.view.getGraph().nodes[linked.output.nodeId as string];
    const state = readComponentInstance(instance!);
    const definition = harness.components.get(state!.componentId, state!.version);
    expect(radiiOf(definition!.graph)).toEqual([20, 20, 20]);

    // The detached copy opted out. It kept the values it was copied with.
    const graph = harness.store.view.getGraph();
    const copiedRadii = detached.output.nodeIds.map(
      (nodeId) => graph.nodes[nodeId]?.parameters.radius,
    );
    expect(copiedRadii).toEqual([4, 4, 4]);
  });

  it("detach replaces the instance with real nodes and rewires the outside edges", async () => {
    const harness = createComponentHarness(
      "t",
      graphOf(
        [node("src", "test.solid"), instanceNode("inst", "bloom", 1), node("dst", "test.mono")],
        {
          e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "inst", portId: "source" } },
        },
      ),
    );
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));

    const result = await harness.bus.execute("component.detach", { nodeId: "inst" }, ctx);
    expect(result.status).toBe("applied");

    const graph = harness.store.view.getGraph();
    expect(graph.nodes.inst).toBeUndefined();
    expect(result.output.nodeIds).toHaveLength(3);

    // The edge that fed the instance's exposed "source" now feeds the internal node the
    // port mapped to. Losing it would silently unwire the user's graph.
    const rewired = Object.values(graph.edges).find((edge) => edge.source.nodeId === "src");
    expect(rewired).toBeDefined();
    expect(result.output.nodeIds).toContain(rewired?.target.nodeId);
    expect(rewired?.target.portId).toBe("source");
  });

  it("a detached copy renames colliding labels and its references follow — the parent's and the definition's do not (B41)", async () => {
    // A component whose internals REFERENCE each other by name: `echo` records `over1`
    // by source reference (§V285). The parent already owns the name `over1`.
    const echoDefinition = {
      componentId: "echo",
      version: 1,
      name: "Echo",
      graph: graphOf([
        node("mix", "test.blur", { radius: 4 }, { label: "over1" }),
        node("echo", "feedback", { source: "over1" }),
      ]),
      inputs: [{ externalId: "source", label: "Source", nodeId: "mix", portId: "source" }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "mix", portId: "out" }],
      parameters: [],
    };
    const harness = createComponentHarness(
      "t",
      graphOf([node("mine", "test.blur", { radius: 4 }, { label: "over1" })]),
    );
    harness.components.register(echoDefinition);

    const placed = await harness.bus.execute(
      "component.instantiate",
      { componentId: "echo", mode: "detached", position: { x: 200, y: 0 } },
      ctx,
    );
    expect(placed.status).toBe("applied");
    expect(placed.output.nodeIds).toHaveLength(2);

    const graph = harness.store.view.getGraph();
    const copies = placed.output.nodeIds.map((nodeId) => graph.nodes[nodeId]);
    const mixCopy = copies.find((copy) => copy?.type === "test.blur");
    const echoCopy = copies.find((copy) => copy?.type === "feedback");

    // The collision resolved AWAY from the parent's name, and the copy's reference
    // moved WITH the rename — still pointing at its own `mix`, not at the parent's node.
    expect(graph.nodes.mine?.label).toBe("over1");
    expect(mixCopy?.label).toBe("over2");
    expect(echoCopy?.parameters.source).toBe("over2");

    // The copy spread the definition's nodes; the rewrite must not have reached back
    // into the installed component (shared parameter records, the B41 footgun).
    const definition = harness.components.get("echo", 1);
    expect(definition?.graph.nodes.mix?.label).toBe("over1");
    expect(definition?.graph.nodes.echo?.parameters.source).toBe("over1");
  });

  it("refuses to instantiate a component inside itself (§V83)", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });
    const result = await session.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("component.recursion");
    session.dispose();
  });
});

describe("component.saveSelection (T129)", () => {
  it("keeps internal wiring and exposes exactly the ports that crossed the boundary", async () => {
    const harness = createComponentHarness(
      "t",
      graphOf(
        [
          node("src", "test.solid", {}, { position: { x: 0, y: 0 } }),
          node("b1", "test.blur", { radius: 2 }, { position: { x: 100, y: 0 } }),
          node("b2", "test.blur", { radius: 8 }, { position: { x: 200, y: 0 } }),
          node("sink", "test.composite", {}, { position: { x: 300, y: 0 } }),
        ],
        {
          e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "b1", portId: "source" } },
          e2: { id: "e2", source: { nodeId: "b1", portId: "out" }, target: { nodeId: "b2", portId: "source" } },
          e3: { id: "e3", source: { nodeId: "b2", portId: "out" }, target: { nodeId: "sink", portId: "layers" } },
        },
      ),
    );

    const result = await harness.bus.execute(
      "component.saveSelection",
      { nodeIds: ["b1", "b2"], name: "Double Blur" },
      ctx,
    );

    expect(result.status).toBe("applied");
    const definition = harness.components.get(result.output.componentId as string, 1);
    expect(definition).toBeDefined();

    // The edge BETWEEN the selected nodes moved inside; it is the component's wiring now.
    expect(Object.keys(definition!.graph.nodes).sort()).toEqual(["b1", "b2"]);
    expect(Object.values(definition!.graph.edges)).toHaveLength(1);
    expect(definition!.graph.nodes.b2?.parameters.radius).toBe(8);

    // One crossing edge each way, so one exposed port each way — and no others.
    expect(definition!.inputs).toEqual([
      { externalId: "source", label: "Source", nodeId: "b1", portId: "source" },
    ]);
    expect(definition!.outputs).toEqual([
      { externalId: "out", label: "Out", nodeId: "b2", portId: "out" },
    ]);

    // And the parent graph is rewired through the instance rather than left dangling.
    const graph = harness.store.view.getGraph();
    expect(graph.nodes.b1).toBeUndefined();
    const instanceId = result.output.instanceNodeId as string;
    const edges = Object.values(graph.edges);
    expect(edges).toHaveLength(2);
    expect(
      edges.some((edge) => edge.source.nodeId === "src" && edge.target.nodeId === instanceId),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source.nodeId === instanceId && edge.target.nodeId === "sink"),
    ).toBe(true);
  });

  it("is one undo group: undoing restores the selection and removes the instance", async () => {
    const harness = createComponentHarness(
      "t",
      graphOf([node("b1", "test.blur", { radius: 2 }), node("b2", "test.blur", { radius: 8 })]),
    );
    await harness.bus.execute(
      "component.saveSelection",
      { nodeIds: ["b1", "b2"], name: "Double Blur" },
      ctx,
    );
    expect(harness.store.view.getHistory(alice).undo).toHaveLength(1);

    await harness.bus.execute("graph.undo", {}, ctx);
    const graph = harness.store.view.getGraph();
    expect(Object.keys(graph.nodes).sort()).toEqual(["b1", "b2"]);
  });

  it("rejects an empty selection", async () => {
    const harness = createComponentHarness();
    const result = await harness.bus.execute(
      "component.saveSelection",
      { nodeIds: [], name: "Nothing" },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.componentId).toBeNull();
  });
});

describe("version pinning and explicit upgrade (§V84)", () => {
  it("does NOT move an instance when a newer version is registered", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const placed = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    const nodeId = placed.output.nodeId as string;

    const revisionBefore = harness.store.view.getRevision();
    harness.components.register({
      ...bloomComponent("bloom", 2, [
        { ...blurKnob, definition: { type: "number", label: "Blur", default: 4, min: 0, max: 64 } },
        {
          key: "threshold",
          definition: { type: "number", label: "Threshold", default: 0.5, min: 0, max: 1 },
          targets: [{ nodeId: "blurA", key: "radius" }],
        },
      ]),
    });

    // A newer definition is not an edit to the document. Nothing moved, nothing changed.
    expect(harness.store.view.getRevision()).toBe(revisionBefore);
    const instance = harness.store.view.getGraph().nodes[nodeId];
    expect(instance?.type).toBe(componentNodeType("bloom", 1));
    expect(instance?.definitionVersion).toBe(1);
    expect(Object.keys(instance?.parameters ?? {})).toEqual(["blur"]);

    // The offer is visible, and only an offer.
    const upgrades = await harness.bus.query("component.upgrades", {}, ctx);
    expect(upgrades).toEqual([
      { nodeId, componentId: "bloom", pinnedVersion: 1, latestVersion: 2 },
    ]);
  });

  it("upgrades on request, keeping surviving values and reporting dropped ones", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const placed = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    const nodeId = placed.output.nodeId as string;
    await harness.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: harness.store.view.getRevision(),
        operations: [{ op: "setParameters", nodeId, parameters: { blur: 11 } }],
      },
      ctx,
    );

    harness.components.register({
      ...bloomComponent("bloom", 2, [
        {
          key: "threshold",
          definition: { type: "number", label: "Threshold", default: 0.5, min: 0, max: 1 },
          targets: [{ nodeId: "blurA", key: "radius" }],
        },
      ]),
      migrations: [{ fromVersion: 1, toVersion: 2, description: "Blur became Threshold." }],
    });

    const result = await harness.bus.execute("component.upgradeInstance", { nodeId }, ctx);
    expect(result.status).toBe("applied");

    const instance = harness.store.view.getGraph().nodes[nodeId];
    expect(instance?.type).toBe(componentNodeType("bloom", 2));
    expect(instance?.definitionVersion).toBe(2);
    expect(instance?.parameters).toEqual({ threshold: 0.5 });

    // The value that no longer has a home is reported, never dropped in silence.
    expect(result.output.plan?.dropped).toEqual(["blur"]);
    expect(result.output.plan?.added).toEqual(["threshold"]);
    expect(result.output.migrations).toEqual([
      { fromVersion: 1, toVersion: 2, description: "Blur became Threshold." },
    ]);
    expect(result.diagnostics.map((d) => d.code)).toContain("component.upgrade.droppedParameters");
  });

  it("refuses to 'upgrade' to the version it is already on", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const placed = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    const result = await harness.bus.execute(
      "component.upgradeInstance",
      { nodeId: placed.output.nodeId as string },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("component.upgrade.alreadyAtVersion");
  });
});

describe("component.setParentBinding (§V81 authoring)", () => {
  it("stores and clears a binding without touching the parameter value", async () => {
    const harness = createComponentHarness("t", graphOf([node("b1", "test.blur", { radius: 4 })]));

    await harness.bus.execute(
      "component.setParentBinding",
      { nodeId: "b1", key: "radius", reference: "parent.blur" },
      ctx,
    );
    expect(harness.store.view.getGraph().nodes.b1?.state).toEqual({
      parentBindings: { radius: "parent.blur" },
    });
    expect(harness.store.view.getGraph().nodes.b1?.parameters.radius).toBe(4);

    await harness.bus.execute(
      "component.setParentBinding",
      { nodeId: "b1", key: "radius", reference: null },
      ctx,
    );
    expect(harness.store.view.getGraph().nodes.b1?.state).toBeUndefined();
  });

  it("refuses a reference that is not a parent reference", async () => {
    const harness = createComponentHarness("t", graphOf([node("b1", "test.blur", { radius: 4 })]));
    const result = await harness.bus.execute(
      "component.setParentBinding",
      { nodeId: "b1", key: "radius", reference: "sibling.blur" },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("component.parentScope.malformed");
  });
});
