import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { PLANNED_COMMANDS } from "@domain/types/commands.ts";
import type { MenuEntry } from "@domain/types/menus.ts";
import { isMenuSeparator } from "@domain/types/menus.ts";
import { createHarness } from "@domain/commands/test-support.ts";
// The keymap's data table directly, not through `@editor/keymap/index.ts` — the barrel
// pulls the React provider and the key-hint components into a node-environment test.
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { menuSchemaFor } from "@editor/menus/schemas.ts";

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
    name: "createPreviewViewStore",
    reason:
      "Composed by `previewViewStoreFor` in the SAME module — the bus-keyed accessor the graph pane, the node info popup and the preview slot all resolve, so all three share one lens store (T336). The product path is `usePreviewViews` in `graph-pane.tsx`; `use-node-previews.test.ts` asserts a lens set on this store reaches the preview pass's uniforms.",
  },
  {
    name: "createReferenceLinesStore",
    reason:
      "Composed by `referenceLinesStoreFor` in the SAME module — the bus-keyed accessor, so two canvases on one document (the floated graph pane, \u00a7V97) agree about what they are drawing (T248). The product path is `registerReferenceLinesCommand` in `graph-canvas.tsx`; `graph-canvas/reference-lines.test.tsx` toggles it through the bus command and asserts the lines leave the DOM.",
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

/**
 * The surface families this enumerates (T330, widened by T356, RE-POINTED by T361).
 *
 * `Pane` and `Panel` fill the shell's slots, which is a registry — `AppShellProps` names
 * them — and that is why §V241 was comfortable enumerating them. This half is unchanged.
 *
 * The OTHER half — whole surfaces a user OPENS — used to be `Dialog|Settings|Popup`, three
 * more name suffixes, added when a third shape turned up (B38: `KeybindingSettings`,
 * referenced only by its own test). T356 wrote down its own weakness at the time: a naming
 * convention only catches what somebody happened to name conventionally, and a surface
 * called `ShortcutEditor` would walk straight past it.
 *
 * §V307 is what makes a registry available, and T361 takes it. An openable surface is now
 * opened by a COMMAND, so the openable set is enumerated two ways below, neither of them a
 * name:
 *
 *  - MODAL SURFACES are the modules that render `DialogRoot` — the app's single dialog
 *    primitive (T5). Every modal in the tree goes through it, so what the component is
 *    CALLED stops mattering: `ShortcutEditor` is caught by construction. Measured, this
 *    finds five modules where the three name suffixes found four, and one of the extras
 *    is `CommandPalette`, which the naming convention never saw at all.
 *  - COMMANDS are enumerated in their own describe below, against the `CommandMap`
 *    declaration blocks — the registry TypeScript itself enforces, since `registerCommand`
 *    and `execute` refuse a name that is not in it.
 *
 * The alternative — every exported component nothing renders — was measured before being
 * rejected: 88 exported components, 63 of which match no surface family at all. That check
 * would report buttons, rows and badges by the dozen and be switched off within a week.
 *
 * `Popup` is deliberately NOT replaced by the popover primitive the way `Dialog` is
 * replaced by the dialog one: `PopoverRoot` is also what a colour swatch and a ramp stop
 * editor render, so enumerating it would report field-level controls by the dozen — §V241's
 * own warning about a check nobody keeps. `NodeInfoPopup`, the one surface that suffix
 * covered, is covered instead by the COMMAND half below: `ui.showNodeInfo` is in the
 * registry, and being opened by a command is what §V307 says a surface IS.
 *
 * The limit worth stating, because a guard believed complete is worse than one known to be
 * partial: a surface that is NEITHER a shell slot NOR a modal — an inline editing surface
 * living inside another pane — is still invisible here. That is exactly what
 * `KeybindingSettings` was. §V307 is what closes it, because such a surface still has to be
 * opened by a command and the command half sees that; a surface with no command at all is a
 * §V307 breach this file cannot detect, only the review that flips the row can.
 */
const PANE_NAME = /(?:Pane|Panel)$/;

/** The app's one dialog primitive. A module rendering it is a modal surface (§V307). */
const MODAL_ELEMENT = "DialogRoot";

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

/** Does this subtree render `<DialogRoot>` — i.e. is this component a modal surface? */
function rendersModal(node: ts.Node, file: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) &&
      child.tagName.getText(file) === MODAL_ELEMENT
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * Every exported surface, by name and defining module: a `*Pane` / `*Panel` (the shell's
 * own slot registry) or a component that renders the dialog primitive (§V307's openable
 * surfaces, enumerated by what they ARE rather than what they are called).
 */
function collectPanes(): Array<{ name: string; file: string }> {
  const panes: Array<{ name: string; file: string }> = [];
  for (const path of sources) {
    if (isTestFile(path) || !path.endsWith(".tsx")) continue;
    const file = sourceFile(path);
    for (const statement of file.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      const exported =
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        if (PANE_NAME.test(statement.name.text) || rendersModal(statement, file)) {
          panes.push({ name: statement.name.text, file: path });
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          if (PANE_NAME.test(declaration.name.text) || rendersModal(declaration, file)) {
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

describe("§V241 — every surface module is rendered by the app (T330, T356, T361)", () => {
  it("finds real surfaces, or it is measuring nothing", () => {
    expect(panes.length).toBeGreaterThan(4);
    // The shell's own slots are the registry the PANE half is enumerated against.
    expect(panes.some((pane) => pane.name === "ViewerPane")).toBe(true);
    // And the MODAL half really is finding modals. Named individually, and by a name the
    // old `Dialog|Settings|Popup` families did NOT match, so nobody can quietly shrink
    // this back to a suffix test and still have it pass: `CommandPalette` is only here
    // because the enumeration reads what a component RENDERS (T361, §V307).
    const modalNames = panes.map((pane) => pane.name);
    expect(modalNames).toContain("ProjectSettingsDialog");
    expect(modalNames).toContain("CommandPalette");
    expect(modalNames).toContain("HelpPanel");
    // A widened guard invites quiet shrinking, so the count has a floor too. Five modal
    // modules were measured when this was written; four is a regression, not a tidy-up.
    const modals = panes.filter((pane) => !PANE_NAME.test(pane.name));
    expect(modals.length).toBeGreaterThanOrEqual(4);
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

/**
 * COMMANDS (T361, §V307).
 *
 * §V307's rule is that an OPENABLE SURFACE IS OPENED BY A COMMAND. What that buys the
 * guard is a registry where T356 had a naming convention: a command cannot exist outside
 * `CommandMap`, because TypeScript refuses `registerCommand` and `execute` for a name that
 * is not declared in it. So this half enumerates the declaration-merging blocks — the
 * registry as the compiler sees it — and asks the same question the rest of the file asks
 * of everything else: does anything the running product reaches actually WIRE this?
 *
 * ## Why "a registrar module" and not "a call site"
 *
 * Two of the command families register in a LOOP over their own table (`node.toggle*`,
 * `transport.play`/`pause`), so the `name:` property is an identifier rather than a
 * literal at the point of the call. Reading only literal `name:` properties would report
 * six false positives and get an allowlist written for it within a week — which is how a
 * guard becomes furniture. A module that calls `registerCommand` AND contains the command's
 * name is the registrar, whichever shape the call takes.
 *
 * ## Why the registrar must be CALLED, not merely reachable
 *
 * Module reachability alone is not evidence of anything here, and this was measured rather
 * than assumed: a barrel `index.ts` the app imports re-exports every module beside it, so
 * "the entry points reach this file" is true of a command module the instant it is added to
 * its directory's barrel — including one whose registrar nobody calls. So the rule is the
 * same one the factory half uses: some exported FUNCTION of the registrar module must be
 * REFERENCED by a different module the entry points reach. Consts are not enough, because
 * `OPEN_SETTINGS_COMMAND` being imported for a keymap label says nothing about whether the
 * command was ever registered. Verified by unwiring `registerProjectSettingsCommand` and
 * watching this go red.
 *
 * ## What it does and does not catch
 *
 * It catches the §V307 shape of §V220: a command declared, implemented, and called by
 * nothing the product runs — the surface built, tested and dead. It does NOT catch a
 * registrar function that a live module calls only from a component nobody renders; the
 * runtime half of that lives beside each surface (`project-settings-ui.test.tsx` executes
 * `ui.openSettings` against the composed app and requires a dialog to appear). And it
 * cannot see a surface that never got a command at all, which is a §V307 breach by
 * definition rather than a wiring bug — the review that flips the row is what catches that.
 */

/** Commands declared but deliberately not registered by a product entry point. */
const COMMANDS_NOT_REGISTERED: ReadonlyArray<{ name: string; reason: string }> = [
  // Empty is the good state, and the both-directions rule below keeps it honest: an entry
  // whose command got wired fails just as loudly as a command with no registrar.
];

/** Every command name declared in a `CommandMap` block, and the module declaring it. */
function collectDeclaredCommands(): Map<string, string> {
  const declared = new Map<string, string>();
  for (const path of sources) {
    if (isTestFile(path)) continue;
    const file = sourceFile(path);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "CommandMap") {
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || member.name === undefined) continue;
          if (!ts.isStringLiteral(member.name)) continue;
          declared.set(member.name.text, path);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return declared;
}

/** Modules that call `registerCommand`, with every string literal they contain. */
function collectRegistrars(): Array<{ file: string; literals: ReadonlySet<string> }> {
  const registrars: Array<{ file: string; literals: ReadonlySet<string> }> = [];
  for (const path of sources) {
    if (isTestFile(path)) continue;
    const file = sourceFile(path);
    let registers = false;
    const literals = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const called = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : "";
        if (called === "registerCommand") registers = true;
      }
      if (ts.isStringLiteral(node)) literals.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (registers) registrars.push({ file: path, literals });
  }
  return registrars;
}

const declaredCommands = collectDeclaredCommands();
const registrars = collectRegistrars();

/** Every exported function declaration of a module, by name. */
function exportedFunctions(path: string): readonly string[] {
  const names: string[] = [];
  for (const statement of sourceFile(path).statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    const exported =
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (exported) names.push(statement.name.text);
  }
  return names;
}

/** Does a module the entry points reach actually CALL into this registrar module? */
function registrarIsCalled(modulePath: string): boolean {
  const names = exportedFunctions(modulePath);
  if (names.length === 0) return false;
  for (const path of sources) {
    if (path === modulePath || isTestFile(path) || !reachable.has(path)) continue;
    const referenced = referencesByFile.get(path);
    if (referenced === undefined) continue;
    if (names.some((name) => referenced.has(name))) return true;
  }
  return false;
}

const calledRegistrars = new Map<string, boolean>(
  registrars.map((registrar) => [registrar.file, registrarIsCalled(registrar.file)] as const),
);

const unregisteredCommands = [...declaredCommands.entries()]
  .filter(
    ([name]) =>
      !registrars.some(
        (registrar) => registrar.literals.has(name) && calledRegistrars.get(registrar.file) === true,
      ),
  )
  .map(([name, declaredIn]) => ({ name, file: relative(ROOT, declaredIn) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const excusedCommands = new Map(COMMANDS_NOT_REGISTERED.map((entry) => [entry.name, entry.reason]));

describe("§V307 — every command in the registry is registered by the product (T361)", () => {
  it("finds the real registry, or it is measuring nothing", () => {
    // 53 commands were declared when this was written. A scan that broke and found a
    // handful would otherwise pass silently, having asked nothing of anything.
    expect(declaredCommands.size).toBeGreaterThan(40);
    expect(registrars.length).toBeGreaterThan(10);
    // And it is not matching everything: `registerCommand` is rare, panes and nodes are
    // not registrars, and if this ever approached the file count the walk is broken.
    expect(registrars.length).toBeLessThan(sources.length / 10);
    // The "is it called" half is doing work in both directions: some registrar modules
    // are live, and the check is not a constant `true`.
    expect([...calledRegistrars.values()].filter(Boolean).length).toBeGreaterThan(5);

    // The openable surfaces §V307 is about, named individually so that DELETING one goes
    // red here rather than making the guard quieter. `ui.openSettings` is T359 itself: it
    // was the one surface opened by a `useState` flag, unreachable from the palette and
    // from every keybinding, and the whole reason this half exists.
    for (const command of [
      "ui.openSettings",
      "ui.openHelp",
      "ui.showNodeInfo",
      "ui.openCommandPalette",
      "preview.setView",
    ]) {
      expect(declaredCommands.has(command), command).toBe(true);
      expect(excusedCommands.has(command), command).toBe(false);
    }
  });

  it("registers every declared command, or says in writing why it does not", () => {
    const surprises = unregisteredCommands.filter((command) => !excusedCommands.has(command.name));
    if (surprises.length > 0) {
      const listed = surprises.map((command) => `  ${command.name}  (${command.file})`).join("\n");
      throw new Error(
        `${surprises.length} command${surprises.length === 1 ? " is" : "s are"} declared in CommandMap ` +
          `but registered by nothing a product entry point reaches (§V307). A surface whose command is ` +
          `not registered is unreachable from the palette, from every keybinding and from an agent, ` +
          `however well its own suite passes. Register it in a module the app reaches, or add it to ` +
          `COMMANDS_NOT_REGISTERED with the reason:\n${listed}`,
      );
    }
    expect(surprises).toEqual([]);
  });

  it("has no stale excuse — a command that got wired must leave the list", () => {
    const stillUnregistered = new Set(unregisteredCommands.map((command) => command.name));
    const stale = [...excusedCommands.keys()].filter((name) => !stillUnregistered.has(name));
    const vanished = [...excusedCommands.keys()].filter((name) => !declaredCommands.has(name));
    expect({ stale, vanished }).toEqual({ stale: [], vanished: [] });
  });
});

/**
 * KEYMAP AND MENU BINDINGS (T365, §V307, §V220).
 *
 * ## The bug this exists for
 *
 * `mod+,` named `ui.openSettings` in the default keymap from T77. Nothing registered that
 * command until T359. The engine's contract for that case is `status: "unresolved"` —
 * reported, never thrown, never stubbed — which is the right RUNTIME behaviour and was,
 * for months, the only thing standing between a shipped keyboard shortcut and a user who
 * pressed it. Nobody looked at those reports, because a report nothing reads is a silence.
 * It was found by accident while building the settings command.
 *
 * So the rule is: a binding may name a command that does not exist only if somebody wrote
 * down that they meant to. `PLANNED_COMMANDS` is where they write it.
 *
 * ## Why "declared in CommandMap" is the right question, and what makes it sufficient
 *
 * `CommandMap` is the registry the compiler enforces: `registerCommand` and `execute`
 * refuse a name that is not in it, so a command cannot exist outside it. Declared is not
 * by itself the same as LIVE — but the §V307 half above already requires every declared
 * command to have a registrar module that a product entry point reaches AND calls, so the
 * two compose: a bound, non-planned command is declared, registered, and registered by
 * something the app runs.
 *
 * What that composition still does NOT catch is a registrar called only from a component
 * nobody renders. `keymap-dispatch.test.tsx` closes that half at runtime, against the
 * mounted `App`, for exactly the commands listed here.
 *
 * ## Both directions, so the allowlist cannot become a dumping ground
 *
 * An entry that got built fails (`PLANNED_COMMANDS` names a declared command), and an
 * entry nothing names fails (a promise to nobody). Promoting a planned command is
 * therefore one edit — declare it — and this gate names the line to delete.
 */

/** Every command the default keymap binds. */
const boundCommands = [...new Set(DEFAULT_BINDINGS.map((binding) => binding.command))].sort();

/** Every command the right-click menus name, at every submenu depth. */
const menuCommands = (() => {
  const registry = createHarness("seams").bus.registry;
  const names = new Set<string>();
  const walk = (entries: readonly MenuEntry[]): void => {
    for (const entry of entries) {
      if (isMenuSeparator(entry)) continue;
      if (entry.command !== undefined) names.add(entry.command);
      if (entry.submenu !== undefined) walk(entry.submenu);
    }
  };
  for (const surface of ["canvas", "node", "port", "edge", "parameter"] as const) {
    walk(menuSchemaFor(surface, registry).entries);
  }
  return [...names].sort();
})();

const namedByData = [...new Set([...boundCommands, ...menuCommands])].sort();
const plannedSet = new Set<string>(PLANNED_COMMANDS);

describe("§V307/T365 — a binding names a command that exists, or one somebody planned", () => {
  it("is reading the real tables, or it is measuring nothing", () => {
    // 35 bound and 33 menu-named commands when this was written. A walk that broke and
    // found a handful would otherwise pass having asked nothing of anything.
    expect(boundCommands.length).toBeGreaterThan(30);
    expect(menuCommands.length).toBeGreaterThan(20);
    // And the tables really do overlap the registry in both directions: some bound
    // commands are declared, some are not. Either extreme means the scan is broken.
    const declaredAndBound = boundCommands.filter((command) => declaredCommands.has(command));
    expect(declaredAndBound.length).toBeGreaterThan(15);
    expect(declaredAndBound.length).toBeLessThan(boundCommands.length);
  });

  it("has no binding naming a command that is neither declared nor planned", () => {
    const orphans = boundCommands.filter(
      (command) => !declaredCommands.has(command) && !plannedSet.has(command),
    );
    if (orphans.length > 0) {
      const listed = orphans
        .map((command) => {
          const ids = DEFAULT_BINDINGS.filter((binding) => binding.command === command)
            .map((binding) => `${binding.id} (${binding.keys})`)
            .join(", ");
          return `  ${command}  bound by ${ids}`;
        })
        .join("\n");
      throw new Error(
        `${orphans.length} keymap binding${orphans.length === 1 ? "" : "s"} name${orphans.length === 1 ? "s" : ""} ` +
          `a command that is in neither \`CommandMap\` nor \`PLANNED_COMMANDS\` (§V307, T365). The engine reports ` +
          `\`unresolved\` for these and nothing reads that, so the key does NOTHING — which is how \`mod+,\` shipped ` +
          `dead from T77 to T359. Declare and register the command, or add it to \`PLANNED_COMMANDS\` in ` +
          `\`src/domain/types/commands.ts\` so the promise is written down:\n${listed}`,
      );
    }
    expect(orphans).toEqual([]);
  });

  it("has no menu item naming a command that is neither declared nor planned", () => {
    const orphans = menuCommands.filter(
      (command) => !declaredCommands.has(command) && !plannedSet.has(command),
    );
    expect(orphans).toEqual([]);
  });

  it("keeps every planned command UNREGISTERED, so the palette can stay honest", () => {
    // The other direction, and the reason promoting a planned command is one edit: the
    // moment `view.frameAll` is declared in a `CommandMap` block, this names it and says
    // which line to delete. Leaving it here would mean the menus render a live command
    // disabled and the palette calls a built command unavailable.
    const built = [...PLANNED_COMMANDS].filter((command) => declaredCommands.has(command));
    expect(built, "declared in CommandMap — delete these from PLANNED_COMMANDS").toEqual([]);
  });

  it("has no planned command that neither a binding nor a menu names", () => {
    // Without this the allowlist is a dumping ground: anyone could quiet the gate above by
    // adding a name, and nothing would ever make them take it back out.
    const promised = new Set(namedByData);
    const orphaned = [...PLANNED_COMMANDS].filter((command) => !promised.has(command));
    expect(orphaned, "planned but named by no menu and no binding — delete these").toEqual([]);
  });
});
