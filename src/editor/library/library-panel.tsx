import { Fragment, useCallback, useId, useRef, useState } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  PopoverAnchor,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from "@ui/primitives/popover.tsx";
import { cx } from "@ui/cx.ts";
import { ALL_CATEGORIES, groupEntries } from "./search.ts";
import styles from "./library.module.css";

/**
 * The shared library panel (§T877) — one skeleton, one search row, one sticky group list,
 * one hover-card anchor.
 *
 * ## Why this exists
 *
 * Four surfaces were built on this stylesheet — the node, component and example panes and
 * the node-search popover — and what they shared was ONLY the stylesheet. Each re-declared
 * the same `.library` / `.toolbar` / `.list` structure by hand, and the owner named the
 * consequence as it happened: §T876's sticky-header bug reproduced in the node library
 * because the STRUCTURE was copied, and §T855's one-row category filter landed in the
 * example pane and nowhere else because the STRUCTURE was copied.
 *
 * Shared CSS with copied structure is the worst of both: it looks like one component
 * right up until you fix one of them. This is `search.ts`'s move (§V748) at the UI layer —
 * the same extraction that let one reversed sort redden both catalogues at once.
 *
 * ## What is shared, and what is honestly not
 *
 *  - `LibraryPanel` — the skeleton, used by all THREE panes. The toolbar is a sibling of
 *    the scroller by construction, which is §T876's fix inherited rather than applied
 *    four times. It also owns the hover card, because the panel IS the collision
 *    boundary a card must not escape.
 *  - `LibrarySearch` — the field and, where a surface has categories, the on-demand filter
 *    beside it on ONE row (§T855, §V90). Node and example panes.
 *  - `LibraryGroups` — the sticky category sections. Node and example panes.
 *  - `useLibraryHoverCard` — the anchor. See its own note; it has been wrong twice.
 *
 * `ComponentLibrary` takes the skeleton and nothing else: it has no categories to filter
 * and a flat list of rows, and giving it a category control to look consistent would be
 * inventing an affordance with nothing behind it.
 *
 * `NodeSearch` takes NONE of it, deliberately. It is a popover, not a pane: dismissal and
 * focus restoration are the popover's, its category control is an ARIA tab strip with a
 * roving tabindex and arrow-key travel rather than a menu behind a trigger, and its list
 * is TRUNCATED to `IDLE_ROWS` while idle. Bending it in would need an escape hatch for
 * each of those, and four escape hatches is a copy with extra steps.
 */

export interface LibraryPanelProps<T> {
  /** The non-scrolling head: a search row, a drag banner, a save row. */
  toolbar: ReactNode;
  /** The scrolling body. */
  children: ReactNode;
  /** A status line pinned under the scroller. Nothing renders when null. */
  notice?: string | null;
  /** From `useLibraryHoverCard`, when this surface has a card. */
  hover?: LibraryHoverCard<T> | undefined;
  /** The card body for the hovered item. */
  renderCard?: ((item: T) => ReactNode) | undefined;
}

/**
 * The skeleton every pane shares.
 *
 * THE ONE STRUCTURAL RULE, and why this is a component rather than a convention: the
 * toolbar is a SIBLING of the scroller, never inside it. A sticky group header can only
 * sit safely at `top: 0` if nothing above it scrolls, and the stylesheet's matching half —
 * no top padding on the scroller, so `top: 0` IS the visible top — is documented on
 * `.list`. Together they make §T876 impossible to reintroduce in one pane by editing the
 * other.
 */
export function LibraryPanel<T>({
  toolbar,
  children,
  notice = null,
  hover,
  renderCard,
}: LibraryPanelProps<T>) {
  // A callback ref rather than `useRef`: the boundary has to be a rendered element before
  // the card can be told to stay inside it, and only state re-renders to deliver it.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const hovered = hover?.hovered ?? null;

  return (
    <div className={styles.library} ref={setRoot}>
      <div className={styles.toolbar}>{toolbar}</div>
      <div className={styles.list}>{children}</div>
      {notice === null ? null : (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {hover === undefined || renderCard === undefined ? null : (
        <PopoverRoot
          open={hovered !== null}
          onOpenChange={(next) => {
            if (!next) hover.hide();
          }}
        >
          {/* The anchor is VIRTUAL — a rect the row hands over, not an element. */}
          <PopoverAnchor virtualRef={hover.anchorRef} />
          <PopoverContent
            id={hover.cardId}
            className={styles.card}
            /*
             * A hover card, not a dialog: it describes, it never takes the caret. Without
             * these three a card that opens on hover steals focus from the list and
             * closing it throws focus somewhere the user did not put it.
             */
            role="tooltip"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            side="right"
            align="start"
            sideOffset={12}
            avoidCollisions
            /*
             * §T862: the card escaped the pane entirely and landed over the inspector,
             * ~1500px from the cursor. The pane is the boundary — a card about a row in
             * this list has no business being drawn outside the list's own panel.
             */
            collisionBoundary={root}
            collisionPadding={8}
          >
            {hovered === null ? null : renderCard(hovered)}
          </PopoverContent>
        </PopoverRoot>
      )}
    </div>
  );
}

export interface LibrarySearchProps {
  /**
   * WHAT THIS SURFACE LISTS, as a plural noun: "nodes", "examples", "components" (T1130).
   *
   * ONE noun per pane, and every control in the row is named from it — the field reads
   * "Search nodes", the filter trigger "Filter nodes by category". Two panes are open at
   * once in the default arrangement (§T1123/§T1125's node library and examples pane), and
   * a sighted user tells their controls apart by WHICH PANE THEY ARE IN while a screen
   * reader user has only the name. So the collection cannot be optional and cannot be
   * spelled separately per control: a second free-text `label` prop beside this one is
   * exactly how the two triggers came to share the string "Filter by category".
   */
  collection: string;
  value: string;
  onChange: (next: string) => void;
  /** Extra key handling, e.g. the node pane's Enter-adds-the-top-hit. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** Native tooltip for the field, where a surface has a gesture worth naming. */
  title?: string;
  /** Every category in the catalogue. Omit on a surface that has none. */
  categories?: readonly string[];
  category?: string | null;
  onCategoryChange?: (next: string | null) => void;
  filtersOpen?: boolean;
  onFiltersOpenChange?: (next: boolean) => void;
}

/**
 * The search field, with the category filter beside it on one row (§T855).
 *
 * §V90 shapes the filter: the category set GROWS with the catalogue, so a permanent chip
 * wall is a control that eventually does not fit — it was three rows deep in the node pane
 * before §T427 moved it. The trigger names the ACTIVE filter, which is the answer to
 * "what am I looking at", and the whole set is one click away.
 */
export function LibrarySearch({
  collection,
  value,
  onChange,
  onKeyDown,
  title,
  categories,
  category = null,
  onCategoryChange,
  filtersOpen = false,
  onFiltersOpenChange,
}: LibrarySearchProps) {
  const choose = (next: string | null): void => {
    onCategoryChange?.(next);
    onFiltersOpenChange?.(false);
  };

  return (
    <div className={styles.saveRow}>
      <input
        type="search"
        className={styles.search}
        value={value}
        placeholder={`Search ${collection}`}
        aria-label={`Search ${collection}`}
        {...(title === undefined ? {} : { title })}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // §V53: a text field swallows editing keys rather than driving the graph. Here,
          // so that no surface can forget it — which is half of why this is shared.
          event.stopPropagation();
          onKeyDown?.(event);
        }}
      />

      {categories === undefined ? null : (
        <PopoverRoot open={filtersOpen} onOpenChange={(next) => onFiltersOpenChange?.(next)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cx(styles.chip, styles.filterTrigger)}
              aria-expanded={filtersOpen}
              /*
               * T1130 — NAMED BY THE COLLECTION IT FILTERS, IN BOTH STATES.
               *
               * The active state carries it too, and that is not belt-and-braces: two
               * panes narrowed to the same category name would otherwise both announce
               * "Category: Generators" and the duplicate would be back, wearing a value
               * instead of a placeholder.
               */
              aria-label={
                category === null
                  ? `Filter ${collection} by category`
                  : `Filter ${collection} by category: ${category}`
              }
            >
              {category ?? ALL_CATEGORIES}
            </button>
          </PopoverTrigger>
          <PopoverContent className={styles.filterMenu} align="end" sideOffset={4}>
            <div className={styles.categories}>
              <button
                type="button"
                className={styles.chip}
                aria-pressed={category === null}
                onClick={() => choose(null)}
              >
                {ALL_CATEGORIES}
              </button>
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={styles.chip}
                  aria-pressed={category === name}
                  // Selecting the active category clears it — the gesture the node pane
                  // has asserted since T427.
                  onClick={() => choose(category === name ? null : name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </PopoverContent>
        </PopoverRoot>
      )}
    </div>
  );
}

export interface LibraryGroupsProps<T extends { readonly category: string }> {
  items: readonly T[];
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Shown instead of the sections when `items` is empty. */
  empty: ReactNode;
}

/**
 * The catalogue as sticky category sections.
 *
 * Grouping goes through `groupEntries`, the call the node pane already made, so the two
 * panes cannot come to disagree about category order or member order — members keep their
 * arrival order, which is what leaves a ranked search still ranked inside a bucket.
 *
 * The header carries its COUNT: the half of a group header a per-row badge could never
 * supply — how many kinds there are and how big each is — and now the same in both panes
 * rather than in whichever one was edited last.
 */
export function LibraryGroups<T extends { readonly category: string }>({
  items,
  keyOf,
  renderItem,
  empty,
}: LibraryGroupsProps<T>) {
  const groups = groupEntries(items);
  if (groups.length === 0) return <p className={styles.empty}>{empty}</p>;
  return (
    <>
      {groups.map((group) => (
        <section className={styles.group} key={group.category} aria-label={group.category}>
          <h3 className={styles.groupHeader}>
            {group.category}
            <span className={styles.groupCount}>{group.items.length}</span>
          </h3>
          {group.items.map((item) => (
            <Fragment key={keyOf(item)}>{renderItem(item)}</Fragment>
          ))}
        </section>
      ))}
    </>
  );
}

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
