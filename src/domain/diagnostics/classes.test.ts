import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CLASS_REASONS } from "./class-reasons.ts";
import { DIAGNOSTIC_CLASSES, diagnosticClass, leavesPlanUsable, stopsFinalRender } from "./classes.ts";

/**
 * T1641b — EVERY DIAGNOSTIC CODE THE SOURCE CAN EMIT HAS A CLASS, AND EVERY ROW NAMES ONE.
 *
 * A code is a plain string, written wherever a diagnostic is built: in some four hundred
 * object literals, and at every call of the dozens of helpers that take one as an argument.
 * So a table of codes kept by hand is a table that is wrong by the next commit, and the two
 * defects that asked for it (§B262, §B264) were codes whose meaning nobody had written
 * down. This gate reads the codes out of the syntax tree and holds `DIAGNOSTIC_CLASSES` to
 * them in both directions.
 *
 * ## How a code is found
 *
 * A code enters a diagnostic at one kind of place: the `code` property of an object
 * literal. Every such property in the tree is a SITE, and its value is read back to the
 * string literals it can hold. What is read:
 *
 *  - a string literal;
 *  - a CONSTANT: an identifier bound by `const`, here or in the module it is imported from
 *    (through `export … from` too), and a member of a table of them: `Codes.x`, and
 *    `Codes[key]`, which is every member;
 *  - a TERNARY: both arms;
 *  - a HELPER'S PARAMETER (`const refuse = (code, message) => ({ severity, code, message })`):
 *    that argument of every call of the helper, and the parameter's default. Its calls are
 *    looked for in its own file and in every file that imports it: by name, under another
 *    name (`import { refuse as deny }`, `export { refuse as deny }`, through a barrel) and
 *    as `lib.refuse(…)` off a namespace import. An argument is read the same way, so a
 *    helper may pass its code to another; and a helper HANDED to a function
 *    (`expand(step, skip)`) is followed into the calls that function makes of it;
 *  - a code READ OFF another object (`picked.code`, `{ code }` taken out of one): that
 *    object was built at a site of its own;
 *  - a NUMBER: another protocol's code (JSON-RPC), never a diagnostic's.
 *
 * ## What it cannot read fails, by file and line
 *
 * A TEMPLATE with a substitution is the main one: what it can spell is in the types, and a
 * parser does not see types. Also a `let`, an array pattern, a call's result, the parameter
 * of a function with no name to find the calls of, a helper passed about as a value in any
 * other way, a helper that is a default export. None of these is skipped. Each is reported
 * where it stands, and the choices are to write the code in a form above, or to name the
 * construction in `LISTED` below with the codes it produces, which are then held to the
 * table like any other. An object whose `code` is not a diagnostic's at all (a shader
 * module's source, a pairing code) is named in `NOT_A_DIAGNOSTIC`. Both ledgers are checked
 * for lines that no longer match anything.
 *
 * ## What it cannot see at all
 *
 * A code that never passes through a `code` property (none today); one that arrives from
 * outside the tree (a library's own error code read off a thrown object); a helper reached
 * by `import()` or through an object it was stored in under another key; and what a
 * `LISTED` line leaves out: the gate checks a listed template's codes against the
 * template's fixed text, not against the type that fills it. Test files are not read: a
 * code only a test builds is not the product's.
 *
 * It reads the tree rather than importing what it checks, so no dependency selector can
 * find it. It is on `test:gates` (§V957).
 */

const ROOT = resolve(import.meta.dirname, "../../..");

/** A place in the source tree: what a failure names. */
interface Site {
  readonly file: string;
  readonly line: number;
  /** The expression as written, on one line. */
  readonly text: string;
}

interface Unread extends Site {
  readonly why: string;
  /** When the expression is itself a `code` property's value: the object it sits in, as `NOT_A_DIAGNOSTIC` keys it. */
  readonly shape?: string;
}

/** file → the key the ledger is held by → what it says. */
type Ledger<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const WGSL = "WGSL source text, held under `code` beside what was reflected from it";
const HELLO = "the hello a page sends a helper: `code` is its pairing code";

/**
 * Objects with a `code` that is not a diagnostic's, by file and by the names of the
 * object's properties, each with what the object is.
 */
const NOT_A_DIAGNOSTIC: Ledger<string> = {
  "src/agent/schemas.ts": { "{ code, message, path }": "a zod issue: `code` is zod's own" },
  "src/devices/device-client.ts": { "{ type, code, client }": HELLO },
  "src/devices/terminal-client.ts": { "{ type, code, client }": HELLO },
  "src/mcp/bridge-client.ts": { "{ type, code, client }": HELLO },
  "src/editor/keymap/resolve.ts": { "{ code, bindingId, message }": "a KeymapProblem, whose three codes are that type's own union" },
  "src/nodes/definitions/material-wgsl.ts": { "{ code, params }": WGSL, "{ code, paramsDeclaration, fields, uniforms, ..., ..., sourceMap }": WGSL },
  "src/nodes/shaders/scene-render.wgsl.ts": { "{ code, paramsDeclaration, fields }": WGSL, "{ ..., code }": WGSL },
  "src/runtime/backend/vgpu/vgpu-backend.ts": { "{ code, label }": "a shader module's descriptor", "{ code }": "a shader module's descriptor" },
  "src/runtime/backend/vgpu/output-accumulator.ts": { "{ label, code }": "a shader module's descriptor" },
  "src/runtime/backend/photo-depth-refinement.ts": { "{ label, code }": "a shader module's descriptor; code holds WGSL source" },
};

/**
 * Constructions the census cannot read, by file and by the expression as written, each
 * with every code it produces. A template's codes are checked against its fixed text; the
 * rest of a line is the word of whoever wrote it.
 */
const LISTED: Ledger<readonly string[]> = {
  "src/app/use-file-references.ts": {
    // Every status of a retained file but `ready`, which never reports.
    "`asset.reference.${status!.kind}`": ["asset.reference.pending", "asset.reference.permission", "asset.reference.missing", "asset.reference.error"],
  },
  "src/app/native-vision-sources.ts": {
    // T1818b: one manager runs both native models; its config's `family` is "vision"
    // (Person Mask) or "depth" (Depth on Core ML, `native-depth.ts`).
    "`${config.family}.native.refused`": ["vision.native.refused", "depth.native.refused"],
    "`${config.family}.native.starting`": ["vision.native.starting", "depth.native.starting"],
    "`${config.family}.native.retirement`": ["vision.native.retirement", "depth.native.retirement"],
  },
  "src/domain/components/parent-scope.ts": {
    "`component.parentScope.${lookup.reason}`": ["component.parentScope.no-scope", "component.parentScope.too-deep", "component.parentScope.unknown-key"],
  },
  "src/domain/presets/commands.ts": {
    // `code` is `bankLookupRefusal`'s own parameter, a function whose default spells `preset.bank.<why>`.
    'code("type")': ["preset.bank.type"],
    'code("noCatalogue")': ["preset.bank.noCatalogue"],
    'code("notInstalled")': ["preset.bank.notInstalled"],
    'code("noPageBank")': ["preset.bank.noPageBank"],
    // `notBank` takes the other arm of the ternary this sits in.
    "`preset.recalls.${lookup.why}`": ["preset.recalls.noCatalogue", "preset.recalls.notInstalled", "preset.recalls.noPageBank"],
  },
  "src/nodes/definitions/corner-pin.ts": {
    // Bound by a `for … of` over two [quad, name, code] rows.
    code: ["cornerPin.pin.degenerate", "cornerPin.extract.degenerate"],
  },
};

/**
 * DEBT (T1641b): the codes that are emitted today for conditions of more than one class.
 * Each carries `splits` in the table. T1641b splits them, and this list goes down with
 * each: a code that is split leaves it, and a new code may not join it.
 */
const SPLITS_OWED: readonly string[] = [
  "compiler/definition-version",
  "compiler/edge-endpoint-missing",
  "compiler/source-reference-missing",
  "component.parameter.noTargets",
  "component.parentScope.type",
  "cue.timeline.bank",
  "cue.timeline.preset",
  "node.compile.missingResource",
  "node.customWgsl.module",
  "node.parameter.map",
  "node.points.capacity",
  "node.points.curve",
  "node.points.curveFrames",
  "node.points.gather",
  "node.points.group",
  "node.points.kernel",
  "node.points.range",
  "node.points.resample",
  "node.points.rope",
  "node.points.sweep",
  "node.scene.geometry",
  "node.scene.instanceAttribute",
  "node.scene.shape",
  "node.surface.topology",
  "project.components.invalid",
  "wgsl/compile",
];

/**
 * RETIRED (T1641b): a code that was split, and the files that still NAME it.
 *
 * Nothing emits a retired code: it has no row, and the census fails a code with no row. That
 * is half of it. A guard that READS one (`d.code === "parameter.expression"`, expecting
 * none) goes blind the day the code is split, and stays green. So no file under `src/`, tests
 * included, may spell a retired code as a string, except the files listed here, which are
 * waiting on an edit this task does not own. A line goes when its file stops naming the code.
 */
const RETIRED: Readonly<Record<string, readonly string[]>> = {
  // Slice 1: split by failure kind into `parameter.expression.*` and `parameter.reference.*`.
  // The consumer's render script asked the class instead (`fe9d2cac`): nobody is waiting.
  "parameter.expression": [],
  // Slice 1b: split by kind into `parameter.bind.unreadable`, `.type`, `.value`, `.unavailable`.
  "parameter.bind": [],
  // Slice 2: merged into `parameter.unknown`, the write gate's code for the same key. The
  // consumer session owns this test; its filter on the old code moves to the class.
  "compiler/parameter-unknown": [],
};

interface CensusOptions {
  /** `["@domain/", "src/domain/"]` pairs, longest prefix first. */
  readonly aliases?: ReadonlyArray<readonly [string, string]>;
  readonly notADiagnostic?: Ledger<string>;
  readonly listed?: Ledger<readonly string[]>;
}

interface Census {
  /** code → every `file:line` it was read at. */
  readonly codes: ReadonlyMap<string, readonly string[]>;
  readonly unread: readonly Unread[];
  /** `file › key` of every ledger line that matched something. */
  readonly ledgerLinesUsed: ReadonlySet<string>;
}

type Declaration =
  | { readonly kind: "const" | "let"; readonly node: ts.VariableDeclaration }
  | { readonly kind: "parameter"; readonly node: ts.ParameterDeclaration; readonly owner: ts.SignatureDeclaration; readonly index: number }
  /** Bound by an object pattern: `{ code }`, `{ code: mine }`. */
  | { readonly kind: "member"; readonly property: string }
  | { readonly kind: "function"; readonly node: ts.FunctionDeclaration }
  | { readonly kind: "import"; readonly node: ts.ImportSpecifier }
  /** Any other binding: an array pattern, a loop variable, a catch variable, a namespace import. */
  | { readonly kind: "other" };

/** What a helper is called by: its own declaration, or a parameter it was handed in as. */
type Callable = ts.VariableDeclaration | ts.FunctionDeclaration | ts.ParameterDeclaration;

const oneLine = (node: ts.Node): string => node.getText().replace(/\s+/g, " ");

const propertyNameOf = (name: ts.PropertyName | ts.BindingName | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;

/** An object literal by the names of its properties: `{ severity, code, message, ... }`. */
const shapeOf = (literal: ts.ObjectLiteralExpression): string =>
  `{ ${literal.properties.map((property) => (ts.isSpreadAssignment(property) ? "..." : (propertyNameOf(property.name) ?? "?"))).join(", ")} }`;

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** How a declaration's name (an identifier or a pattern) binds `wanted`, if it does. */
function bindingIn(name: ts.BindingName, wanted: string): "identifier" | { readonly member: string } | "other" | undefined {
  if (ts.isIdentifier(name)) return name.text === wanted ? "identifier" : undefined;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const inner = bindingIn(element.name, wanted);
    if (inner === undefined) continue;
    if (inner === "identifier" && ts.isObjectBindingPattern(name) && element.dotDotDotToken === undefined) {
      return { member: propertyNameOf(element.propertyName) ?? wanted };
    }
    return "other";
  }
  return undefined;
}

/** True where an identifier NAMES something rather than reads it. */
function isNotAReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isQualifiedName(parent)) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isBindingElement(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  for (let node: ts.Node | undefined = parent; node !== undefined; node = node.parent) {
    if (ts.isTypeNode(node)) return true;
    if (ts.isStatement(node)) break;
  }
  return false;
}

/** The census of the docblock above, over `path → text`. */
function censusOf(sources: ReadonlyMap<string, string>, options: CensusOptions = {}): Census {
  const aliases = options.aliases ?? [];
  const notADiagnostic = options.notADiagnostic ?? {};
  const listed = options.listed ?? {};

  /*
   * Parsed on demand: a file is read into a tree when it can hold a site (its text says
   * `code`), when something imports from it, or when it spells the name of a helper another
   * file exports. Parsing is nearly all this gate costs; when it landed that was 728 of the
   * tree's 1,116 files.
   */
  const parsed = new Map<string, ts.SourceFile>();
  const sourceOf = (file: string): ts.SourceFile => {
    let source = parsed.get(file);
    if (source === undefined) {
      source = ts.createSourceFile(file, sources.get(file) as string, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      parsed.set(file, source);
    }
    return source;
  };

  const codes = new Map<string, string[]>();
  const unread: Unread[] = [];
  const ledgerLinesUsed = new Set<string>();

  const siteOf = (node: ts.Node, file: string): Site => ({
    file,
    line: sourceOf(file).getLineAndCharacterOfPosition(node.getStart(sourceOf(file))).line + 1,
    text: oneLine(node),
  });
  const emit = (code: string, node: ts.Node, file: string): void => {
    const at = `${file}:${siteOf(node, file).line}`;
    const known = codes.get(code);
    if (known === undefined) codes.set(code, [at]);
    else if (!known.includes(at)) known.push(at);
  };
  const cannotRead = (node: ts.Node, file: string, why: string): void => {
    const site = siteOf(node, file);
    const named = listed[file]?.[site.text];
    if (named !== undefined) {
      ledgerLinesUsed.add(`${file} › ${site.text}`);
      for (const code of named) emit(code, node, file);
      return;
    }
    if (unread.some((entry) => entry.file === site.file && entry.line === site.line && entry.text === site.text)) return;
    const property = node.parent;
    const literal = (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && propertyNameOf(property.name) === "code" ? property.parent : undefined;
    unread.push({ ...site, why, ...(literal === undefined ? {} : { shape: shapeOf(literal) }) });
  };

  // ── modules ────────────────────────────────────────────────────────────────────────
  function resolveModule(from: string, specifier: string): string | undefined {
    let base: string | undefined;
    if (specifier.startsWith(".")) {
      const parts = from.split("/").slice(0, -1);
      for (const part of specifier.split("/")) {
        if (part === "." || part === "") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
      }
      base = parts.join("/");
    } else {
      const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
      if (alias !== undefined) base = alias[1] + specifier.slice(alias[0].length);
    }
    if (base === undefined) return undefined;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => sources.has(candidate));
  }

  interface Exported {
    readonly file: string;
    readonly node: ts.VariableDeclaration | ts.FunctionDeclaration;
  }

  /** The declaration a module exports under `name`, through `export … from` and `export *`. */
  function exportOf(file: string, name: string, seen: Set<string> = new Set()): Exported | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key) || !sources.has(file)) return undefined;
    seen.add(key);
    const source = sourceOf(file);
    const local = (wanted: string): Exported | undefined => {
      for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === wanted) return { file, node: statement };
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === wanted) return { file, node: declaration };
        }
      }
      return undefined;
    };
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const target = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? resolveModule(file, statement.moduleSpecifier.text) : undefined;
      if (statement.exportClause === undefined) {
        const through = target === undefined ? undefined : exportOf(target, name, seen);
        if (through !== undefined) return through;
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          if (specifier.name.text !== name) continue;
          const original = (specifier.propertyName ?? specifier.name).text;
          if (statement.moduleSpecifier === undefined) return local(original);
          return target === undefined ? undefined : exportOf(target, original, seen);
        }
      }
    }
    return local(name);
  }

  const importTargets = new Map<ts.ImportSpecifier, Exported | undefined>();
  const importTarget = (specifier: ts.ImportSpecifier, file: string): Exported | undefined => {
    if (importTargets.has(specifier)) return importTargets.get(specifier);
    const declaration = specifier.parent.parent.parent;
    const target = ts.isStringLiteral(declaration.moduleSpecifier) ? resolveModule(file, declaration.moduleSpecifier.text) : undefined;
    const found = target === undefined ? undefined : exportOf(target, (specifier.propertyName ?? specifier.name).text);
    importTargets.set(specifier, found);
    return found;
  };

  // ── names ──────────────────────────────────────────────────────────────────────────
  /** What an identifier is bound to, by the scopes around it, innermost first. */
  function declarationOf(identifier: ts.Identifier): Declaration | undefined {
    const wanted = identifier.text;
    const fromList = (list: ts.VariableDeclarationList): Declaration | undefined => {
      for (const declaration of list.declarations) {
        const bound = bindingIn(declaration.name, wanted);
        if (bound === undefined) continue;
        if (bound === "identifier") return { kind: (list.flags & ts.NodeFlags.Const) !== 0 ? "const" : "let", node: declaration };
        return bound === "other" ? { kind: "other" } : { kind: "member", property: bound.member };
      }
      return undefined;
    };
    const fromStatements = (statements: ts.NodeArray<ts.Statement>): Declaration | undefined => {
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          const found = fromList(statement.declarationList);
          if (found !== undefined) return found;
        } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === wanted) {
          return { kind: "function", node: statement };
        } else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
          const clause = statement.importClause;
          const bindings = clause.namedBindings;
          if (clause.name?.text === wanted) return { kind: "other" };
          if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === wanted) return { kind: "other" };
          const specifier = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.find((element) => element.name.text === wanted) : undefined;
          if (specifier !== undefined) return { kind: "import", node: specifier };
        }
      }
      return undefined;
    };
    for (let scope: ts.Node | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
      if (ts.isFunctionLike(scope)) {
        for (const [index, parameter] of scope.parameters.entries()) {
          const bound = bindingIn(parameter.name, wanted);
          if (bound === undefined) continue;
          if (bound === "identifier") return { kind: "parameter", node: parameter, owner: scope, index };
          return bound === "other" ? { kind: "other" } : { kind: "member", property: bound.member };
        }
      }
      if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
        const found = fromStatements(scope.statements);
        if (found !== undefined) return found;
      }
      if ((ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) && scope.initializer !== undefined && ts.isVariableDeclarationList(scope.initializer)) {
        // A loop variable is a new value each turn, whatever it is declared with.
        if (fromList(scope.initializer) !== undefined) return { kind: "other" };
      }
      if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined && bindingIn(scope.variableDeclaration.name, wanted) !== undefined) {
        return { kind: "other" };
      }
    }
    return undefined;
  }

  /** Every identifier in a file, by its text: where a helper's calls are looked for. */
  const identifiersByFile = new Map<string, Map<string, ts.Identifier[]>>();
  const identifiersOf = (file: string, name: string): readonly ts.Identifier[] => {
    let index = identifiersByFile.get(file);
    if (index === undefined) {
      const built = new Map<string, ts.Identifier[]>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const list = built.get(node.text);
          if (list === undefined) built.set(node.text, [node]);
          else list.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceOf(file));
      identifiersByFile.set(file, built);
      index = built;
    }
    return index.get(name) ?? [];
  };

  // ── helpers: a function whose parameter becomes a code ─────────────────────────────
  /** The function a callee names, when this tree declares it. */
  function functionOf(callee: ts.Node, file: string): { readonly fn: ts.SignatureDeclaration; readonly file: string } | undefined {
    const node = unwrap(callee);
    if (!ts.isIdentifier(node)) return undefined;
    const from = (declaration: ts.Node, inFile: string): { readonly fn: ts.SignatureDeclaration; readonly file: string } | undefined => {
      if (ts.isFunctionDeclaration(declaration)) return { fn: declaration, file: inFile };
      const value = ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined ? unwrap(declaration.initializer) : undefined;
      return value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? { fn: value, file: inFile } : undefined;
    };
    const declaration = declarationOf(node);
    if (declaration?.kind === "function" || declaration?.kind === "const") return from(declaration.node, file);
    if (declaration?.kind === "import") {
      const target = importTarget(declaration.node, file);
      return target === undefined ? undefined : from(target.node, target.file);
    }
    return undefined;
  }

  /**
   * Every name a module-level declaration can be imported under: its own, and each
   * `export { name as other }`, in its own file or in a barrel that passes it on. Read from
   * the text of every `export { … }` in the tree, so that no file has to be parsed to learn
   * it cannot matter.
   */
  let renamedExports: Map<string, string[]> | undefined;
  const spellingsOf = (name: string): readonly string[] => {
    if (renamedExports === undefined) {
      renamedExports = new Map();
      for (const text of sources.values()) {
        for (const clause of text.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
          for (const renamed of (clause[1] ?? "").matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
            renamedExports.set(renamed[1] as string, [...(renamedExports.get(renamed[1] as string) ?? []), renamed[2] as string]);
          }
        }
      }
    }
    const spellings = [name];
    for (const spelling of spellings) {
      for (const other of renamedExports.get(spelling) ?? []) if (!spellings.includes(other)) spellings.push(other);
    }
    return spellings;
  };

  const callsBeingRead = new Set<string>();

  /** Reads argument `index` of every call of `callable`, following it into the functions it is handed to. */
  function readCallsOf(callable: Callable, file: string, index: number): void {
    const key = `${file}:${callable.pos}:${index}`;
    if (callsBeingRead.has(key)) return;
    callsBeingRead.add(key);
    try {
      const name = (callable.name as ts.Identifier).text;
      const asAValue = `the helper "${name}" is used as a value here, so not all of its calls can be found`;
      const readArgument = (call: ts.CallExpression, inFile: string): void => {
        const spread = call.arguments.findIndex((argument) => ts.isSpreadElement(argument));
        if (spread >= 0 && spread <= index) return cannotRead(call, inFile, "the call spreads its arguments");
        const argument = call.arguments[index];
        if (argument !== undefined) read(argument, inFile);
      };
      const follow = (identifier: ts.Identifier, inFile: string, isIt: (found: Declaration | undefined) => boolean): void => {
        if (identifier === callable.name || isNotAReference(identifier) || !isIt(declarationOf(identifier))) return;
        const call = identifier.parent;
        if (ts.isCallExpression(call)) {
          if (call.expression === identifier) return readArgument(call, inFile);
          // Handed on: `expand(step, skip)`. Its calls are the calls that function makes of its parameter.
          const spread = call.arguments.findIndex((argument) => ts.isSpreadElement(argument));
          const position = call.arguments.indexOf(identifier);
          const handedTo = position >= 0 && (spread < 0 || spread > position) ? functionOf(call.expression, inFile) : undefined;
          const parameter = handedTo?.fn.parameters[position];
          if (handedTo !== undefined && parameter !== undefined && ts.isIdentifier(parameter.name) && parameter.dotDotDotToken === undefined) {
            return readCallsOf(parameter, handedTo.file, index);
          }
        }
        cannotRead(identifier, inFile, asAValue);
      };

      if (ts.isParameter(callable)) {
        for (const identifier of identifiersOf(file, name)) follow(identifier, file, (found) => found?.kind === "parameter" && found.node === callable);
        return;
      }
      for (const identifier of identifiersOf(file, name)) {
        follow(identifier, file, (found) => found !== undefined && (found.kind === "const" || found.kind === "let" || found.kind === "function") && found.node === callable);
      }
      // An exported helper is called from other files too: every file that imports this very declaration.
      const statement = ts.isFunctionDeclaration(callable) ? callable : callable.parent.parent;
      const exportedInPlace = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const exportedByClause = sourceOf(file).statements.some(
        (entry) =>
          ts.isExportDeclaration(entry) &&
          entry.moduleSpecifier === undefined &&
          entry.exportClause !== undefined &&
          ts.isNamedExports(entry.exportClause) &&
          entry.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === name),
      );
      if (statement.parent !== sourceOf(file) || !(exportedInPlace || exportedByClause)) return;
      if (ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        return cannotRead(callable.name as ts.Identifier, file, "the helper is a default export, whose importers the census does not follow");
      }
      const spellings = spellingsOf(name);
      // Whatever it is imported as, a file that imports it spells a name it is exported under.
      const spelled = new RegExp(`(?<![\\w$])(?:${spellings.map((spelling) => spelling.replace(/\$/g, "\\$")).join("|")})(?![\\w$])`);
      for (const [other, text] of sources) {
        if (other === file || !spelled.test(text)) continue;
        for (const entry of sourceOf(other).statements) {
          const bindings = ts.isImportDeclaration(entry) ? entry.importClause?.namedBindings : undefined;
          if (!ts.isImportDeclaration(entry) || bindings === undefined) continue;
          if (ts.isNamedImports(bindings)) {
            for (const specifier of bindings.elements) {
              if (importTarget(specifier, other)?.node !== callable) continue;
              for (const identifier of identifiersOf(other, specifier.name.text)) follow(identifier, other, (found) => found?.kind === "import" && found.node === specifier);
            }
            continue;
          }
          // `import * as lib`: its calls are `lib.name(…)`, under whichever name the module exports it.
          const target = ts.isStringLiteral(entry.moduleSpecifier) ? resolveModule(other, entry.moduleSpecifier.text) : undefined;
          for (const spelling of target === undefined ? [] : spellings) {
            if (exportOf(target as string, spelling)?.node !== callable) continue;
            for (const identifier of identifiersOf(other, spelling)) {
              const access = identifier.parent;
              if (!ts.isPropertyAccessExpression(access) || access.name !== identifier || !ts.isIdentifier(access.expression) || access.expression.text !== bindings.name.text) continue;
              if (ts.isCallExpression(access.parent) && access.parent.expression === access) readArgument(access.parent, other);
              else cannotRead(access, other, asAValue);
            }
          }
        }
      }
    } finally {
      callsBeingRead.delete(key);
    }
  }

  /** A code that is a function's parameter: the parameter's default, and that argument of every call. */
  function readParameter(owner: ts.SignatureDeclaration, index: number, file: string, at: ts.Node): void {
    const parameter = owner.parameters[index] as ts.ParameterDeclaration;
    if (parameter.dotDotDotToken !== undefined) return cannotRead(at, file, "it is a rest parameter");
    if (parameter.initializer !== undefined) read(parameter.initializer, file);
    if (ts.isFunctionDeclaration(owner) && owner.name !== undefined) return readCallsOf(owner, file, index);
    if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
      let holder: ts.Node = owner.parent;
      while (ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isSatisfiesExpression(holder)) holder = holder.parent;
      if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return readCallsOf(holder, file, index);
    }
    cannotRead(at, file, "it is the parameter of a function with no name of its own, so its calls cannot be found");
  }

  // ── values ─────────────────────────────────────────────────────────────────────────
  /** The object literal a table name stands for, and the file it is written in. */
  function tableOf(expression: ts.Node, file: string): { readonly literal: ts.ObjectLiteralExpression; readonly file: string } | undefined {
    const node = unwrap(expression);
    if (ts.isObjectLiteralExpression(node)) return { literal: node, file };
    if (!ts.isIdentifier(node)) return undefined;
    const declaration = declarationOf(node);
    if (declaration?.kind === "const" && declaration.node.initializer !== undefined) return tableOf(declaration.node.initializer, file);
    if (declaration?.kind === "import") {
      const target = importTarget(declaration.node, file);
      if (target !== undefined && ts.isVariableDeclaration(target.node) && target.node.initializer !== undefined) return tableOf(target.node.initializer, target.file);
    }
    return undefined;
  }

  const beingRead = new Set<ts.Node>();

  /** Reads an expression back to the string literals it can hold, or says why it cannot. */
  function read(expression: ts.Node, file: string): void {
    const node = unwrap(expression);
    if (beingRead.has(node)) return;
    beingRead.add(node);
    try {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return emit(node.text, node, file);
      if (ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))) return;
      if (ts.isConditionalExpression(node)) {
        read(node.whenTrue, file);
        read(node.whenFalse, file);
        return;
      }
      if (ts.isTemplateExpression(node)) return cannotRead(node, file, "it is a template with a substitution: what it can spell is in the types, not in the text");
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === "code") return; // read off an object built at a site of its own
        const table = tableOf(node.expression, file);
        const member = table?.literal.properties.find((property) => ts.isPropertyAssignment(property) && propertyNameOf(property.name) === node.name.text);
        if (table === undefined || member === undefined || !ts.isPropertyAssignment(member)) return cannotRead(node, file, "it is a member of something that is not a table of constants in this tree");
        return read(member.initializer, table.file);
      }
      if (ts.isElementAccessExpression(node)) {
        const table = tableOf(node.expression, file);
        if (table === undefined) return cannotRead(node, file, "it indexes something that is not a table of constants in this tree");
        const key = unwrap(node.argumentExpression);
        for (const property of table.literal.properties) {
          if (!ts.isPropertyAssignment(property)) return cannotRead(node, file, "the table it indexes has a member that is not a plain property");
          if (ts.isStringLiteral(key) && propertyNameOf(property.name) !== key.text) continue;
          read(property.initializer, table.file);
        }
        return;
      }
      if (ts.isIdentifier(node)) {
        const declaration = declarationOf(node);
        switch (declaration?.kind) {
          case undefined:
            return cannotRead(node, file, "nothing in this file declares it");
          case "const":
            if (declaration.node.initializer === undefined) return cannotRead(node, file, "it is declared with no value");
            return read(declaration.node.initializer, file);
          case "let":
            return cannotRead(node, file, "it is a `let`, which can be assigned again");
          case "member":
            if (declaration.property === "code") return; // taken out of an object built at a site of its own
            return cannotRead(node, file, `it is the "${declaration.property}" of another object`);
          case "parameter":
            return readParameter(declaration.owner, declaration.index, file, node);
          case "import": {
            const target = importTarget(declaration.node, file);
            if (target === undefined || !ts.isVariableDeclaration(target.node) || target.node.initializer === undefined) {
              return cannotRead(node, file, "it is imported from outside this tree, or is not a constant there");
            }
            return read(target.node.initializer, target.file);
          }
          default:
            return cannotRead(node, file, "it is bound by a pattern, a loop or a function, which the census does not follow");
        }
      }
      return cannotRead(node, file, `it is a ${ts.SyntaxKind[node.kind]}, which the census does not read`);
    } finally {
      beingRead.delete(node);
    }
  }

  // ── the sites ──────────────────────────────────────────────────────────────────────
  for (const [file, text] of sources) {
    if (!/\bcode\b/.test(text)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          const value =
            ts.isPropertyAssignment(property) && propertyNameOf(property.name) === "code"
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property) && property.name.text === "code"
                ? property.name
                : undefined;
          if (value === undefined) continue;
          const shape = shapeOf(node);
          if (notADiagnostic[file]?.[shape] !== undefined) ledgerLinesUsed.add(`${file} › ${shape}`);
          else read(value, file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceOf(file));
  }

  return { codes, unread, ledgerLinesUsed };
}

const sortedCodes = (census: Census): string[] => [...census.codes.keys()].sort();
const places = (census: Census): string[] => census.unread.map((entry) => `${entry.file}:${entry.line} ${entry.text}`);

describe("the census reads a code back from every way it is written (T1641b)", () => {
  /*
   * The whole gate rests on the census seeing what is there: a code it did not read is a
   * code with no row and nothing red. So each construction it claims to read is pinned on
   * a tree small enough to check by eye, and so is the refusal of each it does not.
   */
  const CODES = `
export const SHARED = "shared.constant";
export const TABLE = { one: "table.one", two: "table.two" } as const;
export function build(severity: string, code: string, message: string) {
  return { severity, code, message };
}
function quiet(code: string, message: string) {
  return { severity: "info", code, message };
}
export { quiet as hush };
export const note = (code: string) => ({ severity: "info", code, message: "" });
`;
  const USE = `
import { SHARED, TABLE, build as make, hush } from "@lib/index.ts";
import * as lib from "../lib/codes.ts";
const LOCAL = "local.constant";
const refuse = (code: string, reason: string) => ({ ok: false, code, reason });
const fail = (message: string, code = "helper.default") => ({ severity: "error", code, message });
const skip = (code: string) => ({ severity: "warning", code, message: "" });
function expand(depth: number, note: (code: string) => unknown): void {
  note("handed.on");
  if (depth > 0) expand(depth - 1, note);
}
export function all(flag: boolean, key: "one" | "two", picked: { code: string }) {
  expand(1, skip);
  return [
    { severity: "error", code: "plain.literal", message: "" },
    { severity: "error", code: LOCAL, message: "" },
    { severity: "error", code: SHARED, message: "" },
    { severity: "error", code: TABLE.one, message: "" },
    { severity: "error", code: TABLE[key], message: "" },
    { severity: "error", code: flag ? "ternary.yes" : "ternary.no", message: "" },
    { severity: "error", code: picked.code, message: "" },
    { code: -32700, message: "" },
    refuse("helper.argument", ""),
    fail("no code given"),
    fail("a code given", "helper.given"),
    make("error", flag ? "imported.helper" : SHARED, ""),
    hush("renamed.export", ""),
    lib.note("namespace.call"),
  ];
}
`;
  const tree = new Map([
    ["src/lib/codes.ts", CODES],
    ["src/lib/index.ts", `export * from "./codes.ts";\n`],
    ["src/app/use.ts", USE],
  ]);
  const aliases = [["@lib/", "src/lib/"]] as const;

  it("reads a literal, a constant, a table, a ternary, a helper's argument and its default, here and across an import under any name", () => {
    const census = censusOf(tree, { aliases });
    expect(places(census)).toEqual([]);
    expect(sortedCodes(census)).toEqual(
      [
        "plain.literal",
        "local.constant",
        "shared.constant",
        "table.one",
        "table.two",
        "ternary.yes",
        "ternary.no",
        "helper.argument",
        "helper.default",
        "helper.given",
        "imported.helper",
        "handed.on",
        "renamed.export",
        "namespace.call",
      ].sort(),
    );
    // Where it was read is where it is written: the call, not the helper that carries it.
    expect(census.codes.get("helper.argument")).toEqual(["src/app/use.ts:23"]);
    expect(census.codes.get("shared.constant")).toEqual(["src/lib/codes.ts:2"]);
  });

  it("reports each construction it cannot read, by file and line, and reads nothing out of it", () => {
    const census = censusOf(
      new Map([
        [
          "src/app/unreadable.ts",
          [
            "declare const kind: string;",
            "declare function compute(): string;",
            'let moving = "let.code";',
            'export const a = { severity: "error", code: `templated.${kind}`, message: "" };',
            'export const b = { severity: "error", code: moving, message: "" };',
            'export const c = [["x", "array.code"]].map(([name, code]) => ({ severity: "error", code, message: name }));',
            'export const d = { severity: "error", code: compute(), message: "" };',
            'export const e = ["callback.code"].map((code) => ({ severity: "error", code, message: "" }));',
            'const loose = (code: string) => ({ severity: "error", code, message: "" });',
            'loose("seen.call");',
            "export const f = { run: loose };",
            "",
          ].join("\n"),
        ],
      ]),
    );
    expect(places(census)).toEqual([
      "src/app/unreadable.ts:4 `templated.${kind}`",
      "src/app/unreadable.ts:5 moving",
      "src/app/unreadable.ts:6 code",
      "src/app/unreadable.ts:7 compute()",
      "src/app/unreadable.ts:8 code",
      "src/app/unreadable.ts:11 loose",
    ]);
    expect(census.unread.every((entry) => entry.why.length > 20)).toBe(true);
    // The call it could see is still read: an unread construction hides nothing but itself.
    expect(sortedCodes(census)).toEqual(["seen.call"]);
  });

  it("takes a listed construction's codes from its ledger line, and leaves a named object alone", () => {
    const sources = new Map([
      [
        "src/app/ledgers.ts",
        [
          "declare const kind: string;",
          "declare const source: string;",
          'export const a = { severity: "error", code: `templated.${kind}`, message: "" };',
          'export const module = { code: source, label: "shader" };',
          "",
        ].join("\n"),
      ],
    ]);
    const bare = censusOf(sources);
    expect(places(bare)).toEqual(["src/app/ledgers.ts:3 `templated.${kind}`", "src/app/ledgers.ts:4 source"]);
    // A failure at a `code` property names the object, in the words the ledger is keyed by.
    expect(bare.unread.map((entry) => entry.shape)).toEqual(["{ severity, code, message }", "{ code, label }"]);

    const census = censusOf(sources, {
      listed: { "src/app/ledgers.ts": { "`templated.${kind}`": ["templated.one", "templated.two"] } },
      notADiagnostic: { "src/app/ledgers.ts": { "{ code, label }": "a shader module" } },
    });
    expect(places(census)).toEqual([]);
    expect(sortedCodes(census)).toEqual(["templated.one", "templated.two"]);
    expect([...census.ledgerLinesUsed].sort()).toEqual(["src/app/ledgers.ts › `templated.${kind}`", "src/app/ledgers.ts › { code, label }"]);
  });
});

function sourceTree(withTests = false): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && (withTests || !/\.(test|spec)\.tsx?$/.test(entry.name)) && !entry.name.endsWith(".d.ts")) {
        sources.set(relative(ROOT, path).split("\\").join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  walk(join(ROOT, "src"));
  return sources;
}

/** The alias table the app is built with, read where it is written. */
function sourceAliases(): Array<readonly [string, string]> {
  const paths = (JSON.parse(readFileSync(join(ROOT, "tsconfig.app.json"), "utf8")) as { compilerOptions: { paths: Record<string, readonly string[]> } }).compilerOptions.paths;
  return Object.entries(paths)
    .map(([pattern, targets]) => [pattern.replace(/\*$/, ""), (targets[0] ?? "").replace(/^\.\//, "").replace(/\*$/, "")] as const)
    .sort((left, right) => right[0].length - left[0].length);
}

const ledgerLines = (ledger: Ledger<unknown>): string[] => Object.entries(ledger).flatMap(([file, lines]) => Object.keys(lines).map((key) => `${file} › ${key}`));

describe("every diagnostic code has a class, and every row names a code (T1641b)", () => {
  const census = censusOf(sourceTree(), { aliases: sourceAliases(), notADiagnostic: NOT_A_DIAGNOSTIC, listed: LISTED });
  const rows = Object.keys(DIAGNOSTIC_CLASSES);

  it("reads the tree: one code of each way of writing one is among what it found", () => {
    // If the walk or the alias table broke, every case below would pass for want of subjects.
    expect(census.codes.size).toBeGreaterThan(500);
    for (const code of [
      "gpu.unavailable", // a literal in the object
      "compiler/cycle", // a member of a code table, through `compilerDiagnostic`
      "parameter.type", // a local helper's argument
      "mesh.decode", // a ternary
      "node.customWgsl.params", // a constant handed to an imported helper
      "preset.page.on", // a helper handed to the function that calls it
      "preset.recalls.noCatalogue", // a listed template
    ]) {
      expect(census.codes.has(code), `the census no longer finds "${code}"`).toBe(true);
    }
  });

  it("reads every construction a code is written with", () => {
    const problems = census.unread.map(
      (entry) =>
        `${entry.file}:${entry.line}  ${entry.text}\n    The census cannot read this code: ${entry.why}.\n` +
        "    Write it as a string literal, a const, a ternary of those, or a helper's argument. If it has to stay as it is, " +
        "name it in LISTED (src/domain/diagnostics/classes.test.ts) with every code it produces" +
        (entry.shape === undefined ? "." : `; if the object is not a diagnostic at all, name its shape, \`${entry.shape}\`, in NOT_A_DIAGNOSTIC.`),
    );
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });

  it("has a row for every code the source emits", () => {
    const problems = sortedCodes(census)
      .filter((code) => !Object.hasOwn(DIAGNOSTIC_CLASSES, code))
      .map(
        (code) =>
          `"${code}" (${(census.codes.get(code) ?? []).join(", ")}) has no row in DIAGNOSTIC_CLASSES.\n` +
          "    Add one to src/domain/diagnostics/classes.ts: its class, and why in a few words. The classes are in that file's docblock.",
      );
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });

  it("has no row for a code nothing emits", () => {
    const problems = rows
      .filter((code) => !census.codes.has(code))
      .map((code) => `"${code}" has a row in DIAGNOSTIC_CLASSES and nothing in src/ emits it. Remove the row; if the code was renamed, the new name needs its own.`);
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("says why on every row, and keeps `local` to the codes it can apply to", () => {
    // The reasons are a file of their own (`class-reasons.ts`), kept out of the app: prose
    // for a reader of the table. Held to the table here, in both directions.
    for (const [code, row] of Object.entries(DIAGNOSTIC_CLASSES)) {
      expect((DIAGNOSTIC_CLASS_REASONS[code] ?? "").trim().length, `"${code}" has no reason in class-reasons.ts`).toBeGreaterThan(10);
      if (row.local === true) expect(row.class, `"${code}" is \`local\`, which is said of a \`never\` finding only`).toBe("never");
    }
    const orphaned = Object.keys(DIAGNOSTIC_CLASS_REASONS).filter((code) => !Object.hasOwn(DIAGNOSTIC_CLASSES, code));
    expect(orphaned, "these reasons in class-reasons.ts name a code with no row in DIAGNOSTIC_CLASSES: remove them").toEqual([]);
  });

  it("ships the classes and not the reasons: nothing under src/ but this gate imports class-reasons.ts", () => {
    // If a surface comes to show a reason, it imports the file and this line names it.
    const importers = [...sourceTree(true)]
      .filter(([file, text]) => file !== "src/domain/diagnostics/classes.test.ts" && /from\s+["'][^"']*class-reasons(\.ts)?["']/.test(text))
      .map(([file]) => file);
    expect(importers).toEqual([]);
  });

  it("holds the codes of more than one class to the debt ledger: it only gets shorter", () => {
    const problems: string[] = [];
    for (const [code, row] of Object.entries(DIAGNOSTIC_CLASSES)) {
      if (row.splits === undefined) continue;
      if (!SPLITS_OWED.includes(code)) {
        problems.push(`"${code}" carries \`splits\` and is not in SPLITS_OWED. A new code means one class: give each condition its own code.`);
      }
      if (!/^T\d+b?$/.test(row.splits.task)) problems.push(`"${code}" names no task that splits it.`);
      if (new Set(row.splits.holds).size < 2) problems.push(`"${code}" carries \`splits\` and holds fewer than two classes.`);
      if (!row.splits.holds.includes(row.class)) problems.push(`"${code}" is classed \`${row.class}\`, which is not one of the classes it holds.`);
    }
    for (const code of SPLITS_OWED) {
      if (DIAGNOSTIC_CLASSES[code]?.splits === undefined) {
        problems.push(`"${code}" is in SPLITS_OWED and its row carries no \`splits\` any more. Remove its line from SPLITS_OWED in src/domain/diagnostics/classes.test.ts.`);
      }
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("keeps both ledgers honest: every line still matches something, and a listed template spells its codes", () => {
    const stale = [...ledgerLines(NOT_A_DIAGNOSTIC), ...ledgerLines(LISTED)].filter((line) => !census.ledgerLinesUsed.has(line));
    expect(stale, "these ledger lines match nothing in the tree any more: remove them").toEqual([]);

    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    for (const [file, lines] of Object.entries(LISTED)) {
      for (const [text, listedCodes] of Object.entries(lines)) {
        expect(listedCodes.length, `${file} › ${text} lists no code`).toBeGreaterThan(0);
        if (!text.startsWith("`")) continue;
        const fixed = text.slice(1, -1).split(/\$\{[^}]*\}/).map(escape).join("[A-Za-z0-9-]+");
        for (const code of listedCodes) expect(code, `${file} › ${text} cannot spell "${code}"`).toMatch(new RegExp(`^${fixed}$`));
      }
    }
  });
});

describe("a code that was split is gone from every reader too (T1641b)", () => {
  it("lets no file spell a retired code but the ones the ledger waits for", () => {
    const everything = sourceTree(true);
    const self = "src/domain/diagnostics/classes.test.ts";
    const problems: string[] = [];
    for (const [code, waiting] of Object.entries(RETIRED)) {
      if (Object.hasOwn(DIAGNOSTIC_CLASSES, code)) problems.push(`"${code}" is in RETIRED and still has a row in DIAGNOSTIC_CLASSES.`);
      // As a string, in either quote. A comment may still tell the code's history in backticks.
      const spelled = new RegExp(`["']${code.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`);
      const naming = [...everything].filter(([file, text]) => file !== self && spelled.test(text)).map(([file]) => file);
      for (const file of naming) {
        if (waiting.includes(file)) continue;
        problems.push(
          `${file} spells "${code}", a code nothing emits since it was split. A filter on it matches nothing and can no longer fail.\n` +
            "    Read the codes it became, or the class: diagnosticClass(d.code) from src/domain/diagnostics/classes.ts.",
        );
      }
      for (const file of waiting) {
        if (!naming.includes(file)) problems.push(`${file} no longer spells "${code}". Remove it from RETIRED in ${self}.`);
      }
    }
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });
});

describe("diagnosticClass (T1641b)", () => {
  it("answers a row's class, and `unclassified` for anything with no row", () => {
    expect(diagnosticClass("parameter.unknown")).toBe("never");
    expect(diagnosticClass("patch.conflict")).toBe("act");
    // A code holding more than one class answers the least refusing of them until it is split.
    expect(diagnosticClass("wgsl/compile")).toBe("advice");
    // And a code that was split answers for nothing: each condition has its own.
    expect(diagnosticClass("parameter.expression")).toBe("unclassified");
    expect(diagnosticClass("parameter.expression.syntax")).toBe("never");
    expect(diagnosticClass("parameter.reference.channel")).toBe("notYet");
    expect(diagnosticClass("parameter.reference.unknownType")).toBe("elsewhereBuild");
    expect(diagnosticClass("parameter.bind")).toBe("unclassified");
    expect(diagnosticClass("parameter.bind.unreadable")).toBe("never");
    expect(diagnosticClass("parameter.bind.value")).toBe("degraded");
    expect(diagnosticClass("parameter.expression.clamped")).toBe("degraded");
    expect(diagnosticClass("no.such.code")).toBe("unclassified");
    // Not a row because Object.prototype has it.
    expect(diagnosticClass("constructor")).toBe("unclassified");
  });

  it("says which errors leave the plan usable: the rows marked local, and no other code", () => {
    expect(leavesPlanUsable("parameter.expression.syntax")).toBe(true);
    // An error before the rule stays one that withdraws the plan.
    expect(leavesPlanUsable("parameter.referenceCycle")).toBe(false);
    expect(leavesPlanUsable("compiler/unknown-node-type")).toBe(false);
    // A code nobody classed is not waved through.
    expect(leavesPlanUsable("no.such.code")).toBe(false);
    expect(leavesPlanUsable("constructor")).toBe(false);
    // Slice 3: a payload a slot only keeps is an error the picture does not depend on.
    expect(leavesPlanUsable("parameter.retained")).toBe(true);
  });

  it("says what a final render stops on: one question, the failed value at a frame included", () => {
    const at = (severity: string, code: string): boolean => stopsFinalRender({ severity, code });
    // An error; what can never take effect, at any severity; what still waits; what nobody classed.
    expect(at("error", "compiler/input-missing")).toBe(true);
    expect(at("warning", "compiler/component-parameter-conflict")).toBe(true);
    expect(at("warning", "parameter.reference.channel")).toBe(true);
    expect(at("info", "no.such.code")).toBe(true);
    // The one degraded code a film frame cannot carry (the lead's ruling on slice 1): the
    // stored value stood in for an expression with no finite answer at that frame.
    expect(at("warning", "parameter.expression.value")).toBe(true);
    // A clamp says what stands in, and a host-bound read is not the document's.
    expect(at("warning", "parameter.expression.clamped")).toBe(false);
    expect(at("info", "parameter.channels.unavailable")).toBe(false);
    // The harness's remark on its own request stops a render only as the error `strict` makes it.
    expect(at("warning", "harness.animateOff")).toBe(false);
    expect(at("error", "harness.animateOff")).toBe(true);
  });
});
