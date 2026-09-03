import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { BackendCapabilities } from "../types/backend.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { componentNodeType } from "./component-type.ts";
import { createComponentSystem } from "./index.ts";
import { buildComponentFromSelection } from "./save-selection.ts";
import { deriveBoundaryPorts, withBoundaryPorts } from "./boundary-ports.ts";

/**
 * T607 — boundary In/Out nodes ARE the component's sockets.
 *
 * The owner's ask: "subgraph input nodes that then produce sockets on the top level…
 * analog to TD / ComfyUI". The mechanism is deliberately NOTHING NEW: an In is a
 * `passthrough` wire (exactly the Null node), the register-time derivation turns it
 * into an `ExposedPort` aimed at `In.in`, flatten retargets the outer edge onto it,
 * and the compiler's existing splice erases the wire — so these tests drive the REAL
 * compiler and assert the property that justified the route: ONE socket fans out to
 * every inner consumer, where the selection-save path used to mint one socket per
 * inner consumer, all wired back to the same producer.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function node(
  id: string,
  type: string,
  position = { x: 0, y: 0 },
  extra: Partial<GraphNode> = {},
): GraphNode {
  return { id: id as NodeId, type, definitionVersion: 1, position, parameters: {}, ...extra } as GraphNode;
}

function graphOf(nodes: GraphNode[], edges: Array<[string, string, string, string]>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(
      edges.map(([source, sourcePort, target, targetPort], index) => [
        `e${String(index)}`,
        {
          id: `e${String(index)}`,
          source: { nodeId: source, portId: sourcePort },
          target: { nodeId: target, portId: targetPort },
        },
      ]),
    ),
    groups: {},
  } as never;
}

/** In("feed") fans out to three blurs; blurA feeds Out("result"). */
function fanComponent(): GraphComponentDefinition {
  return {
    componentId: "fan",
    version: 1,
    name: "Fan",
    graph: graphOf(
      [
        node("entry", "componentIn", { x: 0, y: 0 }, { label: "feed" }),
        node("blurA", "blur", { x: 240, y: 0 }),
        node("blurB", "blur", { x: 240, y: 120 }),
        node("blurC", "blur", { x: 240, y: 240 }),
        node("exit", "componentOut", { x: 480, y: 0 }, { label: "result" }),
      ],
      [
        ["entry", "out", "blurA", "input"],
        ["entry", "out", "blurB", "input"],
        ["entry", "out", "blurC", "input"],
        ["blurA", "out", "exit", "in"],
      ],
    ),
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

describe("boundary-port derivation (T607)", () => {
  it("derives sockets from In/Out nodes, named by label, ordered by canvas y", () => {
    const ports = deriveBoundaryPorts(
      graphOf(
        [
          node("b", "componentIn", { x: 0, y: 200 }, { label: "second" }),
          node("a", "componentIn", { x: 0, y: 10 }, { label: "first" }),
          node("z", "componentOut", { x: 400, y: 0 }, { label: "result" }),
          node("plain", "blur", { x: 200, y: 0 }),
        ],
        [],
      ),
    );
    // Canvas order, not id order — TD's own answer to socket ordering.
    expect(ports.inputs.map((port) => port.externalId)).toEqual(["first", "second"]);
    // The exposure aims at the passthrough INPUT: the outer edge lands on `In.in`.
    expect(ports.inputs[0]).toEqual({ externalId: "first", label: "first", nodeId: "a", portId: "in" });
    expect(ports.outputs).toEqual([
      { externalId: "result", label: "result", nodeId: "z", portId: "out" },
    ]);
  });

  it("withBoundaryPorts keeps legacy rows after derived ones and is identity when moot", () => {
    const definition = fanComponent();
    const legacy = {
      ...definition,
      inputs: [{ externalId: "old", label: "Old", nodeId: "blurB" as NodeId, portId: "source" }],
    };
    const folded = withBoundaryPorts(legacy);
    expect(folded.inputs.map((port) => port.externalId)).toEqual(["feed", "old"]);
    expect(folded.outputs.map((port) => port.externalId)).toEqual(["result"]);

    const plain: GraphComponentDefinition = {
      ...definition,
      graph: graphOf([node("blurA", "blur")], []),
      inputs: [],
      outputs: [],
    };
    expect(withBoundaryPorts(plain)).toBe(plain);
  });

  it("the registry folds sockets in at registration — one effective interface everywhere", () => {
    const system = createComponentSystem(registry, [fanComponent()]);
    const stored = system.components.get("fan", 1);
    expect(stored?.inputs.map((port) => port.externalId)).toEqual(["feed"]);
    expect(stored?.outputs.map((port) => port.externalId)).toEqual(["result"]);
    // And the synthesized manifest carries them as real, typed ports.
    const manifest = system.nodes.get(componentNodeType("fan", 1));
    expect(manifest?.inputs.map((port) => port.id)).toEqual(["feed"]);
    expect(manifest?.outputs.map((port) => port.id)).toEqual(["result"]);
    expect(manifest?.inputs[0]?.type.kind).toBe("texture2d");
  });
});

describe("one socket fans out to every inner consumer — through the real compiler (T607, T423)", () => {
  it("splices the In away and feeds all three blurs from the parent's producer", () => {
    const system = createComponentSystem(registry, [fanComponent()]);
    const parent = graphOf(
      [
        node("gen", "noise", { x: 0, y: 0 }),
        node("c1", componentNodeType("fan", 1), { x: 240, y: 0 }),
        node("sink", "output", { x: 480, y: 0 }),
      ],
      [
        ["gen", "out", "c1", "feed"],
        ["c1", "result", "sink", "input"],
      ],
    );
    const compiled = compileGraph({
      graph: parent,
      settings: SETTINGS,
      registry: system.nodes,
      capabilities: CAPABILITIES,
      components: system.components.view(),
      sinks: [
        // Watch blurB and blurC too, so the pruner keeps the whole fan and the claim
        // "every consumer is fed" is about all three, not the one on the output path.
        { nodeId: "c1/blurB" as NodeId, portId: "out", kind: "preview" },
        { nodeId: "c1/blurC" as NodeId, portId: "out", kind: "preview" },
      ],
    });
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    // The boundary wires are GONE — spliced, zero passes, zero resources.
    expect(compiled.order).not.toContain("c1/entry");
    expect(compiled.order).not.toContain("c1/exit");

    // Every blur runs, and every one binds the PARENT producer's texture: the fan-in
    // property. Before boundary nodes this shape produced three sockets each wired to
    // the same producer — and an authored component simply could not express it.
    for (const blurId of ["c1/blurA", "c1/blurB", "c1/blurC"]) {
      expect(compiled.order).toContain(blurId);
      const pass = compiled.passes.find(
        (entry) => entry.kind === "effect" && entry.nodeId === blurId,
      ) as { textures?: ReadonlyArray<{ resourceId: string }> } | undefined;
      expect(pass, blurId).toBeDefined();
      expect(
        pass?.textures?.some((binding) => binding.resourceId.includes("gen")),
        `${blurId} reads the parent producer`,
      ).toBe(true);
    }

    // The output socket resolves through the Out wire to blurA's real target.
    const sinkPass = compiled.passes.find(
      (entry) => entry.kind === "effect" && entry.nodeId === "sink",
    ) as { textures?: ReadonlyArray<{ resourceId: string }> } | undefined;
    expect(
      sinkPass?.textures?.some((binding) => binding.resourceId.includes("blurA")),
    ).toBe(true);
  });

  it("an unwired socket is a warning-free disconnect, never a required-input error", () => {
    const system = createComponentSystem(registry, [fanComponent()]);
    const parent = graphOf(
      [node("c1", componentNodeType("fan", 1), { x: 0, y: 0 }), node("sink", "output", { x: 240, y: 0 })],
      [["c1", "result", "sink", "input"]],
    );
    const compiled = compileGraph({
      graph: parent,
      settings: SETTINGS,
      registry: system.nodes,
      capabilities: CAPABILITIES,
      components: system.components.view(),
    });
    // The dangling In side is `optional`, exactly as the Null's input is: no
    // input-missing error for the boundary itself. (Downstream nodes losing their feed
    // report their own missing input, which is the honest chain.)
    expect(
      compiled.diagnostics.filter(
        (entry) => entry.severity === "error" && String(entry.nodeId ?? "").includes("entry"),
      ),
    ).toEqual([]);
  });

  it("a WATCHED unwired boundary node warns nothing about itself (T607 splice fix)", () => {
    // Pre-existing with the Null and loud with boundary nodes: a preview sink on a
    // wire that reaches no producer used to survive the splice while its node did
    // not, so resolveSinks warned sink-unknown about a node visibly on the canvas.
    // The splice now drops the sink — nothing to watch is nothing, not a mystery.
    const system = createComponentSystem(registry, [fanComponent()]);
    for (const type of ["componentIn", "componentOut", "null"]) {
      const graph = graphOf([node("w1", type, { x: 0, y: 0 })], []);
      const compiled = compileGraph({
        graph,
        settings: SETTINGS,
        registry: system.nodes,
        capabilities: CAPABILITIES,
        sinks: [{ nodeId: "w1" as NodeId, portId: "out", kind: "preview" }],
      });
      expect(
        compiled.diagnostics.filter((entry) => entry.code === "compiler/sink-unknown"),
        type,
      ).toEqual([]);
    }
  });
});

describe("selection-save synthesizes boundary nodes (T607) — the fan-in fix at the source", () => {
  it("one outer source feeding three inner nodes becomes ONE socket through one In", () => {
    const graph = graphOf(
      [
        node("gen", "noise", { x: 0, y: 0 }),
        node("blurA", "blur", { x: 240, y: 0 }),
        node("blurB", "blur", { x: 240, y: 120 }),
        node("blurC", "blur", { x: 240, y: 240 }),
        node("sink", "output", { x: 480, y: 0 }),
      ],
      [
        ["gen", "out", "blurA", "input"],
        ["gen", "out", "blurB", "input"],
        ["gen", "out", "blurC", "input"],
        ["blurA", "out", "sink", "input"],
      ],
    );
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["blurA", "blurB", "blurC"] as NodeId[],
      componentId: "sel",
      name: "Selection",
      nodes: registry,
    });
    expect(built.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    // ONE wiring row for the one outer source — this used to be three.
    expect(built.inputWiring).toHaveLength(1);
    const socket = built.inputWiring[0]?.externalId as string;

    // One In node inside, feeding all three blurs.
    const boundary = Object.values(built.definition.graph.nodes).filter(
      (entry) => entry.type === "componentIn",
    );
    expect(boundary).toHaveLength(1);
    const inId = boundary[0]?.id as string;
    const feeds = Object.values(built.definition.graph.edges).filter(
      (edge) => edge.source.nodeId === inId,
    );
    expect(feeds.map((edge) => edge.target.nodeId).sort()).toEqual(["blurA", "blurB", "blurC"]);

    // The derivation names the socket after the In — the wiring row must agree.
    const effective = withBoundaryPorts(built.definition);
    expect(effective.inputs.map((port) => port.externalId)).toEqual([socket]);
    // Output side symmetric: one Out node, one socket.
    expect(
      Object.values(built.definition.graph.nodes).filter((entry) => entry.type === "componentOut"),
    ).toHaveLength(1);
    expect(effective.outputs).toHaveLength(1);
    expect(built.outputWiring[0]?.externalId).toBe(effective.outputs[0]?.externalId);
  });
});

/**
 * T1046/§B170 — the label is a NAME, the externalId is an ADDRESS.
 *
 * The owner's ask: name the In/Out nodes with speaking names and have the instance's
 * sockets say those names "automatically". The label half always worked; what these
 * gates pin is the half that made renaming UNSAFE: the externalId used to be re-derived
 * from the label on every registration, and a component edit session re-registers the
 * SAME version in place — so renaming `in1` re-addressed the socket and every parent
 * edge wired to it dangled. Now the definition's stored rows are the address book:
 * matched by nodeId (the identity a rename cannot touch), the externalId survives and
 * only the label follows the name.
 */
describe("T1046/§B170 — renaming a boundary node moves its NAME, never its ADDRESS", () => {
  it("re-registering after a rename keeps the externalId and refreshes the label everywhere", () => {
    const system = createComponentSystem(registry, [fanComponent()]);
    const stored = system.components.get("fan", 1)!;
    const entry = stored.graph.nodes["entry" as NodeId]!;
    // What the edit session's writeback does on every commit: same id, same VERSION.
    system.components.register({
      ...stored,
      graph: {
        ...stored.graph,
        nodes: { ...stored.graph.nodes, entry: { ...entry, label: "Source Picture" } },
      },
    });
    const after = system.components.get("fan", 1)!;
    expect(after.inputs).toEqual([
      { externalId: "feed", label: "Source Picture", nodeId: "entry", portId: "in" },
    ]);
    // The owner's "automatically ... on the outside": the instance's port SAYS the name.
    const manifest = system.nodes.get(componentNodeType("fan", 1))!;
    expect(manifest.inputs.map((port) => ({ id: port.id, label: port.label }))).toEqual([
      { id: "feed", label: "Source Picture" },
    ]);
  });

  it("a parent edge wired before the rename still feeds the fan after it — the real compiler", () => {
    const system = createComponentSystem(registry, [fanComponent()]);
    const stored = system.components.get("fan", 1)!;
    const entry = stored.graph.nodes["entry" as NodeId]!;
    system.components.register({
      ...stored,
      graph: {
        ...stored.graph,
        nodes: { ...stored.graph.nodes, entry: { ...entry, label: "Source Picture" } },
      },
    });
    // The parent was wired BEFORE the rename — its edge targets "feed". Cut this edge
    // (what the old derivation did by re-addressing) and blurA loses the producer.
    const parent = graphOf(
      [
        node("gen", "noise", { x: 0, y: 0 }),
        node("c1", componentNodeType("fan", 1), { x: 240, y: 0 }),
        node("sink", "output", { x: 480, y: 0 }),
      ],
      [
        ["gen", "out", "c1", "feed"],
        ["c1", "result", "sink", "input"],
      ],
    );
    const compiled = compileGraph({
      graph: parent,
      settings: SETTINGS,
      registry: system.nodes,
      capabilities: CAPABILITIES,
      components: system.components.view(),
    });
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const pass = compiled.passes.find(
      (each) => each.kind === "effect" && each.nodeId === "c1/blurA",
    ) as { textures?: ReadonlyArray<{ resourceId: string }> } | undefined;
    expect(
      pass?.textures?.some((binding) => binding.resourceId.includes("gen")),
      "the renamed socket still carries the parent's picture",
    ).toBe(true);
  });

  it("a NEW In named like an existing socket suffixes itself instead of stealing the address", () => {
    const system = createComponentSystem(registry, [fanComponent()]);
    const stored = system.components.get("fan", 1)!;
    system.components.register({
      ...stored,
      graph: {
        ...stored.graph,
        nodes: {
          ...stored.graph.nodes,
          // Below the existing In in canvas order, deliberately NAMED "feed": were the
          // newcomer allowed the id, the parent's existing edge would silently feed it.
          late: { id: "late" as NodeId, type: "componentIn", definitionVersion: 1, position: { x: 0, y: 400 }, parameters: {}, label: "feed" },
        },
      },
    } as never);
    const after = system.components.get("fan", 1)!;
    expect(after.inputs.map((port) => ({ id: port.externalId, node: port.nodeId }))).toEqual([
      { id: "feed", node: "entry" },
      { id: "feed_2", node: "late" },
    ]);
  });
});
