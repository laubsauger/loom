import type { NodeId } from "@domain/types/ids.ts";
import { DEFAULT_PREVIEW_ORBIT } from "@runtime/previews/index.ts";
import type { PreviewOrbit } from "@runtime/previews/index.ts";

/**
 * Per-node inspection ORBIT state (T561) — one store per mounted pane, like
 * `PreviewSlotBoundsStore` beside it: the slot's drag writes it, the pane's preview
 * tick samples it every frame. Panes are separate React instances, so two panes
 * showing the same node hold two independent cameras with no paneKey plumbing.
 *
 * Deliberately NOT document state, for §V255's reasons one more time: an orbit changes
 * no pixel the graph produces — not in the plan, not in an export, not in a headless
 * render. It makes no undo entry and does not survive a reload; session-scoped view
 * state self-heals, and a viewpoint persisted into the file would misrepresent the
 * stock framing everyone else opens to. The owner's framing IS the contract: "3d stuff
 * needs 3d inspection without screwing with its data".
 *
 * No subscribe: nothing re-renders on an orbit change — the preview tick samples per
 * frame (§V16), and the picture updating IS the feedback.
 */
export interface PreviewOrbitStore {
  /** Undefined for an untouched node — the request then omits `orbit` entirely. */
  get(nodeId: NodeId): PreviewOrbit | undefined;
  /** Accumulates drag deltas; range clamping lives in `orbitEye`, once. */
  apply(nodeId: NodeId, delta: { azimuth: number; elevation: number }): void;
  reset(nodeId: NodeId): void;
}

export function createPreviewOrbitStore(): PreviewOrbitStore {
  const orbits = new Map<NodeId, PreviewOrbit>();
  return {
    get: (nodeId) => orbits.get(nodeId),
    apply(nodeId, delta) {
      const current = orbits.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT;
      orbits.set(nodeId, {
        azimuth: current.azimuth + delta.azimuth,
        elevation: current.elevation + delta.elevation,
        distance: current.distance,
      });
    },
    reset(nodeId) {
      orbits.delete(nodeId);
    },
  };
}
