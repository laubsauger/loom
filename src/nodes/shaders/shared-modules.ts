import { remember } from "../definitions/params-reflection.ts";
import { WGSL_HASH } from "./common.wgsl.ts";

/**
 * T1286 — THE WGSL A `customWgsl` SOURCE MAY PULL IN, BY NAME.
 *
 * Until now a source reached exactly one thing: `SHARED_UNIFORMS_WGSL`. Everything else in
 * the repo's WGSL was private to the file it was typed into — §T1283's survey found
 * `time-grid.wgsl.ts`'s `cellAt()` was the ONLY function shared across more than one
 * shader, while `common.wgsl.ts` already held the integer lattice hashes that every new
 * shader re-writes by hand.
 *
 * ## Why a registry rather than a blanket prelude
 *
 * A prepend that hands every source everything is cheap to write and wrong twice over: it
 * puts code a shader never asked for into its compile (and into any error message it
 * produces), and it makes every future addition a global change to every shader in the
 * catalogue. The row's constraint is EXPLICIT PER SOURCE, and this is that: a source names
 * what it wants and gets nothing else.
 *
 * ## What may live here, and what may not
 *
 * ⚑ A MODULE MUST BE PARAMETER-FREE. Everything it needs arrives as a function argument;
 * it may not read `params` (the host's own reflected struct) and it may not read `frameU`
 * (the shared frame block). That rule is not tidiness — it is what makes a module MEAN the
 * same thing in the shader that imports it as in the one it came from. §T1286 found the
 * two blocks the row most wanted are not parameter-free today: `reactor.wgsl.ts`'s Worley
 * (`cellEdge`) reads `params.morph` and `frameU.absTime`, and `alembic.wgsl.ts`'s `fold()`
 * reads four `params` fields and a local `spin()`. Sharing either means re-cutting it so
 * its knobs are arguments, with byte-identity proved on the file it came from — a refactor
 * per block, not an entry in this table.
 *
 * ## Names are global to a source's compile, so they are chosen once and here
 *
 * A module's declarations land in the same namespace as the importing source's own, and a
 * collision is refused BY NAME at compile rather than shadowed (`custom-wgsl.ts`). That is
 * also why `cellAt`'s struct is `GridCell` here and not `Cell`: two shipped shaders declare
 * a `Cell` with different fields, and a shared module that claimed the bare name would make
 * the two un-importable together for no reason anybody could see from the call site.
 */
export interface SharedWgslModule {
  /** The WGSL this module contributes, verbatim. */
  readonly source: string;
  /** Modules this one calls into. Pulled in automatically, once, before it. */
  readonly requires?: readonly string[];
  /** What it is for, in one line — read by the editor's completion and by error text. */
  readonly summary: string;
}

/**
 * The integer avalanche family (`hashU32`, `hash2`, `hash3`, …) already in `common.wgsl.ts`.
 *
 * INTEGER on purpose, and the reason is §V44's sibling promise: a float hash built on
 * `fract(sin(x))` is a different number on every driver, so a seeded look would replay
 * differently per machine. `u32` shifts and multiplies are exact everywhere WGSL runs.
 */
const HASH_MODULE: SharedWgslModule = {
  summary: "integer lattice hashes — exact on every driver, unlike fract(sin(x))",
  source: WGSL_HASH,
};

/**
 * The uniform grid partition, lifted from `time-grid.wgsl.ts` (§T1283 named it the only
 * WGSL already shared across shaders, which is what makes it the safe first entry here).
 *
 * It is the SAME partition the Tile node uses — `floor(uv * repeat)`, offset zero, both
 * rounding the count the same way — so a cell here is exactly a cell there and no effect
 * built on it can straddle a seam.
 */
const GRID_MODULE: SharedWgslModule = {
  summary: "uniform grid partition: index, count, origin, size and local uv of a cell",
  source: `struct GridCell {
  index: f32,
  count: f32,
  last: f32,
  local: vec2f,
  origin: vec2f,
  size: vec2f,
};

fn gridCellAt(uv: vec2f, grid: vec2f) -> GridCell {
  let cols = max(1.0, floor(grid.x + 0.5));
  let rows = max(1.0, floor(grid.y + 0.5));
  let ij = clamp(floor(uv * vec2f(cols, rows)), vec2f(0.0), vec2f(cols - 1.0, rows - 1.0));
  var cell: GridCell;
  cell.index = (ij.y * cols) + ij.x;
  cell.count = cols * rows;
  cell.last = max(1.0, cell.count - 1.0);
  cell.size = vec2f(1.0 / cols, 1.0 / rows);
  cell.origin = ij * cell.size;
  cell.local = clamp((uv - cell.origin) / cell.size, vec2f(0.0), vec2f(1.0));
  return cell;
}`,
};

export const SHARED_WGSL_MODULES: Readonly<Record<string, SharedWgslModule>> = {
  hash: HASH_MODULE,
  grid: GRID_MODULE,
};

/** The directive a source writes, in the file's own `// @` comment idiom. */
const USE_DIRECTIVE = /^[ \t]*\/\/[ \t]*@use[ \t]+([^\n]*)$/gm;

export interface SharedModuleResolution {
  /** The modules named, in the order they must be emitted (dependencies first). */
  readonly names: readonly string[];
  /** Names the source asked for that do not exist. */
  readonly missing: readonly string[];
  /** The WGSL to place before the source, or "" when nothing was asked for. */
  readonly prelude: string;
}

/**
 * Read a source's `// @use` lines and resolve them.
 *
 * A COMMENT rather than a `#include`: WGSL has no preprocessor, so a directive that is not
 * a comment would make the source invalid WGSL on its own — and this file's sources are
 * edited in a pane that highlights and validates them, pasted into shader playgrounds, and
 * read by `reflectParamsStruct`. `// @use` is the same idiom the reflected controls already
 * use for `// @default`, so a reader who has seen one has seen the other.
 *
 * Pure and total: it never throws. A name that does not resolve comes back in `missing` for
 * the caller to turn into a diagnostic naming it, because a shader that silently compiles
 * without the code it asked for is §V288's bug wearing a new hat.
 */
export function resolveSharedModules(source: string): SharedModuleResolution {
  const hit = resolutionsBySource.get(source);
  if (hit !== undefined) return hit;
  return remember(resolutionsBySource, source, resolveModules(source));
}

/**
 * ⚑ MEMOISED FOR THE SAME REASON AS THE POINT KERNEL'S SCANS (§T1333b), and found the same
 * way: 3.37% of all script time on E55 Reactor, in the production build, mapped back through
 * the bundle's sourcemap. §T259 compiles every frame, `customWgsl`'s compile calls this, and
 * the answer is a pure function of bytes that do not change between frames.
 *
 * It is a SMALLER number than the kernel's 39.4%, and the gap is the argument rather than a
 * reason to skip it: which emitter is hot is a property of the DOCUMENT, not of the emitter.
 * E32 Pasture made the point kernel a third of the main thread and never touched this; E55
 * does the reverse; E24 makes neither measurable. Nobody can know at authoring time which
 * document will make their emitter the expensive one, which is what §T1335b's seam is for.
 *
 * ⚠ The value is SHARED, like every `remember`ed value: `names`, `missing` and `prelude` are
 * `readonly` on the interface and no caller may mutate what comes back.
 */
const resolutionsBySource = new Map<string, SharedModuleResolution>();

function resolveModules(source: string): SharedModuleResolution {
  const asked: string[] = [];
  for (const match of source.matchAll(USE_DIRECTIVE)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.trim();
      if (name.length > 0) asked.push(name);
    }
  }

  const missing: string[] = [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const module = SHARED_WGSL_MODULES[name];
    if (module === undefined) {
      // Recorded once, in the order it was asked for, so the message can name every one.
      if (!missing.includes(name)) missing.push(name);
      return;
    }
    // Marked BEFORE the recursion: a cycle in the table would otherwise hang the compile,
    // and a table this small is exactly where nobody would look for a hang.
    seen.add(name);
    for (const dependency of module.requires ?? []) visit(dependency);
    ordered.push(name);
  };
  for (const name of asked) visit(name);

  const prelude = ordered.map((name) => SHARED_WGSL_MODULES[name]!.source).join("\n\n");
  return { names: ordered, missing, prelude: prelude.length > 0 ? `${prelude}\n\n` : "" };
}

/**
 * Every top-level `fn` and `struct` a chunk of WGSL declares.
 *
 * Deliberately crude — it reads declarations at the start of a line, which is what both the
 * modules above and every shipped source do — because the alternative is a WGSL parser, and
 * the cost of being crude here is bounded: a missed declaration means a collision this gate
 * does not catch, and the compile fails at Dawn instead with the driver's own message. What
 * it must never do is report a collision that is not one, which is why it anchors.
 */
export function declaredNames(wgsl: string): readonly string[] {
  const names: string[] = [];
  for (const match of wgsl.matchAll(/^[ \t]*(?:fn|struct)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}
