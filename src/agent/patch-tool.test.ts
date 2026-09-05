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

  /**
   * §V33 conflicts on ENTITY OVERLAP, not on revision distance alone (T107). So this
   * patch must touch the node the concurrent edit touched — an earlier version added a
   * disjoint node against a stale base and now correctly APPLIES, which is the whole
   * point of the carve-out: a 60Hz human drag must not starve every agent patch.
   */
  it("bare add_node calls CASCADE — twenty adds are a row, never a pile at the origin (T612)", async () => {
    // The owner's screenshot: an agent added ~20 nodes with neither position nor
    // placement and every one landed verbatim at (0,0). The cascade is deterministic
    // (a pure function of the document), so this asserts positions, not vibes.
    const first = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const second = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const third = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const ids = [first, second, third].map(
      (outcome) => Object.values(patchData(outcome).createdIds)[0] as string,
    );
    const graph = fixture.store.view.getGraph();
    const positions = ids.map((id) => graph.nodes[id]!.position);
    // The first node on an empty graph belongs at the origin; each later one opens the
    // next column in reading order — strictly increasing x, no two alike.
    expect(positions[0]).toEqual({ x: 0, y: 0 });
    expect(positions[1]!.x).toBeGreaterThan(positions[0]!.x);
    expect(positions[2]!.x).toBeGreaterThan(positions[1]!.x);
    // An EXPLICIT position is still taken verbatim — the cascade is a default, not a veto.
    const pinned = await fixture.surface.callTool("add_node", { type: "test.solid", position: { x: 7, y: 9 } });
    const pinnedId = Object.values(patchData(pinned).createdIds)[0] as string;
    expect(fixture.store.view.getGraph().nodes[pinnedId]!.position).toEqual({ x: 7, y: 9 });
  });

  it("reports a stale baseRevision as a conflict when the edits OVERLAP (§V33)", async () => {
    const created = await fixture.surface.callTool("add_node", { type: "test.solid" });
    const nodeId = Object.values(patchData(created).createdIds)[0] as string;
    const stale = 0;

    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: stale,
      operations: [{ op: "moveNodes", positions: { [nodeId]: { x: 40, y: 40 } } }],
    });

    expect(outcome.status).toBe("conflict");
    expect(patchData(outcome).appliedOperations).toBe(0);
    expect(outcome.diagnostics.some((entry) => entry.code === "patch.conflict")).toBe(true);
  });

  /** The other half of the same rule: a stale base with NO overlap still applies. */
  it("applies a stale patch that overlaps nothing (§V33, T107)", async () => {
    await fixture.surface.callTool("add_node", { type: "test.solid" });

    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } }],
    });

    expect(outcome.status).toBe("ok");
    expect(nodeCount()).toBe(2);
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

/**
 * T1208 — the mode the owner thought was gone, through the door that was still open.
 *
 * §T897 retired `driven`: the mode buttons stopped offering it, `parameter.setMode`
 * refuses switching into it, and a document holding one is upgraded at LOAD. Every one of
 * those guards is on a route that changes ONE mode, and none of them is on a PATCH — so an
 * agent could write the whole slot in one operation and land the retired mode past all
 * three. That is §V941's shape: several entrances, and the rite lived on some of them.
 *
 * BOTH agent routes are pinned, because they do not share a schema: the convenience tools
 * carry this boundary's own `parameters` record, `apply_graph_patch` carries the document's
 * operation union. A rule on one of those is a rule with a door beside it.
 *
 * The refusal names the expression that replaces it, built from the caller's OWN channel,
 * because "retired" without a replacement is a dead end (T1207).
 */
describe("the retired driven mode cannot be written through a patch (T1208, T897)", () => {
  it("refuses a driven slot through apply_graph_patch, the other route", async () => {
    const added = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const nodeId = patchData(added).createdIds["$node"] ?? "";
    const before = revision();

    const outcome = await fixture.surface.callTool("apply_graph_patch", {
      baseRevision: before,
      operations: [
        {
          op: "setParameters",
          nodeId,
          parameters: {
            radius: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1:low" } } },
          },
        },
      ],
    });

    // A schema refusal is `error` at this surface, not `rejected`: the input never
    // reached the bus, so there is no revision to have conflicted with.
    expect(outcome.status).toBe("error");
    expect(revision()).toBe(before);
    const messages = outcome.diagnostics.map((entry) => entry.message);
    expect(messages.join(" ")).toContain("op('lfo1').chan.low");
  });

  it("refuses a driven slot and names the expression that replaces it", async () => {
    const added = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const nodeId = patchData(added).createdIds["$node"] ?? "";
    const before = revision();

    const outcome = await fixture.surface.callTool("set_parameters", {
      nodeId,
      parameters: {
        radius: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1:value" } } },
      },
    });

    expect(outcome.status).toBe("error");
    // Nothing landed: a refused input is an input that never reached the bus (§V32).
    expect(revision()).toBe(before);
    // The REPLACEMENT reaches the caller, which is the whole point — a refinement's
    // content is its message, and the surface used to publish only the issue's code.
    const messages = outcome.diagnostics.map((entry) => entry.message);
    expect(messages.join(" ")).toContain("op('lfo1').chan.value");
    expect(messages.join(" ")).toContain("retired");
  });

  it("accepts the expression the refusal names, so the advice is not a dead end", async () => {
    const added = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const nodeId = patchData(added).createdIds["$node"] ?? "";

    const outcome = await fixture.surface.callTool("set_parameters", {
      nodeId,
      parameters: {
        radius: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "op('lfo1').chan.value" } },
        },
      },
    });

    expect(outcome.status).toBe("ok");
  });

  it("still accepts a slot that merely RETAINS a driven payload under another mode (§V108)", async () => {
    // The legitimate case this guard could swallow. `upgradeDrivenSlot` leaves a shadowed
    // driven payload in place beside an authored expression, so a document loaded from the
    // wild carries one — and refusing every write that touches such a node would make a
    // loaded document uneditable to fix a mode nobody is using.
    const added = await fixture.surface.callTool("add_node", { type: "test.blur" });
    const nodeId = patchData(added).createdIds["$node"] ?? "";

    const outcome = await fixture.surface.callTool("set_parameters", {
      nodeId,
      parameters: {
        radius: {
          mode: "expression",
          bindings: {
            expression: { kind: "expression", source: "time" },
            driven: { kind: "driven", channel: "lfo1:value" },
          },
        },
      },
    });

    expect(outcome.status).toBe("ok");
  });
});

/**
 * B191 — "Agent transactions: no agent edits to revert", forever.
 *
 * The owner watched an MCP agent drop a graph of nodes into his document and the panel
 * that is supposed to show what an agent did stayed empty. It was not filtering anything
 * out: `beginTransaction` was called from nowhere in the product — not the bridge, not the
 * page, not the WebMCP adapter — so there was never a transaction for an undo group to be
 * recorded against. Built, tested, never wired.
 *
 * These assert what the PANEL reads: a transaction that exists, carrying the undo groups
 * the edits produced, so `revertible` (status not reverted AND at least one group) is
 * non-empty and the Revert button has something to press. Asserting "openTransaction was
 * called" would be the mechanism; the panel's filter is the consumer.
 */
describe("an agent's edits land in a revertible transaction without anyone opening one (B191)", () => {
  const revertible = () =>
    fixture.surface.presence
      .snapshot()
      .transactions.filter(
        (transaction) => transaction.status !== "reverted" && transaction.undoGroupIds.length > 0,
      );

  it("shows the session's edits in the panel's own terms", async () => {
    expect(revertible()).toEqual([]);

    await fixture.surface.callTool("add_node", { type: "test.solid" });
    await fixture.surface.callTool("add_node", { type: "test.blur" });

    // ONE unit for the session, not one per call: "an agent session is a transaction, not
    // N unrelated edits" is the panel's stated contract and this is it holding.
    expect(revertible()).toHaveLength(1);
    // TWO undo groups inside it, and that number is the design decision, not a detail: the
    // store coalesces mutations sharing an InvocationContext transaction id into ONE undo
    // group, so a session unit that reached the invocation would read `1` here and a human
    // pressing undo once would lose the agent's whole visit. The unit is presence-side.
    expect(revertible()[0]?.undoGroupIds).toHaveLength(2);
    expect(revertible()[0]?.label).toContain("claude");
  });

  it("reverts that transaction as one unit, which is what the button does", async () => {
    await fixture.surface.callTool("add_node", { type: "test.solid" });
    await fixture.surface.callTool("add_node", { type: "test.blur" });
    expect(nodeCount()).toBe(2);

    const id = fixture.surface.currentTransaction() ?? "";
    const outcome = await fixture.surface.revertTransaction(id);

    expect(outcome.status).toBe("ok");
    expect(nodeCount()).toBe(0);
    expect(revertible()).toEqual([]);
  });

  it("opens nothing for a READ, and nothing for a dry run (§V36)", async () => {
    // The legitimate cases the guard could swallow. A session that only looked at the
    // document has nothing to revert, and a dry run mutates nothing by definition — a
    // transaction for either would put an empty unit in front of the human, which is the
    // same lie in the other direction.
    await fixture.surface.callTool("get_graph", {});
    await fixture.surface.callTool("add_node", { type: "test.solid", dryRun: true });

    expect(fixture.surface.presence.snapshot().transactions).toEqual([]);
    expect(nodeCount()).toBe(0);
  });

  it("still lets a caller group edits deliberately, and does not open a second unit", async () => {
    const id = fixture.surface.beginTransaction("Building the chain");
    await fixture.surface.callTool("add_node", { type: "test.solid" });

    const transactions = fixture.surface.presence.snapshot().transactions;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.id).toBe(id);
    expect(transactions[0]?.label).toBe("Building the chain");
  });
});
