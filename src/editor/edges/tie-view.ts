import type { GraphTie } from "@domain/types/graph.ts";
import type { TieId } from "@domain/types/ids.ts";

/**
 * Where each wire tie is DRAWN (T1821b): the document's positions, and the one tie in the
 * hand while it is dragged.
 *
 * A drag writes nothing to the document until it is let go (§V15: gestures commit, frames
 * do not), but every wire through the tie has to follow the pointer. So the wires read
 * their ties' positions here rather than off the document, and this store answers with
 * the drag position for the tie in the hand. The canvas feeds it the document's ties on
 * every structural revision; the tie layer feeds it the drag.
 *
 * Not React state, for `edge-geometry.ts`'s reason: it changes at pointer rate and only
 * the wires through ONE tie need to repaint. Each wire subscribes with `routeKey` of its
 * own route, so a drag repaints the wires through the dragged tie and nothing else (§V16).
 */

export interface TiePoint {
  readonly x: number;
  readonly y: number;
}

export interface TieDrag {
  readonly tieId: TieId;
  readonly position: TiePoint;
}

export interface TieView {
  /** The document's ties, as the canvas last projected them. */
  setDocument(ties: Readonly<Record<TieId, GraphTie>> | undefined): void;
  /** The tie in the hand, drawn at `position` until the drag ends; `null` ends it now. */
  setDrag(drag: TieDrag | null): void;
  /**
   * The drag is over and its patch is on its way: keep drawing the tie where it was let go
   * until the document says so too, so the wires do not flash back for a frame. Cleared by
   * the next `setDocument` that moves or removes the tie, or by `setDrag(null)`.
   */
  release(): void;
  drag(): TieDrag | null;
  /** Where a tie is drawn: the drag's position for the tie in the hand, else the document's. */
  position(tieId: TieId): TiePoint | undefined;
  /** Every tie, at the position it is drawn at, sorted by id. */
  all(): ReadonlyArray<{ readonly id: TieId; readonly position: TiePoint }>;
  /** A string that changes exactly when a point of this route moves: a wire's snapshot. */
  routeKey(via: readonly TieId[] | undefined): string;
  subscribe(listener: () => void): () => void;
  /** Bumped on every change: the tie layer's snapshot. */
  version(): number;
}

const NO_TIES: Readonly<Record<TieId, GraphTie>> = Object.freeze({});

export function createTieView(): TieView {
  let document: Readonly<Record<TieId, GraphTie>> = NO_TIES;
  let drag: TieDrag | null = null;
  let released = false;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const position = (tieId: TieId): TiePoint | undefined =>
    drag !== null && drag.tieId === tieId ? drag.position : document[tieId]?.position;

  return {
    setDocument(ties) {
      const next = ties ?? NO_TIES;
      if (next === document) return;
      document = next;
      if (released && drag !== null) {
        const landed = document[drag.tieId];
        if (landed === undefined || (landed.position.x === drag.position.x && landed.position.y === drag.position.y)) {
          drag = null;
          released = false;
        }
      }
      notify();
    },
    setDrag(next) {
      drag = next;
      released = false;
      notify();
    },
    release() {
      released = true;
    },
    drag: () => drag,
    position,
    all() {
      const ids = Object.keys(document).sort();
      return ids.flatMap((id) => {
        const at = position(id);
        return at === undefined ? [] : [{ id, position: at }];
      });
    },
    routeKey(via) {
      if (via === undefined || via.length === 0) return "";
      return via
        .map((tieId) => {
          const at = position(tieId);
          return at === undefined ? "-" : `${at.x},${at.y}`;
        })
        .join(";");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}
