import { useEffect, useMemo, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { Button } from "@ui/primitives/button.tsx";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import { LibraryGroups, LibraryPanel, LibrarySearch } from "./library-panel.tsx";
import { useLibraryHoverCard } from "./use-library-hover-card.ts";
import { capabilityOf, listExampleProjects } from "./example-catalogue.ts";
import type { ExampleProject } from "./example-catalogue.ts";
import { exampleLinkUrl } from "./example-link.ts";
import { filterExamples } from "./example-search.ts";
import { categoriesOf } from "./search.ts";
import styles from "./library.module.css";

function ExampleBadges({ example, row = false }: { example: ExampleProject; row?: boolean }) {
  return <span className={`${styles.cardTags} ${row ? styles.exampleBadges : ""}`}>
    {example.requirementsError === undefined ? null : (
      <span className={`${styles.cardTag} ${styles.requirementTag}`} title={example.requirementsError}>
        Requirements unknown
      </span>
    )}
    {example.requirements.map(requirement => (
      <span className={`${styles.cardTag} ${styles.requirementTag}`} key={requirement.id} title={requirement.description}>
        {requirement.label}
      </span>
    ))}
    {example.tags.map(tag => {
      const capability = capabilityOf(tag);
      return <span className={styles.cardTag} key={tag} title={capability.meaning}>{capability.label}</span>;
    })}
  </span>;
}

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
 * The card carries the five things that decide "is this the one I mean": the picture, the
 * name, WHAT IT DEMONSTRATES (T1162), the size, and the sentence the example's own `.md`
 * opens with. It stops there. It is not a place to put the graph, the claims or the docs
 * — the document is one click away and says all of that better than a tooltip can.
 *
 * T1162 added the capability tags because the other four answer "what does it LOOK like"
 * and none of them answers "what is this FOR": the descriptions are scene prose, and the
 * category is one bucket chosen by precedence. Every tag is DERIVED from the node types in
 * the file, so no card can claim a capability its graph does not have.
 */

/**
 * The command an example row runs. A literal rather than an import: the registration
 * lives in `src/app`, and `src/editor` importing upward from the composition root would
 * invert the layering. `CommandMap` still types the call, so a rename breaks this line.
 */
const OPEN_COMMAND = "project.open";

export interface ExampleLibraryProps {
  bus: LoomBus;
  /** Actor/project/capabilities for the open command (§V30). Memoise it. */
  context: InvocationContext;
  /** Unsaved work in the open document — the one thing that makes opening ask first. */
  dirty: boolean;
  /** Injectable for tests; otherwise the shipped `examples/` directory. */
  examples?: readonly ExampleProject[];
  /** Fires after a successful open, e.g. to focus the canvas. */
  onOpened?: (example: ExampleProject) => void;
  /**
   * T1278 — where a copied link is mirrored so it can leave the app (§V148).
   *
   * Injected rather than reached for, the same argument `writeClipboard` makes one layer
   * down in `parameter-commands.ts`: `navigator.clipboard` is absent in jsdom and in any
   * non-secure context, and a copy that threw would be an odd way to lose a pane.
   * Defaults to the real clipboard when there is one, and to a no-op when there is not —
   * the row still renders and the rest of the pane still opens examples.
   */
  copyLink?: (text: string) => void;
  /** Test seams for the link's two halves. Default to THIS page's own address. */
  linkOrigin?: string;
  linkBase?: string;
}

function writeToClipboard(text: string): void {
  void globalThis.navigator?.clipboard?.writeText(text);
}

export function ExampleLibrary({
  bus,
  context,
  dirty,
  examples,
  onOpened,
  copyLink = writeToClipboard,
  linkOrigin,
  linkBase,
}: ExampleLibraryProps) {
  /*
   * The link's prefix, read HERE rather than baked into `example-link.ts`: the base is
   * `/loom/` on Pages and `/` in dev, so a hard-coded either would hand somebody a URL
   * that works on exactly one of the two builds.
   */
  const origin = linkOrigin ?? globalThis.location.origin;
  const base = linkBase ?? import.meta.env.BASE_URL;
  const catalogue = useMemo(() => examples ?? listExampleProjects(), [examples]);
  const [pending, setPending] = useState<ExampleProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  /*
   * T1281 — the copy's receipt lands ON THE BUTTON, because that is where the eye is.
   * The pane's `notice` still fires (it is what a screen reader announces, §V148), but it
   * renders BELOW a 59-row scrolling list: click a row near the top and the confirmation
   * is off screen, which is exactly how the owner read a working copy as a dead button.
   */
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  useEffect(() => {
    if (copiedFor === null) return undefined;
    const timer = setTimeout(() => setCopiedFor(null), 1600);
    return () => clearTimeout(timer);
  }, [copiedFor]);

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
          {/*
            T1162 — the capability tags, second on the card because they are the answer to
            the question the name and the picture do not answer. Each carries its own
            DEFINITION on hover ("closes a temporal loop: this frame reads the frame before
            it"), which is a sentence about the TAG and so cannot go stale against the file
            the way a hand-written per-example claim would.
          */}
          <ExampleBadges example={example} />
          <span className={styles.cardMeta}>{example.nodeCount} nodes</span>
          {example.description === "" ? null : (
            <span className={styles.cardText}>{example.description}</span>
          )}
        </>
      )}
      notice={message}
      toolbar={
        <LibrarySearch
          collection="examples"
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
            <div className={styles.exampleRow}>
              <button
                type="button"
                className={styles.item}
                disabled={busy || !canOpen}
                onClick={() => choose(example)}
                {...hover.rowProps(example)}
              >
                <span className={styles.itemTitle}>{example.name}</span>
                <span className={styles.itemMeta}>{example.nodeCount} nodes</span>
                <ExampleBadges example={example} row />
              </button>
              {/*
                T1278 — the SHARE half of the feature, a sibling button rather than
                anything nested: the row is already a `<button>` and a button inside a
                button is not a control any browser agrees about. The component pane's
                row/action split (`.row` + a trailing `Button`) is the precedent.
              */}
              <Button
                aria-label={`Copy a link to ${example.name}`}
                title={`Copy a link to ${example.name}`}
                onClick={() => {
                  copyLink(exampleLinkUrl(example.fileName, origin, base));
                  setMessage(`Link to ${example.name} copied.`);
                  setCopiedFor(example.fileName);
                }}
              >
                {copiedFor === example.fileName ? "copied" : "copy link"}
              </Button>
            </div>
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
