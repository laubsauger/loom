import { useMemo, useRef, useState } from "react";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { PopoverAnchor, PopoverContent, PopoverRoot } from "@ui/primitives/popover.tsx";
import { searchDefinitions } from "./search.ts";
import styles from "./node-search.module.css";

/**
 * T709 — the searchable node browser, anchored at the point it will place its node.
 *
 * `anchor` is in CLIENT coordinates and is derived by the caller from the same graph
 * position it will hand to `onPick`, by projecting it back through the viewport. That is
 * the load-bearing detail of this row: the browser appearing at the cursor and the node
 * landing at the cursor are not two behaviours that happen to agree, they are one number
 * used twice, so they cannot drift apart.
 *
 * Search is `searchDefinitions`, the same ranked implementation the library pane uses —
 * not a second matcher that would answer "blur" differently depending on which surface
 * you asked (§V29).
 */
export interface NodeSearchProps {
  definitions: readonly NodeDefinition[];
  /** Client coordinates to anchor at — projected from the graph position by the caller. */
  anchor: { x: number; y: number };
  onPick: (type: string) => void;
  onClose: () => void;
}

/**
 * With no query there is nothing ranked to show, and dumping the whole catalogue into a
 * cursor popover would make it the library pane badly. A short alphabetical head is
 * enough to prove the surface is alive and to click straight through for common nodes.
 */
const IDLE_ROWS = 8;

export function NodeSearch({ definitions, anchor, onPick, onClose }: NodeSearchProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  /**
   * §B107/§V472's bug, in a second Radix primitive — found by this row's own e2e spec,
   * because the KEYBOARD path (Enter on the search box) created its node perfectly while
   * clicking a row created nothing at all.
   *
   * Measured sequence: `pointerdown` on a result row, then Radix's `focusOutside` with a
   * DIV target, then `interactOutside`. Under React 19.2 the pointerdown-driven focus
   * lands before the layer has registered the press as its own, so the layer reads the
   * press as outside, dismisses, and unmounts the row MID-PRESS — the `pointerup` then
   * finds nothing and React's `click` never fires. Every jsdom test would stay green, and
   * `onPick` would never run.
   *
   * The veto is scoped to an active press INSIDE this content's own React subtree, and
   * deliberately not unconditional (§V516, and §B120, which is what an unconditional veto
   * did to the context menu — "closes too eagerly" became "never closes"). A genuine click
   * outside still fires `pointerDownOutside`, Escape still closes, and tabbing out still
   * closes, because none of those has a press inside this layer.
   *
   * ⚠ This is the SECOND copy of this veto — `src/ui/primitives/context-menu.tsx` carries
   * the first. Two copies of one subtle fix is how one of them gets repaired and the other
   * quietly rots; they want extracting into a single primitive.
   */
  const pointerPressInside = useRef(false);

  /**
   * The SAME dismissal, reached a second way — by the context-menu door rather than the
   * double-click one, and found the same way: the "Search nodes…" row ran the command,
   * the handler was reached with the right position, and the browser still never appeared.
   *
   * Measured: `focusOutside` fires with the graph pane div as its target, in the same tick
   * the browser mounts. Radix's ContextMenu restores focus to its trigger as it closes,
   * and that restoration races this popover's own autofocus — so the layer sees focus
   * land outside itself before it has ever held any, and dismisses.
   *
   * The veto is "this layer has not had focus yet", not a timer (§V565 — a burst is
   * distinguished by what the event IS, never by how long ago something happened; a
   * timer would be tuned against one machine's scheduling and would rot). Once the search
   * box has taken focus, a later focus-outside is a real tab-away and closes normally.
   * It cannot wedge open either: `pointerDownOutside` and Escape are untouched, so a
   * click anywhere else and the Escape key both still dismiss it.
   */
  const hasHeldFocus = useRef(false);

  const results = useMemo(() => {
    if (query.trim() === "") {
      return [...definitions]
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, IDLE_ROWS);
    }
    return searchDefinitions(definitions, query);
  }, [definitions, query]);

  const clamped = Math.min(active, Math.max(results.length - 1, 0));

  return (
    <PopoverRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor asChild>
        {/* A zero-size fixed point, so Radix positions against the cursor rather than
            against any element that happens to be under it. */}
        <span
          aria-hidden="true"
          style={{ position: "fixed", left: `${anchor.x}px`, top: `${anchor.y}px` }}
        />
      </PopoverAnchor>
      <PopoverContent
        aria-label="Add node"
        data-testid="node-search"
        align="start"
        side="bottom"
        sideOffset={0}
        onPointerDownCapture={(event) => {
          pointerPressInside.current = true;
          // The matching release can land anywhere — a drag out of the row, or the row
          // being removed under the cursor — so listen on the window that owns THIS
          // content, not the ambient one: a pane floated into a child window (§V97) has
          // its own, and the flag would otherwise never clear there. `pointercancel`
          // matters for the same reason: a press that never releases would leave the
          // veto stuck on and the popover would stop closing at all.
          const view = event.currentTarget.ownerDocument.defaultView ?? window;
          const clear = () => {
            pointerPressInside.current = false;
            view.removeEventListener("pointerup", clear, true);
            view.removeEventListener("pointercancel", clear, true);
          };
          view.addEventListener("pointerup", clear, true);
          view.addEventListener("pointercancel", clear, true);
        }}
        onFocusCapture={() => {
          hasHeldFocus.current = true;
        }}
        onFocusOutside={(event) => {
          if (pointerPressInside.current || !hasHeldFocus.current) event.preventDefault();
        }}
      >
        <div className={styles.surface}>
          <input
            type="search"
            autoFocus
            className={styles.search}
            value={query}
            placeholder="Search nodes"
            aria-label="Search nodes"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              // §V53: a text field swallows editing keys rather than driving the graph.
              event.stopPropagation();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, results.length - 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              const chosen = results[clamped];
              if (chosen !== undefined) onPick(chosen.type);
            }}
          />
          <div className={styles.list}>
            {results.length === 0 ? (
              <p className={styles.empty}>No node matches that search.</p>
            ) : (
              results.map((definition, index) => (
                <button
                  key={definition.type}
                  type="button"
                  className={styles.item}
                  data-active={index === clamped}
                  data-node-type={definition.type}
                  title={definition.description ?? definition.type}
                  /*
                   * T635's lesson, same shape: a double-click is two click events, and
                   * this surface is REACHED by a double-click, so the second click of a
                   * fast follow-up must not add twice.
                   */
                  onClick={(event) => {
                    if (event.detail > 1) return;
                    onPick(definition.type);
                  }}
                >
                  <span className={styles.itemTitle}>{definition.title}</span>
                  <span className={styles.itemMeta}>{definition.type}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
