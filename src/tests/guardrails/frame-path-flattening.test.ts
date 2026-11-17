import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
  { file: "app/photo-mapping-host.tsx", reads: 1, why: "User-triggered Apply validates and patches the authored root recipe; never runs in a frame." },
  {
    file: "app/use-perform-windows.ts",
    reads: 4,
    why: "§T1391b: NOT per frame — on a perform command (which Window Outs exist, and the one being opened), on a document change (close the window of a deleted Window Out), and when the inspector describes a window. A Window Out is an AUTHORED node the user picks; a perform window for one inside a component is not offered. §T1536b: the edit-mapping mode reads it (one site) on a toggle, a document change, a new plan and a window resize, to find the Corner Pin / Grid Warp upstream — authored nodes, whose parameters a drag writes.",
  },
  {
    file: "app/flattened-graph.ts",
    reads: 1,
    why: "THE declared read. This is the memo that produces the flattened document every frame path reads instead; it is called per frame and answers from cache unless the document or the catalogue moved (§V529).",
  },
  {
    file: "app/app-runtime.ts",
    reads: 3,
    why: "`projectDocument()`, derived external asset records for snapshots/save/project queries, and the root document supplied to command-time reference-cycle validation of a definition edit. None runs per frame. A file holds the authored document, instances and all; saving a flattening would destroy every component in the project (§V79).",
  },
  {
    file: "app/use-graph-compile.ts",
    reads: 3,
    why: "Two are the `useSyncExternalStore` snapshot pair — the subscription that makes the raw document a React value, which is what the compile memo, the node badges and the classifier key on. The third is `compileNow`, a command handler that must answer for the revision the STORE is on rather than the one React last rendered; it flattens through `runtime.flattened.current()`, which is keyed on the same object.",
  },
  {
    file: "app/graph-pane.tsx",
    reads: 5,
    why: "Canvas gesture handling — an edge drop and its before/after edge count. A gesture is a pointer event, not a frame, and it addresses the nodes the USER can see, which are the authored ones. T1652b, two more, each on demand and never per frame: the camera pose a viewport gesture starts from, and the node an agent's `render_preview` names. Both used to read the pane's `graph` prop, which no longer moves for a values-only revision; the store's document is the one that holds the value just written.",
  },
  {
    file: "app/use-viewer-camera-lock.ts",
    reads: 1,
    why: "§T970: the authored camera document is retained on mount and command-store notifications, including values-only edits that do not rerender the pane. Gestures and the corner gizmo read that retained snapshot; frame polling resolves its animated drivers through the current read scope and never calls getGraph. The camera is the authored node the user's undoable edits target.",
  },
  {
    file: "app/revision-watch.ts",
    reads: 4,
    why: "T1652b: NOT per frame — once per REVISION (the store's own notification), to classify it as values-only or structural, and three times to take the document the next revision is compared with (at creation, when the first listener attaches, and when `structure()` is asked while nothing listens). It compares AUTHORED documents because a revision is an authored edit; what a frame path reads is still `runtime.flattened.current()`.",
  },
  {
    file: "app/use-live-graph.ts",
    reads: 2,
    why: "T1652b: the `useSyncExternalStore` snapshot pair of a PANE that shows values (the canvas, the inspector, the Controls pane). A React value for presentation, taken on a revision the pane shows and never in a frame; the panes lay out and write AUTHORED nodes.",
  },
  {
    file: "app/use-viewer-mapping.ts",
    reads: 1,
    why: "T1652b: NOT per frame — when the edit-mapping layer re-derives (a toggle, a document change, a new plan, a resize), to find the Corner Pin / Grid Warp whose handles it draws. AUTHORED nodes, whose parameters a drag writes; it was the pane's `graph` prop until that stopped moving for a values-only revision, which is what a dragged handle is.",
  },
  {
    file: "app/dock-panes.tsx",
    reads: 1,
    why: "Reads a stored parameter to open the expression editor on it. A panel, on a click; it edits the DOCUMENT, so the document is the right graph.",
  },
  {
    file: "app/use-component-editing.ts",
    reads: 7,
    why: "Component AUTHORING: two `useSyncExternalStore` pairs (the host document and the component's own edit buffer) plus the root read that saves a selection into a definition, the user-edit read that resolves the nearest published parameter owner, and (T1545b) the read-only root handed to the editing sessions so an in-session detach can name the project's paths into the detached instance. This is the surface that writes components; flattening is the surface that consumes them (§V79).",
  },
  {
    file: "app/app.tsx",
    reads: 1,
    why: "`useAgentPorts` — `render_preview` and `describe_output` answer an agent TOOL CALL, on demand, and describe the document the agent is patching by the ids it patches with (§V30).",
  },
  {
    file: "app/phone-writes.ts",
    reads: 2,
    why: "T1396b: NOT per frame — once per phone WRITE, to vet it against the AUTHORED document: a Panel names its widgets by their authored names (the controls pane's rule) and the write patches that authored node by id through the bus. A widget inside a component is not publishable (T1143). T1503b, the second: once per phone press of a LAYER's switch, after that phone's earlier writes have settled, to see whether the authored layer is already in the state asked for — so a double tap is one undo step and never a flip back.",
  },
  {
    file: "app/use-arriving-files.ts",
    reads: 1,
    why: "T1519b: NOT per frame — on a document or catalogue change, to find file references that ARRIVED (open, import, paste). It reads the AUTHORED graph beside each definition in the catalogue, so it can name the component that holds a file; a flattening would name instances, not components, and miss a definition nothing instances yet. A graph already scanned answers from a cache keyed on its identity.",
  },
  {
    file: "app/use-phone-door.ts",
    reads: 1,
    why: "T1396b: NOT a frame path — only while the phone door is open, at most once per animation frame and only after a DOCUMENT change (or, T1503b, once when a published bank's fade ENDS — the per-frame watch for that end compares the fade's records with the frame clock and reads no document), to build what the phones see from the AUTHORED Panels (the same document the controls pane lays out and a phone write patches).",
  },
];

/**
 * §T1559b: every consumer these three hand the graph to is typed `FlatGraph` now — the value
 * graph's `evaluate` was the last (the probe at the foot of this file asks the checker). The
 * zero-raw-reads half below stays all the same, because a type sees only a HAND-OFF: a path
 * that walks `store.getGraph().nodes` itself (say, to skip the evaluation when the document
 * holds no value node) reaches no typed consumer, and is T615 again for every value node
 * inside a component. Here such a read cannot even be declared with a reason.
 */
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

/**
 * §T1552b — THE AUTHORED AND THE FLAT GRAPH ARE TWO TYPES.
 *
 * The scan above catches a raw read in the frame-path tree by its SPELLING. The brand
 * catches the mistake by its TYPE, wherever it is written: a consumer that needs the
 * flattening takes `FlatGraph` (the value graph, the pulse watcher, the OSC pump, the media
 * transport, the Analyze/vision/inference readers, the file and device doors, the compiler
 * past flatten),
 * and every parameter evaluation (`parameterReadOptions`, `validateGraph`) takes
 * `FlatGraph | AuthoredGraph`, so the inspector and a command's read scope say
 * `authoredGraph(…)` by name. Two halves hold it: the cast that would forge a brand is
 * refused outside its producer, and the checker itself is asked to refuse the mistake.
 */
describe("§T1552b — a FlatGraph is minted only by the flattener", () => {
  const MINTS: ReadonlyArray<{ cast: RegExp; allowed: readonly string[] }> = [
    { cast: /\bas\s+FlatGraph\b/, allowed: ["compiler/flatten.ts"] },
    { cast: /\bas\s+AuthoredGraph\b/, allowed: ["domain/types/graph.ts"] },
  ];

  it("finds the brand cast only in its producer (product code; a test may force the defect on purpose)", () => {
    const files = sourceFiles(SRC).filter((path) => !/test-support\.ts$/.test(path));
    for (const { cast, allowed } of MINTS) {
      const found = files
        .filter((path) => cast.test(code(readFileSync(path, "utf8"))))
        .map((path) => relative(SRC, path))
        .sort();
      expect(
        found,
        `${cast} outside its producer forges the brand: a graph that was never flattened (or ` +
          `never chosen as the authored one) claims to be. Flatten it (\`flattenComponents\`), ` +
          `read \`runtime.flattened.current().graph\`, or say \`authoredGraph(…)\` (§T1552b).`,
      ).toEqual(allowed);
    }
  });

  it("asks the checker: the authored document is refused where the flat graph is needed, and vice versa", () => {
    const directory = mkdtempSync(join(tmpdir(), "shaderloom-graph-brand-"));
    try {
      const graph = join(SRC, "domain/types/graph.ts");
      const nodeRefs = join(SRC, "domain/parameters/node-references.ts");
      const valueGraph = join(SRC, "domain/channels/value-graph.ts");
      const frame = join(SRC, "domain/types/frame.ts");
      const file = join(directory, "brand.ts");
      const lines = [
        `import { authoredGraph, type FlatGraph, type GraphDocument } from ${JSON.stringify(graph)};`,
        `import { NO_FLATTENING, parameterReadOptions } from ${JSON.stringify(nodeRefs)};`,
        `import type { ValueGraphSession } from ${JSON.stringify(valueGraph)};`,
        `import { ZERO_FRAME } from ${JSON.stringify(frame)};`,
        "declare const stored: GraphDocument;",
        "declare const flat: FlatGraph;",
        "declare const session: ValueGraphSession;",
        "declare function needsFlat(graph: FlatGraph): void;",
        "const registry = { get: () => undefined };",
        "needsFlat(flat);",
        "session.evaluate(flat, ZERO_FRAME, { flattening: NO_FLATTENING });",
        "parameterReadOptions({ graph: flat, registry, frame: undefined, channels: undefined, flattening: NO_FLATTENING });",
        "parameterReadOptions({ graph: authoredGraph(stored), registry, frame: undefined, channels: undefined, flattening: NO_FLATTENING });",
        "needsFlat(stored); // REFUSED: the store's document where the flattening is needed",
        "parameterReadOptions({ graph: stored, registry, frame: undefined, channels: undefined, flattening: NO_FLATTENING }); // REFUSED: no side said",
        "authoredGraph(flat); // REFUSED: a flattening is not the document",
        "session.evaluate(stored, ZERO_FRAME, { flattening: NO_FLATTENING }); // REFUSED: §T1559b — the value graph evaluates the flattening",
        "session.evaluate(authoredGraph(stored), ZERO_FRAME, { flattening: NO_FLATTENING }); // REFUSED: and saying `authored` does not make it one",
        // §T1559b: WHICH flattening is required too — an evaluation input left optional is
        // the bug class (§T1551b): the reader was built with no instances and nothing failed.
        "session.evaluate(flat, ZERO_FRAME); // REFUSED: no flattening said",
        "session.evaluate(flat, ZERO_FRAME, { pointer: { x: 0, y: 0, buttons: 0 } }); // REFUSED: inputs handed, and still no flattening",
        "",
      ];
      writeFileSync(file, lines.join("\n"), "utf8");
      const config = ts.readConfigFile(join(SRC, "../tsconfig.app.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(SRC, ".."));
      const program = ts.createProgram([file], parsed.options);
      const source = program.getSourceFile(file);
      if (source === undefined) throw new Error("the probe file did not load");
      const errorLines = [
        ...new Set(
          program
            .getSemanticDiagnostics(source)
            .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.start !== undefined)
            .map((diagnostic) => source.getLineAndCharacterOfPosition(diagnostic.start as number).line),
        ),
      ].sort((a, b) => a - b);
      // Exactly the seven marked lines; the legitimate reads beside them typecheck.
      const refused = lines.flatMap((line, index) => (line.includes("// REFUSED") ? [index] : []));
      expect(refused).toHaveLength(7);
      expect(errorLines).toEqual(refused);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
