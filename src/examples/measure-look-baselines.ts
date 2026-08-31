import { writeFileSync } from "node:fs";
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

const entries: Record<string, { motion: number; range: number; f0max: number }> = {};
for (const document of EXAMPLE_DOCUMENTS) {
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
const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
const path = join(import.meta.dirname, "look-baselines.json");
writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${path}`);
