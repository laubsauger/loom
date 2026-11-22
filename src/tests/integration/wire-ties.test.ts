import { describe, expect, it } from "vitest";
import { graphEdits } from "../../app/classify-revision.ts";
import { compileGraph } from "../../compiler/index.ts";
import { spikeNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { loadProject } from "../../domain/project/load.ts";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import { testDocument, testSettings } from "../../domain/project/test-support.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * Wire ties through the real stack (T1821b, §V1040): the save path, the compiler and the
 * revision classifier. The owner's terms were "saved in the document, no effect on
 * render", and these are the two halves of that sentence, each read back through the code
 * that would break it — the open path a person reopens a file with, and the compile a
 * frame is rendered from.
 */

const registry = createNodeRegistry(spikeNodeDefinitions).view();

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** Solid → Custom WGSL → Output, and a second Custom WGSL off the solid: three wires. */
function untied(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 300, y: 0 }, parameters: {} },
      fx2: { id: "fx2", type: "customWgsl", definitionVersion: 1, position: { x: 300, y: 300 }, parameters: {} },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 600, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fx2", portId: "input" } },
    },
    groups: {},
  };
}

/** The same graph with two wires bound through one tie and one routed through two. */
function tied(graph: GraphDocument = untied()): GraphDocument {
  return {
    ...graph,
    edges: {
      e1: { ...(graph.edges["e1"] as GraphDocument["edges"][string]), via: ["ti_bundle"] },
      e2: { ...(graph.edges["e2"] as GraphDocument["edges"][string]), via: ["ti_up", "ti_down"] },
      e3: { ...(graph.edges["e3"] as GraphDocument["edges"][string]), via: ["ti_bundle"] },
    },
    ties: {
      ti_bundle: { id: "ti_bundle", position: { x: 220, y: 120 } },
      ti_up: { id: "ti_up", position: { x: 480, y: -80 } },
      ti_down: { id: "ti_down", position: { x: 540, y: 60 } },
    },
  };
}

describe("wire ties are saved in the document (T1821b)", () => {
  it("round-trips through save and reopen, every route in order", () => {
    const document = testDocument({ graph: tied() });
    const file = serializeProjectDocument(document);
    const reopened = loadProject(file, { nodes: registry });
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.document.graph.ties).toEqual(tied().ties);
    expect(reopened.document.graph.edges["e2"]?.via).toEqual(["ti_up", "ti_down"]);
    expect(reopened.document.graph.edges["e1"]?.via).toEqual(["ti_bundle"]);
    // And the reopened document saves back to the same bytes (§V68's other half).
    expect(serializeProjectDocument(reopened.document)).toBe(file);
  });

  it("writes nothing about ties into a document that has none", () => {
    const file = serializeProjectDocument(testDocument({ graph: untied() }));
    expect(file).not.toContain('"ties"');
    expect(file).not.toContain('"via"');
  });
});

describe("wire ties have no effect on render (T1821b)", () => {
  it("compiles to exactly the plan the untied graph compiles to", () => {
    const compile = (graph: GraphDocument) =>
      compileGraph({ graph, settings: testSettings(), registry, capabilities });
    const plain = compile(untied());
    const routed = compile(tied());
    expect(plain.ok).toBe(true);
    expect(JSON.stringify(routed)).toBe(JSON.stringify(plain));
  });

  it("calls a tie added, moved or removed no edit the compiler must hear about", () => {
    // A route is not a connection: reclassifying it as a rewire would recompile the graph
    // and reset every feedback loop each time someone tidied a wire.
    // Successive revisions share every untouched node object, as the store's do.
    const base = untied();
    const routed = tied(base);
    expect(graphEdits(base, routed)).toEqual([]);
    const moved: GraphDocument = { ...routed, ties: { ...routed.ties, ti_up: { id: "ti_up", position: { x: 0, y: 0 } } } };
    expect(graphEdits(routed, moved)).toEqual([]);
    expect(graphEdits(routed, base)).toEqual([]);
    // ...while a real rewire still is one.
    const rewired: GraphDocument = {
      ...routed,
      edges: { ...routed.edges, e3: { id: "e3", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
    };
    expect(graphEdits(routed, rewired).map((edit) => edit.kind)).toContain("topology");
  });
});
