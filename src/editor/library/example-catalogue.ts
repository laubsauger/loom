/**
 * The shipped example projects, as the browser sees them (T189, §V88).
 *
 * `src/examples/catalogue.ts` walks the directory with `node:fs`; that is the headless
 * runner's copy and nothing in the app can import it. This is the same directory read
 * the only way a browser can read it — Vite inlines each `.loom.json` at build time —
 * and it is deliberately the SAME BYTES the runner gates on, not a re-export of the
 * in-memory documents that produced them. An example the user opens must be the file,
 * or "the example loads" stops proving anything about the format (§V88).
 *
 * The glob is the whole registration step, exactly as it is for the runner: dropping a
 * `.loom.json` into `examples/` puts it in this list.
 */

const RAW_EXAMPLES = import.meta.glob("../../../examples/*.loom.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

/**
 * The prose (T846). A SECOND GLOB, deliberately, not a build-time extract.
 *
 * The description an example row shows is the first paragraph of that example's `.md` —
 * already written, already curated, and already held honest by the doc-drift gates. The
 * question was how those bytes reach the browser, and the two candidates were this glob
 * or a generated table.
 *
 * The glob wins on the invariant this file exists to protect. §V88 is "the app reads the
 * same bytes the runner gates on", and the docblock above already refuses a re-export of
 * the in-memory documents for that reason; a generated description table is the same
 * mistake in a smaller font — a second source that agrees with the `.md` until someone
 * edits one of them. It also keeps registration whole: dropping `E46-Foo.loom.json` and
 * `E46-Foo.md` into `examples/` gives the row its description with no other edit, which
 * is §T675's rule that a new entry be impossible to forget rather than something someone
 * has to remember. And a virtual module would have to be declared in `vite.config.ts`
 * AND `vitest.config.ts` — Vitest does not extend the Vite config here — so the browser
 * and the test runner would resolve the description through two different mechanisms.
 *
 * THE COST, MEASURED, because it is not free: the 38 shipped `.md` files are 401,117
 * bytes raw / ~150 KB gzipped, and only 15,050 of those characters are ever displayed.
 * The app chunk carries the rest. That is a real 13% on a 3.08 MB chunk that already
 * inlines 734,588 bytes of `.loom.json`, and it is the price of the single-source read.
 * If the budget ever bites, the fix is a Vite plugin BEHIND THIS MODULE — `description`
 * on `ExampleProject` is the seam, and no consumer would change.
 */
const RAW_DESCRIPTIONS = import.meta.glob("../../../examples/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

/**
 * The cards (§T847). Same registration idiom as the looms: the seam is
 * `examples/thumbs/<ExampleFileStem>.png` and the glob is the whole of it.
 *
 * `?url` and NOT `?raw`: these are 38 real PNGs totalling 1.2 MB, and `?raw` would
 * base64 them into the JS bundle. `?url` emits them as assets, so a card's image is a
 * request made when the card opens — which is also the behaviour a hover card wants.
 *
 * Absence stays handled even though all 38 have landed: `import.meta.glob` returns `{}`
 * for a pattern matching nothing, and a row whose stem has no thumb renders no `<img>`
 * at all rather than one pointing at a 404. That is what keeps the 39th example's row
 * correct on the day its loom lands and its thumb has not.
 */
const THUMBNAILS = import.meta.glob("../../../examples/thumbs/*.png", {
  query: "?url",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

export interface ExampleProject {
  /** File name including the extension, e.g. `E1-Feedback-Echo.loom.json`. */
  readonly fileName: string;
  /** The project's own name, read from the file. */
  readonly name: string;
  /** Node count, so a row carries a size without a sentence about it. */
  readonly nodeCount: number;
  /** The bytes. `project.open` is handed exactly this (§V88). */
  readonly text: string;
  /**
   * First paragraph of the example's `.md`, as plain text. Empty when there is no `.md`
   * — never a placeholder sentence, because an invented description is worse than none.
   */
  readonly description: string;
  /** Derived from the node types in the file — see `categoryOf`. Never hand-assigned. */
  readonly category: ExampleCategory;
  /**
   * What the file DEMONSTRATES, derived from the same node types (T1162). Never empty,
   * never hand-assigned; `category` is its first medium member.
   */
  readonly tags: readonly ExampleTag[];
  /** `examples/thumbs/<stem>.png` if one has been rendered, else undefined (§T847). */
  readonly thumbnailUrl?: string;
}

function fileNameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** `E44-Sounding.loom.json` → `E44-Sounding`. The key the `.md` and the thumb share. */
function stemOf(fileName: string): string {
  return fileName.replace(/\.loom\.json$/, "");
}

/**
 * The capability vocabulary and the prose reader are IMPORTED, not defined here (T1211).
 *
 * They moved to `src/examples/capabilities.ts` the day a second reader appeared: the MCP
 * server derives the same tags in Node off `readdirSync`, and it cannot import this module
 * because `import.meta.glob` is a Vite transform. Re-exported so every existing consumer of
 * this file — the cards, the search, `example-tags.test.ts` — keeps its one import site, and
 * so a future third reader still finds one table rather than two.
 */
import {
  categoryOf,
  firstParagraph,
  tagsOf,
  type ExampleCategory,
  type ExampleTag,
} from "../../examples/capabilities.ts";

export {
  EXAMPLE_CAPABILITIES,
  capabilityOf,
  categoryOf,
  firstParagraph,
  tagsOf,
  type Capability,
  type ExampleCategory,
  type ExampleTag,
} from "../../examples/capabilities.ts";


/**
 * Both side globs re-keyed by file stem, which is the join `.loom.json`, `.md` and
 * `thumbs/*.png` share. One lookup each, and a missing side is simply a missing key.
 */
function byStem(entries: Readonly<Record<string, string>>, suffix: RegExp): Map<string, string> {
  return new Map(
    Object.entries(entries).map(([path, value]) => [fileNameOf(path).replace(suffix, ""), value]),
  );
}

const DESCRIPTIONS_BY_STEM = byStem(RAW_DESCRIPTIONS, /\.md$/);
const THUMBNAILS_BY_STEM = byStem(THUMBNAILS, /\.png$/);

/** Name and node count read from the file itself; never a second table to keep in sync. */
function describe(fileName: string, text: string): ExampleProject {
  let name = fileName;
  let nodeCount = 0;
  const nodeTypes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as { name?: unknown; graph?: { nodes?: unknown } };
      if (typeof record.name === "string" && record.name !== "") name = record.name;
      const nodes = record.graph?.nodes;
      if (typeof nodes === "object" && nodes !== null) {
        nodeCount = Object.keys(nodes).length;
        for (const node of Object.values(nodes as Record<string, unknown>)) {
          const type = (node as { type?: unknown } | null)?.type;
          if (typeof type === "string") nodeTypes.push(type);
        }
      }
    }
  } catch {
    // A malformed shipped file is the loader's finding, not this list's: the row stays,
    // named by its file, and opening it reports the real reason.
  }
  const stem = stemOf(fileName);
  const markdown = DESCRIPTIONS_BY_STEM.get(stem);
  const thumbnailUrl = THUMBNAILS_BY_STEM.get(stem);
  return {
    fileName,
    name,
    nodeCount,
    text,
    description: markdown === undefined ? "" : firstParagraph(markdown),
    category: categoryOf(nodeTypes),
    tags: tagsOf(nodeTypes),
    ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
  };
}

const EXAMPLE_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * THE example ordering — natural file-name order, and the only derivation of it.
 *
 * NATURAL, not lexicographic: plain `localeCompare` puts E10 immediately after E1 and
 * buries E2 seventh, which reads as "examples are missing" rather than as a sort. The
 * owner reported exactly that. `numeric` compares digit runs as numbers.
 *
 * Exported since T846 because the search's tie-break needs the same answer (§V487 — a
 * second collator is a value with two derivations that agree until one is edited).
 */
export function compareExamples(a: ExampleProject, b: ExampleProject): number {
  return EXAMPLE_ORDER.compare(a.fileName, b.fileName);
}

/** Every shipped example, in natural file-name order so the list never reshuffles. */
export function listExampleProjects(): readonly ExampleProject[] {
  return Object.entries(RAW_EXAMPLES)
    .map(([path, text]) => describe(fileNameOf(path), text))
    .sort(compareExamples);
}
