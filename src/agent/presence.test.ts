import { describe, expect, it } from "vitest";

import type { Actor } from "@domain/types/commands.ts";

import { createAgentPresence } from "./presence.ts";

/**
 * Presence transitions (§V42, T60).
 *
 * The store is what makes agent activity visible, so every transition a UI can render is
 * asserted here rather than inferred from a component test: a badge that never changes is
 * the invisible background mutation §V42 forbids.
 */

const agent: Actor = { kind: "agent", id: "claude", label: "Claude" };

function createStore() {
  let clock = 0;
  const presence = createAgentPresence({
    actor: agent,
    now: () => {
      clock += 1;
      return clock;
    },
  });
  const seen: string[] = [];
  presence.subscribe(() => {
    seen.push(presence.snapshot().activity);
  });
  return { presence, seen };
}

describe("activity", () => {
  it("starts idle and reports each state change once", () => {
    const { presence, seen } = createStore();
    expect(presence.snapshot().activity).toBe("idle");

    presence.setActivity("planning", "get_graph");
    presence.setActivity("editing", "add_node");
    presence.setActivity("editing", "add_node");
    presence.setActivity("idle", null);

    expect(seen).toEqual(["planning", "editing", "idle"]);
    expect(presence.snapshot().tool).toBeNull();
  });

  it("publishes an immutable snapshot per change", () => {
    const { presence } = createStore();
    const before = presence.snapshot();
    presence.setActivity("compiling", "compile_project");
    expect(presence.snapshot()).not.toBe(before);
    expect(before.activity).toBe("idle");
  });
});

describe("proposals (patch review before applying)", () => {
  it("enters awaiting-approval when a proposal is added and leaves when it resolves", () => {
    const { presence, seen } = createStore();

    presence.addProposal({
      id: "proposal-1",
      tool: "add_node",
      label: "Add node",
      baseRevision: 3,
      operations: [{ op: "removeNodes", nodeIds: ["n1"] }],
      transactionId: undefined,
    });
    expect(presence.snapshot().activity).toBe("awaiting-approval");

    const resolved = presence.resolveProposal("proposal-1", "approved");
    expect(resolved?.status).toBe("approved");
    expect(presence.snapshot().activity).toBe("idle");
    expect(seen).toEqual(["awaiting-approval", "idle"]);
  });

  it("stays awaiting-approval while another proposal is still pending", () => {
    const { presence } = createStore();
    for (const id of ["proposal-1", "proposal-2"]) {
      presence.addProposal({
        id,
        tool: "add_node",
        label: "Add node",
        baseRevision: 0,
        operations: [],
        transactionId: undefined,
      });
    }
    presence.resolveProposal("proposal-1", "rejected");
    expect(presence.snapshot().activity).toBe("awaiting-approval");
  });

  it("resolves a proposal only once", () => {
    const { presence } = createStore();
    presence.addProposal({
      id: "proposal-1",
      tool: "add_node",
      label: "Add node",
      baseRevision: 0,
      operations: [],
      transactionId: undefined,
    });
    expect(presence.resolveProposal("proposal-1", "approved")?.status).toBe("approved");
    expect(presence.resolveProposal("proposal-1", "rejected")).toBeNull();
  });
});

describe("transactions", () => {
  it("collects the undo groups an edit produced and closes as reverted", () => {
    const { presence } = createStore();
    presence.openTransaction("txn-1", "Agent session");
    presence.recordUndoGroup("txn-1", "group-1");
    presence.recordUndoGroup("txn-1", "group-1");
    presence.recordUndoGroup("txn-1", "group-2");

    const open = presence.snapshot().transactions[0];
    expect(open?.undoGroupIds).toEqual(["group-1", "group-2"]);
    expect(open?.status).toBe("open");

    presence.closeTransaction("txn-1", "reverted");
    expect(presence.snapshot().transactions[0]?.status).toBe("reverted");
  });

  it("ignores an undo group for a transaction it does not know", () => {
    const { presence } = createStore();
    presence.recordUndoGroup("txn-nope", "group-1");
    expect(presence.snapshot().transactions).toEqual([]);
  });
});
