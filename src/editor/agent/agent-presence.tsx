import type { AgentActivity, AgentPresenceSnapshot, AgentProposal, AgentTransaction } from "@agent/index.ts";
import { Button } from "@ui/index.ts";

import { describeOperation } from "./describe-operation.ts";
import styles from "./agent-presence.module.css";

/**
 * Agent presence UI (T60, §V42).
 *
 * §V42: agent activity is visible, and invisible background mutation is forbidden. Three
 * things make that true here, and each one is a requirement rather than decoration:
 *
 *  1. **An actor badge with a state.** Planning, editing, compiling and awaiting-approval
 *     are distinct, labelled and colour-coded, and the label is text — not colour alone
 *     (§V19). The state comes from the same store the tool surface writes as it runs, so
 *     "editing" is on screen while the edit is in flight.
 *  2. **Patch review before applying.** A held mutation is listed operation by operation
 *     with Approve and Reject. The reviewer sees WHAT will change before it changes.
 *  3. **Revert a transaction as one unit.** An agent session is a transaction, not N
 *     unrelated edits, so undoing it is one button rather than N presses of undo.
 *
 * Everything rendered from the document — node ids, type names, labels, parameter keys —
 * is untrusted text placed in a text node (§V37). React escapes it; nothing here builds
 * markup or prose out of it.
 *
 * The component is presentational: it takes a snapshot and three callbacks. It never
 * calls the bus, and it never computes presence.
 */

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  idle: "Idle",
  planning: "Planning",
  editing: "Editing",
  compiling: "Compiling",
  "awaiting-approval": "Awaiting approval",
};

export interface AgentBadgeProps {
  readonly presence: AgentPresenceSnapshot;
}

export function AgentBadge({ presence }: AgentBadgeProps) {
  const label = presence.actor.label ?? presence.actor.id;
  return (
    <span
      className={styles.badge}
      data-activity={presence.activity}
      data-testid="agent-badge"
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.actor}>{label}</span>
      <span className={styles.activity} data-testid="agent-activity">
        {ACTIVITY_LABEL[presence.activity]}
      </span>
      {presence.tool === null ? null : (
        <span className={styles.meta} data-testid="agent-tool">
          {presence.tool}
        </span>
      )}
    </span>
  );
}

export interface AgentPresencePanelProps {
  readonly presence: AgentPresenceSnapshot;
  readonly onApprove: (proposalId: string) => void;
  readonly onReject: (proposalId: string) => void;
  readonly onRevert: (transactionId: string) => void;
}

export function AgentPresencePanel({
  presence,
  onApprove,
  onReject,
  onRevert,
}: AgentPresencePanelProps) {
  const pending = presence.proposals.filter((proposal) => proposal.status === "pending");
  const revertible = presence.transactions.filter(
    (transaction) => transaction.status !== "reverted" && transaction.undoGroupIds.length > 0,
  );

  return (
    <div className={styles.panel} data-testid="agent-presence-panel">
      <AgentBadge presence={presence} />

      <section className={styles.section} aria-labelledby="agent-proposals-heading">
        <h3 className={styles.sectionTitle} id="agent-proposals-heading">
          Pending changes
        </h3>
        {pending.length === 0 ? (
          <p className={styles.empty}>No changes are waiting for review.</p>
        ) : (
          pending.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))
        )}
      </section>

      <section className={styles.section} aria-labelledby="agent-transactions-heading">
        <h3 className={styles.sectionTitle} id="agent-transactions-heading">
          Agent transactions
        </h3>
        {revertible.length === 0 ? (
          <p className={styles.empty}>No agent edits to revert.</p>
        ) : (
          revertible.map((transaction) => (
            <TransactionRow key={transaction.id} transaction={transaction} onRevert={onRevert} />
          ))
        )}
      </section>
    </div>
  );
}

interface ProposalCardProps {
  readonly proposal: AgentProposal;
  readonly onApprove: (proposalId: string) => void;
  readonly onReject: (proposalId: string) => void;
}

function ProposalCard({ proposal, onApprove, onReject }: ProposalCardProps) {
  return (
    <article className={styles.card} data-status={proposal.status} data-proposal={proposal.id}>
      <header className={styles.cardHead}>
        <span>{proposal.label}</span>
        <span className={styles.meta}>
          {proposal.tool} · rev {proposal.baseRevision}
        </span>
      </header>
      <ul className={styles.operations} data-testid="proposal-operations">
        {proposal.operations.map((operation, index) => {
          const row = describeOperation(operation);
          return (
            <li className={styles.operation} key={`${row.kind}-${String(index)}`}>
              <span className={styles.opKind}>{row.kind}</span>
              <span className={styles.opTargets}>{row.targets.join(" → ")}</span>
              {row.detail === null ? null : <span className={styles.opDetail}>{row.detail}</span>}
            </li>
          );
        })}
      </ul>
      <div className={styles.actions}>
        <Button
          onClick={() => {
            onApprove(proposal.id);
          }}
        >
          Apply
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onReject(proposal.id);
          }}
        >
          Discard
        </Button>
      </div>
    </article>
  );
}

interface TransactionRowProps {
  readonly transaction: AgentTransaction;
  readonly onRevert: (transactionId: string) => void;
}

function TransactionRow({ transaction, onRevert }: TransactionRowProps) {
  return (
    <article className={styles.card} data-status={transaction.status} data-transaction={transaction.id}>
      <header className={styles.cardHead}>
        <span>{transaction.label}</span>
        <span className={styles.meta}>
          {transaction.undoGroupIds.length} edit group
          {transaction.undoGroupIds.length === 1 ? "" : "s"} · {transaction.status}
        </span>
      </header>
      <div className={styles.actions}>
        <Button
          variant="outline"
          onClick={() => {
            onRevert(transaction.id);
          }}
        >
          Revert all
        </Button>
      </div>
    </article>
  );
}
