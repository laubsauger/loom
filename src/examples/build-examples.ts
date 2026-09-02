import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR, STARTER_COMPONENTS_DIR } from "./catalogue.ts";
import { buildStarterComponentFiles } from "./component-files.ts";
import { buildStarterComponents } from "./starter-components.ts";
import { buildExampleFiles } from "./example-files.ts";

/**
 * Regenerates `examples/*.loom.json` and `examples/components/*.loom.json` (T153-T156, T190).
 *
 *   node --import ./src/mcp/alias-hooks.ts src/examples/build-examples.ts
 *
 * Running this is the ONLY way an example changes: edit `documents.ts`, re-run, commit the
 * regenerated file. `sync.test.ts` fails the build if a shipped file and its source have
 * drifted, so a hand-edit of the JSON is caught rather than quietly kept.
 *
 * Writing happens on import — this module is a script and nothing else imports it.
 */

/**
 * T698: `--only <substring>` writes just the matching examples. Five workers share this
 * tree through windowed files, and a bare regen sweeps up every other worker's
 * in-flight document changes — regenerate only what your change touched.
 */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
if (onlyAt >= 0 && only === undefined) throw new Error("--only needs a name substring");

/* T956: examples that INSTANCE a library component embed its definition, so the starter
   set is authored first even under --only — the definitions are deterministic and cheap. */
const starterDefinitions = (await buildStarterComponents()).map((built) => built.definition);

let wrote = 0;
for (const file of buildExampleFiles(starterDefinitions)) {
  if (only !== undefined && !file.fileName.includes(only)) continue;
  const path = join(EXAMPLES_DIR, file.fileName);
  writeFileSync(path, file.text, "utf8");
  console.log(`wrote ${path}`);
  wrote += 1;
}
if (only !== undefined && wrote === 0) throw new Error(`--only ${only} matched no example`);

// Components are authored by running the real authoring commands, so this half is async.
// Skipped under --only: the flag scopes a regen to named EXAMPLES.
for (const file of only !== undefined ? [] : await buildStarterComponentFiles()) {
  const path = join(STARTER_COMPONENTS_DIR, file.fileName);
  writeFileSync(path, file.text, "utf8");
  console.log(`wrote ${path}`);
}
