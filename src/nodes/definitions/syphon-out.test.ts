import { expect, it } from "vitest";
import { compileGraph } from "@compiler/compile.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import { nativeOutputFixture } from "../../desktop/testing/output-fixture.ts";
import { loadProject } from "@domain/project/load.ts";
it("self-input fixture keeps the receiver outside the publishing branch", async () => {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const fixture = await nativeOutputFixture("", false, "Self test");
  const loaded = loadProject(fixture.text, { nodes: runtime.registry, components: runtime.components });
  if (!loaded.ok) throw new Error(loaded.reason);
  const graph = loaded.document.graph;
  const input = Object.values(graph.nodes).find(node => node.type === "syphonIn")!;
  const output = Object.values(graph.nodes).find(node => node.type === "syphonOut")!;
  expect(input.parameters["source"]).toBe("");
  const edge = Object.values(graph.edges).find(edge => edge.target.nodeId === output.id)!;
  expect(graph.nodes[edge.source.nodeId]?.type).toBe("checker");
  expect(Object.values(graph.edges).some(edge => edge.source.nodeId === input.id)).toBe(false);
  expect(fixture.native).toBe(`${input.id}:out`);
});
it.each([1, 2, 4])("loads a %i-publisher fixture through the actual project validator", async count => {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const names = Array.from({ length: count }, (_, index) => `Loom graph smoke ${index}`);
  const fixture = await nativeOutputFixture(undefined, false, names);
  const loaded = loadProject(fixture.text, { nodes: runtime.registry, components: runtime.components });
  expect(loaded).toMatchObject({ ok: true });
  if (!loaded.ok) throw new Error(loaded.reason);
  expect(Object.values(loaded.document.graph.nodes).filter(node => node.type === "syphonOut")
    .map(node => node.parameters["name"]).sort()).toEqual(names);
});
it("keeps the full-HD source without allocating a sink target or extra pass", async () => {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "Native sink", operations: [
    { op: "addNode", ref: "$source", type: "checker", position: { x: 0, y: 0 } },
    { op: "setNodeResolution", nodeId: "$source", resolution: { mode: "fixed", width: 1920, height: 1080 } },
    { op: "addNode", ref: "$sink", type: "syphonOut", position: { x: 300, y: 0 } },
    { op: "connect", source: { nodeId: "$source", portId: "out" }, target: { nodeId: "$sink", portId: "input" } },
  ] }, runtime.invocation);
  expect(result.status).toBe("applied");
  const source = result.output.createdIds["$source"]!; const sink = result.output.createdIds["$sink"]!;
  const compiled = compileGraph({ graph: runtime.bus.store.getGraph(), registry: runtime.registry, settings: runtime.settings,
    capabilities: { tier: "B", features: [], formats: ["rgba8unorm-srgb", "rgba8unorm", "rgba16float"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } } });
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.ok).toBe(true);
  expect(compiled.order).toContain(sink);
  expect(compiled.outputs.find(output => output.nodeId === source)?.size).toEqual([1920, 1080]);
  expect(compiled.passes).toHaveLength(1);
  expect(compiled.outputs.some(output => output.nodeId === sink)).toBe(false);
});
