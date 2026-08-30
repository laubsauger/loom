import type { FrameInputs } from "../../domain/types/backend.ts";

export type PointerState = FrameInputs["pointer"];

/**
 * Pointer values fed into the shared frame uniforms (§T16).
 *
 * Deliberately has no DOM listeners: React components own the events and call `set()`,
 * so no GPU-adjacent module reaches into the document (§V2).
 */
export interface PointerSource {
  readonly state: PointerState;
  set(next: Partial<PointerState>): void;
  reset(): void;
}

/** A DOM rect, restated structurally so this module never depends on the DOM (§V2). */
export interface PointerRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A client-space point, normalised to a rect (T324, §V236).
 *
 * 0..1 across the rect, **v DOWN**, matching the uv convention our fragment coordinate and
 * the `uv` generator both use. A shader reading `pointer` is asking "where in the PICTURE",
 * so the rect is the viewer's own box and never the window: wherever the viewer is not
 * full-window the two answers differ, and the window one is wrong in a way that changes
 * with the user's layout.
 *
 * Returns null OUTSIDE the rect rather than clamping. §V236 says the pointer HOLDS its last
 * position when the cursor leaves, and holding means "publish nothing" — an edge-clamped
 * value would be a position the cursor is not at, reported as though it were.
 */
export function normalizedPointer(
  client: { readonly x: number; readonly y: number },
  rect: PointerRect,
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const x = (client.x - rect.left) / rect.width;
  const y = (client.y - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}

export function createPointerSource(): PointerSource {
  let state: PointerState = { x: 0, y: 0, buttons: 0 };

  return {
    get state() {
      return state;
    },
    set(next) {
      state = {
        x: next.x ?? state.x,
        y: next.y ?? state.y,
        buttons: next.buttons ?? state.buttons,
      };
    },
    reset() {
      state = { x: 0, y: 0, buttons: 0 };
    },
  };
}
