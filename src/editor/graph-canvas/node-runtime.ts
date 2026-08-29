import type { NodeId } from "@domain/types/ids.ts";

/**
 * Per-node runtime state for the graph view — status, per-pass GPU time, agent
 * activity (§V16, §V42, T18, T19).
 *
 * This is deliberately NOT part of the document store. Per-frame metrics and preview
 * pixels may never enter the domain graph or re-render the whole node tree (§V16), so
 * the compiler / backend / telemetry tracks publish here instead, each node component
 * subscribes to its own id only, and metric updates are coalesced to <= 10 Hz.
 *
 * Track F owns the consumer side. The producer side (real per-pass timestamp spans) is
 * T41/T42; until it lands, `gpuMs` is simply `null` everywhere and the edges degrade to
 * static hairlines, which is exactly the "idle pass" reading (§C signature element).
 */

/** Node lifecycle as the user sees it (doc §17.2). */
export type NodeRunStatus =
  | "idle"
  | "compiling"
  | "valid"
  | "warning"
  | "error"
  | "device-lost";

/** §V42 — agent work is never invisible; these are the states the chrome must show. */
export type AgentActivityKind = "planning" | "editing" | "compiling" | "awaiting-approval";

export interface AgentActivity {
  kind: AgentActivityKind;
  /** Who is acting. `InvocationContext.actor.label ?? actor.id` (§V30). */
  actorLabel: string;
  /** One short line: what it is doing, or what it is waiting for approval on. */
  detail?: string;
}

export interface NodeRuntimeSnapshot {
  status: NodeRunStatus;
  /** Last measured GPU time for this node's pass, in ms. `null` = no timing yet. */
  gpuMs: number | null;
  /** Highest-severity diagnostic text for this node, or null (§I.diag, §V27). */
  message: string | null;
  /** Diagnostic counts behind the node badge (§V27). */
  errorCount: number;
  warningCount: number;
  /** The displayed output came from the last valid plan, not the current edit (§V9). */
  stale: boolean;
  /** §V42. `null` when no agent is touching this node. */
  agent: AgentActivity | null;
}

/**
 * Shared idle value. Returned by identity so `useSyncExternalStore` sees a stable
 * snapshot for every node nobody has published anything about.
 */
export const IDLE_RUNTIME: NodeRuntimeSnapshot = Object.freeze({
  status: "idle",
  gpuMs: null,
  message: null,
  errorCount: 0,
  warningCount: 0,
  stale: false,
  agent: null,
});

/** Read side, which is all a node or an edge component needs. */
export interface NodeRuntimeSource {
  get(nodeId: NodeId): NodeRuntimeSnapshot;
  subscribe(nodeId: NodeId, listener: () => void): () => void;
}

export interface NodeRuntimeStore extends NodeRuntimeSource {
  /** Merge a partial update. Producers call this; nothing else may. */
  publish(nodeId: NodeId, patch: Partial<NodeRuntimeSnapshot>): void;
  /** Forget a node (deleted from the graph). */
  clear(nodeId: NodeId): void;
  /** Drop every pending flush. Call on unmount. */
  dispose(): void;
}

/** §V16 — "UI metric refresh <= 10 Hz". 100 ms is the cap, not a target. */
export const METRIC_TICK_MS = 100;

export interface NodeRuntimeStoreOptions {
  /** Minimum gap between metric-driven notifications, ms. */
  intervalMs?: number;
  now?: () => number;
}

function sameSnapshot(a: NodeRuntimeSnapshot, b: NodeRuntimeSnapshot): boolean {
  return (
    a.status === b.status &&
    a.gpuMs === b.gpuMs &&
    a.message === b.message &&
    a.errorCount === b.errorCount &&
    a.warningCount === b.warningCount &&
    a.stale === b.stale &&
    a.agent === b.agent
  );
}

/**
 * A snapshot changes *structurally* when something the user must see immediately moved:
 * an error appearing, a compile starting, an agent taking the node. Rate-limiting those
 * behind a 100 ms metric tick would be reading §V16 backwards — the invariant caps how
 * often numbers repaint, it does not ask us to sit on an error for a tenth of a second.
 */
function isStructural(previous: NodeRuntimeSnapshot, next: NodeRuntimeSnapshot): boolean {
  return (
    previous.status !== next.status ||
    previous.message !== next.message ||
    previous.errorCount !== next.errorCount ||
    previous.warningCount !== next.warningCount ||
    previous.stale !== next.stale ||
    previous.agent !== next.agent
  );
}

export function createNodeRuntimeStore(options: NodeRuntimeStoreOptions = {}): NodeRuntimeStore {
  const intervalMs = options.intervalMs ?? METRIC_TICK_MS;
  const now = options.now ?? (() => Date.now());

  const current = new Map<NodeId, NodeRuntimeSnapshot>();
  const pending = new Map<NodeId, NodeRuntimeSnapshot>();
  const listeners = new Map<NodeId, Set<() => void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;

  function notify(nodeId: NodeId): void {
    const set = listeners.get(nodeId);
    if (set === undefined) return;
    for (const listener of [...set]) listener();
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastFlush = now();
    if (pending.size === 0) return;
    const flushed = [...pending.entries()];
    pending.clear();
    for (const [nodeId, snapshot] of flushed) {
      current.set(nodeId, snapshot);
      notify(nodeId);
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    const wait = Math.max(0, intervalMs - (now() - lastFlush));
    timer = setTimeout(flush, wait);
  }

  return {
    get(nodeId: NodeId): NodeRuntimeSnapshot {
      return current.get(nodeId) ?? IDLE_RUNTIME;
    },

    subscribe(nodeId: NodeId, listener: () => void): () => void {
      let set = listeners.get(nodeId);
      if (set === undefined) {
        set = new Set();
        listeners.set(nodeId, set);
      }
      set.add(listener);
      return () => {
        const existing = listeners.get(nodeId);
        if (existing === undefined) return;
        existing.delete(listener);
        if (existing.size === 0) listeners.delete(nodeId);
      };
    },

    publish(nodeId: NodeId, patch: Partial<NodeRuntimeSnapshot>): void {
      const base = pending.get(nodeId) ?? current.get(nodeId) ?? IDLE_RUNTIME;
      const next: NodeRuntimeSnapshot = { ...base, ...patch };
      if (sameSnapshot(base, next)) return;
      pending.set(nodeId, next);
      const visible = current.get(nodeId) ?? IDLE_RUNTIME;
      if (isStructural(visible, next)) flush();
      else scheduleFlush();
    },

    clear(nodeId: NodeId): void {
      pending.delete(nodeId);
      if (current.delete(nodeId)) notify(nodeId);
    },

    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
