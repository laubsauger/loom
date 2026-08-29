import { useSyncExternalStore } from "react";

import type { AgentPresenceSnapshot, AgentPresenceView } from "@agent/index.ts";

/**
 * Subscribes the UI to agent presence (§V42, T60).
 *
 * The store is headless and lives in `src/agent`; this is the only place React learns
 * about it. `useSyncExternalStore` rather than an effect + state because presence changes
 * inside a tool call — a tearing read here would show "idle" while an edit is in flight,
 * which is exactly the invisible mutation §V42 forbids.
 */
export function useAgentPresence(presence: AgentPresenceView): AgentPresenceSnapshot {
  return useSyncExternalStore(
    (listener) => presence.subscribe(listener),
    () => presence.snapshot(),
    () => presence.snapshot(),
  );
}
