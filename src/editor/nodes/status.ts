import type { AgentActivityKind, NodeRunStatus } from "@editor/graph-canvas/node-runtime.ts";

/**
 * The node's state vocabulary (doc §17.2: compiling, valid, warning, error, bypassed,
 * device-lost) as tokens and words.
 *
 * Colour alone is never the whole signal — every state also carries a word, so the
 * status is legible to a screen reader and to anyone who cannot separate the hues (§V19).
 * `error` and `device-lost` share the error token deliberately: both mean "this node is
 * not producing output", and the label is what tells them apart.
 */
export const STATUS_TOKEN: Readonly<Record<NodeRunStatus, string>> = {
  idle: "var(--text-dim)",
  compiling: "var(--signal)",
  valid: "var(--ok)",
  warning: "var(--warn)",
  error: "var(--error)",
  "device-lost": "var(--error)",
};

export const STATUS_LABEL: Readonly<Record<NodeRunStatus, string>> = {
  idle: "idle",
  compiling: "compiling",
  valid: "valid",
  warning: "warning",
  error: "error",
  "device-lost": "device lost",
};

/** §V42 — agent activity is chrome, not a toast: it lives on the node it is changing. */
export const AGENT_LABEL: Readonly<Record<AgentActivityKind, string>> = {
  planning: "agent planning",
  editing: "agent editing",
  compiling: "agent compiling",
  "awaiting-approval": "awaiting approval",
};

/** Approval is a decision the user owes; it reads as a warning, not as activity. */
export const AGENT_TOKEN: Readonly<Record<AgentActivityKind, string>> = {
  planning: "var(--signal)",
  editing: "var(--signal)",
  compiling: "var(--signal)",
  "awaiting-approval": "var(--warn)",
};
