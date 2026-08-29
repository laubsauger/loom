import { describe, expect, it } from "vitest";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { componentNodeDefinition, pruneComponentDefinition, validateComponentDefinition } from "./definition.ts";
import { buildComponentFromSelection } from "./save-selection.ts";
import { componentSourcePath, effectiveInternalOverrides, internalParameterValues } from "./flatten.ts";
import {
  componentInstances,
  internalParameterPath,
  parseInternalParameterPath,
  readComponentInstance,
} from "./instance.ts";
import { migrationChain, planComponentUpgrade } from "./upgrade.ts";
import { blurKnob, bloomComponent, graphOf, instanceNode, node } from "./test-support.ts";

const nodes = createTestRegistry().view();

describe("synthesized manifest", () => {
  it("refuses to compile as a node — a component is FLATTENED, not compiled (§V82)", () => {
    const manifest = componentNodeDefinition(bloomComponent("bloom", 1, [blurKnob]), nodes);
    const compiled = manifest.compile({});
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("component.notFlattened");
  });

  it("drops an exposed port whose internal port cannot be typed rather than inventing a type", () => {
    const broken = {
      ...bloomComponent("bloom", 1),
      outputs: [{ externalId: "out", label: "Out", nodeId: "blurA", portId: "nope" }],
    };
    expect(componentNodeDefinition(broken, nodes).outputs).toEqual([]);
    expect(validateComponentDefinition(broken, nodes).map((d) => d.code)).toContain(
      "component.port.missingPort",
    );
  });
});

describe("validateComponentDefinition", () => {
  it("warns when a published range reaches outside the target's", () => {
    const definition = bloomComponent("bloom", 1, [
      {
        key: "blur",
        // test.blur's radius stops at 64; a knob that goes to 200 refuses at the edit.
        definition: { type: "number", label: "Blur", default: 4, min: 0, max: 200 },
        targets: [{ nodeId: "blurA", key: "radius" }],
      },
    ]);
    expect(validateComponentDefinition(definition, nodes).map((d) => d.code)).toContain(
      "component.parameter.rangeWiderThanTarget",
    );
  });

  it("only WARNS about a published parameter with no targets — it may be pure scope (§V81)", () => {
    const definition = bloomComponent("bloom", 1, [
      { key: "scope", definition: { type: "number", label: "Scope", default: 1 }, targets: [] },
    ]);
    const diagnostics = validateComponentDefinition(definition, nodes);
    expect(diagnostics.every((diagnostic) => diagnostic.severity !== "error")).toBe(true);
  });

  it("rejects a componentId carrying the version separator", () => {
    const definition = { ...bloomComponent("bloom@2", 1) };
    expect(validateComponentDefinition(definition, nodes).map((d) => d.code)).toContain("component.id");
  });
});

describe("pruneComponentDefinition", () => {
  it("drops exposures and targets that no longer exist, and unpublishes an empty knob", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    const remaining = { ...definition.graph.nodes };
    delete remaining.blurA;
    delete remaining.blurB;
    delete remaining.blurC;

    const pruned = pruneComponentDefinition(
      { ...definition, graph: { ...definition.graph, nodes: remaining } },
      nodes,
    );
    expect(pruned.inputs).toEqual([]);
    expect(pruned.outputs).toEqual([]);
    expect(pruned.parameters).toEqual([]);
  });

  it("keeps the surviving targets of a partly-broken knob", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    const remaining = { ...definition.graph.nodes };
    delete remaining.blurC;
    const pruned = pruneComponentDefinition(
      { ...definition, graph: { ...definition.graph, nodes: remaining } },
      nodes,
    );
    expect(pruned.parameters[0]?.targets.map((target) => target.nodeId)).toEqual(["blurA", "blurB"]);
  });
});

describe("buildComponentFromSelection", () => {
  it("exposes ONE output for a port feeding several outside targets", () => {
    const graph = graphOf(
      [
        node("b1", "test.blur"),
        node("out1", "test.composite"),
        node("out2", "test.composite"),
      ],
      {
        e1: { id: "e1", source: { nodeId: "b1", portId: "out" }, target: { nodeId: "out1", portId: "layers" } },
        e2: { id: "e2", source: { nodeId: "b1", portId: "out" }, target: { nodeId: "out2", portId: "layers" } },
      },
    );
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["b1"],
      componentId: "c",
      name: "One",
      nodes,
    });
    expect(built.definition.outputs).toHaveLength(1);
    // ...but both outside edges are rewired through it, or the user loses a connection.
    expect(built.outputWiring).toHaveLength(2);
  });

  it("gives two exposures distinct ids when one internal port is fed twice", () => {
    const graph = graphOf(
      [node("src1", "test.solid"), node("src2", "test.solid"), node("comp", "test.composite")],
      {
        e1: { id: "e1", source: { nodeId: "src1", portId: "out" }, target: { nodeId: "comp", portId: "layers" } },
        e2: { id: "e2", source: { nodeId: "src2", portId: "out" }, target: { nodeId: "comp", portId: "layers" } },
      },
    );
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["comp"],
      componentId: "c",
      name: "Two",
      nodes,
    });
    expect(built.definition.inputs.map((port) => port.externalId)).toEqual(["layers", "layers_2"]);
  });

  it("places the instance at the centre of what it replaces", () => {
    const graph = graphOf([
      node("a", "test.blur", {}, { position: { x: 0, y: 0 } }),
      node("b", "test.blur", {}, { position: { x: 100, y: 50 } }),
    ]);
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["a", "b"],
      componentId: "c",
      name: "Mid",
      nodes,
    });
    expect(built.position).toEqual({ x: 50, y: 25 });
  });
});

describe("what the flattening compiler reads (§V82)", () => {
  it("expands one published value into every internal target it drives", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    expect(internalParameterValues(definition, { blur: 5 })).toEqual({
      "blurA/radius": 5,
      "blurB/radius": 5,
      "blurC/radius": 5,
    });
  });

  it("lets a per-instance override win over the published fan-out", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    const instance = instanceNode("i", "bloom", 1, { blur: 5 });
    const withOverride = { ...instance, state: { componentOverrides: { "blurB/radius": 40 } } };
    expect(effectiveInternalOverrides(definition, withOverride, { blur: 5 })).toEqual({
      "blurA/radius": 5,
      "blurB/radius": 40,
      "blurC/radius": 5,
    });
  });

  it("builds the source path a user can act on", () => {
    expect(componentSourcePath(["n1", "n2"], { n1: "DreamyFeedback_2", n2: "Blur_1" }, "shader.wgsl:42")).toBe(
      "Main / DreamyFeedback_2 / Blur_1 / shader.wgsl:42",
    );
  });
});

describe("instance helpers", () => {
  it("round-trips an internal parameter path", () => {
    expect(parseInternalParameterPath(internalParameterPath("blurA", "radius"))).toEqual({
      nodeId: "blurA",
      key: "radius",
    });
    expect(parseInternalParameterPath("nope")).toBeNull();
  });

  it("reads identity and version from the node type, never from a second copy", () => {
    const instance = instanceNode("i", "bloom", 3, { blur: 5 });
    // definitionVersion disagreeing must not change the answer: the type is the key the
    // registry is looked up by, so it is the version that is actually in effect.
    const state = readComponentInstance({ ...instance, definitionVersion: 1 });
    expect(state).toEqual({ componentId: "bloom", version: 3, parameters: { blur: 5 } });
  });

  it("finds instances in sorted order and ignores ordinary nodes", () => {
    const graph = graphOf([
      node("z", "test.blur"),
      instanceNode("b", "bloom", 1),
      instanceNode("a", "bloom", 1),
    ]);
    expect(componentInstances(graph).map((each) => each.nodeId)).toEqual(["a", "b"]);
  });
});

describe("upgrade planning (§V84, §V10)", () => {
  it("reports a version step nobody wrote a migration for", () => {
    const target = { ...bloomComponent("bloom", 3), migrations: [{ fromVersion: 2, toVersion: 3, description: "x" }] };
    const chain = migrationChain(target, 1, 3);
    expect(chain.steps).toHaveLength(1);
    expect(chain.gaps).toEqual([{ from: 1, to: 2 }]);
  });

  it("resets a value the re-authored control can no longer hold, and says so", () => {
    const to = bloomComponent("bloom", 2, [
      {
        key: "blur",
        definition: { type: "number", label: "Blur", default: 4, min: 0, max: 8 },
        targets: [{ nodeId: "blurA", key: "radius" }],
      },
    ]);
    const plan = planComponentUpgrade({
      instance: instanceNode("i", "bloom", 1, { blur: 40 }),
      from: bloomComponent("bloom", 1, [blurKnob]),
      to,
    });
    expect(plan.parameters).toEqual({ blur: 4 });
    expect(plan.reset).toEqual(["blur"]);
    expect(plan.diagnostics.map((d) => d.code)).toContain("component.upgrade.valueReset");
  });

  it("reports ports that disappear, because their edges go with them", () => {
    const plan = planComponentUpgrade({
      instance: instanceNode("i", "bloom", 1, { blur: 4 }),
      from: bloomComponent("bloom", 1, [blurKnob]),
      to: { ...bloomComponent("bloom", 2, [blurKnob]), inputs: [] },
    });
    expect(plan.removedInputs).toEqual(["source"]);
    expect(plan.diagnostics.map((d) => d.code)).toContain("component.upgrade.removedPorts");
  });
});
