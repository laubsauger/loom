import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATEGORIES, percentile, mean } from "../../perf/trace-parser.ts";
import type { ScenarioResult } from "./scenarios.ts";

/**
 * Turns `PERF_OUT_DIR/<fixture>.json` into the markdown tables of the report (T1235).
 *
 *   node --import ./src/tooling/alias-hooks.ts src/tests/e2e/perf/summarize.ts <out dir>
 *
 * Every table carries N (frames or inputs), and the same-run controls of the block. The
 * script prints; the report author pastes and annotates — the numbers are never retyped.
 */
interface FixtureFile {
  readonly fixture: string;
  readonly path: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly gpu: string;
  readonly displayIntervalMs: number;
  readonly userAgent: string;
  readonly when: string;
  readonly results: ScenarioResult[];
}

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: summarize.ts <out dir>");

const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json") && !name.endsWith(".trace.json") && !name.endsWith(".loom.json"))
  .sort();

const fmt = (value: number, digits = 2): string => (Number.isNaN(value) ? "n/a" : value.toFixed(digits));
const med = (values: readonly number[]): number => percentile(values, 50);

for (const file of files) {
  const data = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as FixtureFile;
  console.log(`\n## ${data.fixture} — ${data.nodeCount} nodes, ${data.edgeCount} edges\n`);
  console.log(`Adapter ${data.gpu}; display interval ${fmt(data.displayIntervalMs)} ms (30 rAF stamps); ${data.when}; ${data.userAgent.replace(/^.*Chrome\//, "Chrome ").replace(/ .*$/, "")}.\n`);

  console.log("### Per-scenario frame budget\n");
  console.log("| scenario | variant | pass | N frames | interval p50 / p95 ms | busy p50 / p95 / mean ms | script mean | style | layout | paint | gc | React commits | control cheap / dear ms |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const result of data.results) {
    const frames = result.frames;
    const controls = `${fmt(med(result.controls.cheapMs))} / ${fmt(med(result.controls.dearMs))}`;
    if (frames === null) {
      console.log(`| ${result.scenario} | ${result.variant} | ${result.pass} | <2 | — | busy ${fmt(result.busyMs, 0)} of ${fmt(result.windowMs, 0)} | — | — | — | — | — | ${result.reactCommits.count} | ${controls} |`);
      continue;
    }
    console.log(
      `| ${result.scenario} | ${result.variant} | ${result.pass} | ${frames.frames} | ${fmt(frames.intervalMs.p50)} / ${fmt(frames.intervalMs.p95)} | ${fmt(frames.busyMs.p50)} / ${fmt(frames.busyMs.p95)} / ${fmt(frames.busyMs.mean)} | ${fmt(frames.scriptTotalMs)} | ${fmt(frames.styleMs)} | ${fmt(frames.layoutMs)} | ${fmt(frames.paintMs)} | ${fmt(frames.gcMs)} | ${result.reactCommits.count} | ${controls} |`,
    );
  }

  console.log("\n### Script time by category, mean ms per frame window (leaf-first attribution; `entry` = outermost frame)\n");
  const shown = CATEGORIES.filter((category) => data.results.some((result) => (result.frames?.scriptMs[category] ?? 0) >= 0.02 || (result.frames?.entryMs[category] ?? 0) >= 0.02));
  console.log(`| scenario | pass | ${shown.map((category) => `${category}`).join(" | ")} |`);
  console.log(`|---|---|${shown.map(() => "---").join("|")}|`);
  for (const result of data.results) {
    if (result.frames === null) continue;
    console.log(`| ${result.scenario} ${result.variant} | ${result.pass} | ${shown.map((category) => fmt(result.frames!.scriptMs[category])).join(" | ")} |`);
    console.log(`| ↳ entry | ${result.pass} | ${shown.map((category) => fmt(result.frames!.entryMs[category])).join(" | ")} |`);
  }

  console.log("\n### Heaviest entry points (ms inside the window, whole stack charged to the outermost frame)\n");
  for (const result of data.results) {
    console.log(`- **${result.scenario} ${result.variant} pass ${result.pass}** (${fmt(result.windowMs, 0)} ms window, ${fmt(result.busyMs, 0)} ms busy): ` + result.topEntries.slice(0, 8).map((entry) => `${entry.label} ${fmt(entry.ms, 1)}`).join("; "));
  }

  console.log("\n### Input latency (dispatch → end of next main-thread Commit)\n");
  console.log("| scenario | pass | inputs | landed | p50 ms | p95 ms | max ms | handler p50 ms |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const result of data.results) {
    if (result.latencies === null) continue;
    const landed = result.latencies.map((latency) => latency.toCommitMs).filter((value): value is number => value !== null);
    const handlers = result.latencies.map((latency) => latency.handlerMs);
    console.log(`| ${result.scenario} ${result.variant} | ${result.pass} | ${result.latencies.length} | ${landed.length} | ${fmt(percentile(landed, 50))} | ${fmt(percentile(landed, 95))} | ${fmt(landed.length === 0 ? Number.NaN : Math.max(...landed))} | ${fmt(percentile(handlers, 50))} |`);
  }

  console.log("\n### React commits and component renders (devtools hook; fibers with PerformedWork)\n");
  for (const result of data.results) {
    const commits = result.reactCommits;
    const durations = commits.actualDurationMs.filter((value) => !Number.isNaN(value));
    const performed = commits.performedFibers.filter((value) => value >= 0);
    const top = Object.entries(result.renders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => `${name} ×${count}`)
      .join(", ");
    console.log(
      `- **${result.scenario} ${result.variant} pass ${result.pass}**: ${commits.count} commits in ${fmt(result.windowMs, 0)} ms` +
        (durations.length > 0 ? `; actualDuration p50 ${fmt(percentile(durations, 50))} / p95 ${fmt(percentile(durations, 95))} ms, sum ${fmt(durations.reduce((a, b) => a + b, 0), 0)} ms` : "") +
        (performed.length > 0 ? `; fibers rendered per commit p50 ${fmt(percentile(performed, 50), 0)} / max ${Math.max(...performed)}` : "") +
        (top.length > 0 ? `; top: ${top}` : ""),
    );
    // Commits grouped by shape: what kind of update they were, how many, what they cost.
    const groups = new Map<string, { count: number; ms: number; fibers: number[] }>();
    commits.signatures.forEach((signature, index) => {
      if (signature === "") return;
      const group = groups.get(signature) ?? { count: 0, ms: 0, fibers: [] };
      group.count += 1;
      group.ms += commits.actualDurationMs[index] ?? 0;
      group.fibers.push(commits.performedFibers[index] ?? 0);
      groups.set(signature, group);
    });
    const ranked = [...groups].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6);
    for (const [signature, group] of ranked) {
      console.log(`  - ${group.count}× \`${signature}\` — ${fmt(group.ms, 0)} ms render, ${fmt(group.ms / group.count)} ms each, ${fmt(percentile(group.fibers, 50), 0)} fibers p50`);
    }
  }

  console.log("\n### Hub readings (performance panel / top bar, read from the DOM at the end of the window)\n");
  for (const result of data.results) {
    if (result.hub === null) continue;
    console.log(`- **${result.scenario} ${result.variant} pass ${result.pass}**: fps ${result.hub["fps"]}, gpu ${result.hub["gpuTopBar"]}; ${result.hub["frame"]}; plan: ${result.hub["plan"]}`);
    if (result.hub["cost"]) console.log(`  cost rows: ${result.hub["cost"]}`);
  }

  console.log("\n### Timeline span counts inside the window\n");
  for (const result of data.results) {
    const interesting = ["FunctionCall", "TimerFire", "FireAnimationFrame", "EventDispatch", "Layout", "UpdateLayoutTree", "Paint", "Commit", "MinorGC", "MajorGC", "UserTiming::Measure"];
    console.log(`- **${result.scenario} ${result.variant} pass ${result.pass}**: ` + interesting.filter((name) => result.spans[name]).map((name) => `${name} ${result.spans[name]!.count}× ${fmt(result.spans[name]!.ms, 0)} ms`).join("; "));
  }

  console.log(`\n### Notes\n`);
  for (const result of data.results) {
    // A window that should hold no input but does was touched by a real mouse (seen twice:
    // 102 pointermoves, 16 wheels and 3 clicks inside one "idle" window; 5 keydowns in
    // another). Only pointer/wheel/key types count — the DOM raises `slotchange` bursts
    // on its own. Say so beside the row.
    const events = Object.entries(result.spans)
      .filter(([name]) => /^EventDispatch:(pointer|mouse|wheel|key)/.test(name))
      .reduce((sum, [, span]) => sum + span.count, 0);
    const foreign = (result.scenario === "A" || result.scenario === "B") && events > 3 ? ` — ⚠ ${events} pointer/wheel/key events dispatched inside an idle window: foreign input, discard` : "";
    console.log(`- ${result.scenario} ${result.variant} pass ${result.pass}: ${result.note}${foreign}`);
  }
  void mean;
}
