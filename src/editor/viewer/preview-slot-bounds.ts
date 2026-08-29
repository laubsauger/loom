import type { NodeId } from "@domain/types/ids.ts";
import type { SlotBox } from "@runtime/previews/index.ts";

/**
 * Each node's preview slot, as an offset + size WITHIN ITS OWN NODE (design note §3;
 * §V111, §V112).
 *
 * Deliberately NOT an absolute graph-space or screen rect: `NodePreviewSlot` measures
 * the slot relative to its node's own `.react-flow__node` wrapper once on mount and
 * again whenever it resizes, which is why the value survives an uncommitted drag with
 * no re-measurement — the offset within the node does not change while the node moves,
 * only its absolute position does, and that is read LIVE from React Flow (never the
 * document, which lags for the whole drag) by whoever adds it back on, every tick, in
 * `use-node-previews.ts`. The composition root's rAF tick reads this store to build
 * that. Plain — no React, no coalescing — because both sides already rate-limit
 * themselves: a `ResizeObserver` on the write side, one tick on the read side.
 */
export interface PreviewSlotBoundsStore {
  publish(nodeId: NodeId, box: SlotBox): void;
  clear(nodeId: NodeId): void;
  get(nodeId: NodeId): SlotBox | undefined;
}

export function createPreviewSlotBounds(): PreviewSlotBoundsStore {
  const boxes = new Map<NodeId, SlotBox>();
  return {
    publish(nodeId, box) {
      boxes.set(nodeId, box);
    },
    clear(nodeId) {
      boxes.delete(nodeId);
    },
    get(nodeId) {
      return boxes.get(nodeId);
    },
  };
}
