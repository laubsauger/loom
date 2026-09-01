import type { NodeId } from "@domain/types/ids.ts";

/**
 * T756 — WHICH NODE THE VIEWER IS SHOWING, as preview interest.
 *
 * The viewer presents whatever the graph pane's preview requests render, so a node
 * whose tile is hidden and unpinned showed a STALE target in the viewer — a bug the
 * user cannot explain, reading as flakiness rather than a rule. The fix is
 * deliberately NOT a second request path (§V730's shape: two paths asking for the
 * same target eventually disagree and neither looks wrong alone): the viewer
 * publishes its interest HERE, and `use-node-previews` — the one request assembler —
 * treats that interest as a PIN, the mechanic that already means "keep this alive
 * while I work elsewhere" (§V28). One assembler, one policy, one more reason to pin.
 *
 * Session view state like the orbit store beside it: no bus, no document, sampled by
 * the preview tick rather than subscribed (a change is picked up next tick, which is
 * the cadence everything else here already runs at). The popped-out viewer mounts the
 * same ViewerPane and therefore publishes through the same store — the third consumer
 * stays free.
 */
export interface PreviewInterestStore {
  /** The node the viewer is currently presenting, or null. */
  get(): NodeId | null;
  set(nodeId: NodeId | null): void;
}

export function createPreviewInterestStore(): PreviewInterestStore {
  let current: NodeId | null = null;
  return {
    get: () => current,
    set(nodeId) {
      current = nodeId;
    },
  };
}
