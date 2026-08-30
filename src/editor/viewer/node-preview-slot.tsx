import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useReactFlow } from "@xyflow/react";
import type { NodeId } from "@domain/types/ids.ts";
import { useNodeRuntime } from "@editor/graph-canvas/index.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { DEFAULT_PREVIEW_LENS } from "@runtime/previews/index.ts";
import { NodePreview } from "./node-preview.tsx";
import type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";
import type { PreviewViewSource } from "./preview-view-store.ts";

/**
 * The composition root's `renderPreview` implementation for one node (T185).
 *
 * `NodeView` (`src/editor/nodes/`) knows nothing about the preview system — it only
 * calls `renderPreview(nodeId)` and renders whatever comes back — so this is where that
 * indirection is filled in. Two jobs, both per-node:
 *
 *  - measure this slot's offset and size WITHIN ITS OWN NODE, once on mount and again on
 *    resize, and publish that (§V111: never the slot's absolute screen rect, and never
 *    on a per-frame tick — that is the forced-layout-during-pan mistake design note §2
 *    warns about, and `slotScreenRect` exists so nobody has to). The offset is relative
 *    to `.react-flow__node`, react-flow's own wrapper, which moves with the node during
 *    an uncommitted drag — so the offset itself needs no re-measurement while dragging,
 *    only the LIVE node position added on top of it does (§V112, done by the reader in
 *    `use-node-previews.ts`, never here);
 *  - show whatever the preview scheduler most recently classified this node as, via its
 *    own slice of the runtime channel (§V16) — only this node repaints when its own
 *    preview state changes, exactly like `NodeView` itself.
 */
export interface NodePreviewSlotProps {
  nodeId: NodeId;
  runtime: NodeRuntimeSource;
  bounds: PreviewSlotBoundsStore;
  /**
   * The lens store (T336). Optional so a caller that wants a plain slot — a test, an
   * embedding — is not forced to wire one; absent means every preview is the plain picture.
   */
  views?: PreviewViewSource | undefined;
}

export function NodePreviewSlot({ nodeId, runtime, bounds, views }: NodePreviewSlotProps) {
  const flow = useReactFlow();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const measure = (): void => {
      const nodeElement = element.closest(".react-flow__node");
      if (nodeElement === null) return;
      const slotRect = element.getBoundingClientRect();
      const nodeRect = nodeElement.getBoundingClientRect();
      const zoom = flow.getViewport().zoom;
      if (!(zoom > 0) || slotRect.width <= 0 || slotRect.height <= 0) return;
      // A rect DELTA between two elements measured at the same instant cancels pan
      // entirely, so only zoom converts screen px to the node's own local (graph-space)
      // px — this offset stays correct at any pan and needs no re-measurement for one.
      bounds.publish(nodeId, {
        x: (slotRect.left - nodeRect.left) / zoom,
        y: (slotRect.top - nodeRect.top) / zoom,
        width: slotRect.width / zoom,
        height: slotRect.height / zoom,
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      bounds.clear(nodeId);
    };
  }, [bounds, flow, nodeId]);

  const snapshot = useNodeRuntime(runtime, nodeId);
  const preview = snapshot.preview;

  // Its own slice, like the runtime channel above: setting a lens on one node repaints that
  // node's slot and nothing else, and the store only notifies when a lens actually changed.
  const readLens = useCallback(
    () => (views === undefined ? DEFAULT_PREVIEW_LENS : views.get(nodeId)),
    [views, nodeId],
  );
  const lens = useSyncExternalStore(
    useCallback(
      (listener: () => void) => views?.subscribe(nodeId, listener) ?? (() => {}),
      [views, nodeId],
    ),
    readLens,
    readLens,
  );

  return (
    <div ref={ref} style={{ width: "100%", height: "100%" }}>
      {preview === null ? (
        /**
         * §V303 — a slot with nothing published still has to COVER.
         *
         * The live slot is a hole through the node chrome and the shared surface
         * composites the tile behind it; a canvas keeps its last presented pixels, so an
         * empty `<div>` here is a window onto whatever was drawn in that spot last. That
         * is the "shown anyway, just not updating" report: a frozen picture that reads as
         * a live one. `NodePreview`'s opaque background is the cover, and the ONLY
         * transparent case is `live`, so the rule holds with no exceptions.
         */
        <NodePreview output={{ nodeId, portId: "" }} state={{ kind: "idle" }} lens={lens} />
      ) : (
        <NodePreview
          output={preview.output}
          state={preview.state}
          facts={preview.facts}
          lens={lens}
        />
      )}
    </div>
  );
}
