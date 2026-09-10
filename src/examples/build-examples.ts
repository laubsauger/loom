import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR, STARTER_COMPONENTS_DIR } from "./catalogue.ts";
import { buildStarterComponentFiles } from "./component-files.ts";
import { buildStarterComponents } from "./starter-components.ts";
import { buildExampleFiles } from "./example-files.ts";
import { matchesOnlyFlag } from "./only-flag.ts";

/**
 * Regenerates `examples/*.loom.json` and `examples/components/*.loom.json` (T153-T156, T190).
 *
 *   node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts
 *
 * Running this is the ONLY way an example changes: edit `documents.ts`, re-run, commit the
 * regenerated file. `sync.test.ts` fails the build if a shipped file and its source have
 * drifted, so a hand-edit of the JSON is caught rather than quietly kept.
 *
 * Writing happens on import — this module is a script and nothing else imports it.
 */

/**
 * T698: `--only <name>` writes just the matching examples. Five workers share this
 * tree through windowed files, and a bare regen sweeps up every other worker's
 * in-flight document changes — regenerate only what your change touched.
 *
 * T1267/B197: an E-number argument (`--only E2`) names ONE example and is matched exactly;
 * substring matching is kept for every other shape (`--only E2-Reaction`, `--only Reaction`).
 * See `only-flag.ts`.
 */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
if (onlyAt >= 0 && only === undefined) throw new Error("--only needs a name substring");

/* T956: examples that INSTANCE a library component embed its definition, so the starter
   set is authored first even under --only — the definitions are deterministic and cheap. */
const starterDefinitions = (await buildStarterComponents()).map((built) => built.definition);

const selected = buildExampleFiles(starterDefinitions).filter(
  (file) => only === undefined || matchesOnlyFlag(file.fileName, only),
);
if (only !== undefined && selected.length === 0) throw new Error(`--only ${only} matched no example`);

/* T1267: say what is about to be OVERWRITTEN before a byte moves, scoped run or not — the
   sweep in B197 was invisible until `git status` showed seven foreign files rewritten. */
console.log(`writing ${selected.length} example${selected.length === 1 ? "" : "s"}: ${selected.map((file) => file.fileName).join(", ")}`);

for (const file of selected) {
  const path = join(EXAMPLES_DIR, file.fileName);
  writeFileSync(path, file.text, "utf8");
  console.log(`wrote ${path}`);
}

// Components are authored by running the real authoring commands, so this half is async.
// Skipped under --only: the flag scopes a regen to named EXAMPLES.
for (const file of only !== undefined ? [] : await buildStarterComponentFiles()) {
  const path = join(STARTER_COMPONENTS_DIR, file.fileName);
  writeFileSync(path, file.text, "utf8");
  console.log(`wrote ${path}`);
}
