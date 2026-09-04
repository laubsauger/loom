import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { NodeIdentity } from "@ui/primitives/node-identity.tsx";
import { PopoverAnchor, PopoverContent, PopoverRoot } from "@ui/primitives/popover.tsx";
import { ALL_CATEGORIES, categoriesOf, filterLibrary } from "./search.ts";
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
 * cursor popover would make it the library pane badly. That reasoning held while the
 * list could not scroll: an uncapped list simply ran off the popover. T963 gave the list
 * `nowheel` (React Flow was eating the wheel) and it has always had a max-height, so the
 * cap now only hides rows a scroll would reach. The browser IS how people browse.
 */
const IDLE_ROWS = Number.POSITIVE_INFINITY;

/** The "no category filter" tab. A value, so the strip has no special-case first entry. */
const ALL = "\u0000all";

export function NodeSearch({ definitions, anchor, onPick, onClose }: NodeSearchProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  /**
   * T732 — the category filter, which COMPOSES with the query rather than replacing it.
   *
   * The owner asked for tabs "in addition to the typing search", and the two filters are
   * therefore simultaneous and independent: picking a category never clears the query,
   * typing never clears the category. Both directions the row names then work, and they
   * work the same way — pick `filter` then type `bl`, or type `bl` then pick `filter`,
   * and you are looking at the same list.
   *
   * That is also exactly what `filterLibrary` already does for the library pane, which is
   * why this calls it instead of composing `searchDefinitions` with a category predicate
   * of its own. One filter implementation, two surfaces (§V29): a node the pane finds
   * under `filter` + "bl" is the node the browser finds, by construction.
   *
   * The one thing composition costs is legibility — type "blur" with `generator` selected
   * and you get an empty list with no visible reason. `populated` below is the answer to
   * that, and it is why this is tabs rather than a second dropdown.
   */
  const [category, setCategory] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

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

  /** Derived from the manifest, shared with the library pane's dropdown (§V487, T732). */
  const categories = useMemo(() => categoriesOf(definitions), [definitions]);

  const results = useMemo(() => {
    const filtered = filterLibrary(definitions, { query, category });
    // With no query there is nothing ranked to show, so the head is a sample rather than
    // a result set. A CHOSEN category is a result set, though, and truncating it would
    // quietly hide nodes the user has just asked to see — so the cap applies only to the
    // unfiltered idle list.
    return query.trim() === "" && category === null ? filtered.slice(0, IDLE_ROWS) : filtered;
  }, [category, definitions, query]);

  /**
   * WHICH CATEGORIES THE CURRENT QUERY CAN STILL REACH — composition, made visible.
   *
   * Two filters that silently intersect produce the surface's worst moment: you type
   * "blur" with `generator` selected, get nothing, and cannot see which of the two
   * constraints is responsible. Dimming the categories the query cannot reach answers
   * that before it is asked, and turns "type then narrow" into a one-glance gesture —
   * type "blur" and `filter` is the only tab still lit.
   *
   * Computed through the SAME `filterLibrary`, with the category dropped, so "this tab
   * has a hit" and "this tab shows a hit when clicked" cannot disagree.
   *
   * `null` when there is no query: with nothing typed every category is reachable, and
   * dimming nothing is cheaper than marking everything.
   */
  const populated = useMemo(() => {
    if (query.trim() === "") return null;
    return new Set(filterLibrary(definitions, { query }).map((one) => one.category));
  }, [definitions, query]);

  const clamped = Math.min(active, Math.max(results.length - 1, 0));

  const choose = useCallback((next: string | null) => {
    setCategory(next);
    // The result list has changed underneath the highlight, so the highlight goes back to
    // the top rather than pointing at whatever now happens to occupy its index.
    setActive(0);
  }, []);

  /**
   * Keyboard control of the strip — NOT optional here (T732).
   *
   * The browser opens on `tab` at the cursor, so a category filter that needs the mouse
   * breaks the gesture that opened it: you would reach for the keyboard to summon it and
   * for the mouse to use it. The strip is therefore a standard ARIA tablist with a roving
   * tabindex — one tab stop, so `Tab` from the search box lands on the strip and a second
   * `Tab` leaves it for the results — and arrows move along it with AUTOMATIC ACTIVATION,
   * so the list narrows as you travel instead of after a separate commit keystroke.
   * `Enter` hands focus back to the search box, which is the "narrowed it, now let me
   * type" move and the reason the strip is not a dead end.
   *
   * ⚠ `stopPropagation` is load-bearing, and the reason is NARROWER than it first looks —
   * measured, after the first version of this comment claimed the wrong thing and the
   * mutation written to prove it declined to fail (§V666 earning its keep).
   *
   * The popover is PORTALED to `document.body`, so `paneContextFromTarget` finds no
   * `data-keymap-context` ancestor and the keymap falls back to `environment.context`.
   * That fallback is `"global"` (`app.tsx`), NOT `"graph"` — so graph-context bindings
   * genuinely cannot fire from in here, and `tab` re-opening the browser on top of itself
   * is NOT the hazard. Verified: deleting this line leaves the Tab-out behaviour identical.
   *
   * GLOBAL-context bindings are another matter, and they are live. A focused tab is a
   * `<button>`, so §V53's `text` context does not cover it the way it covers the search
   * box beside it. `mod+z` is `graph.undo` and `space` is `transport.togglePlay`, both
   * global: without this line, browsing categories with the keyboard silently undoes the
   * user's last graph edit. That is §V53's classic bug — ⌘Z in one surface undoing
   * another's work — arriving through the one target shape the context rule cannot see.
   *
   * Escape is deliberately NOT stopped. Radix's dismissal listens on the document in the
   * CAPTURE phase, so it has already run by the time this handler sees the key — but
   * saying so here is cheaper than rediscovering it, and a future handler that returned
   * early on Escape would be wrong for a reason nothing else would explain.
   */
  const onTabsKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") return;
    // Everything else the strip sees is either handled here or is focus traversal, and
    // in both cases the graph keymap must not also act on it.
    event.stopPropagation();

    if (event.key === "Enter" || event.key === " ") {
      // Space and Enter both "confirm" — the tab is already selected (activation follows
      // focus), so confirming means going back to typing.
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }

    const strip = tabsRef.current;
    if (strip === null) return;
    const tabs = [...strip.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = tabs.findIndex((tab) => tab === event.target);
    if (at === -1) return;

    const to =
      event.key === "ArrowRight"
        ? Math.min(at + 1, tabs.length - 1)
        : event.key === "ArrowLeft"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (to === -1) return;
    event.preventDefault();
    const target = tabs[to];
    if (target === undefined) return;
    // Automatic activation: focus and selection move together, so travelling the strip
    // narrows the list live rather than requiring a commit.
    const name = target.dataset["category"] ?? ALL;
    choose(name === ALL ? null : name);
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [choose]);

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
            ref={searchRef}
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
          {/*
            The strip sits BELOW the search box on purpose, and it is not decoration.
            The popover is anchored at the cursor with `align="start" side="bottom"`, so
            whatever is first here is directly under the pointer when the surface mounts —
            and the surface is REACHED BY A DOUBLE-CLICK, whose second click lands on it.
            The search box absorbs that click harmlessly (it just takes focus, which it
            wanted anyway); a category tab there would silently filter the catalogue on
            every open. Keeping the input first also makes Tab order read the way the
            gesture does: type, then narrow, then choose.
          */}
          <div
            className={styles.tabs}
            role="tablist"
            /* NOT "Filter by category" — the library pane's dropdown trigger already
               carries that label, and two identically-named category controls on one
               screen is a puzzle for anyone navigating by name. */
            aria-label="Node category"
            ref={tabsRef}
            onKeyDown={onTabsKeyDown}
          >
            {[ALL, ...categories].map((name) => {
              const isAll = name === ALL;
              const selected = isAll ? category === null : category === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  className={styles.tab}
                  data-category={name}
                  data-testid={`node-search-tab-${isAll ? "all" : name}`}
                  aria-selected={selected}
                  /* Roving tabindex: exactly one stop, so Tab reaches the strip and one
                     more Tab leaves it — arrows travel WITHIN it (ARIA tabs). */
                  tabIndex={selected ? 0 : -1}
                  /* Dimmed, not disabled. A disabled tab leaves the roving order and
                     makes arrow travel skip unpredictably, and clicking one is a
                     legitimate way to ask "really nothing?" and get an honest answer. */
                  data-empty={populated !== null && !isAll && !populated.has(name)}
                  onClick={(event) => {
                    // Same burst guard as the rows (T635): the double-click that opens
                    // this surface must not also be read as a filter choice.
                    if (event.detail > 1) return;
                    // Selecting the ACTIVE tab does not clear it — "all" is a tab, so
                    // clearing has its own target and a tab that deselects itself on a
                    // second click would be a surprise no tab strip anywhere else has.
                    choose(isAll ? null : name);
                  }}
                >
                  {/* T1130: the library pane's own catch-all word, imported rather than
                      re-spelled. This strip said "all" and the pane's chip "All", and the
                      cross-surface gate had to compare the two lists case-blind to get
                      past it — the gate was compensating for a difference with no reason
                      to exist. */}
                  {isAll ? ALL_CATEGORIES : name}
                </button>
              );
            })}
          </div>
          {/* `nowheel` is React Flow's own wheel opt-out (the same one node-preview-slot.tsx
              applies). Without it the canvas zooms instead of the list scrolling, so a
              result set taller than the 244px cap was unreachable. */}
          <div className={`${styles.list} nowheel`}>
            {results.length === 0 ? (
              <p className={styles.empty}>
                {category === null
                  ? "No node matches that search."
                  : `No node in ${category} matches that search.`}
              </p>
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
                  {/*
                    T954: same rows as the node library, so the same component renders
                    them — title first, machine type as a quiet badge. This popover
                    deliberately does not take §T877's panel (three escape hatches), but
                    the ROW is identical, and a hand-built copy of it is exactly how the
                    two lists drifted apart before.
                  */}
                  <NodeIdentity
                    name={definition.title}
                    type={definition.type}
                    category={definition.category}
                    nameClassName={styles.itemTitle}
                    typeClassName={styles.itemMeta}
                  />
                </button>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
