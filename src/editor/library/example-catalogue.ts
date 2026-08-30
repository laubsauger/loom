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

export interface ExampleProject {
  /** File name including the extension, e.g. `E1-Feedback-Echo.loom.json`. */
  readonly fileName: string;
  /** The project's own name, read from the file. */
  readonly name: string;
  /** Node count, so a row carries a size without a sentence about it. */
  readonly nodeCount: number;
  /** The bytes. `project.open` is handed exactly this (§V88). */
  readonly text: string;
}

function fileNameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Name and node count read from the file itself; never a second table to keep in sync. */
function describe(fileName: string, text: string): ExampleProject {
  let name = fileName;
  let nodeCount = 0;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as { name?: unknown; graph?: { nodes?: unknown } };
      if (typeof record.name === "string" && record.name !== "") name = record.name;
      const nodes = record.graph?.nodes;
      if (typeof nodes === "object" && nodes !== null) nodeCount = Object.keys(nodes).length;
    }
  } catch {
    // A malformed shipped file is the loader's finding, not this list's: the row stays,
    // named by its file, and opening it reports the real reason.
  }
  return { fileName, name, nodeCount, text };
}

const EXAMPLE_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Every shipped example, in natural file-name order so the list never reshuffles. */
export function listExampleProjects(): readonly ExampleProject[] {
  return Object.entries(RAW_EXAMPLES)
    .map(([path, text]) => describe(fileNameOf(path), text))
    // NATURAL order, not lexicographic: plain `localeCompare` puts E10 immediately after
    // E1 and buries E2 seventh, which reads as "examples are missing" rather than as a
    // sort. The owner reported exactly that. `numeric` compares digit runs as numbers.
    .sort((a, b) => EXAMPLE_ORDER.compare(a.fileName, b.fileName));
}
