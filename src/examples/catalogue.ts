import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_FILE_EXTENSION } from "../domain/project/index.ts";

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
