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
import {
  LibraryGroups,
  LibraryPanel,
  LibrarySearch,
  useLibraryHoverCard,
} from "./library-panel.tsx";
import { listExampleProjects } from "./example-catalogue.ts";
import type { ExampleProject } from "./example-catalogue.ts";
import { filterExamples } from "./example-search.ts";
import { categoriesOf } from "./search.ts";
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
   * §T863 — the categories are SHOWN as the shape of the list, under a sticky header,
   * rather than repeated on every row as a badge.
   *
   * Both were on the table. A badge spends the row's scarcest resource — width, in a dock
   * this narrow, where the name already truncates — to restate on 38 rows what one header
   * says once; and a header answers a question a badge cannot, which is how many kinds
   * there ARE and how big each is. Since §T877 the answer is `LibraryGroups`, so the node
   * pane gets the same one rather than a second copy of the reasoning.
   *
   * It stays grouped while searching, which is the node pane's behaviour: `groupEntries`
   * keeps members in arrival order, so a ranked result is still ranked inside its bucket.
   */
  const hover = useLibraryHoverCard<ExampleProject>();

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
    <LibraryPanel
      hover={hover}
      renderCard={(example) => (
        <>
          {example.thumbnailUrl === undefined ? null : (
            <img
              className={styles.cardThumb}
              src={example.thumbnailUrl}
              // Decorative beside the name and description it sits with: a second reading
              // of "E9 Ember" is noise, and no alt text conveys the picture better than
              // the sentence already below it.
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
        </>
      )}
      notice={message}
      toolbar={
        <LibrarySearch
          label="Search examples"
          value={query}
          onChange={setQuery}
          categories={categories}
          category={category}
          onCategoryChange={setCategory}
          filtersOpen={filtersOpen}
          onFiltersOpenChange={setFiltersOpen}
        />
      }
    >
      {catalogue.length === 0 ? (
        <p className={styles.empty}>No example ships with this build.</p>
      ) : (
        <LibraryGroups
          items={results}
          keyOf={(example) => example.fileName}
          empty="No example matches that search."
          renderItem={(example) => (
            <button
              type="button"
              className={styles.item}
              disabled={busy || !canOpen}
              onClick={() => choose(example)}
              {...hover.rowProps(example)}
            >
              <span className={styles.itemTitle}>{example.name}</span>
              <span className={styles.itemMeta}>{example.nodeCount} nodes</span>
            </button>
          )}
        />
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
    </LibraryPanel>
  );
}
