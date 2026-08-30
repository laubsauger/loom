import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/**
 * Path-alias resolution for plain `node`, so `serve.ts` can be STARTED (T399).
 *
 * ## Why this file exists
 *
 * `src/mcp/serve.ts` is a complete headless Shaderloom on stdio and has worked since
 * T290 — under Vitest, which resolves `@domain/...` from `vitest.config.ts`. Bare
 * `node src/mcp/serve.ts` dies on the first aliased import inside the agent surface,
 * so the one path that already talks to Claude Desktop today had no invocation and
 * nobody would have found it. Node 24 strips the types on its own; the aliases are the
 * only thing missing.
 *
 * ## Why not a loader dependency
 *
 * `tsx`/`vite-node` would do this too, at the cost of a devDependency for a resolver
 * that is nine lines. `module.registerHooks` is in-thread and synchronous, so it needs
 * no separate worker file and is registered before the entry module loads.
 *
 * ## One source of truth for the alias table
 *
 * The map is READ from `tsconfig.app.json`'s `compilerOptions.paths` rather than
 * copied. `vite.config.ts` and `vitest.config.ts` already carry hand-maintained copies
 * of the same table; a third copy would be the one that silently rots, and an alias
 * this hook did not know about fails as "Cannot find package '@thing/x'" — an error
 * that reads like a missing npm install, not like a stale table.
 *
 * Usage: `node --import ./src/mcp/alias-hooks.ts src/mcp/serve.ts` (`pnpm mcp:serve`).
 */

const repoRoot = new URL("../../", import.meta.url);

interface TsconfigPaths {
  readonly compilerOptions?: { readonly paths?: Record<string, readonly string[]> };
}

/** `["@domain/", "./src/domain/"]` pairs, longest prefix first so `@domain/` beats `@/`. */
function aliasTable(): ReadonlyArray<readonly [string, string]> {
  const tsconfig = JSON.parse(
    readFileSync(new URL("tsconfig.app.json", repoRoot), "utf8"),
  ) as TsconfigPaths;
  return Object.entries(tsconfig.compilerOptions?.paths ?? {})
    .flatMap(([pattern, targets]) => {
      const target = targets[0];
      return target === undefined
        ? []
        : [[pattern.replace(/\*$/, ""), target.replace(/\*$/, "")] as const];
    })
    .sort((left, right) => right[0].length - left[0].length);
}

if (typeof registerHooks !== "function") {
  throw new Error(
    "module.registerHooks is unavailable — Node 22.15+ or 24+ is required to run src/mcp/serve.ts.",
  );
}

const table = aliasTable();

registerHooks({
  resolve(specifier, context, next) {
    for (const [prefix, target] of table) {
      if (!specifier.startsWith(prefix)) continue;
      return next(new URL(`${target}${specifier.slice(prefix.length)}`, repoRoot).href, context);
    }
    return next(specifier, context);
  },
});
