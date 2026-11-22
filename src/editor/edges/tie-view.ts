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
 *
 * T1821b(c) — it also holds which ties are SELECTED. A box selection takes the ties it
 * touches as well as the nodes, as Houdini's takes network dots, and dragging the selected
 * nodes carries the selected ties with them: drawn moved by the drag's offset (`carry`)
 * while it is in flight, written as one `moveTies` beside the `moveNodes` at release. Like
 * the node selection it is view state, never the document's.
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
  /** T1821b(c): the selected ties — what a box selection took, until the selection changes. */
  selection(): ReadonlySet<TieId>;
  /** Replaces the selection. An id the document does not hold is dropped. */
  select(tieIds: Iterable<TieId>): void;
  /**
   * While the selected nodes are dragged, every selected tie is drawn moved by `offset`;
   * `null` ends it now.
   */
  carry(offset: TiePoint | null): void;
  /** The carry is over and its patch is on its way: it is drawn until the next document. */
  releaseCarry(): void;
  /**
   * Where a tie is drawn: the drag's position for the tie in the hand, the document's moved
   * by the carry for a selected one, else the document's.
   */
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
  let selected: ReadonlySet<TieId> = new Set();
  let carried: TiePoint | null = null;
  let carryReleased = false;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const position = (tieId: TieId): TiePoint | undefined => {
    if (drag !== null && drag.tieId === tieId) return drag.position;
    const at = document[tieId]?.position;
    if (at === undefined || carried === null || !selected.has(tieId)) return at;
    return { x: at.x + carried.x, y: at.y + carried.y };
  };

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
      // The selected nodes' patch has landed (or something else moved the ties): the
      // document says where they are now.
      if (carryReleased) {
        carried = null;
        carryReleased = false;
      }
      if ([...selected].some((tieId) => document[tieId] === undefined)) {
        selected = new Set([...selected].filter((tieId) => document[tieId] !== undefined));
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
    selection: () => selected,
    select(tieIds) {
      const next = new Set([...tieIds].filter((tieId) => document[tieId] !== undefined));
      if (next.size === selected.size && [...next].every((tieId) => selected.has(tieId))) return;
      selected = next;
      notify();
    },
    carry(offset) {
      if (offset === null && carried === null) return;
      carried = offset;
      carryReleased = false;
      notify();
    },
    releaseCarry() {
      carryReleased = true;
    },
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

/**
 * T1821b(c) — the ties a box selection takes: those whose dot, `margin` round its centre,
 * the box in graph space touches, as a box takes a node it crosses. Sorted by id.
 */
export function tiesTouching(
  view: Pick<TieView, "all">,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  margin: number,
): TieId[] {
  const left = Math.min(box.x, box.x + box.width) - margin;
  const right = Math.max(box.x, box.x + box.width) + margin;
  const top = Math.min(box.y, box.y + box.height) - margin;
  const bottom = Math.max(box.y, box.y + box.height) + margin;
  return view
    .all()
    .filter((tie) => tie.position.x >= left && tie.position.x <= right && tie.position.y >= top && tie.position.y <= bottom)
    .map((tie) => tie.id);
}
