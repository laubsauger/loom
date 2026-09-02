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
 * THE EXAMPLE CATEGORIES (T846) — six, DERIVED from the node types the file uses.
 *
 * Derived rather than declared, and the choice is forced by §V88 more than by taste. An
 * explicit field would have to live somewhere: in the `.loom.json`, where it would be a
 * key the document schema does not name (the exact thing §T848 is preparing to gate), or
 * in a table beside this glob, which is the "second table to keep in sync" the read
 * above already refuses. Derivation reads the SAME BYTES the runner gates on, so a
 * category cannot disagree with the file it describes, and a new example is categorised
 * the moment it is dropped in — §T732's rule that the category set grow with the
 * catalogue rather than with someone's memory.
 *
 * `image` is the fallback, not a bucket someone forgot to fill: an example that reaches
 * it uses no audio, no footage, no camera, no point system and no feedback loop, which
 * is a real and recognisable kind of file — a flat texture chain.
 */
export type ExampleCategory = "audio" | "video" | "3d" | "points" | "feedback" | "image";

/**
 * The signature node types, in PRECEDENCE ORDER — first match wins.
 *
 * Precedence is the whole design, because the interesting examples match several. The
 * order runs from the ingredient that most changes what the file IS to the one that
 * least does: an audio input changes what every downstream parameter MEANS, so E45 Pulse
 * is an audio example even though it is also a 3D scene full of points; footage changes
 * where the picture comes from, so E44 Sounding is a video example even though what it
 * renders is a point cloud; a camera makes it a 3D scene; points make it a point system;
 * a feedback edge makes it a simulation. Cross-cutting discovery is search's job, not the
 * taxonomy's — "points" typed into the box finds E45 through its description.
 *
 * The distribution over the 38 shipped examples is 12 / 4 / 8 / 4 / 3 / 7. That is the
 * test of a taxonomy: no bucket holds one file, and none holds most of them.
 */
const CATEGORY_SIGNATURES: readonly (readonly [ExampleCategory, ReadonlySet<string>])[] = [
  ["audio", new Set(["audioFileIn", "audioPattern", "analyze", "channelIn"])],
  ["video", new Set(["movieFileIn", "webcam", "depth", "slitScan"])],
  [
    "3d",
    new Set([
      "camera",
      "geometry",
      "light",
      "materialUnlit",
      "materialPhong",
      "materialGlass",
      "render",
      "projector",
    ]),
  ],
  [
    "points",
    new Set([
      "pointGenerator",
      "pointGrid",
      "pointKernel",
      "pointKernelAdvanced",
      "pointLine",
      "pointProximity",
      "pointRay",
      "pointSphere",
      "pointTopology",
      "pointTorus",
      "pointTube",
      "pointsFromTexture",
      "renderInstances",
      "renderPoints",
      "textureToAttribute",
    ]),
  ],
  // `feedback` only. `cache` was in this set and taken back out: three examples hold a
  // frame without being simulations, and it pulled them out of the categories that
  // actually describe them.
  ["feedback", new Set(["feedback"])],
];

/** The category for a set of node types. Pure, so the gate can call it on a fixture. */
export function categoryOf(nodeTypes: Iterable<string>): ExampleCategory {
  const used = new Set(nodeTypes);
  for (const [category, signature] of CATEGORY_SIGNATURES) {
    for (const type of used) if (signature.has(type)) return category;
  }
  return "image";
}

/**
 * Markdown stripped to the plain sentence a card shows.
 *
 * Only the inline forms the example docs actually use — code spans, links, bold, italic.
 * Not a markdown parser: this reads one paragraph of curated prose, and a parser here
 * would be machinery for a job the corpus does not have.
 */
function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The description: the `.md`'s first PROSE paragraph.
 *
 * Every shipped example opens `# En — Name`, a blank line, then the sentence that says
 * what the thing is. Headings, fences, tables, quotes and list items are skipped so the
 * rule survives a file that opens differently, and a file with no prose at all yields
 * "" rather than a heading masquerading as a description.
 */
export function firstParagraph(markdown: string): string {
  for (const block of markdown.split(/\n[ \t]*\n/)) {
    const text = block.trim();
    if (text === "") continue;
    if (NOT_PROSE.test(text)) continue;
    return plainText(text);
  }
  return "";
}

/**
 * Blocks that are structure rather than sentences.
 *
 * The list markers require a FOLLOWING SPACE, and that is not fussiness — `*` and `-`
 * open a bullet only when spaced, and a bare `[-*+]` guard silently swallows any
 * paragraph that opens in **bold** or *italic*. No shipped example does today; the guard
 * that assumes none ever will is the kind that fails on the file nobody re-checked.
 */
const NOT_PROSE = /^(#|>|\||```|<|[-*+][ \t]|\d+[.)][ \t]|-{3,}$)/;

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
