import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { KEYMAP_CONTEXT_ATTRIBUTE, isTextEntryTarget } from "./context.ts";
import type { KeyContext } from "./types.ts";

/**
 * DECLARING a keymap context and being able to HOLD FOCUS are one thing (§V351, B66).
 *
 * They used to be two. A pane wrote `data-keymap-context="graph"` on its root and that
 * was the whole ceremony — but `activeContextsFor` derives the context from
 * `event.target.closest(...)`, and a container that can never be the event target is
 * never on that path. The graph pane declared `graph`, carried no `tabIndex`, and every
 * one of its 26 bindings was dead from the one place a user actually stands: focus on
 * `<body>` after clicking the empty canvas, `closest` returning null, fallback `global`.
 *
 * So the attribute is not handed out on its own any more. A pane asks for the context and
 * gets the focusability with it, and the next pane cannot repeat B66 by forgetting half.
 *
 * The other half of the same invariant is B67: while only ONE pane could take focus,
 * focus stayed PARKED there. Click the canvas, then click the inspector, and `delete` was
 * still the graph's delete — a destructive key firing while the user believes they are
 * somewhere else. Symmetry is the fix: every pane takes focus, so whichever one you
 * clicked owns the keys.
 */

/** Props to spread on the element that declares the context. */
export interface KeymapPaneProps<T extends HTMLElement> {
  readonly ref: RefObject<T | null>;
  /**
   * Never 0. The pane is click- and script-focusable so the context resolves, and is
   * NOT a tab stop: a large silent container in the tab order is a trap, not an
   * affordance.
   */
  readonly tabIndex: -1;
  readonly onPointerDown: (event: ReactPointerEvent<T>) => void;
  readonly [KEYMAP_CONTEXT_ATTRIBUTE]: KeyContext;
}

/**
 * Focus is taken EXPLICITLY rather than by leaning on the browser's implicit "focus the
 * nearest focusable ancestor on mousedown". That implicit path is one `preventDefault`
 * away from being suppressed by a pane's own pointer handlers — React Flow's d3 zoom is
 * in exactly that position — and it is not something a test can observe without also
 * simulating the browser's half of it.
 *
 * One guard, and it is §V53's: a text entry target keeps its focus, so a pointer-down
 * landing in a field is never intercepted by the pane around it. `isTextEntryTarget`
 * reads `readOnly` too, which is what keeps a number field's SCRUB (read-only, not a text
 * target) distinct from its TEXT EDIT (writable, guarded).
 */
export function useKeymapPane<T extends HTMLElement>(
  context: KeyContext,
  ref: RefObject<T | null>,
): KeymapPaneProps<T> {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<T>) => {
      const pane = ref.current;
      if (pane === null) return;
      if (isTextEntryTarget(event.target)) return;
      pane.focus({ preventScroll: true });
    },
    [ref],
  );

  return { ref, tabIndex: -1, onPointerDown, [KEYMAP_CONTEXT_ATTRIBUTE]: context };
}
