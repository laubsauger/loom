import type { ActiveSink } from "../compiler/types.ts";

/**
 * The live preview-sink set (T252, §V158, B18).
 *
 * `visiblePreviewSinks` used to declare EVERY texture node a preview sink, so every
 * node in the document was materialized and rendered every frame whether anyone could
 * see it or not — B18, and the single largest source of avoidable per-frame work. The
 * partition (§V158): OUTPUT-REACHABLE nodes are never gated — the declared sinks keep
 * them, and an offline render (which has no previews at all) can therefore only
 * under-render, never over. PREVIEW-ONLY nodes are gated by what the preview scheduler
 * actually keeps: on screen or pinned, within the tile budget.
 *
 * The store is a one-value observable so the compile hook can react: the scheduler
 * publishes its kept set each tick, the store notifies ONLY when the set genuinely
 * changed (sorted-key comparison — pans and re-ticks are free), and a change triggers
 * one recompile whose plan materializes exactly what is watched.
 */

export interface PreviewSinkStore {
  /** The scheduler's kept set, replaced wholesale each tick. Cheap when unchanged. */
  set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void;
  get(): ReadonlyArray<ActiveSink>;
  subscribe(listener: () => void): () => void;
}

/**
 * How long a ref may be ABSENT before it leaves the sink set.
 *
 * §V142 vs §V158, reconciled: additions apply immediately (an entering tile must
 * materialize to show anything), but removals wait — a pan that sweeps a node off
 * screen and back must not recompile twice mid-gesture. A second of grace; a node that
 * genuinely left recompiles ONCE, and that compile only releases (T143 carry), never
 * allocates.
 *
 * MEASURED IN TIME, not in `set()` calls (T620). The grace used to be 60 calls, written
 * when every call was one rAF tick. Chrome suspends rAF entirely for a hidden or
 * occluded window, and there the store is driven only by the per-plan resync — one call
 * per recompile — so "60 ticks ≈ a second" silently became "60 recompiles ≈ forever",
 * and a deleted node's sink poisoned every compile (`sink-unknown`) for the rest of the
 * session. A clock does not stop when rAF does.
 */
const REMOVAL_GRACE_MS = 1000;

export function createPreviewSinkStore(
  now: () => number = () => performance.now(),
): PreviewSinkStore {
  let sinks: ReadonlyArray<ActiveSink> = [];
  let key = "";
  const lastSeen = new Map<string, { ref: { nodeId: string; portId: string }; at: number }>();
  const listeners = new Set<() => void>();

  return {
    set(refs) {
      const at = now();
      for (const ref of refs) {
        lastSeen.set(`${ref.nodeId}:${ref.portId}`, { ref, at });
      }
      for (const [seenKey, entry] of lastSeen) {
        if (at - entry.at > REMOVAL_GRACE_MS) lastSeen.delete(seenKey);
      }
      const sorted = [...lastSeen.values()]
        .map((entry) => entry.ref)
        .sort((a, b) => `${a.nodeId}:${a.portId}`.localeCompare(`${b.nodeId}:${b.portId}`));
      const nextKey = sorted.map((ref) => `${ref.nodeId}:${ref.portId}`).join("|");
      if (nextKey === key) return;
      key = nextKey;
      sinks = sorted.map((ref) => ({ nodeId: ref.nodeId, portId: ref.portId, kind: "preview" as const }));
      for (const listener of [...listeners]) listener();
    },
    get: () => sinks,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
