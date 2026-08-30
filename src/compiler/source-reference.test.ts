import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { migrateProjectDocument } from "../domain/migrations/document-migrations.ts";
import type { GraphDocument } from "../domain/types/graph.ts";

/**
 * T350 (§V285): feedback by REFERENCE. The centrepiece claim is EQUALITY BY
 * CONSTRUCTION — a referenced loop and a wired loop compile to the IDENTICAL plan,
 * because the reference synthesizes the exact edge the wire was. Identical bytes
 * cannot sample a different frame, which is strictly stronger than a pixel test.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

/** The minimal loop: noise → over ← feedback(over), over → out. */
function loopGraph(shape: "wired" | "reference"): GraphDocument {
  const nodes: Record<string, unknown> = {
    src: { id: "src", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    mix: { id: "mix", type: "over", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "over1" },
    echo: {
      id: "echo",
      type: "feedback",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: shape === "reference" ? { source: "over1" } : {},
    },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
  };
  const edges: Record<string, unknown> = {
    e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "mix", portId: "in1" } },
    e2: { id: "e2", source: { nodeId: "echo", portId: "out" }, target: { nodeId: "mix", portId: "in2" } },
    e3: { id: "e3", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  if (shape === "wired") {
    // The synthesized edge id, deliberately: the two plans must be BYTE-identical,
    // and pass/resource ids fold edge ids in nowhere — but keeping every input equal
    // except the mechanism under test is what makes the comparison an experiment.
    edges["ref:echo"] = { id: "ref:echo", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "echo", portId: "in" } };
  }
  return { revision: 1, nodes, edges, groups: {} } as never;
}

describe("feedback by reference (T350/§V285)", () => {
  it("a referenced loop compiles to the IDENTICAL plan the wired loop had", () => {
    const wired = compileGraph({ graph: loopGraph("wired"), settings: SETTINGS, registry, capabilities: CAPABILITIES });
    const referenced = compileGraph({
      graph: loopGraph("reference"),
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    expect(wired.ok).toBe(true);
    expect(referenced.ok).toBe(true);
    // Equality by construction: same signature, same passes, same uniforms — the
    // whole plan, byte for byte.
    expect(referenced.signature).toBe(wired.signature);
    expect(JSON.stringify(referenced.passes)).toBe(JSON.stringify(wired.passes));
    expect(referenced.feedback).toEqual(wired.feedback);
  });

  it("a dangling source name is an error that names the name", () => {
    const graph = loopGraph("reference");
    (graph.nodes["echo"] as { parameters: Record<string, unknown> }).parameters["source"] = "ghost1";
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    const diagnostic = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.sourceReferenceMissing);
    expect(diagnostic?.message).toContain('"ghost1"');
  });

  it("a reference AND a wire on one loop is refused — one loop, one truth", () => {
    const graph = loopGraph("wired");
    (graph.nodes["echo"] as { parameters: Record<string, unknown> }).parameters["source"] = "over1";
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.some((d) => d.code === CompilerDiagnosticCode.sourceReferenceAmbiguous)).toBe(true);
  });
});

describe("the wired-loop migration (T350) — THE ONLY WIRED-PATH LOADER COVERAGE", () => {
  /**
   * E1/E2 now ship in the reference shape, so no shipped file exercises the loader's
   * conversion. This test CONSTRUCTS the old wired document — a fixture that happens
   * to be old decays; a constructed one keeps working forever (§V283's lesson).
   */
  it("converts a schema-2 wired loop to the reference, assigning a label when the source has none", () => {
    const raw = {
      schemaVersion: 2,
      projectId: "p",
      name: "legacy",
      graph: {
        revision: 1,
        nodes: {
          mix: { id: "mix", type: "over", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
          echo: { id: "echo", type: "feedback", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          loop: { id: "loop", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "echo", portId: "in" } },
        },
        groups: {},
      },
      settings: {},
      assets: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const result = migrateProjectDocument(raw as never);
    if (!result.ok) throw new Error(result.reason);
    const graph = (result.document as { graph: { nodes: Record<string, Record<string, unknown>>; edges: Record<string, unknown> } }).graph;
    // The wire is gone; the name is real (assigned, since `mix` had no label).
    expect(graph.edges["loop"]).toBeUndefined();
    expect(graph.nodes["mix"]?.["label"]).toBe("over1");
    expect((graph.nodes["echo"]?.["parameters"] as Record<string, unknown>)["source"]).toBe("over1");
  });

  it("keeps an existing label rather than renaming the source", () => {
    const raw = {
      schemaVersion: 2,
      projectId: "p",
      name: "legacy",
      graph: {
        revision: 1,
        nodes: {
          mix: { id: "mix", type: "over", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "blend" },
          echo: { id: "echo", type: "feedback", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          loop: { id: "loop", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "echo", portId: "in" } },
        },
        groups: {},
      },
      settings: {},
      assets: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const result = migrateProjectDocument(raw as never);
    if (!result.ok) throw new Error(result.reason);
    const graph = (result.document as { graph: { nodes: Record<string, Record<string, unknown>> } }).graph;
    expect((graph.nodes["echo"]?.["parameters"] as Record<string, unknown>)["source"]).toBe("blend");
  });
});

describe("the editor never CREATES a wired loop (T350 amendment)", () => {
  it("connecting into a source-reference input is refused, pointing at the parameter", async () => {
    const { createGraphStore } = await import("../domain/graph/store.ts");
    const { createDomainBus } = await import("../domain/commands/index.ts");
    const store = createGraphStore();
    const { bus } = createDomainBus({ store, registry });
    const build = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: 0,
        label: "seed",
        operations: [
          { op: "addNode", ref: "$a", type: "over", position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$b", type: "feedback", position: { x: 0, y: 100 } },
        ],
      },
      { actor: { kind: "human", id: "t350" }, projectId: "t350" } as never,
    );
    expect(build.status).toBe("applied");
    const ids = Object.keys(store.view.getGraph().nodes);
    const over = ids.find((id) => store.view.getGraph().nodes[id]?.type === "over");
    const feedback = ids.find((id) => store.view.getGraph().nodes[id]?.type === "feedback");

    const wired = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: store.view.getGraph().revision,
        label: "wire the loop",
        operations: [
          {
            op: "connect",
            source: { nodeId: over as string, portId: "out" },
            target: { nodeId: feedback as string, portId: "in" },
          },
        ],
      },
      { actor: { kind: "human", id: "t350" }, projectId: "t350" } as never,
    );
    // Loader compatibility is not editor licence: the wire is refused with the fix
    // named — set the source parameter instead.
    expect(wired.status).not.toBe("applied");
    const message = JSON.stringify(wired);
    expect(message).toContain("source");
    expect(Object.keys(store.view.getGraph().edges)).toHaveLength(0);
  });
});
