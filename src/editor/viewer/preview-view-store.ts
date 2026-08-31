// v16-allow-command-bus: the bus is the per-document identity this store is keyed by; it is
// never executed against here and nothing in this file writes the document.
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { DEFAULT_PREVIEW_LENS, isDefaultLens, viewForLens } from "@runtime/previews/index.ts";
import type { PreviewLens, PreviewView } from "@runtime/previews/index.ts";
import { sharedForBus } from "@domain/commands/command-holder.ts";

/**
 * Per-node preview LENS state (T336, §V255).
 *
 * `PreviewRequest.view` has existed since T34 and every caller passed the default, so channel
 * isolation, exposure and the tonemap were a live capability with nothing able to reach them
 * (§V220, the CAPABILITY-without-UI shape). This store is the reachable half.
 *
 * ## Why this is NOT document state
 *
 * Deliberate, and the opposite call from §V116's node size. A lens changes no pixel the graph
 * produces: it is not in the plan, not in an export, not in a headless render, and a project
 * saved with green isolated on one node renders identically to one saved without it. What a
 * `.loom.json` must carry is what a renderer has to reproduce, and this is not that.
 *
 * Two consequences follow, and both are the point:
 *
 *  - it makes no undo entry. Undo is for edits, and a look is not an edit; putting an
 *    inspection act on the stack means Cmd+Z after a look undoes the look and the change the
 *    user actually wanted back is one press further down.
 *  - it does not survive a reload. That is the §V70a argument one level in: a display
 *    transform that outlives the inspection HIDES WHICH NODE IS WRONG. A lens persisted into
 *    the file is exactly that trap with a week's delay — you reopen the project, one node is
 *    green, and nothing on screen says you did that. Session-scoped state self-heals; the
 *    badge on the slot covers the same session.
 *
 * Plain and React-free, like `PreviewSlotBoundsStore` beside it: the writer is a command
 * invoked by a person (rare), and the reader is the preview tick, which samples every frame.
 */
export interface PreviewViewSource {
  /** Never undefined: an untouched node reads the default lens. */
  get(nodeId: NodeId): PreviewLens;
  /** The lens widened into the full uniform set the preview pass takes. */
  viewFor(nodeId: NodeId): PreviewView;
  /** True while nothing is being done to this node's picture. */
  isDefault(nodeId: NodeId): boolean;
  subscribe(nodeId: NodeId, listener: () => void): () => void;
}

export interface PreviewViewStore extends PreviewViewSource {
  /** Applies a partial change and returns the resolved lens. */
  set(nodeId: NodeId, patch: Partial<PreviewLens>): PreviewLens;
  reset(nodeId: NodeId): void;
}

export function createPreviewViewStore(): PreviewViewStore {
  const lenses = new Map<NodeId, PreviewLens>();
  const listeners = new Map<NodeId, Set<() => void>>();

  const notify = (nodeId: NodeId): void => {
    for (const listener of [...(listeners.get(nodeId) ?? [])]) listener();
  };

  const read = (nodeId: NodeId): PreviewLens => lenses.get(nodeId) ?? DEFAULT_PREVIEW_LENS;

  const write = (nodeId: NodeId, next: PreviewLens): PreviewLens => {
    const current = read(nodeId);
    if (
      current.lens === next.lens &&
      current.exposureStops === next.exposureStops &&
      current.tonemap === next.tonemap
    ) {
      return current;
    }
    // Back to default drops the entry rather than storing a default: `isDefault` then costs a
    // map lookup, and a long session that inspects and un-inspects hundreds of nodes leaves
    // nothing behind.
    if (isDefaultLens(next)) lenses.delete(nodeId);
    else lenses.set(nodeId, next);
    notify(nodeId);
    return next;
  };

  return {
    get: read,
    viewFor: (nodeId) => viewForLens(read(nodeId)),
    isDefault: (nodeId) => !lenses.has(nodeId),
    set: (nodeId, patch) => write(nodeId, { ...read(nodeId), ...patch }),
    reset: (nodeId) => {
      write(nodeId, DEFAULT_PREVIEW_LENS);
    },
    subscribe: (nodeId, listener) => {
      const bucket = listeners.get(nodeId) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(nodeId, bucket);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(nodeId);
      };
    },
  };
}

/**
 * ONE lens store per bus, resolved rather than prop-drilled.
 *
 * The same shape as `nodeInfoHolderFor`, and for the same reason: three surfaces need the same
 * instance — the graph pane's preview tick reads it, the node info popup writes it, the slot
 * badge watches it — and they do not share a parent close enough to hand it down without
 * threading a prop through the composition root. The bus is the per-document runtime identity
 * that all three already hold.
 */
export function previewViewStoreFor(bus: ShaderloomBus): PreviewViewStore {
  /*
   * STATE HELD: the per-node lens map (only non-default entries — a default lens is
   * stored as absence), plus one listener bucket PER NODE. The buckets are why identity
   * alone is not the property here: three surfaces subscribe per node (the preview tick,
   * the info popup, the slot badge), and a store that came back fresh would leave all
   * three subscribed to an object nothing writes to any more.
   *
   * The key is a literal rather than `SET_PREVIEW_VIEW_COMMAND`: that constant lives in
   * `preview-view-command.ts`, which imports THIS module, so naming it here would close
   * an import cycle. `#store` distinguishes it from the `#target` holder that command
   * keeps on the same bus.
   */
  return sharedForBus<PreviewViewStore>(bus, "ui.setPreviewView#store", createPreviewViewStore);
}
