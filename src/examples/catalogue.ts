import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_FILE_EXTENSION } from "../domain/project/index.ts";
import { libraryEntry, type LibraryEntry } from "./library-entry.ts";

/**
 * Discovery of the shipped examples (T157).
 *
 * The runner walks the DIRECTORY. There is no list of example names anywhere in the suite,
 * on purpose: §V89 makes every example a release gate, and a gate you have to remember to
 * add a file to is a gate that eventually has a hole in it. Dropping a `.loom.json` into
 * `examples/` is the whole registration step.
 *
 * Node-only (`node:fs`). The runner is a headless vitest test; nothing in the app imports
 * this.
 */

/** Absolute path of the `examples/` directory, resolved from this module rather than cwd. */
export const EXAMPLES_DIR = fileURLToPath(new URL("../../examples/", import.meta.url));

/**
 * Where the starter COMPONENTS ship (T190, §V94).
 *
 * A subdirectory, and that is load-bearing rather than tidy: `listExamples` reads
 * `EXAMPLES_DIR` non-recursively and so does the browser glob in
 * `src/editor/library/example-catalogue.ts`, so a component file cannot accidentally
 * become an entry in the EXAMPLES library. They are different libraries with different
 * verbs — open vs instantiate (§V93) — and a file in the wrong one offers the wrong verb.
 */
export const STARTER_COMPONENTS_DIR = fileURLToPath(
  new URL("../../examples/components/", import.meta.url),
);

export interface ExampleFile {
  /** File name including the extension, e.g. `E1-Feedback-Echo.loom.json`. */
  readonly fileName: string;
  readonly path: string;
  /** The bytes as they are shipped. The loader is given exactly this. */
  readonly text: string;
}

function listDirectory(directory: string): readonly ExampleFile[] {
  const fileNames = readdirSync(directory)
    .filter((name) => name.endsWith(PROJECT_FILE_EXTENSION))
    .sort();

  return fileNames.map((fileName) => {
    const path = join(directory, fileName);
    return { fileName, path, text: readFileSync(path, "utf8") };
  });
}

/** Every `.loom.json` in `examples/`, sorted by file name so runs are reproducible. */
export function listExamples(): readonly ExampleFile[] {
  return listDirectory(EXAMPLES_DIR);
}

/** Every shipped starter component file, sorted by file name. Same discovery rule. */
export function listStarterComponentFiles(): readonly ExampleFile[] {
  return listDirectory(STARTER_COMPONENTS_DIR);
}

/**
 * The shipped corpus, as the HEADLESS MCP server reads it (T1211).
 *
 * The browser half is `createAgentLibraryCatalogue` in `src/editor/library/agent-library.ts`.
 * The two cannot share a directory read — one is `import.meta.glob`, this one is
 * `readdirSync` — so they share the DERIVATION instead (`libraryEntry`, over §T1162's tag
 * table) and answer identically about the same file. §V941's rule: two entrances, one rite.
 *
 * Read once and cached. The corpus is 66 files that ship inside the build; re-walking the
 * directory per tool call would let a listing change under a client mid-session for no
 * reason a client could act on.
 */
export function createNodeLibraryCatalogue(): {
  list(): readonly LibraryEntry[];
  read(fileName: string): string | undefined;
} {
  let entries: readonly LibraryEntry[] | undefined;
  let bytes: Map<string, string> | undefined;

  const build = (): void => {
    if (entries !== undefined) return;
    const rows: LibraryEntry[] = [];
    const texts = new Map<string, string>();
    for (const file of listExamples()) {
      texts.set(file.fileName, file.text);
      rows.push(
        libraryEntry({
          fileName: file.fileName,
          kind: "example",
          text: file.text,
          markdown: readMarkdownBeside(file.path),
        }),
      );
    }
    for (const file of listStarterComponentFiles()) {
      texts.set(file.fileName, file.text);
      rows.push(libraryEntry({ fileName: file.fileName, kind: "component", text: file.text }));
    }
    entries = rows;
    bytes = texts;
  };

  return {
    list() {
      build();
      return entries ?? [];
    },
    read(fileName) {
      build();
      return bytes?.get(fileName);
    },
  };
}

/**
 * `E13-Prism.loom.json` → the bytes of `E13-Prism.md`, or undefined.
 *
 * Undefined and never a placeholder: an example whose prose has not landed yet gets an empty
 * summary, which is honest, where an invented sentence would be a claim nothing checks.
 */
function readMarkdownBeside(loomPath: string): string | undefined {
  try {
    return readFileSync(loomPath.replace(new RegExp(`${PROJECT_FILE_EXTENSION}$`), ".md"), "utf8");
  } catch {
    return undefined;
  }
}
