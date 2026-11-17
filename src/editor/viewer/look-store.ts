import type { ActiveSink } from "@compiler/types.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { isDefaultOrbit } from "@runtime/previews/index.ts";
import { createPreviewOrbitStore, type PreviewOrbitStore } from "./preview-orbit-store.ts";

/**
 * §T1732b — THE LOOKS: an inspection orbit around a picture drawn through a camera node.
 *
 * A look is view state exactly as a geometry tile's orbit is (T561): per document, never a
 * revision, never in a file, and it never touches the camera. What differs is where it lands.
 * A geometry tile's orbit is a uniform on a synthesized preview; a Render's picture is the
 * Render's own passes, so a look asks the compiler to draw the Render again through the moved
 * camera (`compiler/look.ts`). The ask is a `look` sink, and this store is where those come
 * from: one per renderer whose look is moved off its camera, read by the compile with the
 * preview sinks.
 *
 * Keyed by the RENDERER's flat id, so a Render's tile, the tile of the camera that borrows its
 * picture (T546) and the viewer showing either all share one look: they show one picture.
 *
 * A look that has not moved asks for nothing. Arming it (the corner toggle, alt over the
 * tile) costs no compile; the first drag adds the sink, and going home removes it.
 */
export interface LookStore extends PreviewOrbitStore {
  /** One `look` sink per renderer whose look is off its camera, sorted. Stable until that set changes. */
  get sinks(): readonly ActiveSink[];
  subscribeSinks(listener: () => void): () => void;
}

const NONE: readonly ActiveSink[] = [];

export function createLookStore(): LookStore {
  const orbits = createPreviewOrbitStore();
  const looking = new Set<NodeId>();
  /** One sink object per renderer, kept: its `orbit` reads this store at every frame. */
  const made = new Map<NodeId, ActiveSink>();
  let sinks: readonly ActiveSink[] = NONE;
  const listeners = new Set<() => void>();

  const sync = (nodeId: NodeId): void => {
    const orbit = orbits.get(nodeId);
    const now = orbits.mode(nodeId) === "adjustable" && orbit !== undefined && !isDefaultOrbit(orbit);
    if (now === looking.has(nodeId)) return;
    if (now) looking.add(nodeId);
    else looking.delete(nodeId);
    sinks =
      looking.size === 0
        ? NONE
        : [...looking].sort().map((id) => {
            let sink = made.get(id);
            if (sink === undefined) {
              sink = { nodeId: id, kind: "look", orbit: () => orbits.get(id) };
              made.set(id, sink);
            }
            return sink;
          });
    for (const listener of listeners) listener();
  };
  const after =
    <A extends unknown[]>(write: (nodeId: NodeId, ...rest: A) => void) =>
    (nodeId: NodeId, ...rest: A): void => {
      write(nodeId, ...rest);
      sync(nodeId);
    };

  return {
    get: orbits.get,
    mode: orbits.mode,
    subscribe: orbits.subscribe,
    setMode: after(orbits.setMode),
    apply: after(orbits.apply),
    zoom: after(orbits.zoom),
    fly: after((nodeId: NodeId, delta: readonly [number, number, number]) => orbits.fly?.(nodeId, delta)),
    reset: after(orbits.reset),
    get sinks() {
      return sinks;
    },
    subscribeSinks(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A store read under another key: a tile's id becomes the renderer or the camera it answers to. */
export function rekeyedOrbitStore(store: PreviewOrbitStore, key: (nodeId: NodeId) => NodeId): PreviewOrbitStore {
  return {
    get: (nodeId) => store.get(key(nodeId)),
    mode: (nodeId) => store.mode(key(nodeId)),
    setMode: (nodeId, mode) => {
      store.setMode(key(nodeId), mode);
    },
    subscribe: (nodeId, listener) => store.subscribe(key(nodeId), listener),
    apply: (nodeId, delta) => {
      store.apply(key(nodeId), delta);
    },
    zoom: (nodeId, factor) => {
      store.zoom(key(nodeId), factor);
    },
    ...(store.fly === undefined ? {} : { fly: (nodeId: NodeId, delta: readonly [number, number, number]) => store.fly?.(key(nodeId), delta) }),
    ...(store.pose === undefined ? {} : { pose: (nodeId: NodeId) => store.pose?.(key(nodeId)) ?? null }),
    reset: (nodeId) => {
      store.reset(key(nodeId));
    },
    ...(store.release === undefined ? {} : { release: (nodeId: NodeId) => store.release?.(key(nodeId)) }),
  };
}

/** Which camera a picture's gestures move: a look (view only) or the camera itself (an edit). */
export type PictureCamera = "look" | "move";

/**
 * §T1732b — ONE PICTURE, TWO CAMERAS: LOOK (the default, never an edit) and MOVE (the camera
 * node's own pose, T692/T970, every gesture an edit that undo steps back).
 *
 * The tile's gestures and the viewer's take ONE store, so this is that store: it routes each
 * gesture to whichever of the two is armed. Anything that arms a camera without saying which
 * (alt over the tile, the first drag in the viewer) arms the LOOK, because a gesture that
 * edits the document must be asked for by name. Arming one disarms the other, and the look
 * goes home with it, so a camera being moved is seen through itself.
 */
export interface LookMoveStore extends PreviewOrbitStore {
  armed(nodeId: NodeId): PictureCamera | null;
  arm(nodeId: NodeId, which: PictureCamera | null): void;
  /** The node MOVE edits, by name, or null where nothing here can move it. */
  readonly moves: string | null;
  /** §T970: the channels of that node's pose a move leaves alone (a partly driven pose), or "". */
  readonly held: string;
}

export function lookOrMove(look: PreviewOrbitStore, move: PreviewOrbitStore | null, moves: string | null, held = ""): LookMoveStore {
  const armed = (nodeId: NodeId): PictureCamera | null =>
    move !== null && move.mode(nodeId) === "adjustable" ? "move" : look.mode(nodeId) === "adjustable" ? "look" : null;
  const active = (nodeId: NodeId): PreviewOrbitStore => (move !== null && armed(nodeId) === "move" ? move : look);
  const arm = (nodeId: NodeId, which: PictureCamera | null): void => {
    if (which !== "look") look.setMode(nodeId, "home");
    if (which !== "move") move?.setMode(nodeId, "home");
    if (which === "look") look.setMode(nodeId, "adjustable");
    if (which === "move") move?.setMode(nodeId, "adjustable");
  };
  return {
    moves: move === null ? null : moves,
    held: move === null ? "" : held,
    armed,
    arm,
    get: (nodeId) => look.get(nodeId),
    mode: (nodeId) => (armed(nodeId) === null ? "home" : "adjustable"),
    setMode(nodeId, mode) {
      if (mode === "home") arm(nodeId, null);
      else if (armed(nodeId) === null) arm(nodeId, "look");
    },
    subscribe(nodeId, listener) {
      const offLook = look.subscribe(nodeId, listener);
      const offMove = move?.subscribe(nodeId, listener);
      return () => {
        offLook();
        offMove?.();
      };
    },
    apply: (nodeId, delta) => {
      active(nodeId).apply(nodeId, delta);
    },
    zoom: (nodeId, factor) => {
      active(nodeId).zoom(nodeId, factor);
    },
    fly: (nodeId, delta) => {
      active(nodeId).fly?.(nodeId, delta);
    },
    reset: (nodeId) => {
      active(nodeId).reset(nodeId);
    },
    release: (nodeId) => {
      active(nodeId).release?.(nodeId);
    },
  };
}

/** §T1732b: what the tile's C says, armed or not. The keys are the tile's own. */
export function lookToggleTitle(armed: boolean, hint: string): string {
  const said = armed
    ? "Looking around: view only, the camera does not move. Press, or h over the tile, to return to the camera"
    : "Look around (or alt on tile): drag orbits, shift-drag pans, the wheel zooms. View only, the camera does not move";
  return hint === "" ? said : `${said}. ${hint}`;
}

/** §T1732b: what the tile's M says, armed or not, naming the camera it edits and what it leaves alone. */
export function moveToggleTitle(name: string, armed: boolean, held = ""): string {
  const said = armed
    ? `Moving ${name}: every move is an edit, undo steps back. Press, or h over the tile, to stop`
    : `Move ${name}: drag orbits it, shift-drag trucks, the wheel dollies. Every move is an edit, undo steps back`;
  return held === "" ? said : `${said}. ${held}`;
}
