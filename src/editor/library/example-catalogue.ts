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
 * THE CAPABILITY TAGS (T1162) — what the example DEMONSTRATES, as opposed to what it
 * looks like.
 *
 * The owner's complaint was that a name plus a sentence of scene prose does not say what
 * a file is FOR: "Marionette is demonstrating pose, that is not clear." E34 Lidar opens
 * "a mast at the origin sweeps a ring of 240 rays over a dark terrain", which is the
 * picture and not the capability.
 *
 * A TAG IS A SUPERSET OF A CATEGORY, and that is the whole reason it earns its place
 * beside one. `categoryOf` is single-label WITH PRECEDENCE — E32 Pasture is filed under
 * `points` and its two feedback loops are invisible; E44 Sounding is filed under `video`
 * and its point cloud is invisible; E45 Pulse is `audio` and it is also a 3D scene full
 * of points. 15 examples close a temporal loop and 3 of them are categorised `feedback`.
 * So the tags are the multi-label truth the precedence throws away, plus four capabilities
 * the category taxonomy has no word for at all.
 *
 * DERIVED, never authored per example. An authored tag list is the artefact that goes
 * quietly wrong: E54 was rebuilt from a Laplacian into a trail system and E56 from a
 * position map into a rate drive within a week of each other, and hand-written tags would
 * still be describing the files they used to be. What IS authored here is one row per
 * capability — ten of them, not one per example — and every node type a row names is
 * checked against the registry by `example-tags.test.ts`, so a renamed node reddens a gate
 * rather than silently emptying a tag.
 */
export type ExampleTag = ExampleCategory | "wgsl" | "vision" | "device" | "component";

export interface Capability<Tag extends ExampleTag = ExampleTag> {
  readonly tag: Tag;
  /** What the badge says. Terse: the card's description carries the sentence. */
  readonly label: string;
  /** What the badge MEANS, on hover. A definition of the tag, never a claim about a file. */
  readonly meaning: string;
  /** Node types that earn the tag. Every one is asserted to be a registered type. */
  readonly nodeTypes: ReadonlySet<string>;
  /** Type PREFIX that earns the tag — component instances are `component:<name>@<v>`. */
  readonly typePrefix?: string;
}

/**
 * The MEDIUM rows, in PRECEDENCE ORDER — and the category taxonomy is now a projection of
 * exactly these (first match wins, `image` when none does).
 *
 * Precedence is the whole design of the CATEGORY, because the interesting examples match
 * several. The order runs from the ingredient that most changes what the file IS to the
 * one that least does: an audio input changes what every downstream parameter MEANS, so
 * E45 Pulse is an audio example even though it is also a 3D scene full of points; footage
 * changes where the picture comes from, so E44 Sounding is a video example even though
 * what it renders is a point cloud; a camera makes it a 3D scene; points make it a point
 * system; a feedback edge makes it a simulation.
 *
 * §V487/§V748: these sets were the body of `CATEGORY_SIGNATURES` and are unchanged, so
 * every shipped example keeps the category it had — `example-tags.test.ts` pins that by
 * asserting `categoryOf` IS the first medium tag for all 57. The tags do not re-derive
 * them; there is one table and two readings of it.
 *
 * Measured over the 57 examples shipped at T1162, audio / video / 3d / points / feedback /
 * image runs 17 / 14 / 17 / 26 / 15 / 14 AS TAGS and 17 / 8 / 9 / 6 / 3 / 14 AS CATEGORIES.
 * Precedence costs `points` twenty files and `feedback` twelve, and that gap is the whole
 * argument for shipping both readings rather than one.
 */
const MEDIUM_SIGNATURES: readonly Capability<ExampleCategory>[] = [
  {
    tag: "audio",
    label: "audio",
    meaning: "A sound signal drives the graph: an audio file, a beat pattern, or a meter.",
    nodeTypes: new Set(["audioFileIn", "audioPattern", "analyze", "channelIn"]),
  },
  {
    tag: "video",
    label: "video",
    meaning: "Footage or a live camera is in the chain, not a generated picture.",
    nodeTypes: new Set(["movieFileIn", "webcam", "depth", "slitScan"]),
  },
  {
    tag: "3d",
    label: "3D",
    meaning: "A 3D scene: a camera, geometry, lights and materials rendered to a texture.",
    nodeTypes: new Set([
      "camera",
      "geometry",
      "light",
      "materialUnlit",
      "materialPhong",
      "materialGlass",
      "render",
      "projector",
    ]),
  },
  {
    tag: "points",
    label: "points",
    meaning: "A GPU point system: attributes in buffers, a kernel over them, an instanced draw.",
    nodeTypes: new Set([
      "pointBox",
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
  },
  {
    // `feedback` only. `cache` was in this set and taken back out: three examples hold a
    // frame without being simulations, and it pulled them out of the categories that
    // actually describe them.
    tag: "feedback",
    label: "feedback",
    meaning: "Closes a temporal loop: this frame reads the frame before it.",
    nodeTypes: new Set(["feedback"]),
  },
];

/**
 * The medium fallback. Reached when an example uses no audio, no footage, no camera, no
 * point system and no feedback loop — a flat texture chain, which is a real and
 * recognisable kind of file and not a bucket someone forgot to fill. 14 of the 57 shipped
 * examples reach it.
 *
 * The SAME predicate as the category fallback, deliberately: `image` is in the tags exactly
 * when the category is `image`, so the two never say different things about the same file.
 * Half of those 14 also carry `wgsl`, which is the pairing that makes the fallback worth
 * rendering at all — "a flat texture chain, with a hand-written shader in it" is a real
 * description, and neither half says it alone.
 */
const IMAGE: Capability<ExampleCategory> = {
  tag: "image",
  label: "image",
  meaning: "A flat texture chain: generators and per-pixel filters, no simulation and no scene.",
  nodeTypes: new Set(),
};

/**
 * The TECHNIQUE rows. No category counterpart, which is the point of them — these are the
 * four things the six-bucket taxonomy has no word for, and three of the four are what
 * §T728's coverage census is about.
 *
 * They do not participate in `categoryOf`. Adding one cannot move an example between
 * groups; it can only add a badge.
 */
const TECHNIQUE_SIGNATURES: readonly Capability[] = [
  {
    tag: "wgsl",
    label: "WGSL",
    meaning: "Carries hand-written WGSL — a shader authored in the file rather than a node chain.",
    nodeTypes: new Set(["customWgsl"]),
  },
  {
    // `depth` is deliberately in BOTH this row and `video`: it reads footage AND infers
    // structure from it. Tags are multi-label, so it does not have to be filed as one
    // or the other the way a category does.
    tag: "vision",
    label: "vision",
    meaning: "Infers structure from an image on-device: body pose, a person matte, or depth.",
    nodeTypes: new Set(["pose", "personMask", "matte", "depth"]),
  },
  {
    // `laserPath` with no `laserOut` is E49 and E50: they PLAN for the hardware without
    // opening the DAC, which is why the meaning says "plans or drives" rather than "sends".
    tag: "device",
    label: "device",
    meaning: "Plans or drives hardware over the local bridge: a laser, OSC, or MIDI.",
    nodeTypes: new Set(["oscIn", "oscOut", "laserOut", "laserPath", "midiIn"]),
  },
  {
    tag: "component",
    label: "component",
    meaning: "Instantiates a component — a subgraph reused as one node, flattened at compile.",
    nodeTypes: new Set(),
    typePrefix: "component:",
  },
];

/** Every capability row, in the order a card renders them: medium first, then technique. */
export const EXAMPLE_CAPABILITIES: readonly Capability[] = [
  ...MEDIUM_SIGNATURES,
  IMAGE,
  ...TECHNIQUE_SIGNATURES,
];

function earns(capability: Capability, used: ReadonlySet<string>): boolean {
  for (const type of used) {
    if (capability.nodeTypes.has(type)) return true;
    if (capability.typePrefix !== undefined && type.startsWith(capability.typePrefix)) return true;
  }
  return false;
}

/**
 * Every capability a set of node types earns, medium tags first. Never empty: an example
 * that earns no medium tag earns `image`, which is the same predicate `categoryOf` falls
 * back on, so `image` is in the tags exactly when the category is `image`.
 *
 * Pure, so the gate can call it on a fixture with the capability and a fixture without.
 */
export function tagsOf(nodeTypes: Iterable<string>): readonly ExampleTag[] {
  const used = new Set(nodeTypes);
  const medium = MEDIUM_SIGNATURES.filter((capability) => earns(capability, used));
  const technique = TECHNIQUE_SIGNATURES.filter((capability) => earns(capability, used));
  return [...(medium.length === 0 ? [IMAGE] : medium), ...technique].map(({ tag }) => tag);
}

/** The card's label and hover meaning for one tag. */
export function capabilityOf(tag: ExampleTag): Capability {
  const capability = EXAMPLE_CAPABILITIES.find((entry) => entry.tag === tag);
  // Unreachable through `tagsOf`, which only ever returns rows from this same list; the
  // throw is for a caller that invents a tag rather than deriving one.
  if (capability === undefined) throw new Error(`no capability row for tag ${tag}`);
  return capability;
}

/**
 * The category for a set of node types: the FIRST medium tag, or `image`. Pure, so the
 * gate can call it on a fixture.
 */
export function categoryOf(nodeTypes: Iterable<string>): ExampleCategory {
  const used = new Set(nodeTypes);
  return MEDIUM_SIGNATURES.find((capability) => earns(capability, used))?.tag ?? IMAGE.tag;
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
