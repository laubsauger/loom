import { useCallback, useId, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from "react";

/**
 * The library panes' hover-card controller (§T862). Split out of `library-panel.tsx` by
 * T1315b so that file exports only components and Fast Refresh can swap them — a hook
 * living beside components is the mixed module the rule is about.
 */

/** What Radix needs of an anchor: a rectangle, from anywhere. */
interface Measurable {
  getBoundingClientRect: () => DOMRect;
}

export interface LibraryRowHoverProps {
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  "aria-describedby"?: string;
}

export interface LibraryHoverCard<T> {
  hovered: T | null;
  hide: () => void;
  /** Spread onto the row element. */
  rowProps: (item: T) => LibraryRowHoverProps;
  anchorRef: { readonly current: Measurable };
  cardId: string;
}

/**
 * The hover-card anchor — POINTER, CAPTURED ONCE ON ENTRY (§T862).
 *
 * This has been wrong twice in opposite directions, and the pair is the whole lesson:
 *
 *  - a POINTER-TRACKED anchor is NEAR but JITTERS. It reads a live coordinate at the
 *    element edge, which is exactly where hover flickers, so it shakes by construction.
 *  - a TRIGGER anchor is STABLE but FAR. The trigger is a full-width row, so `side="right"`
 *    means "off the right edge of a 1500-pixel box" — the owner's screenshot had the card
 *    over the inspector, a pane away from the cursor.
 *  - POINTER-CAPTURED-ONCE is BOTH. The rect is taken at `pointerenter` and never updated
 *    while the pointer stays on the row, so it cannot jitter; and it is the cursor's own
 *    x, so it cannot be far.
 *
 * The rect is a one-pixel column at the pointer's x spanning the row's height, so
 * `side="right"` puts the card beside the CURSOR and `align="start"` still lines it up
 * with the row. Positioning, collision detection and flipping all stay Radix's — the only
 * thing this owns is where the anchor is.
 *
 * Keyboard has no pointer, so focus anchors at the row's near edge, where the focus ring
 * the user is following already is.
 *
 * One controller for the whole list, not one per row: a hook cannot run in a loop, and a
 * single card is what should exist anyway.
 */
export function useLibraryHoverCard<T>(): LibraryHoverCard<T> {
  const [hovered, setHovered] = useState<T | null>(null);
  const rect = useRef<DOMRect | null>(null);
  const cardId = useId();

  // A stable object whose `getBoundingClientRect` reads the latest captured rect. Radix
  // calls this when it positions, so the ref identity never has to change.
  const anchorRef = useRef<Measurable>({
    getBoundingClientRect: () => rect.current ?? asRect(0, 0, 0, 0),
  });

  const hide = useCallback(() => setHovered(null), []);

  const rowProps = useCallback(
    (item: T): LibraryRowHoverProps => ({
      onPointerEnter: (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        // CAPTURED ONCE. No `pointermove` handler exists, deliberately: tracking is what
        // made it jitter, and re-rendering a list on every mouse move to get a worse
        // result is the cost of the bug rather than the fix.
        rect.current = asRect(event.clientX, box.top, 1, box.height);
        setHovered(item);
      },
      onPointerLeave: () => setHovered(null),
      onFocus: (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        rect.current = asRect(box.left, box.top, 1, box.height);
        setHovered(item);
      },
      onBlur: () => setHovered(null),
    }),
    [],
  );

  return { hovered, hide, rowProps, anchorRef, cardId };
}

/**
 * A plain rectangle, cast to `DOMRect`.
 *
 * Radix's anchor type asks for a `DOMRect`, but it only ever READS the geometry, and
 * `new DOMRect()` is not reliably present in every environment this renders in — jsdom
 * included. A literal with every field populated is what the positioner actually needs.
 */
function asRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}
