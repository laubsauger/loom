import { expect, it } from "vitest";
import { createAppRuntime } from "./app-runtime.ts";
import { flattenComponents } from "@compiler/flatten.ts";
import { compileGraph } from "@compiler/compile.ts";
import { INTERNAL_RESOLUTIONS_KEY } from "@domain/components/internal-resolutions.ts";
import type { NodeResolutionOverride } from "@domain/types/graph.ts";
import { buildProjectFile } from "@domain/project/project-file.ts";
import { parseProjectDocument } from "@domain/project/serialize.ts";
import { displacementStackDocument } from "../examples/documents/displacement-stack.ts";

async function fixture(nested = false, type = "syphonIn") {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const { bus, invocation } = runtime;
  const added = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "fixture", operations: [
    { op: "addNode", ref: "$input", type, position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 200, y: 0 } },
    { op: "connect", source: { nodeId: "$input", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
  ] }, invocation);
  expect(added.status).toBe("applied");
  const inputId = added.output.createdIds["$input"]!;
  let saved = await bus.execute("component.saveSelection", { nodeIds: [inputId], name: "Input receiver" }, invocation);
  expect(saved.status).toBe("applied");
  if (nested) {
    saved = await bus.execute("component.saveSelection", { nodeIds: [saved.output.instanceNodeId!], name: "Nested receiver" }, invocation);
    expect(saved.status).toBe("applied");
  }
  const second = await bus.execute("component.instantiate", { componentId: saved.output.componentId! }, invocation);
  expect(second.status).toBe("applied");
  bus.attachFlattenedGraph(() => runtime.flattened.current().graph);
  const inputs = Object.values(runtime.flattened.current().graph.nodes).filter(node => node.type === type);
  expect(inputs).toHaveLength(2);
  return { runtime, inputs, first: saved.output.instanceNodeId!, second: second.output.nodeId! };
}

it.each([false, true].flatMap(nested => ["syphonIn", "ndiIn", "spoutIn"].map(type => ({ nested, type }))))("keeps two linked $type receivers independently sized (nested=$nested), without touching definitions", async ({ nested, type }) => {
  const { runtime, inputs, first } = await fixture(nested, type);
  const definitionsBefore = JSON.stringify(runtime.components.view().list());
  for (const [index, size] of [[1280, 720], [1920, 1080]].entries()) {
    const result = await runtime.bus.execute("node.setResolution", {
      nodeId: inputs[index]!.id, resolution: { mode: "fixed", width: size[0]!, height: size[1]! },
    }, runtime.invocation);
    expect(result.status).toBe("applied");
  }
  const flat = runtime.flattened.current();
  expect(flat.graph.nodes[inputs[0]!.id]?.resolution).toEqual({ mode: "fixed", width: 1280, height: 720 });
  expect(flat.graph.nodes[inputs[1]!.id]?.resolution).toEqual({ mode: "fixed", width: 1920, height: 1080 });
  expect(JSON.stringify(runtime.components.view().list())).toBe(definitionsBefore);
  const saved = buildProjectFile({ document: { ...displacementStackDocument, graph: runtime.bus.store.getGraph() },
    components: runtime.components.view().list(), now: () => displacementStackDocument.updatedAt });
  const opened = parseProjectDocument(saved.text);
  if (!opened.ok) throw new Error(opened.reason);
  const loaded = opened.document.graph;
  const replay = flattenComponents({ graph: loaded, registry: runtime.registry, components: runtime.components.view() });
  expect(replay.graph.nodes[inputs[1]!.id]?.resolution).toEqual(flat.graph.nodes[inputs[1]!.id]?.resolution);
  expect(loaded.nodes[first]?.state?.[INTERNAL_RESOLUTIONS_KEY]).toBeTruthy();
  const compiled = compileGraph({ graph: loaded, registry: runtime.registry, components: runtime.components.view(), settings: runtime.settings,
    sinks: inputs.map(node => ({ nodeId: node.id, portId: "out", kind: "preview" as const })),
    capabilities: { tier: "B", features: [], formats: ["rgba8unorm-srgb", "rgba8unorm", "rgba16float"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } },
  });
  expect(compiled.ok).toBe(true);
  expect(compiled.outputs.find(output => output.nodeId === inputs[0]!.id)?.size).toEqual([1280, 720]);
  expect(compiled.outputs.find(output => output.nodeId === inputs[1]!.id)?.size).toEqual([1920, 1080]);
});

it("validates, supports dry-run, undo, and clearing an internal override", async () => {
  const { runtime, inputs } = await fixture(true);
  const nodeId = inputs[0]!.id;
  const resolution: NodeResolutionOverride = { mode: "fixed", width: 1920, height: 1080 };
  const before = JSON.stringify(runtime.bus.store.getGraph());
  const dry = await runtime.bus.execute("node.setResolution", { nodeId, resolution }, { ...runtime.invocation, dryRun: true });
  expect(dry.status).toBe("validated"); expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(before);
  expect(dry.output.status).toBe("validated"); expect(dry.output.appliedOperations).toBe(0);
  const invalid = await runtime.bus.execute("node.setResolution", { nodeId, resolution: { ...resolution, width: -1 } }, runtime.invocation);
  expect(invalid.status).toBe("rejected"); expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(before);
  await runtime.bus.execute("node.setResolution", { nodeId, resolution }, runtime.invocation);
  await runtime.bus.execute("graph.undo", {}, runtime.invocation);
  expect(runtime.flattened.current().graph.nodes[nodeId]?.resolution).toBeUndefined();
  await runtime.bus.execute("node.setResolution", { nodeId, resolution }, runtime.invocation);
  await runtime.bus.execute("node.setResolution", { nodeId, resolution: null }, runtime.invocation);
  expect(runtime.flattened.current().graph.nodes[nodeId]?.resolution).toBeUndefined();
});

it("rejects malformed persisted internal dimensions at the project boundary", async () => {
  const { runtime, first } = await fixture();
  const graph = structuredClone(runtime.bus.store.getGraph());
  graph.nodes[first]!.state = { [INTERNAL_RESOLUTIONS_KEY]: { child: { mode: "fixed", width: -1, height: 720 } } };
  const file = buildProjectFile({ document: { ...displacementStackDocument, graph }, now: () => displacementStackDocument.updatedAt });
  expect(parseProjectDocument(file.text).ok).toBe(false);
});
