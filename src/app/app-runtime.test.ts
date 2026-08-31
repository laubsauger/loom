import { describe, expect, it } from "vitest";

import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { compileGraph } from "@compiler/index.ts";
import { createAppRuntime } from "./app-runtime.ts";

/**
 * T627 — OPENING A FILE KEEPS ITS COMPONENT LIBRARY.
 *
 * The property, not a fixture: a document containing a LINKED instance, saved and
 * reopened, resolves its definition. §V79 is exactly what made this fail — a linked
 * instance references its definition rather than copying it, `loadProject` installed
 * the library into the CURRENT runtime's registry and returned it, and
 * `adoptDocument` built a FRESH runtime that dropped it — so every instance in a
 * reopened file reported `component-missing` while the same file worked moments
 * before saving. The round trip below goes through the real save bytes, the real
 * loader, and the real runtime constructor the open path uses.
 */

const ACTOR = { kind: "human" as const, id: "tester", label: "Tester" };

function fanDefinition(version = 1): GraphComponentDefinition {
  return {
    componentId: "fan",
    version,
    name: "Fan",
    graph: {
      revision: 1,
      nodes: {
        entry: { id: "entry" as NodeId, type: "componentIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "feed" },
        blurA: { id: "blurA" as NodeId, type: "blur", definitionVersion: 1, position: { x: 240, y: 0 }, parameters: {} },
        exit: { id: "exit" as NodeId, type: "componentOut", definitionVersion: 1, position: { x: 480, y: 0 }, parameters: {}, label: "result" },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "entry" as NodeId, portId: "out" }, target: { nodeId: "blurA" as NodeId, portId: "input" } },
        e1: { id: "e1", source: { nodeId: "blurA" as NodeId, portId: "out" }, target: { nodeId: "exit" as NodeId, portId: "in" } },
      },
      groups: {},
    } as never,
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

async function seededRuntime() {
  const runtime = createAppRuntime({ identityStorage: null, actor: ACTOR });
  runtime.components.register(fanDefinition());
  const type = componentNodeType("fan", 1);
  const patched = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$gen", type: "noise", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$c", type, position: { x: 240, y: 0 } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
        { op: "connect", source: { nodeId: "$gen", portId: "out" }, target: { nodeId: "$c", portId: "feed" } },
        { op: "connect", source: { nodeId: "$c", portId: "result" }, target: { nodeId: "$out", portId: "input" } },
      ],
    },
    runtime.invocation,
  );
  expect(patched.status).toBe("applied");
  return { runtime, type };
}

describe("T627 — the component library survives the open (§V79)", () => {
  it("save, reopen through the REAL runtime constructor: the linked instance resolves", async () => {
    const { runtime, type } = await seededRuntime();

    const file = buildProjectFile({
      document: { ...runtime.project, graph: runtime.bus.store.getGraph() },
      components: runtime.components.all(),
    });

    // The open path exactly as `adoptDocument` performs it: load, then a FRESH runtime.
    const loaded = loadProject(file.text, { nodes: runtime.registry });
    if (!loaded.ok) throw new Error("load failed");
    expect(loaded.components.map((entry) => entry.componentId)).toContain("fan");

    const reopened = createAppRuntime({
      identityStorage: null,
      actor: ACTOR,
      document: loaded.document,
      components: loaded.components,
      unknownParameters: loaded.unknownParameters,
    });

    // The definition is IN the fresh catalogue, and the manifest resolves the type.
    expect(reopened.components.get("fan", 1)).toBeDefined();
    expect(reopened.registry.get(type)).toBeDefined();

    // And the whole document COMPILES: the instance flattens instead of reporting
    // component-missing — which is what the user actually sees on reopen.
    const compiled = compileGraph({
      graph: reopened.bus.store.getGraph(),
      settings: reopened.project.settings,
      registry: reopened.registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
      components: reopened.components.view(),
    });
    expect(
      compiled.diagnostics.filter(
        (entry) => entry.severity === "error" || entry.code.includes("component"),
      ),
    ).toEqual([]);
    expect(compiled.order.some((nodeId) => String(nodeId).includes("/blurA"))).toBe(true);
  });

  it("a VERSION-PINNED instance resolves the pinned entry from the file (T136, §V84)", async () => {
    const { runtime } = await seededRuntime();
    // The catalogue moves on — v2 exists — but the saved instance stays pinned to v1.
    runtime.components.register(fanDefinition(2));

    const file = buildProjectFile({
      document: { ...runtime.project, graph: runtime.bus.store.getGraph() },
      components: runtime.components.all(),
    });
    const loaded = loadProject(file.text, { nodes: runtime.registry });
    if (!loaded.ok) throw new Error("load failed");

    const reopened = createAppRuntime({
      identityStorage: null,
      actor: ACTOR,
      document: loaded.document,
      components: loaded.components,
    });
    // Both versions came back through the same seam; the pinned type resolves to v1
    // exactly (§V84: upgrading is explicit, never a silent retarget to latest).
    expect(reopened.components.get("fan", 1)?.version).toBe(1);
    expect(reopened.components.get("fan", 2)?.version).toBe(2);
    expect(reopened.registry.get(componentNodeType("fan", 1))?.version).toBe(1);
  });
});
