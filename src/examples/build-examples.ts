import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR } from "./catalogue.ts";
import { buildExampleFiles } from "./example-files.ts";

/**
 * Regenerates `examples/*.loom.json` (T153-T156).
 *
 *   node --experimental-strip-types src/examples/build-examples.ts
 *
 * Running this is the ONLY way an example changes: edit `documents.ts`, re-run, commit the
 * regenerated file. `sync.test.ts` fails the build if a shipped file and its source have
 * drifted, so a hand-edit of the JSON is caught rather than quietly kept.
 *
 * Writing happens on import — this module is a script and nothing else imports it.
 */

for (const file of buildExampleFiles()) {
  const path = join(EXAMPLES_DIR, file.fileName);
  writeFileSync(path, file.text, "utf8");
  console.log(`wrote ${path}`);
}
