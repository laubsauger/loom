import { useMemo, useState } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { Button } from "@ui/primitives/button.tsx";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { listExampleProjects } from "./example-catalogue.ts";
import type { ExampleProject } from "./example-catalogue.ts";
import { filterExamples } from "./example-search.ts";
import { categoriesOf, groupEntries } from "./search.ts";
import styles from "./library.module.css";

/**
 * The example library (T189, §V93, §V88).
 *
 * Third library, third verb: OPEN. It is its own pane and not a tab beside the node and
 * component catalogues, because those two ADD to the graph and this one REPLACES the
 * document — §V93 refuses to put a destructive verb one click from an additive one.
 *
 * That asymmetry is the whole design here:
 *  - opening asks first when there is unsaved work, and only then (§V93). A confirmation
 *    on a clean document trains people to dismiss the one that matters;
 *  - adding and instantiating never ask, because undo is right there.
 *
 * Opening goes through `project.open` with the file's own bytes (§V29, §V88) — the same
 * command the file picker and the restore path use, so an example takes the identical
 * route a user's own file takes and cannot be "loaded" by a path nothing else exercises.
 *
 * T846 gives the pane the node library's toolbar — one search box, one on-demand
 * category filter — and a hover card. All three are the node pane's own vocabulary
 * rather than a second one: 38 rows is past the point where a flat list is browsable,
 * and this was already the answer to that question one pane over (§V90).
 *
 * The card carries the four things that decide "is this the one I mean": the picture,
 * the name, the size, and the sentence the example's own `.md` opens with. It stops
 * there. It is not a place to put the graph, the claims or the docs — the document is
 * one click away and says all of that better than a tooltip can.
 */

/**
 * The command an example row runs. A literal rather than an import: the registration
 * lives in `src/app`, and `src/editor` importing upward from the composition root would
 * invert the layering. `CommandMap` still types the call, so a rename breaks this line.
 */
const OPEN_COMMAND = "project.open";

export interface ExampleLibraryProps {
  bus: ShaderloomBus;
  /** Actor/project/capabilities for the open command (§V30). Memoise it. */
  context: InvocationContext;
  /** Unsaved work in the open document — the one thing that makes opening ask first. */
  dirty: boolean;
  /** Injectable for tests; otherwise the shipped `examples/` directory. */
  examples?: readonly ExampleProject[];
  /** Fires after a successful open, e.g. to focus the canvas. */
  onOpened?: (example: ExampleProject) => void;
}

export function ExampleLibrary({
  bus,
  context,
  dirty,
  examples,
  onOpened,
}: ExampleLibraryProps) {
  const catalogue = useMemo(() => examples ?? listExampleProjects(), [examples]);
  const [pending, setPending] = useState<ExampleProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // The same derivation the node library's filter uses (§V754): the category list comes
  // out of the catalogue, so an example whose graph earns a new category gets a filter
  // row with no other edit, and there is no second list to leave behind.
  const categories = useMemo(() => categoriesOf(catalogue), [catalogue]);
  const results = useMemo(
    () => filterExamples(catalogue, { query, category }),
    [catalogue, category, query],
  );

  /**
   * §T863 — the categories are SHOWN as the node pane shows them: as the shape of the
   * list, under a sticky header, rather than repeated on every row as a badge.
   *
   * Both were on the table and the pane decides it. A badge spends the row's scarcest
   * resource — width, in a dock this narrow, where the name already truncates — to
   * restate on 38 rows what one header says once. And a header answers a question a
   * badge cannot: how many kinds there ARE, and how big each is. That is what someone
   * opening a library of 38 files is actually asking.
   *
   * It stays grouped while searching too, which is the node pane's behaviour and worth
   * inheriting rather than switching idioms mid-gesture: `groupEntries` keeps members in
   * arrival order, so a ranked result is still ranked inside its bucket.
   */
  const groups = useMemo(() => groupEntries(results), [results]);

  // `project.open` is registered by the mounted composition root, so it can genuinely be
  // absent — in a test harness, or before the root's effect has run. A row that would
  // throw is disabled instead, the way an unregistered menu item is (§V52).
  const canOpen = bus.hasCommand(OPEN_COMMAND);

  const open = async (example: ExampleProject): Promise<void> => {
    setPending(null);
    setBusy(true);
    try {
      const outcome = await bus.execute(
        OPEN_COMMAND,
        { text: example.text, fileName: example.fileName },
        context,
      );
      const first = outcome.diagnostics[0];
      setMessage(first === undefined ? null : first.message);
      if (outcome.output.opened) onOpened?.(example);
    } finally {
      setBusy(false);
    }
  };

  const choose = (example: ExampleProject): void => {
    // §V93: confirm only when there is work to lose.
    if (dirty) setPending(example);
    else void open(example);
  };

  return (
    <div className={styles.library}>
      {/*
        §T855, the owner's own layout call: the filter sits BESIDE the search field, one
        row. `saveRow` is the pane's existing two-control row (the component library saves
        through it) — the input yields, the button keeps its label — so this is the
        stylesheet's idiom rather than a third arrangement of the same two controls.
      */}
      <div className={styles.toolbar}>
        <div className={styles.saveRow}>
          <input
            type="search"
            className={styles.search}
            value={query}
            placeholder="Search examples"
            aria-label="Search examples"
            onChange={(event) => setQuery(event.target.value)}
            // §V53: a text field swallows editing keys rather than driving the graph.
            onKeyDown={(event) => event.stopPropagation()}
          />

          {/*
            §V90, as the node pane resolved it: the trigger shows the ACTIVE filter — the
            answer to "what am I looking at" — and the full set is one click away, so the
            toolbar carries one control instead of a chip wall that grows with the list.

            The resting label is the WORD "All", not an icon (§T855). A compact trigger
            has to state its own state: the property a chip wall gives away for free is
            that you can see nothing is hidden without touching anything, and an icon is
            exactly what loses it. "All" costs three characters and keeps it.
          */}
          <PopoverRoot open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cx(styles.chip, styles.filterTrigger)}
                aria-expanded={filtersOpen}
                aria-label={category === null ? "Filter by category" : `Category: ${category}`}
              >
                {category ?? "All"}
              </button>
            </PopoverTrigger>
            <PopoverContent className={styles.filterMenu} align="end" sideOffset={4}>
              <div className={styles.categories}>
                <button
                  type="button"
                  className={styles.chip}
                  aria-pressed={category === null}
                  onClick={() => {
                    setCategory(null);
                    setFiltersOpen(false);
                  }}
                >
                  All
                </button>
                {categories.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={styles.chip}
                    aria-pressed={category === name}
                    onClick={() => {
                      setCategory(category === name ? null : name);
                      setFiltersOpen(false);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </PopoverRoot>
        </div>
      </div>

      {/*
        The pane mounts its own provider so it is self-contained wherever it is embedded.
        Radix opens the card on FOCUS as well as hover (§V19), so the description is not
        something only a mouse can reach.
      */}
      <TooltipProvider delayDuration={250}>
        <div className={styles.list}>
          {catalogue.length === 0 ? (
            <p className={styles.empty}>No example ships with this build.</p>
          ) : groups.length === 0 ? (
            <p className={styles.empty}>No example matches that search.</p>
          ) : (
            groups.map((group) => (
              <section className={styles.group} key={group.category} aria-label={group.category}>
                <h3 className={styles.groupHeader}>
                  {group.category}
                  {/* The size of the bucket, which is half of what a header is for. */}
                  <span className={styles.groupCount}>{group.items.length}</span>
                </h3>
                {group.items.map((example) => (
                <TooltipRoot key={example.fileName}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={styles.item}
                      disabled={busy || !canOpen}
                      onClick={() => choose(example)}
                    >
                      <span className={styles.itemTitle}>{example.name}</span>
                      <span className={styles.itemMeta}>{example.nodeCount} nodes</span>
                    </button>
                  </TooltipTrigger>
                  {/*
                    §T862 — ANCHORED TO THE ROW, positioned by the shipped primitive.
                    Four props, and each is one of the owner's three requirements:

                     - `side="right"` puts the card BESIDE the row, so it cannot cover the
                       thing being hovered. A card on the main axis always can.
                     - `align="start"` lines its top edge up with the row's, which is the
                       strongest "this row" signal a list can give, and it is the same for
                       every row — the consistency the owner asked for.
                     - `avoidCollisions` + `collisionPadding` keep it on screen, flipping
                       to the row's other side rather than jumping across the pane.

                    An earlier pass computed this from `event.clientX` per row. That is the
                    bug the owner hit rather than a tuning problem: a pointer anchor reads a
                    live coordinate at the element edge, which is exactly where hover
                    flickers, so it jitters BY CONSTRUCTION. The row does not move.
                  */}
                  <TooltipContent
                    className={styles.card}
                    side="right"
                    align="start"
                    sideOffset={8}
                    avoidCollisions
                    collisionPadding={8}
                  >
                    {example.thumbnailUrl === undefined ? null : (
                      <img
                        className={styles.cardThumb}
                        src={example.thumbnailUrl}
                        // Decorative beside the name and description it sits with: a second
                        // reading of "E9 Ember" is noise, and there is no alt text that
                        // conveys the picture better than the sentence already below it.
                        alt=""
                        width={256}
                        height={144}
                        loading="lazy"
                      />
                    )}
                    <span className={styles.cardTitle}>{example.name}</span>
                    <span className={styles.cardMeta}>{example.nodeCount} nodes</span>
                    {example.description === "" ? null : (
                      <span className={styles.cardText}>{example.description}</span>
                    )}
                  </TooltipContent>
                </TooltipRoot>
                ))}
              </section>
            ))
          )}
        </div>
      </TooltipProvider>

      {message === null ? null : (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}

      <DialogRoot
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
      >
        {/* Named by its title, so the dialog announces the example it is about. */}
        <DialogContent>
          <DialogTitle>Open {pending?.name ?? ""}</DialogTitle>
          <DialogDescription>Unsaved changes are replaced.</DialogDescription>
          <DialogFooter>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pending !== null) void open(pending);
              }}
            >
              Open
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
