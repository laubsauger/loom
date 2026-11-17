import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { describeFinding, refusedAtCodeSave } from "../compiler/document-findings.ts";
import { validateGraph } from "../compiler/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { diagnosticClass } from "../domain/diagnostics/classes.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import { frameFromClock } from "../domain/types/frame.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles, type ExampleFile } from "./catalogue.ts";
import { runExample, type RunExampleResult } from "./runner.ts";

/**
 * §T1641b — NO SHIPPED DOCUMENT HOLDS SOMETHING THAT CAN NEVER TAKE EFFECT.
 *
 * §B262 shipped in a project file: three lamps whose expression called a function the
 * grammar does not have, each rendering at its stored value. The compile said so, as a
 * warning nobody read, and no gate read `projects/` at all. This one reads every shipped
 * document (the examples, the starter component files, every project document) through
 * the real load, with the file's own component library, and holds it to three things.
 *
 *  1. AT REST, what a save by code would refuse (`refusedAtCodeSave` over
 *     `documentFindings`): anything whose CLASS is `never`, at any severity; a code nobody
 *     has classed; an error on a node a sink reaches. By class and not by code, so a code
 *     that is split tomorrow cannot walk past it. `documentFindings` is the write gate
 *     asked of every stored node, in the document's own graph and in every definition the
 *     file carries, with the structural compile's report: so this reads what only the
 *     write gate checks (a payload a slot KEEPS, of another type than its parameter; a
 *     pulse stored armed), which no compile ever saw.
 *  2. AT A FRAME. Three frames of each (0, 1 and 30, at 60 a second) through the real value
 *     graph, then every node's parameters resolved at that frame with its channels. No
 *     GPU, no plan: about a third of a second for the set. Nothing of class `never` may
 *     appear, and what is still WAITING at a frame is the ledger below, exactly.
 *  3. THE DOOR. Every module under `src/examples` and `src/projects` that writes a document
 *     writes it through the checked save (`checked-project.ts`).
 *
 * What it cannot read: a finding only an asset's contents show (a mesh's joints), anything
 * a device decides, and a frame's own node compiles (it resolves parameters at a frame and
 * builds no pass).
 *
 * It lives beside the documents because it reads the document set, and is on `test:gates`
 * for the same reason: no file's own tests would run it.
 */

const SHIPPED: ReadonlyArray<readonly [string, ExampleFile]> = [
  ...listExamples().map((file) => [`examples/${file.fileName}`, file] as const),
  ...listStarterComponentFiles().map((file) => [`examples/components/${file.fileName}`, file] as const),
  ...listProjectDocuments().map((file) => [`projects/${file.fileName}`, file] as const),
];

/** Each shipped document, loaded and compiled once for every case below. */
const RUNS: ReadonlyArray<readonly [string, RunExampleResult]> = SHIPPED.map(([path, file]) => [path, runExample(file)] as const);

const neverOrUnjudged = (diagnostic: RuntimeDiagnostic): boolean => {
  const found = diagnosticClass(diagnostic.code);
  return found === "never" || found === "unclassified";
};

/** The frames read, at 60 a second: the first, the one after it, and half a second in. */
const FRAMES = [0, 1, 30] as const;

/**
 * WHAT STILL WAITS AT A FRAME in a shipped document, by document and by the node's name.
 *
 * Each is a read of a channel a LIVE publisher supplies (a Person Mask's and a Matte's
 * `coverage` and `ready`, through the vision helper), which no process without that helper
 * has. A strict render of these files stops on them, which is the truth about that render.
 * Held exactly, in both directions: a new one is a reference that resolves to nothing
 * here, and must be looked at before it ships (a misspelt channel reads the same way).
 */
const WAITING_AT_A_FRAME: Readonly<Record<string, readonly string[]>> = {
  "examples/E52-Presence.loom.json": ["level_wash parameter.reference.channel"],
  "examples/E53-Two-Cuts.loom.json": ["level_washC parameter.reference.channel", "level_washW parameter.reference.channel"],
  "examples/components/MatteCut.loom.json": ["cache_history parameter.reference.channel"],
};

describe("no shipped document holds something that can never take effect (T1641b)", () => {
  it("reads every example, starter component file and project document", () => {
    // If a directory moved, every case below would pass for want of subjects.
    expect(listExamples().length).toBeGreaterThan(60);
    expect(listStarterComponentFiles().length).toBeGreaterThan(8);
    expect(listProjectDocuments().length).toBeGreaterThan(10);
    expect(RUNS.filter(([, result]) => result.plan === undefined).map(([path, result]) => `${path}: ${result.reason ?? "no reason given"}`)).toEqual([]);
  });

  it("at rest, each holds nothing a save by code refuses: the load, the write gate and the compile", () => {
    const problems: string[] = [];
    let judged = 0;
    for (const [path, result] of RUNS) {
      for (const diagnostic of result.loadDiagnostics.filter(neverOrUnjudged)) {
        problems.push(`${path}: at the load, ${describeFinding({ diagnostic, node: undefined, component: undefined })}`);
      }
      judged += result.findings.length;
      for (const finding of result.findings.filter(refusedAtCodeSave)) {
        problems.push(`${path}: ${finding.diagnostic.severity} (${finding.class}${finding.retained ? ", kept and not in effect" : ""}) ${describeFinding(finding)}`);
      }
    }
    // The set says something of itself (a channel read with no resolver): an empty list
    // from a check that read nothing would pass this for want of subjects.
    expect(judged).toBeGreaterThan(500);
    expect(
      problems,
      `\n${problems.join("\n\n")}\n\nEach is a stored thing that cannot do what it says. Fix it in the document's source ` +
        "(src/examples/documents/**, src/projects/**) and regenerate; it is not a warning to live with.\n",
    ).toEqual([]);
  });

  it("at frames 0, 1 and 30, each shows nothing that can never take effect, and what still waits is the ledger", () => {
    const problems: string[] = [];
    const waiting: Record<string, string[]> = {};
    for (const [path, result] of RUNS) {
      const { document, flattened, nodes: registry } = result;
      if (document === undefined || flattened === undefined || registry === undefined) continue;
      const atRest = new Set(result.findings.map((finding) => `${finding.diagnostic.code}|${finding.diagnostic.nodeId ?? ""}`));
      const session = createValueGraphSession(registry);
      const seen = new Set<string>();
      for (const frameIndex of FRAMES) {
        const frame = frameFromClock({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: document.settings.randomSeed, fps: 60 });
        const evaluated = session.evaluate(flattened.graph, frame, { flattening: flattened });
        const resolved = validateGraph(flattened.graph, registry, { frame, channels: evaluated.resolver, morphs: flattened.morphs, instances: flattened.instanceChannels, instancePages: flattened.instancePages });
        for (const diagnostic of [...evaluated.diagnostics, ...resolved.diagnostics]) {
          const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}`;
          if (atRest.has(key) || seen.has(key)) continue;
          seen.add(key);
          const node = diagnostic.nodeId === undefined ? undefined : flattened.graph.nodes[diagnostic.nodeId];
          const name = node?.label ?? diagnostic.nodeId ?? "";
          if (diagnostic.severity === "error" || neverOrUnjudged(diagnostic)) {
            problems.push(`${path}, frame ${frameIndex}: ${describeFinding({ diagnostic, node: node === undefined ? undefined : { id: node.id, name, type: node.type }, component: undefined })}`);
          } else if (diagnosticClass(diagnostic.code) === "notYet") {
            (waiting[path] ??= []).push(`${name} ${diagnostic.code}`);
          }
        }
      }
    }
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
    for (const names of Object.values(waiting)) names.sort();
    expect(waiting).toEqual(WAITING_AT_A_FRAME);
  });
});

/**
 * THE DOOR IS THE ONLY DOOR. A module that builds a document and hands it to the save that
 * checks nothing is how both failures shipped, so no module under `src/examples` or
 * `src/projects` may call `serializeProjectDocument` or `buildProjectFile` itself: it calls
 * `serializeCheckedProject` or `buildCheckedProjectFile`. The one listed file is another
 * session's to move; its line goes when it has.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const THE_DOOR = "src/examples/checked-project.ts";
const UNCHECKED_WRITERS: Readonly<Record<string, string>> = {};

describe("every document a script builds is saved through the checked save (T1641b)", () => {
  const unchecked = /\b(serializeProjectDocument|buildProjectFile)\s*\(/;
  const writers: string[] = [];
  let read = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        read += 1;
        const file = relative(ROOT, path).split("\\").join("/");
        if (file !== THE_DOOR && unchecked.test(readFileSync(path, "utf8"))) writers.push(file);
      }
    }
  };
  walk(join(ROOT, "src/examples"));
  walk(join(ROOT, "src/projects"));

  it("reads the two trees, and the door itself is where the unchecked save is called", () => {
    expect(read).toBeGreaterThan(150);
    expect(unchecked.test(readFileSync(join(ROOT, THE_DOOR), "utf8"))).toBe(true);
  });

  it("finds no writer outside the door but the ones the ledger waits for", () => {
    const stray = writers.filter((file) => !Object.hasOwn(UNCHECKED_WRITERS, file));
    expect(
      stray,
      `\n${stray.join("\n")}\n\nEach calls the save that checks nothing. A document built by code never met the command bus: ` +
        "save it with serializeCheckedProject or buildCheckedProjectFile (src/examples/checked-project.ts).\n",
    ).toEqual([]);
    const moved = Object.keys(UNCHECKED_WRITERS).filter((file) => !writers.includes(file));
    expect(moved, "these no longer call the unchecked save: remove them from UNCHECKED_WRITERS").toEqual([]);
  });
});
