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

/**
 * How long the set must STOP MOVING before a change is published (T924(3), T919).
 *
 * The grace above is per-ref and one-sided; this one is about the SET, and it is what the
 * measurement asked for. T919 profiled a 5 s pan across E34-Lidar and counted **13
 * recompiles**, median 3.3 ms of `compileGraph` + `backend.compile` each, every one of them
 * also re-rendering the whole App because `useGraphCompile` is called from its root. The
 * cause is that one node crossing the viewport edge changes the set by one entry and each
 * such change is published on the spot — additions the instant they appear, removals the
 * instant their own grace expires, which during a sweep is a steady drip a second behind
 * the camera.
 *
 * So the set is published when it SETTLES rather than while it is churning: any difference
 * from what is applied re-arms a quiet window, and the change lands when nothing has moved
 * for `SETTLE_MS`. A pan therefore costs one recompile at the end of the gesture instead of
 * one per node crossing an edge, and a graph nobody is moving is unaffected — the window
 * has already elapsed by the time anything changes.
 *
 * ## Why the FIRST set is exempt, and it is not an optimisation
 *
 * Opening a document goes from no sinks at all to every visible one, and there is nothing
 * to be gained by making the whole canvas wait 200 ms to show its first picture — nothing
 * is churning, and one compile is the floor either way. Only a set that is CHANGING can be
 * settled, so the empty->first transition applies immediately.
 *
 * ## What this costs, stated rather than hidden
 *
 * A node entering the viewport mid-pan becomes a sink when the gesture stops instead of
 * within a frame or two, so its slot reads "no signal" for the rest of the pan. That is a
 * real cost and it is the reason `SETTLE_MS` is small: the picture arrives ~200 ms after
 * the user stops moving, which is the moment they can actually look at it. Nothing STALE is
 * ever shown — a ref that is already applied keeps its sink, its tile (§V455) and therefore
 * its picture right through the gesture, in both directions, so the case this could have
 * broken (pan a node off screen and back) is precisely the case that never re-enters the
 * quiet window at all.
 *
 * MEASURED IN TIME and driven by a TIMER as well as by `set()` (T620, as above): rAF stops
 * in a hidden window and the store is then called once per recompile, so a settle that only
 * resolved on the next call would hold a pending change forever — including a removal that
 * a deleted node needs in order to stop poisoning every compile.
 */
const SETTLE_MS = 200;

export function createPreviewSinkStore(
  now: () => number = () => performance.now(),
  /**
   * The quiet window, as a PARAMETER rather than a build-time switch. The app never passes
   * it — `SETTLE_MS` is the shipped number and the one the gate asserts — but T919's
   * profiling harness sweeps it to show where the recompile count actually turns, and a
   * measurement that cannot vary the thing it is measuring proves nothing about it.
   */
  settleMs: number = SETTLE_MS,
): PreviewSinkStore {
  let sinks: ReadonlyArray<ActiveSink> = [];
  /** The published set. */
  let key = "";
  /** The set the scheduler last asked for, and when it last changed. */
  let pendingKey = "";
  let pendingAt = 0;
  let pending: ReadonlyArray<ActiveSink> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const lastSeen = new Map<string, { ref: { nodeId: string; portId: string }; at: number }>();
  const listeners = new Set<() => void>();

  function cancel(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function publish(): void {
    cancel();
    if (pendingKey === key) return;
    key = pendingKey;
    sinks = pending;
    for (const listener of [...listeners]) listener();
  }

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

      if (nextKey !== pendingKey) {
        // The set moved. Whatever quiet window was running is over; a new one starts here.
        pendingKey = nextKey;
        pendingAt = at;
        pending = sorted.map((ref) => ({
          nodeId: ref.nodeId,
          portId: ref.portId,
          kind: "preview" as const,
        }));
        cancel();
      }
      if (nextKey === key) {
        // What was pending came back to what is published — a node that left the viewport
        // and returned inside its own grace. Nothing to settle, nothing to recompile.
        cancel();
        return;
      }
      // Opening a document: there is no churn to wait out and no picture to protect.
      // Otherwise, the window is read off the store's OWN clock as well as off the timer,
      // so a caller driving it faster or slower than wall time (an offline render, a test,
      // a profiling harness) settles on the clock it was given rather than on `setTimeout`.
      if (key === "" || at - pendingAt >= settleMs) {
        publish();
        return;
      }
      if (timer === null) timer = setTimeout(publish, settleMs);
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
