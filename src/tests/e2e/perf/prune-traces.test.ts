import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPrune,
  describeOutcome,
  keepRawTraces,
  planPrune,
  scanRuns,
} from "./prune-traces.ts";
import type { RunSnapshot } from "./prune-traces.ts";

/**
 * T1277 / §B206 — the pruner exists because 386 raw traces filled 18 GB of a disk with
 * 37 GiB free. It is one delete away from being the worse bug: §T1254, §T1264 and §T1248
 * cite `scratchpad/perf/<timestamp>` directories as the EVIDENCE for measurements the
 * owner has already acted on, so a pruner that takes a run directory destroys the record
 * of a decision. Every case below is about that line, not about the byte count.
 */

const run = (name: string, mtimeMs: number, traces: string[], evidence: string[]): RunSnapshot => ({
  name,
  mtimeMs,
  traces,
  evidence,
});

describe("keepRawTraces — the raw trace is opt-in (T1277)", () => {
  it("does not write a trace unless someone asked for one", () => {
    expect(keepRawTraces({})).toBe(false);
    expect(keepRawTraces({ PERF_KEEP_TRACES: "" })).toBe(false);
    // A shell that exports the variable as off must not be read as on: `PERF_KEEP_TRACES=0`
    // is how someone turns it back off in a session that had it set.
    expect(keepRawTraces({ PERF_KEEP_TRACES: "0" })).toBe(false);
    expect(keepRawTraces({ PERF_KEEP_TRACES: "false" })).toBe(false);
  });

  it("keeps them when asked", () => {
    expect(keepRawTraces({ PERF_KEEP_TRACES: "1" })).toBe(true);
    expect(keepRawTraces({ PERF_KEEP_TRACES: "yes" })).toBe(true);
  });
});

describe("planPrune — traces aggressively, run directories conservatively (T1277)", () => {
  const runs = [
    run("20260910-100000", 100, ["E24-A-1.trace.json"], ["E24.json", "summary.md"]),
    run("20260910-110000", 200, ["E24-A-1.trace.json", "E24-B-1.trace.json"], ["E24.json", "summary.md"]),
    run("20260910-120000", 300, ["E24-A-1.trace.json"], ["E24.json"]),
    run("20260910-130000", 400, ["E24-A-1.trace.json"], ["E24.json", "summary.md"]),
  ];

  it("keeps the newest N trace-bearing runs and takes the traces of the rest", () => {
    const plan = planPrune(runs, 2);
    expect(plan.keptTraceRuns).toEqual(["20260910-130000", "20260910-120000"]);
    expect(plan.removeTraces).toEqual([
      "20260910-100000/E24-A-1.trace.json",
      "20260910-110000/E24-A-1.trace.json",
      "20260910-110000/E24-B-1.trace.json",
    ]);
  });

  it("NEVER names a file that is not a raw trace — the summaries are what SPEC rows cite", () => {
    const plan = planPrune(runs, 0);
    // The whole safety argument in one assertion: if the plan cannot name `summary.md` or
    // `<fixture>.json`, no run of the pruner can orphan a path §T1254/§T1264/§T1248 cite.
    for (const path of plan.removeTraces) expect(path.endsWith(".trace.json")).toBe(true);
    expect(plan.removeTraces).toHaveLength(5);
  });

  it("leaves the DIRECTORY of a run that carries any evidence, even when its traces go", () => {
    const plan = planPrune(runs, 0);
    expect(plan.removeDirs).toEqual([]);
  });

  it("removes a run directory only when the traces were the whole of it", () => {
    const traceOnly = run("probe-scratch", 50, ["E24-A-1.trace.json"], []);
    const plan = planPrune([...runs, traceOnly], 2);
    expect(plan.removeDirs).toEqual(["probe-scratch"]);
  });

  it("never touches a run with no traces — an empty directory is one a session just made", () => {
    // The race this guards: another session `mkdir`s its out dir, the pruner runs between
    // that and its first write, and the harness then throws ENOENT into someone else's run.
    const fresh = run("20260910-140000", 500, [], []);
    const plan = planPrune([...runs, fresh], 0);
    expect(plan.removeDirs).toEqual([]);
    expect(plan.removeTraces.some((path) => path.startsWith("20260910-140000/"))).toBe(false);
  });

  it("protects the run in progress without spending the keep budget on it", () => {
    const inFlight = run("20260910-140000", 500, ["E24-A-1.trace.json"], []);
    const plan = planPrune([...runs, inFlight], 2, ["20260910-140000"]);
    expect(plan.keptTraceRuns).toContain("20260910-140000");
    // Still two OTHER runs kept: a keep-traces run must not evict the previous run's
    // traces merely by existing.
    expect(plan.keptTraceRuns).toEqual(expect.arrayContaining(["20260910-130000", "20260910-120000"]));
    expect(plan.removeDirs).toEqual([]);
  });

  it("says nothing was removed rather than reporting a silent zero", () => {
    const plan = planPrune(runs, 10);
    const line = describeOutcome("scratchpad/perf", { plan, bytes: 0, runs: runs.length, summaries: 3 });
    expect(line).toContain("no raw traces to remove");
    expect(line).toContain("3 with a summary");
  });
});

describe("the pruner against a real directory (T1277)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-prune-"));
    roots.push(root);
    const make = (name: string, files: Record<string, string>, mtime: number): void => {
      mkdirSync(join(root, name), { recursive: true });
      for (const [file, body] of Object.entries(files)) {
        writeFileSync(join(root, name, file), body);
        utimesSync(join(root, name, file), mtime, mtime);
      }
    };
    make("old-cited", { "E24.json": "{}", "summary.md": "# numbers a row cites", "E24-A-1.trace.json": "x".repeat(4096) }, 1000);
    make("newer", { "E24.json": "{}", "E24-A-1.trace.json": "y".repeat(2048) }, 2000);
    make("trace-only", { "E24-A-1.trace.json": "z".repeat(1024) }, 1500);
    make("in-progress", {}, 3000);
    return root;
  }

  it("takes the bytes and leaves the record", () => {
    const root = fixture();
    const runs = scanRuns(root);
    const outcome = applyPrune(root, runs, planPrune(runs, 1));

    // Gone: the traces of every run but the newest.
    expect(existsSync(join(root, "old-cited", "E24-A-1.trace.json"))).toBe(false);
    expect(existsSync(join(root, "trace-only"))).toBe(false);
    expect(outcome.bytes).toBe(4096 + 1024);

    // Kept: the cited evidence, and the newest run's traces.
    expect(existsSync(join(root, "old-cited", "summary.md"))).toBe(true);
    expect(existsSync(join(root, "old-cited", "E24.json"))).toBe(true);
    expect(existsSync(join(root, "newer", "E24-A-1.trace.json"))).toBe(true);
    // And the directory another session is about to write into.
    expect(existsSync(join(root, "in-progress"))).toBe(true);

    expect(describeOutcome(root, outcome)).toContain("removed 2 raw trace(s)");
  });

  it("is idempotent: a second sweep finds nothing and says so", () => {
    const root = fixture();
    const first = scanRuns(root);
    applyPrune(root, first, planPrune(first, 1));
    const second = scanRuns(root);
    const outcome = applyPrune(root, second, planPrune(second, 1));
    expect(outcome.bytes).toBe(0);
    expect(describeOutcome(root, outcome)).toContain("no raw traces to remove");
  });
});
