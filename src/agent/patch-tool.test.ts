import { beforeEach, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore, type GraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { Actor } from "@domain/types/commands.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";

import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import type { PatchToolData } from "./tool-support.ts";
import type { ToolResult } from "./types.ts";

/**
 * `apply_graph_patch` through the tool surface: §V32 §V33 §V35 §V36 §V66.
 *
 * The atomicity, conflict and temp-id rules belong to `graph.applyPatch` and are tested
 * there. What is tested HERE is that the tool projects them faithfully — an adapter that
 * swallowed a conflict, or reported a dry run as applied, would break the agent's whole
 * verify loop while the domain stayed correct.
 */

const agent: Actor = { kind: "agent", id: "claude" };

interface Fixture {
  store: GraphStore;
  surface: AgentToolSurface;
}

let fixture: Fixture;

beforeEach(() => {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
  fixture = {
    store,
    surface: createAgentToolSurface({ bus, actor: agent, projectId: "project-1", now: () => 1_000 }),
  };
});

const patchData = (outcome: ToolResult): PatchToolData => outcome.data as PatchToolData;

const revision = (): number => fixture.store.view.getRevision();
const nodeCount = (): number => Object.keys(fixture.store.view.getGraph().nodes).length;
const edgeCount = (): number => Object.keys(fixture.store.view.getGraph().edges).length;

describe("apply_graph_patch (§V32, §V35)", () => {
  it("adds nodes and wires them in one request, returning the stable ids", async () => {
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: revision(),
      label: "Build chain",
      operations: [
        { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
        {
          op: "connect",
          ref: "$e",
          source: { nodeId: "$a", portId: "out" },
          target: { nodeId: "$b", portId: "source" },
        },
      ],
    });

    expect(outcome.status).toBe("ok");
    const data = patchData(outcome);
    expect(data.appliedOperations).toBe(3);
    // §V35: every temp ref resolved, and the ids handed back are the real ones.
    expect(Object.keys(data.createdIds).sort()).toEqual(["$a", "$b", "$e"]);
    for (const stable of Object.values(data.createdIds)) {
      expect(stable.startsWith("$")).toBe(false);
    }
    expect(nodeCount()).toBe(2);
    expect(edgeCount()).toBe(1);
    // §V34: one patch, one undo group.
    expect(outcome.undoGroupId).toBeDefined();
  });

  it("is atomic: one invalid operation leaves the document byte-identical (§V32)", async () => {
    const base = revision();
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: base,
      operations: [
        { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "test.doesNotExist", position: { x: 10, y: 0 } },
      ],
    });

    expect(outcome.status).toBe("rejected");
    expect(nodeCount()).toBe(0);
    expect(revision()).toBe(base);
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
  });

  it("reports a stale baseRevision as a conflict and never rebases (§V33)", async () => {
    await fixture.surface.callTool("add_node", { type: "test.solid" });
    const stale = 0;

    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: stale,
      operations: [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } }],
    });

    expect(outcome.status).toBe("conflict");
    expect(patchData(outcome).appliedOperations).toBe(0);
    expect(nodeCount()).toBe(1);
    expect(outcome.diagnostics.some((entry) => entry.code === "patch.conflict")).toBe(true);
  });

  it("refuses malformed input structurally instead of throwing (§V66)", async () => {
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: revision(),
      operations: [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: Number.NaN, y: 0 } }],
    });

    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]?.code).toBe("tool.input");
    expect(nodeCount()).toBe(0);
  });

  it("rejects a patch-local ref that is not a $temp id", async () => {
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: revision(),
      operations: [{ op: "addNode", ref: "a", type: "test.solid", position: { x: 0, y: 0 } }],
    });
    expect(outcome.status).toBe("error");
  });

  it("requires a baseRevision — an agent patch is never silently rebased (§V33)", async () => {
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      operations: [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } }],
    });
    expect(outcome.status).toBe("error");
    expect(nodeCount()).toBe(0);
  });
});

describe("dryRun validates and mutates nothing (§V36)", () => {
  it("reports `validated`, not `applied`, and creates no ids", async () => {
    const base = revision();
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: base,
      dryRun: true,
      operations: [
        { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      ],
    });

    // The underlying command answers a dry run with status "applied" (T102). Reporting
    // that verbatim would tell the agent an edit happened; the adapter knows it asked for
    // a dry run and says so.
    expect(outcome.status).toBe("validated");
    expect(patchData(outcome).status).toBe("validated");
    expect(patchData(outcome).createdIds).toEqual({});
    expect(nodeCount()).toBe(0);
    expect(revision()).toBe(base);
    expect(fixture.store.view.getAudit()).toHaveLength(0);
  });

  it("still reports the diagnostics a real apply would have produced", async () => {
    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: revision(),
      dryRun: true,
      operations: [{ op: "addNode", ref: "$a", type: "test.doesNotExist", position: { x: 0, y: 0 } }],
    });

    expect(outcome.status).toBe("rejected");
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
    expect(nodeCount()).toBe(0);
  });

  it("holds for a convenience tool too", async () => {
    const outcome = await fixture.surface.callTool("add_node", { type: "test.solid", dryRun: true });
    expect(outcome.status).toBe("validated");
    expect(nodeCount()).toBe(0);
  });
});

describe("the single-edit tools are the same patch path", () => {
  it("connects two nodes and disconnects them again", async () => {
    const a = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const b = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const sourceId = patchData(a).createdIds["$node"] ?? "";
    const targetId = patchData(b).createdIds["$node"] ?? "";

    const connected = await fixture.surface.callTool("connect_ports", {
      source: { nodeId: sourceId, portId: "out" },
      target: { nodeId: targetId, portId: "source" },
    });
    expect(connected.status).toBe("ok");
    expect(edgeCount()).toBe(1);

    const edgeId = patchData(connected).createdIds["$edge"] ?? "";
    const disconnected = await fixture.surface.callTool("disconnect_ports", { edgeIds: [edgeId] });
    expect(disconnected.status).toBe("ok");
    expect(edgeCount()).toBe(0);
  });

  it("refuses an incompatible connection with a diagnostic, not a throw (§V13)", async () => {
    const a = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const b = await fixture.surface.callTool("add_node", { type: "test.mono" });

    const outcome = await fixture.surface.callTool("connect_ports", {
      source: { nodeId: patchData(a).createdIds["$node"] ?? "", portId: "out" },
      target: { nodeId: patchData(b).createdIds["$node"] ?? "", portId: "source" },
    });

    expect(outcome.status).toBe("rejected");
    expect(edgeCount()).toBe(0);
  });

  it("removes nodes with their incident edges (§V40)", async () => {
    const a = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const b = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const sourceId = patchData(a).createdIds["$node"] ?? "";
    const targetId = patchData(b).createdIds["$node"] ?? "";
    await fixture.surface.callTool("connect_ports", {
      source: { nodeId: sourceId, portId: "out" },
      target: { nodeId: targetId, portId: "source" },
    });

    const outcome = await fixture.surface.callTool("remove_nodes", { nodeIds: [sourceId] });

    expect(outcome.status).toBe("ok");
    expect(nodeCount()).toBe(1);
    expect(edgeCount()).toBe(0);
  });

  it("sets parameters and reads them back", async () => {
    const added = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const nodeId = patchData(added).createdIds["$node"] ?? "";

    const outcome = await fixture.surface.callTool("set_parameters", {
      nodeId,
      parameters: { radius: 12 },
    });
    expect(outcome.status).toBe("ok");

    const read = await fixture.surface.callTool("get_node", { nodeId });
    const data = read.data as { node: { parameters: Record<string, unknown> } };
    expect(data.node.parameters["radius"]).toBe(12);
  });

  it("undoes and redoes the agent's own work (§V41)", async () => {
    await fixture.surface.callTool("add_node", { type: "test.solid" });
    expect(nodeCount()).toBe(1);

    const undone = await fixture.surface.callTool("undo", {});
    expect(undone.status).toBe("ok");
    expect(nodeCount()).toBe(0);

    const redone = await fixture.surface.callTool("redo", {});
    expect(redone.status).toBe("ok");
    expect(nodeCount()).toBe(1);
  });

  it("reports an empty undo stack rather than pretending", async () => {
    const outcome = await fixture.surface.callTool("undo", {});
    expect(outcome.status).toBe("rejected");
    expect(outcome.diagnostics[0]?.code).toBe("history.empty");
  });
});
