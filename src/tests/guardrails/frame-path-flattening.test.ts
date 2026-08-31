import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No per-frame CPU walk sees the UN-FLATTENED document (T615, §V437, §V464).
 *
 * ## The property, and why it is a property and not six fixes
 *
 * A component instance does not exist until the document is flattened. Every per-frame
 * CPU surface used to read `bus.store.getGraph()` instead, so nothing inside a component
 * existed for any of them: the value graph never evaluated an internal LFO, the driven
 * binding it fed resolved to `undefined`, `hasAnimatedParameters` answered false so
 * `compile.animate` was null and the component's internal EXPRESSIONS died with it, the
 * Analyze sampler never asked for a buffer the plan had allocated, and an expression-fired
 * pulse was never looked at. Six sites, one cause.
 *
 * §V437 is the invariant that says a requirement delivered site-by-site is not delivered.
 * So the answer is structural: `AppRuntime.flattened` is the ONE flattening, memoized per
 * `(document revision, catalogue revision)`, and every frame path reads it. This gate is
 * what keeps site N+1 from being wrong — it fails when a new raw read appears, not when
 * someone notices.
 *
 * ## §V464: it fails three ways, not one
 *
 *  (a) an UNDECLARED `store.getGraph` in a scanned file — the new site;
 *  (b) a STALE declaration whose read is gone — §V421's rot, so the table describes the
 *      code that exists rather than the code that used to;
 *  (c) a SECOND read inside an ALREADY-DECLARED file — declarations carry an exact COUNT,
 *      so one legitimate read in `use-graph-compile.ts` is not a blanket permission for
 *      the next one to join it.
 *
 * And the declaration lives in this file, which is text a person reads, with the REASON
 * each read is not a frame path spelled out — not in a machine-readable table nobody
 * opens.
 *
 * ## §V463: a text scan is not a semantic read
 *
 * Comments are stripped before the scan, because otherwise the prose in
 * `flattened-graph.ts` explaining the defect would itself count as a use. And the scan
 * cannot tell "is called once per frame" from "is called once per edit" — so it is paired
 * with `component-animation.test.ts`, which asserts the BEHAVIOUR on a real document with
 * two instances. Neither gate stands alone.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

/**
 * Where a frame path can live.
 *
 * `src/app` is the composition root and holds every frame-loop seam; the render harness
 * is the OFFLINE frame loop (§V47) and is scanned for exactly that reason — it is the
 * half that was not merely broken but absent, since it never passed `components` at all.
 * `src/editor` is deliberately outside: it is presentation, it runs on React renders and
 * never inside a frame, and pulling it in would bury the signal under panel code.
 */
const SCANNED_DIRECTORIES = ["app"];
const SCANNED_FILES = ["tests/headless/render-harness.ts"];

/** The read this gate is about, in every form — called, or handed over to be called. */
const RAW_READ = /store\.getGraph/g;

/**
 * Every raw-document read in the scanned set, with the reason it is not a frame path.
 *
 * `reads` is EXACT. A file that grows a second read fails until the reason for that one
 * is written down too (§V464(c)).
 */
const DECLARED: ReadonlyArray<{ file: string; reads: number; why: string }> = [
  {
    file: "app/flattened-graph.ts",
    reads: 1,
    why: "THE declared read. This is the memo that produces the flattened document every frame path reads instead; it is called per frame and answers from cache unless the document or the catalogue moved (§V529).",
  },
  {
    file: "app/app-runtime.ts",
    reads: 1,
    why: "`projectDocument()` — what a SAVE writes. A file holds the authored document, instances and all; saving a flattening would destroy every component in the project (§V79).",
  },
  {
    file: "app/use-graph-compile.ts",
    reads: 3,
    why: "Two are the `useSyncExternalStore` snapshot pair — the subscription that makes the raw document a React value, which is what the compile memo, the node badges and the classifier key on. The third is `compileNow`, a command handler that must answer for the revision the STORE is on rather than the one React last rendered; it flattens through `runtime.flattened.current()`, which is keyed on the same object.",
  },
  {
    file: "app/graph-pane.tsx",
    reads: 3,
    why: "Canvas gesture handling — an edge drop and its before/after edge count. A gesture is a pointer event, not a frame, and it addresses the nodes the USER can see, which are the authored ones.",
  },
  {
    file: "app/dock-panes.tsx",
    reads: 1,
    why: "Reads a stored parameter to open the expression editor on it. A panel, on a click; it edits the DOCUMENT, so the document is the right graph.",
  },
  {
    file: "app/use-component-editing.ts",
    reads: 5,
    why: "Component AUTHORING: two `useSyncExternalStore` pairs (the host document and the component's own edit buffer) plus the root read that saves a selection into a definition. This is the surface that writes components; flattening is the surface that consumes them (§V79).",
  },
  {
    file: "app/app.tsx",
    reads: 1,
    why: "`useAgentPorts` — `render_preview` and `describe_output` answer an agent TOOL CALL, on demand, and describe the document the agent is patching by the ids it patches with (§V30).",
  },
];

const DECLARED_FRAME_PATHS: ReadonlyArray<{ file: string; what: string }> = [
  { file: "app/use-value-graph.ts", what: "the per-frame value-graph evaluation and its zero-frame twin" },
  { file: "app/pulse-firing.ts", what: "the expression-fired pulse watcher's step" },
  { file: "tests/headless/render-harness.ts", what: "the OFFLINE frame loop (§V47's other half)" },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * §V463: strip comments before counting, or the module note that EXPLAINS this defect
 * reads as an instance of it. Strings are left alone — a `store.getGraph` inside one
 * would be a diagnostic message, and there are none.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function scanned(): string[] {
  const files = SCANNED_DIRECTORIES.flatMap((directory) => sourceFiles(join(SRC, directory)));
  return [...files, ...SCANNED_FILES.map((file) => join(SRC, file))].sort();
}

function readsIn(path: string): number {
  return code(readFileSync(path, "utf8")).match(RAW_READ)?.length ?? 0;
}

describe("the raw document is unreachable from a per-frame path (T615, §V437)", () => {
  it("declares every raw-document read in the frame-path tree, with an exact count", () => {
    const declared = new Map(DECLARED.map((entry) => [entry.file, entry.reads]));
    const problems: string[] = [];
    const seen = new Set<string>();

    for (const path of scanned()) {
      const file = relative(SRC, path);
      const found = readsIn(path);
      seen.add(file);
      const expected = declared.get(file);
      if (found === 0) {
        // (b) §V421 rot: a declaration whose read is gone must be deleted, or the table
        // starts describing a codebase that no longer exists.
        if (expected !== undefined) {
          problems.push(
            `${file} declares ${expected} raw read(s) and has none left — delete the declaration (§V464(b)).`,
          );
        }
        continue;
      }
      if (expected === undefined) {
        // (a) the new site. This is the one §V437 is about.
        problems.push(
          `${file} reads store.getGraph ${found}x and is UNDECLARED. If it runs per frame it must read runtime.flattened.current().graph instead — a component's internals do not exist in the raw document. If it does not, declare it in DECLARED with the reason (§V464(a)).`,
        );
        continue;
      }
      if (expected !== found) {
        // (c) a declared file is not a blanket permission.
        problems.push(
          `${file} declares ${expected} raw read(s) but has ${found}. A declaration covers the reads it names and no others (§V464(c)).`,
        );
      }
    }

    for (const entry of DECLARED) {
      if (!seen.has(entry.file)) {
        problems.push(`${entry.file} is declared and is not in the scanned set — the file moved or went away (§V464(b)).`);
      }
    }

    expect(problems).toEqual([]);
  });

  it("holds the named frame paths at ZERO raw reads, reading the flattening instead", () => {
    const problems: string[] = [];
    for (const entry of DECLARED_FRAME_PATHS) {
      const text = code(readFileSync(join(SRC, entry.file), "utf8"));
      const raw = text.match(RAW_READ)?.length ?? 0;
      if (raw > 0) {
        problems.push(`${entry.file} (${entry.what}) reads the raw document ${raw}x.`);
      }
      // Positive half: it is not enough that the raw read is gone — the flattening has to
      // be what replaced it, or the path is simply not looking at a document any more.
      if (!/flatten/i.test(text)) {
        problems.push(`${entry.file} (${entry.what}) names no flattening at all.`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("scans a real tree, or it is asserting nothing", () => {
    // NON-VACUITY (§V461): a broken walk, a regex that matches nothing, or a comment
    // stripper that eats the file would each report a clean sweep just as convincingly.
    const files = scanned();
    expect(files.length).toBeGreaterThan(30);
    const total = files.reduce((sum, path) => sum + readsIn(path), 0);
    expect(total).toBe(DECLARED.reduce((sum, entry) => sum + entry.reads, 0));
    expect(total).toBeGreaterThan(10);
  });
});
