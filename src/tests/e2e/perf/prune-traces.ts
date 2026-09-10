import { readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/**
 * T1277 / §B206 — THE PERF HARNESS'S DISK HYGIENE.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/tests/e2e/perf/prune-traces.ts \
 *     scratchpad/perf [--keep N] [--protect <run name>]
 *
 * `run.sh` calls this on every invocation. It also stands alone, which is how a session
 * that ran the harness with `PERF_KEEP_TRACES=1` gets the bytes back.
 *
 * ⚑ WHAT IT MAY DELETE, AND WHY THAT LIST IS SO SHORT. §T1254, §T1264 and §T1248 each
 * cite a `scratchpad/perf/<timestamp>` directory as the evidence for a measurement the
 * owner has already acted on, so `summary.md` and the per-scenario `<fixture>.json` are
 * RECORD, not scratch. The only file this removes is a `*.trace.json` — 27–110 MB of raw
 * CDP events that nothing in the harness ever reads back (see `scenarios.ts`). It cannot
 * orphan a cited path because it never deletes a file that could be one.
 *
 * A run DIRECTORY is removed only when it held traces and nothing else, i.e. the whole
 * directory was the bytes we just took. A directory with no traces at all is left where
 * it is even when it is empty: an empty run directory is one another session has just
 * `mkdir`ed and is about to write into, and it costs nothing to leave.
 */

export const TRACE_SUFFIX = ".trace.json";

/** How many trace-bearing runs keep their traces. The run in progress is extra. */
export const DEFAULT_KEEP_RUNS = 3;

/**
 * The keep/discard decision for the RAW trace of a scenario, read from the environment
 * once per process. Any value other than the empty string and `0` means keep.
 */
export function keepRawTraces(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env["PERF_KEEP_TRACES"] ?? "";
  return value !== "" && value !== "0" && value !== "false";
}

export interface RunSnapshot {
  readonly name: string;
  /** Newest file mtime inside the run — the directory's own mtime is clobbered by a sweep. */
  readonly mtimeMs: number;
  readonly traces: readonly string[];
  /** Every other file: `summary.md`, `<fixture>.json`, `commit.txt`, `run-manifest.json`, … */
  readonly evidence: readonly string[];
}

export interface PrunePlan {
  /** `<run>/<file>` of every raw trace to remove. */
  readonly removeTraces: readonly string[];
  /** Run directories that held nothing but the traces above. */
  readonly removeDirs: readonly string[];
  /** Runs whose traces survive, newest first. */
  readonly keptTraceRuns: readonly string[];
}

/**
 * Pure: what a scan implies, with no filesystem in it. `protectedNames` is the run in
 * progress — always kept, and it does not consume the `keep` budget, so a run started
 * with `PERF_KEEP_TRACES=1` cannot evict the previous run's traces by existing.
 */
export function planPrune(
  runs: readonly RunSnapshot[],
  keep: number,
  protectedNames: readonly string[] = [],
): PrunePlan {
  const guarded = new Set(protectedNames);
  const withTraces = runs.filter((run) => run.traces.length > 0);
  const candidates = withTraces
    .filter((run) => !guarded.has(run.name))
    // Newest first; the name breaks a tie so the plan is the same on every machine.
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const keptNames = new Set([
    ...withTraces.filter((run) => guarded.has(run.name)).map((run) => run.name),
    ...candidates.slice(0, Math.max(0, keep)).map((run) => run.name),
  ]);
  const doomed = withTraces.filter((run) => !keptNames.has(run.name));
  return {
    removeTraces: doomed.flatMap((run) => run.traces.map((trace) => `${run.name}/${trace}`)),
    removeDirs: doomed.filter((run) => run.evidence.length === 0).map((run) => run.name),
    keptTraceRuns: [
      ...candidates.filter((run) => keptNames.has(run.name)).map((run) => run.name),
      ...withTraces.filter((run) => guarded.has(run.name)).map((run) => run.name),
    ],
  };
}

/** Reads one `scratchpad/perf`-shaped root into snapshots. Missing root ⇒ no runs. */
export function scanRuns(root: string): RunSnapshot[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: RunSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const traces: string[] = [];
    const evidence: string[] = [];
    let mtimeMs = 0;
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      (file.name.endsWith(TRACE_SUFFIX) ? traces : evidence).push(file.name);
      mtimeMs = Math.max(mtimeMs, statSync(join(dir, file.name)).mtimeMs);
    }
    runs.push({ name: entry.name, mtimeMs, traces, evidence });
  }
  return runs;
}

export interface PruneOutcome {
  readonly plan: PrunePlan;
  readonly bytes: number;
  readonly runs: number;
  readonly summaries: number;
}

/** Executes a plan against `root` and reports what it cost. */
export function applyPrune(root: string, runs: readonly RunSnapshot[], plan: PrunePlan): PruneOutcome {
  let bytes = 0;
  for (const trace of plan.removeTraces) {
    const path = join(root, trace);
    try {
      bytes += statSync(path).size;
    } catch {
      /* already gone — another session's sweep; deleting nothing is the same outcome */
    }
    rmSync(path, { force: true });
  }
  for (const dir of plan.removeDirs) rmSync(join(root, dir), { recursive: true, force: true });
  return {
    plan,
    bytes,
    runs: runs.length,
    summaries: runs.filter((run) => run.evidence.includes("summary.md")).length,
  };
}

export function describeOutcome(root: string, outcome: PruneOutcome): string {
  const { plan } = outcome;
  const kept = `${outcome.runs - plan.removeDirs.length} run dirs (${outcome.summaries} with a summary) untouched`;
  if (plan.removeTraces.length === 0) return `prune ${root}: no raw traces to remove; ${kept}.`;
  const gb = outcome.bytes / 1e9;
  const size = gb >= 1 ? `${gb.toFixed(2)} GB` : `${(outcome.bytes / 1e6).toFixed(0)} MB`;
  const dirs = plan.removeDirs.length === 0 ? "" : `, and ${plan.removeDirs.length} run dir(s) that held nothing else (${plan.removeDirs.join(", ")})`;
  const kepts = plan.keptTraceRuns.length === 0 ? "no run keeps traces" : `traces kept in ${plan.keptTraceRuns.join(", ")}`;
  return `prune ${root}: removed ${plan.removeTraces.length} raw trace(s), ${size}${dirs}; ${kepts}; ${kept}.`;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  // A flag's VALUE is never mistaken for the root: `--keep 3` must not leave "3" as the
  // directory to sweep.
  const positional: string[] = [];
  const protectedNames: string[] = [];
  let keepArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--keep") keepArg = args[(index += 1)];
    else if (arg === "--protect") protectedNames.push(args[(index += 1)] ?? "");
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  const root = positional[0] ?? "scratchpad/perf";
  const keep = Number(keepArg ?? DEFAULT_KEEP_RUNS);
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`--keep wants a non-negative integer, got ${String(keepArg)}`);
  const runs = scanRuns(root);
  console.log(describeOutcome(root, applyPrune(root, runs, planPrune(runs, keep, protectedNames.filter((name) => name !== "")))));
}
