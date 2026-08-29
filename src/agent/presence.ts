import type { Actor } from "@domain/types/commands.ts";
import type { Revision } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";

/**
 * Agent presence — the observable half of §V42 (T60).
 *
 * §V42: agent activity is VISIBLE. Planning, editing, compiling and awaiting-approval
 * are states the UI must be able to show, and invisible background mutation is forbidden.
 * This store is the single source those states come from; `src/editor/agent/**` renders a
 * snapshot of it and never computes one.
 *
 * It is headless and synchronous on purpose. The tool surface drives it inline with each
 * call, so "the agent is editing" is true while the edit is in flight rather than one
 * animation frame later, and a test can assert the transition without a timer.
 *
 * Nothing here is document state (§V16): presence is never serialized, never undoable and
 * never reaches the graph store.
 */

export type AgentActivity = "idle" | "planning" | "editing" | "compiling" | "awaiting-approval";

export type ProposalStatus = "pending" | "approved" | "rejected" | "failed";

/**
 * A mutation held for human review (§V42 "patch review before applying").
 *
 * `operations` is DATA — node ids, types and parameter values straight from the caller.
 * The UI renders them as text; nothing in this record is prose the surface authored, and
 * nothing in it is interpolated into a message (§V37).
 */
export interface AgentProposal {
  readonly id: string;
  readonly tool: string;
  /** Authored label (the tool's own title), never document text. */
  readonly label: string;
  readonly baseRevision: Revision;
  readonly operations: readonly GraphPatchOperation[];
  readonly status: ProposalStatus;
  readonly createdAt: number;
  readonly transactionId: string | undefined;
}

/**
 * One agent transaction, so the UI can revert it AS A UNIT (§V42, T60).
 *
 * Edits sharing a `transactionId` coalesce into one undo group in the store (§V34), so
 * this is usually one id — but a command that split its undo group, or an interleaved
 * edit, produces more, and reverting must then undo all of them or none of the agent's
 * work looks reverted. The ids are collected from the command results themselves; the
 * bus's `graph.history` summary does not carry `transactionId`, which is the one addition
 * that would let a UI reconstruct this without an adapter-side ledger.
 */
export interface AgentTransaction {
  readonly id: string;
  readonly label: string;
  readonly undoGroupIds: readonly string[];
  readonly status: "open" | "committed" | "reverted" | "partially-reverted";
  readonly startedAt: number;
}

export interface AgentPresenceSnapshot {
  readonly actor: Actor;
  readonly activity: AgentActivity;
  /** Tool currently running, or the tool that last ran. Authored name, not user text. */
  readonly tool: string | null;
  readonly proposals: readonly AgentProposal[];
  readonly transactions: readonly AgentTransaction[];
  /** Revision the agent last observed or produced. */
  readonly revision: Revision | null;
  readonly updatedAt: number;
}

export interface AgentPresenceView {
  snapshot(): AgentPresenceSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface AgentPresenceStore extends AgentPresenceView {
  setActivity(activity: AgentActivity, tool: string | null): void;
  observeRevision(revision: Revision): void;
  openTransaction(id: string, label: string): void;
  recordUndoGroup(transactionId: string, undoGroupId: string): void;
  closeTransaction(id: string, status: AgentTransaction["status"]): void;
  addProposal(proposal: Omit<AgentProposal, "createdAt" | "status">): AgentProposal;
  resolveProposal(id: string, status: ProposalStatus): AgentProposal | null;
  getProposal(id: string): AgentProposal | null;
}

export interface AgentPresenceOptions {
  actor: Actor;
  /** Injected clock: presence timestamps are test-visible state, not wall-clock trivia. */
  now?: () => number;
}

export function createAgentPresence(options: AgentPresenceOptions): AgentPresenceStore {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>();

  let snapshot: AgentPresenceSnapshot = {
    actor: options.actor,
    activity: "idle",
    tool: null,
    proposals: [],
    transactions: [],
    revision: null,
    updatedAt: now(),
  };

  const publish = (next: Omit<AgentPresenceSnapshot, "actor" | "updatedAt">): void => {
    snapshot = { actor: options.actor, ...next, updatedAt: now() };
    for (const listener of [...listeners]) listener();
  };

  const rest = (): Omit<AgentPresenceSnapshot, "actor" | "updatedAt"> => ({
    activity: snapshot.activity,
    tool: snapshot.tool,
    proposals: snapshot.proposals,
    transactions: snapshot.transactions,
    revision: snapshot.revision,
  });

  const replaceTransaction = (
    id: string,
    change: (transaction: AgentTransaction) => AgentTransaction,
  ): void => {
    const transactions = snapshot.transactions.map((transaction) =>
      transaction.id === id ? change(transaction) : transaction,
    );
    publish({ ...rest(), transactions });
  };

  return {
    snapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setActivity(activity, tool) {
      if (snapshot.activity === activity && snapshot.tool === tool) return;
      publish({ ...rest(), activity, tool });
    },

    observeRevision(revision) {
      if (snapshot.revision === revision) return;
      publish({ ...rest(), revision });
    },

    openTransaction(id, label) {
      if (snapshot.transactions.some((transaction) => transaction.id === id)) return;
      publish({
        ...rest(),
        transactions: [
          ...snapshot.transactions,
          { id, label, undoGroupIds: [], status: "open", startedAt: now() },
        ],
      });
    },

    recordUndoGroup(transactionId, undoGroupId) {
      const known = snapshot.transactions.find((transaction) => transaction.id === transactionId);
      if (known === undefined || known.undoGroupIds.includes(undoGroupId)) return;
      replaceTransaction(transactionId, (transaction) => ({
        ...transaction,
        undoGroupIds: [...transaction.undoGroupIds, undoGroupId],
      }));
    },

    closeTransaction(id, status) {
      const known = snapshot.transactions.find((transaction) => transaction.id === id);
      if (known === undefined) return;
      replaceTransaction(id, (transaction) => ({ ...transaction, status }));
    },

    addProposal(proposal) {
      const created: AgentProposal = { ...proposal, status: "pending", createdAt: now() };
      publish({
        ...rest(),
        activity: "awaiting-approval",
        tool: proposal.tool,
        proposals: [...snapshot.proposals, created],
      });
      return created;
    },

    resolveProposal(id, status) {
      const found = snapshot.proposals.find((proposal) => proposal.id === id);
      if (found === undefined || found.status !== "pending") return null;
      const resolved: AgentProposal = { ...found, status };
      const proposals = snapshot.proposals.map((proposal) =>
        proposal.id === id ? resolved : proposal,
      );
      const stillPending = proposals.some((proposal) => proposal.status === "pending");
      publish({
        ...rest(),
        proposals,
        activity: stillPending ? "awaiting-approval" : "idle",
      });
      return resolved;
    },

    getProposal(id) {
      return snapshot.proposals.find((proposal) => proposal.id === id) ?? null;
    },
  };
}

/** Deterministic proposal ids, minted by the surface rather than the store. */
export function createProposalIdFactory(prefix = "proposal"): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}-${count}`;
  };
}
