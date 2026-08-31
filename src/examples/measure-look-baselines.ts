import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { exampleFileNameOf, measure } from "./look-instrument.ts";

/**
 * Regenerates `look-baselines.json` (T690, §V643).
 *
 *   node --import ./src/mcp/alias-hooks.ts src/examples/measure-look-baselines.ts
 *
 * Run this ONLY in the same commit as work that deliberately changes how an example
 * looks, and state the delta in that commit's message (§V642: reverting a parameter is
 * not reverting an effect — re-measure and say what moved). liveness.test.ts fails
 * naming each drifted example precisely so the update cannot happen reflexively.
 */

/**
 * T698/§V643: `--only <substring>` re-measures just the matching examples and MERGES
 * into the existing file — a worker landing one deliberate look move must not sweep
 * up (or hand-measure around) everyone else's rows. Bare invocation still re-seeds
 * all 28, which per §V646 belongs on a CLEAN tree only.
 */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
if (onlyAt >= 0 && only === undefined) throw new Error("--only needs a name substring");

const path = join(import.meta.dirname, "look-baselines.json");
const entries: Record<string, { motion: number; range: number; f0max: number }> =
  only === undefined ? {} : (JSON.parse(readFileSync(path, "utf8")) as typeof entries);
let matched = 0;
for (const document of EXAMPLE_DOCUMENTS) {
  if (only !== undefined && !exampleFileNameOf(document.name).includes(only)) continue;
  matched += 1;
  const outputNodeId = Object.values(document.graph.nodes).find((node) => node.type === "output")?.id;
  if (outputNodeId === undefined) throw new Error(`${document.name}: no output node`);
  const reading = await measure(document.graph, document.settings, outputNodeId);
  entries[exampleFileNameOf(document.name)] = {
    motion: Number(reading.motion.toFixed(5)),
    range: Number(reading.range.toFixed(4)),
    f0max: Number(reading.firstFrameMax.toFixed(4)),
  };
  console.log(`${exampleFileNameOf(document.name)} measured`);
}
if (only !== undefined && matched === 0) throw new Error(`--only ${only} matched no example`);
const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${path}${only === undefined ? "" : ` (merged ${matched} row${matched === 1 ? "" : "s"})`}`);
