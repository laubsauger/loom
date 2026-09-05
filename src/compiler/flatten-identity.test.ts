import { describe, expect, it } from "vitest";

import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { ParameterSlot } from "../domain/types/parameters.ts";
import {
  PARENT_BINDINGS_STATE_KEY,
  componentNodeType,
  createComponentSystem,
  isComponentInstance,
} from "../domain/components/index.ts";
import { loadProject } from "../domain/project/index.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples } from "../examples/catalogue.ts";
import { flattenComponents } from "./flatten.ts";

/**
 * T1176 — the zero-instance early-out must be the FULL WALK'S ANSWER, not a shortcut
 * that happens to look right.
 *
 * `flattenComponents` runs on every document revision, and the walk it performs on a
 * document with no component in it is the identity: every node comes back as a copy of
 * itself. `flatteningIsIdentity` says so and skips the walk. The risk in that is the
 * §B179 shape — a cheap path that silently answers differently from the expensive one —
 * so this file does not assert that the fast path is self-consistent. It asserts that
 * THE TWO WALKS AGREE, on real documents, through the real slow path.
 *
 * ## How the slow path is forced
 *
 * There is no flag. Each shipped example's graph is re-hosted AS A COMPONENT — one
 * instance, in a two-node host document — which is a document the early-out cannot
 * claim, so the full recursive walk runs over exactly the same nodes and edges. Strip the
 * `c1/` namespacing off the result and the two flattenings must agree node for node,
 * parameter for parameter, edge for edge. The set is DERIVED from `examples/`: dropping a
 * `.loom.json` into that directory adds a case, and there is no list here to forget to
 * update (§V89's rule, applied to this gate).
 *
 * ## And the three cases the guard could swallow
 *
 * The predicate refuses three things, and each one is a legitimate document that the
 * early-out would answer wrongly if the clause were dropped: an actual instance, a
 * root-level `state.parentBindings`, and a root-level `parent.*` bind slot. The last two
 * are authorable by cutting a node out of a component and pasting it into the root graph,
 * and both produce a diagnostic the early-out has no way to produce. Each is exercised
 * below, and each fails if its clause is removed from `flatteningIsIdentity`.
 */

const registryBase = createNodeRegistry(allNodeDefinitions).view();

function systemFor(): ReturnType<typeof createComponentSystem> {
  return createComponentSystem(registryBase);
}

/** The example's own graph, hosted as the graph of a component instantiated once. */
function hostOf(graph: GraphDocument): { host: GraphDocument; definition: GraphComponentDefinition } {
  const definition: GraphComponentDefinition = {
    componentId: "t1176-host",
    version: 1,
    name: "T1176 Host",
    graph,
    inputs: [],
    outputs: [],
    parameters: [],
  };
  const instance: GraphNode = {
    id: "c1",
    type: componentNodeType("t1176-host", 1),
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    // A label no example can collide with, so B41's renamer has nothing to do and the
    // two walks are comparing the same names.
    label: "__t1176_host__",
    parameters: {},
  };
  return {
    host: { revision: 1, nodes: { c1: instance }, edges: {}, groups: {} },
    definition,
  };
}

const examples = listExamples();

describe("T1176: the zero-instance early-out answers exactly what the full walk answers", () => {
  const cases = examples
    .map((file) => {
      const system = systemFor();
      const loaded = loadProject(file.text, { nodes: system.nodes });
      if (!loaded.ok) return null;
      for (const definition of loaded.components) system.components.register(definition);
      const graph = loaded.document.graph;
      const hasInstance = Object.values(graph.nodes).some((node) => isComponentInstance(node));
      return hasInstance ? null : { fileName: file.fileName, system, graph };
    })
    .filter((entry): entry is { fileName: string; system: ReturnType<typeof createComponentSystem>; graph: GraphDocument } => entry !== null);

  it("has documents to compare — the derivation is not silently empty", () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  for (const { fileName, system, graph } of cases) {
    it(`${fileName} flattens identically hosted and unhosted`, () => {
      const fast = flattenComponents({ graph, registry: system.nodes, components: system.components.view() });

      const { host, definition } = hostOf(graph);
      system.components.register(definition);
      const slow = flattenComponents({
        graph: host,
        registry: system.nodes,
        components: system.components.view(),
      });

      // The slow walk really ran: it inlined something.
      expect(slow.changed).toBe(true);
      // The fast walk really ran: it hands back the document's own node objects.
      const anyId = Object.keys(graph.nodes)[0];
      if (anyId !== undefined) expect(fast.graph.nodes[anyId]).toBe(graph.nodes[anyId]);

      expect(Object.keys(fast.graph.nodes).sort()).toEqual(
        Object.keys(slow.graph.nodes)
          .filter((id) => id.startsWith("c1/"))
          .map((id) => id.slice("c1/".length))
          .sort(),
      );

      for (const [nodeId, node] of Object.entries(fast.graph.nodes)) {
        const hosted = slow.graph.nodes[`c1/${nodeId}`];
        expect(hosted, `${fileName}: ${nodeId} is missing from the hosted walk`).toBeDefined();
        expect({ ...hosted, id: nodeId }).toEqual({ ...node });
      }

      for (const [edgeId, edge] of Object.entries(fast.graph.edges)) {
        const hosted = slow.graph.edges[`c1/${edgeId}`];
        expect(hosted, `${fileName}: edge ${edgeId} is missing from the hosted walk`).toBeDefined();
        expect({
          ...hosted,
          id: edgeId,
          source: { ...hosted?.source, nodeId: hosted?.source.nodeId.slice("c1/".length) },
          target: { ...hosted?.target, nodeId: hosted?.target.nodeId.slice("c1/".length) },
        }).toEqual({ ...edge });
      }

      // Same node set in `sources`, and each entry names the same authored node.
      expect([...fast.sources.keys()]).toEqual(Object.keys(fast.graph.nodes));
      for (const [nodeId, source] of fast.sources) {
        expect(source.internalNodeId).toBe(slow.sources.get(`c1/${nodeId}`)?.internalNodeId);
        expect(source.path).toEqual([]);
      }

      // Neither walk had anything to say, and the fast one has no way to say it.
      expect(slow.diagnostics).toEqual([]);
      expect(fast.diagnostics).toEqual([]);
      expect(fast.sinks).toEqual([]);
      expect(fast.changed).toBe(false);
    });
  }
});

describe("T1176: the cases the early-out must refuse", () => {
  const solid = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
    id,
    type: "solid",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...extra,
  });

  it("still inlines a real component instance", () => {
    const system = systemFor();
    system.components.register({
      componentId: "inner",
      version: 1,
      name: "Inner",
      graph: { revision: 1, nodes: { s: solid("s") }, edges: {}, groups: {} },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "s", portId: "out" }],
      parameters: [],
    });
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        c1: {
          id: "c1",
          type: componentNodeType("inner", 1),
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {},
        },
      },
      edges: {},
      groups: {},
    };
    const flattened = flattenComponents({
      graph,
      registry: system.nodes,
      components: system.components.view(),
    });
    expect(flattened.changed).toBe(true);
    expect(Object.keys(flattened.graph.nodes)).toEqual(["c1/s"]);
  });

  it("still reports a root-level `state.parentBindings`, which has no parent to read", () => {
    const system = systemFor();
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        s: solid("s", { state: { [PARENT_BINDINGS_STATE_KEY]: { color: "parent.tint" } } }),
      },
      edges: {},
      groups: {},
    };
    const flattened = flattenComponents({
      graph,
      registry: system.nodes,
      components: system.components.view(),
    });
    // The whole point: a value bound to a scope that does not exist must SAY so. Drop
    // the `parentBindings` clause from `flatteningIsIdentity` and this array is empty.
    expect(flattened.diagnostics.length).toBeGreaterThan(0);
    expect(flattened.diagnostics.map((diagnostic) => diagnostic.code).join(" ")).toMatch(
      /component\.parentScope\./,
    );
  });

  it("still warns for a root-level `parent.*` bind slot and falls back to its static (§V108)", () => {
    const system = systemFor();
    const slot: ParameterSlot = {
      mode: "bind",
      bindings: { bind: { kind: "bind", ref: "parent.tint" }, static: { kind: "static", value: [0.25, 0.5, 0.75, 1] } },
    };
    const graph: GraphDocument = {
      revision: 1,
      nodes: { s: solid("s", { parameters: { color: slot } }) },
      edges: {},
      groups: {},
    };
    const flattened = flattenComponents({
      graph,
      registry: system.nodes,
      components: system.components.view(),
    });
    expect(flattened.diagnostics.length).toBeGreaterThan(0);
    // And the fallback actually happened: the slot is gone, the retained static is there.
    expect(flattened.graph.nodes["s"]?.parameters?.["color"]).toEqual([0.25, 0.5, 0.75, 1]);
  });
});
