import type { NodeId } from "@domain/types/ids.ts";
import { clampOrbitDistance, clampOrbitPan, DEFAULT_PREVIEW_ORBIT } from "@runtime/previews/index.ts";
import type { PreviewOrbit } from "@runtime/previews/index.ts";

/**
 * Per-node preview INSPECTION state (T561, T656) — one store per mounted pane, like
 * `PreviewSlotBoundsStore` beside it: the slot's gestures write it, the pane's preview
 * tick samples it every frame. Panes are separate React instances, so two panes showing
 * the same node hold two independent cameras with no paneKey plumbing.
 *
 * Deliberately NOT document state, for §V255's reasons one more time: an orbit changes
 * no pixel the graph produces — not in the plan, not in an export, not in a headless
 * render. It makes no undo entry and does not survive a reload; session-scoped view
 * state self-heals, and a viewpoint persisted into the file would misrepresent the
 * stock framing everyone else opens to. The owner's framing IS the contract: "3d stuff
 * needs 3d inspection without screwing with its data".
 *
 * §V527, and this is the whole design: the store holds NO BUS, so "never document
 * state" is not a rule anyone has to remember — it is unreachable. `no-document-store.
 * test.ts` scans this directory and fails on the import, so the property survives an
 * author who never read this comment.
 *
 * T656 — the MODE lives here too, and it lives here on purpose. The owner asked for a
 * preview that toggles between its default HOME framing and an ADJUSTABLE one, and said
 * "we can turn that off again": turning it off IS the reset. Keeping the mode in the
 * same store makes that ONE operation — `setMode(node, "home")` drops the orbit in the
 * same statement — so the toggle and the reset cannot drift apart into two behaviours
 * that disagree. The gesture writers are gated on the mode HERE rather than in the
 * component for the same reason: home mode is inert by construction, not by whoever
 * remembers to check a prop.
 */
export type PreviewInspectMode = "home" | "adjustable";

export interface PreviewOrbitStore {
  /** Undefined for an untouched node — the request then omits `orbit` entirely. */
  get(nodeId: NodeId): PreviewOrbit | undefined;
  /** HOME unless this pane's user has turned this preview's inspection on (T656). */
  mode(nodeId: NodeId): PreviewInspectMode;
  /**
   * Enter or leave adjustable mode. Leaving RETURNS HOME in every sense: the stored
   * orbit goes with it, so the tile is back on the compiler's baked framing (§V528's
   * identity short-circuit returns the baked eye, float for float).
   */
  setMode(nodeId: NodeId, mode: PreviewInspectMode): void;
  /**
   * The toggle is the affordance AND the indicator (T613), so unlike the orbit itself
   * the mode has to re-render something. Per-node slice, like the lens store's.
   */
  subscribe(nodeId: NodeId, listener: () => void): () => void;
  /** Accumulates orbit and pan deltas. Inert in home mode. */
  apply(nodeId: NodeId, delta: { azimuth?: number; elevation?: number; panX?: number; panY?: number }): void;
  /**
   * T656 — the wheel. Multiplies T561's EXISTING `distance` delta rather than opening a
   * second distance path: same field, same clamp, same `orbitPose`. Clamped on write as
   * well as on read because an unclamped accumulator produces a dead zone — twenty
   * scrolls out then one scroll in would move nothing for nineteen of them.
   */
  zoom(nodeId: NodeId, factor: number): void;
  reset(nodeId: NodeId): void;
  /**
   * T379 — home to MEASURED CONTENT: enter adjustable with a content frame under zero
   * deltas, so the camera looks at what the points actually are instead of the baked
   * constants (which are tuned on unit scenes and strand the user off-screen on every
   * other one). Optional because the camera-GIZMO store writes a document camera and
   * has no stock basis to re-frame.
   */
  frameContent?(nodeId: NodeId, frame: { lookAt: readonly [number, number, number]; radius: number }): void;
  /**
   * T692: the end of a pointer gesture. The INSPECTION store has no use for it — view
   * state needs no commit — but the camera GIZMO store closes its undo transaction
   * here, so one drag is one undo step. Optional so this store stays untouched.
   */
  release?(nodeId: NodeId): void;
}

export function createPreviewOrbitStore(): PreviewOrbitStore {
  const orbits = new Map<NodeId, PreviewOrbit>();
  const modes = new Map<NodeId, PreviewInspectMode>();
  const listeners = new Map<NodeId, Set<() => void>>();

  const mode = (nodeId: NodeId): PreviewInspectMode => modes.get(nodeId) ?? "home";
  /** Every write goes through here, so nothing can move the camera while home. */
  const write = (nodeId: NodeId, next: (current: PreviewOrbit) => PreviewOrbit): void => {
    if (mode(nodeId) !== "adjustable") return;
    orbits.set(nodeId, next(orbits.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT));
  };

  return {
    get: (nodeId) => orbits.get(nodeId),
    mode,
    setMode(nodeId, next) {
      if (mode(nodeId) === next) return;
      if (next === "home") {
        modes.delete(nodeId);
        // Leaving adjustable IS the reset — one statement, so the two cannot drift.
        orbits.delete(nodeId);
      } else {
        modes.set(nodeId, next);
      }
      for (const listener of listeners.get(nodeId) ?? []) listener();
    },
    subscribe(nodeId, listener) {
      const set = listeners.get(nodeId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(nodeId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(nodeId);
      };
    },
    apply(nodeId, delta) {
      write(nodeId, (current) => ({
        azimuth: current.azimuth + (delta.azimuth ?? 0),
        elevation: current.elevation + (delta.elevation ?? 0),
        distance: current.distance,
        panX: clampOrbitPan(current.panX + (delta.panX ?? 0)),
        panY: clampOrbitPan(current.panY + (delta.panY ?? 0)),
        // T379: the content frame rides under the deltas — a drag after framing must
        // orbit the content, not silently snap back to the baked constants.
        ...(current.frame === undefined ? {} : { frame: current.frame }),
      }));
    },
    zoom(nodeId, factor) {
      write(nodeId, (current) => ({
        ...current,
        distance: clampOrbitDistance(current.distance * factor),
      }));
    },
    reset(nodeId) {
      orbits.delete(nodeId);
    },
    frameContent(nodeId, frame) {
      // Entering adjustable and setting the frame is ONE operation, like setMode's
      // reset: a frame the mode gate swallowed would be a button that lies.
      if (mode(nodeId) !== "adjustable") {
        modes.set(nodeId, "adjustable");
        for (const listener of listeners.get(nodeId) ?? []) listener();
      }
      orbits.set(nodeId, { ...DEFAULT_PREVIEW_ORBIT, frame });
    },
  };
}
