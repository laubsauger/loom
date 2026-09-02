import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { exampleFileNameOf } from "./look-instrument.ts";
import { EXAMPLES_DIR } from "./catalogue.ts";
import { renderThumbnail, thumbnailStem } from "./thumbnail.ts";
import { starterComponentsView } from "./component-files.ts";

/**
 * Regenerates `examples/thumbs/<ExampleFileStem>.png` (T847), one still per example at
 * §T794's CARD_FRAME.
 *
 *   node --import ./src/mcp/alias-hooks.ts src/examples/build-thumbnails.ts [--only <name>]
 *
 * A thumbnail is a §V642 baseline in disguise: run this in the SAME commit as work that
 * changes how an example looks, and `thumbnails.test.ts` fails if a shipped loom has no
 * thumb (§V775 — the gate closes the class, not the instance). `--only <substring>`
 * regenerates just the matching examples, exactly as the look-baseline regenerator does.
 */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
if (onlyAt >= 0 && only === undefined) throw new Error("--only needs a name substring");

const thumbsDir = join(EXAMPLES_DIR, "thumbs");
mkdirSync(thumbsDir, { recursive: true });

let matched = 0;
for (const document of EXAMPLE_DOCUMENTS) {
  const loomName = exampleFileNameOf(document.name);
  if (only !== undefined && !loomName.includes(only)) continue;
  matched += 1;
  const outputNodeId = Object.values(document.graph.nodes).find((node) => node.type === "output")?.id;
  if (outputNodeId === undefined) throw new Error(`${document.name}: no output node`);
  const png = await renderThumbnail(document.graph, document.settings, outputNodeId, await starterComponentsView());
  const path = join(thumbsDir, `${thumbnailStem(loomName)}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${(png.length / 1024).toFixed(1)} KB)`);
}
if (only !== undefined && matched === 0) throw new Error(`--only ${only} matched no example`);
console.log(`${matched} thumbnail${matched === 1 ? "" : "s"} written`);
