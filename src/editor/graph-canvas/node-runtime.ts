import type { NodeId } from "@domain/types/ids.ts";
import type { PreviewOutputRef, SuspendReason } from "@runtime/previews/index.ts";

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

/**
 * §V28b classification for a node's preview slot, published by the preview system
 * (T185). Structurally identical to `NodePreviewState` (`@editor/viewer/node-preview.tsx`)
 * on purpose rather than importing it: that file is presentation for this state, and
 * importing it here would point this module at the editor surface that consumes it.
 */
export type NodePreviewRuntimeState =
  | { readonly kind: "live" }
  | { readonly kind: "suspended"; readonly reason: SuspendReason }
  | { readonly kind: "idle" }
  /** Switched off by the user (T353, §V297) — a choice, not a scheduler decision. */
  | { readonly kind: "off" };

export interface NodePreviewRuntime {
  readonly output: PreviewOutputRef;
  readonly state: NodePreviewRuntimeState;
  /**
   * Resolved size/format (§V100, T197). Present whenever the compiler resolved this
   * output, live or not — a suspended or idle slot shows this instead of going blank.
   */
  readonly facts?: { readonly width: number; readonly height: number; readonly format: string };
}

export interface NodeRuntimeSnapshot {
  status: NodeRunStatus;
  /** Last measured GPU time for this node's pass, in ms. `null` = no timing yet. */
  gpuMs: number | null;
  /**
   * §V329 — how stale an ASYNC node's published result is, in frames (T645).
   *
   * `null` for every node that is not `async-cached` (see `NODE_REPRODUCIBILITY`), and for
   * one that has not completed a readback yet. `1` is Analyze's §V144 contract holding —
   * the value visible while frame N renders reduces frame N-1; anything larger is a
   * readback that has not landed, which is the number §V329 says must not be invisible.
   *
   * Deliberately NOT structural: it changes every frame, so it rides the 100 ms metric
   * tick with `gpuMs` rather than forcing a flush (§V16).
   */
  resultAgeFrames: number | null;
  /** Highest-severity diagnostic text for this node, or null (§I.diag, §V27). */
  message: string | null;
  /** Diagnostic counts behind the node badge (§V27). */
  errorCount: number;
  warningCount: number;
  /*
   * There is no per-node `stale` here, and its absence is the decision (B36, §V269,
   * §V267).
   *
   * §V9's staleness is `program !== undefined` — the WHOLE retained program — so it is
   * true for every node at once and is not expressible per node. The field existed, no
   * publisher ever set it, and the node badge rendered a state it could never be in,
   * exactly as `renderedThisFrame` did (B17). Removing it makes the wrong program fail to
   * compile rather than quietly draw nothing; the program-level fact is stated where it is
   * asked for, in the node info popup, sourced live from backend status.
   */
  /** §V42. `null` when no agent is touching this node. */
  agent: AgentActivity | null;
  /** §V28b. `null` when this node has no preview slot at all (no texture output). */
  preview: NodePreviewRuntime | null;
}

/**
 * Shared idle value. Returned by identity so `useSyncExternalStore` sees a stable
 * snapshot for every node nobody has published anything about.
 */
export const IDLE_RUNTIME: NodeRuntimeSnapshot = Object.freeze({
  status: "idle",
  gpuMs: null,
  resultAgeFrames: null,
  message: null,
  errorCount: 0,
  warningCount: 0,
  agent: null,
  preview: null,
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

/**
 * T924/T919 — `preview` is compared BY VALUE, and that is what makes the coalescer
 * coalesce.
 *
 * The producer (`use-node-previews.ts`) walks the scheduler's result each rAF tick and
 * publishes one freshly-allocated `NodePreviewRuntime` per candidate node — active,
 * suspended, idle and off alike. That is the right shape for the producer: it has no
 * cache to compare against and §V28's suspension is a GPU policy, not a publishing one.
 * But `===` on a value that is rebuilt every tick never holds, so `publish` saw a change
 * 60 times a second, `isStructural` (below) correctly declined to flush it immediately,
 * and `scheduleFlush` then repainted every node on the 100 ms tick FOREVER with a value
 * that had not changed since the document opened.
 *
 * MEASURED against this store with 44 nodes over 3 s (`scratchpad/t919/runtime-store-churn.ts`):
 * 1320 listener calls = 10.0 re-renders per node per second, idle, versus 44 = 0.3/s once
 * the identical value stops counting as a change. Each of those renders also re-measured
 * every handle on the node (`node-view.tsx`'s `useHandleBoundsInSync`), so the whole graph
 * was doing ~1,900 forced-layout reads a second on E34-Lidar to publish nothing.
 *
 * §V16 is STRENGTHENED, not bent: the invariant caps the refresh rate at 10 Hz and keeps
 * per-frame state out of the document store. It never asked for a fresh allocation, and a
 * dedupe by identity that can never hit is a coalescer that does not coalesce. The rate
 * cap and the pulled-not-pushed shape are untouched.
 */
function samePreview(a: NodePreviewRuntime | null, b: NodePreviewRuntime | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.output.nodeId !== b.output.nodeId || a.output.portId !== b.output.portId) return false;
  if (a.state.kind !== b.state.kind) return false;
  if (
    a.state.kind === "suspended" &&
    b.state.kind === "suspended" &&
    a.state.reason !== b.state.reason
  ) {
    return false;
  }
  const af = a.facts;
  const bf = b.facts;
  if (af === undefined || bf === undefined) return af === bf;
  return af.width === bf.width && af.height === bf.height && af.format === bf.format;
}

function sameSnapshot(a: NodeRuntimeSnapshot, b: NodeRuntimeSnapshot): boolean {
  return (
    a.status === b.status &&
    a.gpuMs === b.gpuMs &&
    a.resultAgeFrames === b.resultAgeFrames &&
    a.message === b.message &&
    a.errorCount === b.errorCount &&
    a.warningCount === b.warningCount &&
    a.agent === b.agent &&
    samePreview(a.preview, b.preview)
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
      const merged: NodeRuntimeSnapshot = { ...base, ...patch };
      // Hold the OLD `preview` object when the new one says the same thing, so consumers
      // that memoise on it (the preview slot, the node info popup) see a stable reference
      // even on a tick where a number beside it did move. `samePreview` is the compare;
      // this is what makes the stability survive a mixed patch.
      const next: NodeRuntimeSnapshot =
        merged.preview !== base.preview && samePreview(base.preview, merged.preview)
          ? { ...merged, preview: base.preview }
          : merged;
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
