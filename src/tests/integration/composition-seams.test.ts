import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * EVERY SEAM THE APP IS SUPPOSED TO CONSTRUCT (T306, §V205, §V193).
 *
 * ## Why this is not the agent-tool guard
 *
 * T292 enumerates the agent TOOL surface at runtime and asserts each tool's port is live.
 * That guard is real and it caught what it was built for — and it could not have seen B25,
 * because `createAnalyzeChannels` is not a tool. It is a runtime SERVICE whose only
 * construction site in the entire tree was its own GPU test, so an Analyze node published
 * no channel and the image→parameter loop was not closed in the product. Same shape,
 * different clothes: built, unit-tested, never wired. Four times now (B12, T264, B23, B25).
 *
 * §V205 is the correction: the enumeration must cover every seam the app is supposed to
 * construct, not one category of them.
 *
 * ## Where the enumeration comes from, and why it is not a list
 *
 * A hand-kept list of seams rots exactly the way a hand-kept list of anything rots — it
 * describes the day it was written. So nothing here is enumerated by hand. The subjects
 * are DERIVED from the source tree (every exported `create*` / `open*` factory, which is
 * this codebase's own convention for "a service you construct"), and reachability is
 * derived from the real import graph of the real entry points. A service added tomorrow is
 * covered tomorrow, by nobody remembering anything.
 *
 * ## What "constructed" means here
 *
 * The factory's name is REFERENCED from a module the app's entry point transitively
 * imports. A reference, not a call: `options.createBackend ?? createVgpuBackend` is a
 * construction site too, and asking for `(` would have missed it (measured — that exact
 * false positive is why this walks the AST instead of grepping).
 *
 * Test files never count, and that is the whole point: B23's `ExportInterface` had a
 * construction site, and it was inside the acceptance test that proved the tool worked.
 *
 * ## The allowlist works in BOTH directions
 *
 * A seam that genuinely should not be constructed by a product entry point carries a
 * REASON here. And an allowlist entry that is no longer true — the seam got wired — fails
 * this test too, so the list cannot quietly accumulate stale excuses. That second direction
 * is also this file's non-vacuity guard: if the reachability walk ever broke open and
 * marked everything reachable, every entry below would go stale at once and this would go
 * red rather than silently passing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SRC = join(ROOT, "src");

/**
 * The real entry points of the real products.
 *
 * `main.tsx` mounts the browser app; `app.tsx` and `app-runtime.ts` are the composition
 * root proper (named explicitly so a seam wired only for a headless caller still counts);
 * `mcp/serve.ts` is the stdio MCP server, a second product with its own composition.
 */
const ENTRY_POINTS = [
  "src/main.tsx",
  "src/app/app.tsx",
  "src/app/app-runtime.ts",
  "src/mcp/serve.ts",
];

/**
 * Seams no product entry point constructs, each with the reason.
 *
 * Adding a line here is a DECISION, visible on the diff, that this thing is deliberately
 * not part of a running product. It is not a way to make the test quiet: an entry that
 * stops being true fails just as loudly as a missing one.
 */
const NOT_CONSTRUCTED: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "createHeadlessMcpServer",
    reason:
      "Constructed by serveStdio() in the SAME module — the stdio MCP server's own process entry point (T294), which this scan does not treat as an app root. serve.gpu.test.ts drives it end to end with real pixels.",
  },
  {
    name: "createSequentialIdFactory",
    reason:
      "Deliberately never used in the app — its own docstring says so. Two sessions would mint identical ids and collide on merge (§V40). Fixtures and the shipped-component builder only.",
  },
  {
    name: "createComponentRegistry",
    reason:
      "Composed by `createComponentSystem` in the same module, which the composition root does construct. The registry and its component-aware node view are two halves of one seam.",
  },
  {
    name: "createComponentAwareRegistry",
    reason: "The other half of `createComponentSystem`. Same reason.",
  },
  {
    name: "createRng",
    reason:
      "Determinism primitive (§V45), not a service: seeds reach shaders through the shared frame block, and nothing on the CPU draws from a stream.",
  },
  {
    name: "createNodeFrameRng",
    reason: "Same — a primitive over `createRng`, used by the compiler's seeding helpers.",
  },
  {
    name: "createProposalIdFactory",
    reason:
      "Agent PRESENCE (proposal mode) has no surface yet. Nothing in the app proposes rather than applies, so there is no id to mint.",
  },
  {
    name: "createFrameRecorder",
    reason:
      "Sequence recording is export-side and has no UI entry point yet; `recordSequence` is driven by tests and the headless path.",
  },
  {
    name: "createShaderCompilePipeline",
    reason:
      "B27 — the shader editor's debounced compile pipeline is exported from its own index and constructed only by its unit test. The panel validates on the graph compile instead, so WGSL errors appear later than the pipeline was built to show them.",
  },
  {
    name: "openComponentSession",
    reason:
      "Entering a component navigates (T130) without opening an editing session; publishing and exposing from inside a component are therefore not reachable from the canvas yet.",
  },
];

const TEST_FILE = /\.test\.(ts|tsx)$/;
/** Files that exist to serve tests. A construction site here proves nothing (B23). */
const TEST_SUPPORT = [
  /test-support\.(ts|tsx)$/,
  /testing\.(ts|tsx)$/,
  /[\\/]testing[\\/]/,
  /test-nodes\.ts$/,
  /mock-gpu-host\.ts$/,
  /[\\/]tests[\\/]/,
];

const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["@domain/", "src/domain/"],
  ["@compiler/", "src/compiler/"],
  ["@runtime/", "src/runtime/"],
  ["@editor/", "src/editor/"],
  ["@nodes/", "src/nodes/"],
  ["@ui/", "src/ui/"],
  ["@agent/", "src/agent/"],
  ["@/", "src/"],
];

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const isTestFile = (path: string): boolean =>
  TEST_FILE.test(path) || TEST_SUPPORT.some((pattern) => pattern.test(path));

const sources = listSources(SRC);
const parsed = new Map<string, ts.SourceFile>();
function sourceFile(path: string): ts.SourceFile {
  const cached = parsed.get(path);
  if (cached !== undefined) return cached;
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsed.set(path, file);
  return file;
}

/** Every exported `create*` / `open*` function declaration, by name. */
function collectFactories(): Map<string, string> {
  const factories = new Map<string, string>();
  for (const path of sources) {
    if (isTestFile(path)) continue;
    for (const statement of sourceFile(path).statements) {
      if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
      const exported =
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;
      if (/^(create|open)[A-Z]/.test(statement.name.text)) {
        factories.set(statement.name.text, path);
      }
    }
  }
  return factories;
}

function resolveSpecifier(specifier: string, from: string): string | null {
  let base: string | null = null;
  for (const [alias, target] of ALIASES) {
    if (specifier.startsWith(alias)) base = join(ROOT, target + specifier.slice(alias.length));
  }
  if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this shape; try the next.
    }
  }
  return null;
}

/**
 * Modules the entry points transitively import.
 *
 * Type-only imports are skipped: importing a TYPE from a module is not evidence that
 * anything in it ever runs, and counting it would let a seam look constructed because
 * somebody imported its interface.
 */
function reachableModules(): Set<string> {
  const reachable = new Set<string>();
  const queue = ENTRY_POINTS.map((entry) => join(ROOT, entry));
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || reachable.has(path)) continue;
    reachable.add(path);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true)
      ) {
        const target = resolveSpecifier(node.moduleSpecifier.text, path);
        if (target !== null && !isTestFile(target)) queue.push(target);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveSpecifier((node.arguments[0] as ts.StringLiteral).text, path);
        if (target !== null && !isTestFile(target)) queue.push(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile(path));
  }
  return reachable;
}

/** Identifiers a module USES — import/export specifiers and own declaration names excluded. */
function referencedNames(path: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isExportSpecifier(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined;
      const isOwnName =
        parent !== undefined &&
        (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
        (parent as { name?: ts.Node }).name === node;
      if (!isOwnName) names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path));
  return names;
}

const factories = collectFactories();
const reachable = reachableModules();
const referencesByFile = new Map<string, Set<string>>(
  sources.map((path) => [path, referencedNames(path)] as const),
);

/**
 * Is this seam constructed by something a product entry point reaches?
 *
 * The DECLARING module never counts, even when it is reachable. `createComponentSystem`
 * composing `createComponentRegistry` beside it really is construction — but so is a dead
 * factory referenced by another dead function in the same file, and the two are
 * indistinguishable without symbol-level reachability. Counting them would be a false
 * NEGATIVE, which is the exact direction B25 slipped through, so same-module composition
 * is written down in `NOT_CONSTRUCTED` as a decision instead of inferred as a fact.
 */
function isConstructed(name: string, declaredIn: string): boolean {
  for (const path of sources) {
    if (path === declaredIn) continue;
    if (isTestFile(path)) continue;
    if (!reachable.has(path)) continue;
    if (referencesByFile.get(path)?.has(name) === true) return true;
  }
  return false;
}

const unconstructed = [...factories.entries()]
  .filter(([name, declaredIn]) => !isConstructed(name, declaredIn))
  .map(([name, declaredIn]) => ({ name, file: relative(ROOT, declaredIn) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const excused = new Map(NOT_CONSTRUCTED.map((entry) => [entry.name, entry.reason]));

describe("§V205 — every seam the app is supposed to construct, enumerated (T306)", () => {
  it("finds real factories and a real module graph, or it is measuring nothing", () => {
    // A broken walk is the failure mode that would make every other assertion here
    // vacuous, so it is checked first and in both directions.
    expect(factories.size).toBeGreaterThan(30);
    expect(reachable.size).toBeGreaterThan(100);
    expect(reachable.size).toBeLessThan(sources.length);
    expect(NOT_CONSTRUCTED.length).toBeGreaterThan(0);
    // The seam this whole file exists for. If `createAnalyzeChannels` ever stops being
    // constructed, that is B25 returning and it is not an allowlist decision.
    expect(factories.has("createAnalyzeChannels")).toBe(true);
    expect(excused.has("createAnalyzeChannels")).toBe(false);
  });

  it("constructs every service factory, or says in writing why it does not", () => {
    const surprises = unconstructed.filter((seam) => !excused.has(seam.name));
    if (surprises.length > 0) {
      const listed = surprises.map((seam) => `  ${seam.name}  (${seam.file})`).join("\n");
      throw new Error(
        `${surprises.length} service factor${surprises.length === 1 ? "y is" : "ies are"} not constructed by any ` +
          `product entry point (§V205). Built, tested and dead in the product is how B12, T264, B23 and B25 all ` +
          `happened. Wire it in the composition root, or add it to NOT_CONSTRUCTED with the reason:\n${listed}`,
      );
    }
    expect(surprises).toEqual([]);
  });

  it("has no stale excuse — an allowlisted seam that got wired must leave the list", () => {
    const stillUnwired = new Set(unconstructed.map((seam) => seam.name));
    const stale = [...excused.keys()].filter(
      (name) => factories.has(name) && !stillUnwired.has(name),
    );
    const vanished = [...excused.keys()].filter((name) => !factories.has(name));
    expect({ stale, vanished }).toEqual({ stale: [], vanished: [] });
  });
});

/**
 * PANES (T330, §V241).
 *
 * §V193's enumeration covers agent tools; T306's covers `create*` factories. B34 was
 * neither: an unmounted COMPONENT, invisible to both, shipping a poorer viewer than the one
 * the tree contained. The lesson §V241 draws is that the unwired thing takes a new shape
 * each time, so the guard grows with them — NARROWLY, where the set is closed.
 *
 * A pane is such a set. The shell declares its slots in `AppShellProps`, so "a pane module
 * nothing renders" is a finding, where "an exported component nothing renders" would drown
 * in buttons, rows and badges.
 *
 * ## Why this resolves imports instead of matching names
 *
 * `ViewerPane` existed TWICE, with different capability. A name-only check sees the mounted
 * one referenced and calls both live — it would have passed through B34 without a murmur.
 * So a pane counts as rendered only when a reachable module imports THAT NAME FROM THAT
 * MODULE, following re-exports through barrels, which is how the app actually reaches one.
 */

const PANE_NAME = /(?:Pane|Panel)$/;

/** Panes deliberately not rendered, with the reason. Same both-directions rule as above. */
const NOT_RENDERED: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "Pane",
    reason:
      "A chrome PRIMITIVE (title + actions + scroll box), not a shell slot — the naming convention catches it and the registry does not contain it. Its module is live: `PaneEmpty` beside it is what `app-shell` and `dock-zone` render. The component itself has no caller and is a candidate for deletion, not a slot to fill.",
  },
];

/** Where `name` is really defined, following `export { name } from "..."` through barrels. */
function exportOrigin(file: string, name: string, seen = new Set<string>()): string | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const source = sourceFile(file);

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return file;
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) return file;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return file;
      }
    }
  }

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveSpecifier(statement.moduleSpecifier.text, file);
    if (target === null) continue;
    const clause = statement.exportClause;
    if (clause === undefined) {
      const through = exportOrigin(target, name, seen);
      if (through !== null) return through;
      continue;
    }
    if (!ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      if (element.name.text !== name) continue;
      const original = element.propertyName?.text ?? name;
      const through = exportOrigin(target, original, seen);
      if (through !== null) return through;
    }
  }
  return null;
}

/** Every exported `*Pane` / `*Panel` component, by name and defining module. */
function collectPanes(): Array<{ name: string; file: string }> {
  const panes: Array<{ name: string; file: string }> = [];
  for (const path of sources) {
    if (isTestFile(path) || !path.endsWith(".tsx")) continue;
    for (const statement of sourceFile(path).statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      const exported =
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        if (PANE_NAME.test(statement.name.text)) panes.push({ name: statement.name.text, file: path });
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && PANE_NAME.test(declaration.name.text)) {
            panes.push({ name: declaration.name.text, file: path });
          }
        }
      }
    }
  }
  return panes.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

/** Does a reachable module import THIS pane from THIS module, and use it? */
function isRendered(pane: { name: string; file: string }): boolean {
  for (const path of sources) {
    if (path === pane.file || isTestFile(path) || !reachable.has(path)) continue;
    if (!(referencesByFile.get(path)?.has(pane.name) ?? false)) continue;
    for (const statement of sourceFile(path).statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      const imported = bindings.elements.find((element) => element.name.text === pane.name);
      if (imported === undefined) continue;
      const target = resolveSpecifier(statement.moduleSpecifier.text, path);
      if (target === null) continue;
      const origin = exportOrigin(target, imported.propertyName?.text ?? pane.name);
      if (origin === pane.file) return true;
    }
  }
  return false;
}

const panes = collectPanes();
const unrendered = panes.filter((pane) => !isRendered(pane));
const excusedPanes = new Map(NOT_RENDERED.map((entry) => [entry.name, entry.reason]));

describe("§V241 — every pane module is rendered by the app (T330)", () => {
  it("finds real panes, or it is measuring nothing", () => {
    expect(panes.length).toBeGreaterThan(4);
    // The shell's own slots are the registry this is enumerated against.
    expect(panes.some((pane) => pane.name === "ViewerPane")).toBe(true);
  });

  it("renders every pane, or says in writing why it does not", () => {
    const surprises = unrendered.filter((pane) => !excusedPanes.has(pane.name));
    if (surprises.length > 0) {
      const listed = surprises
        .map((pane) => `  ${pane.name}  (${relative(ROOT, pane.file)})`)
        .join("\n");
      throw new Error(
        `${surprises.length} pane module${surprises.length === 1 ? " is" : "s are"} not rendered by ` +
          `anything the app reaches (§V241). B34 was exactly this: two panes named ViewerPane, and the ` +
          `app shipped the poorer one. Render it, or add it to NOT_RENDERED with the reason:\n${listed}`,
      );
    }
    expect(surprises).toEqual([]);
  });

  it("has no stale excuse", () => {
    const stillUnrendered = new Set(unrendered.map((pane) => pane.name));
    const stale = [...excusedPanes.keys()].filter((name) => !stillUnrendered.has(name));
    expect(stale).toEqual([]);
  });
});
