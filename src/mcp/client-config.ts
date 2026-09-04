import { HELPER_SCRIPT } from "@devices/helper.ts";

/**
 * HOW TO POINT AN MCP CLIENT AT THIS REPO (T399, T1110).
 *
 * ## The gap this closes
 *
 * `serve.ts` has been a complete headless Loom on stdio since T290 — full node
 * catalogue, the whole agent tool surface, and real pixels on Dawn. It is the path that
 * works with an external MCP client TODAY, and it had no documented invocation, so
 * nobody would have found it. A capability with no way in is invisible, which is the
 * §V220 family this project keeps landing in.
 *
 * ## Why the invocation lives here and not in the help panel
 *
 * The help panel's rule is that it states no fact of its own — every tab is a projection
 * of the thing that owns the fact. This module owns the fact, and `client-config.test.ts`
 * checks it against `package.json` and the filesystem: rename the script, move the
 * loader, or drop the entry point and that test goes red rather than the help panel
 * quietly teaching a command that no longer runs.
 *
 * ## Why the snippet does not go through pnpm
 *
 * MEASURED, not assumed, and re-measured on pnpm 9.15.4 for T1110: `pnpm run` writes its
 * two-line banner to STDOUT, which is the JSON-RPC channel. A client reading that stream
 * sees `> loom@0.0.0 helper` before the first message and fails to parse. The script is for
 * humans at a terminal; the snippet spawns `node` directly.
 *
 * ## Why the script NAME is not this module's fact any more (T1110)
 *
 * It was, and it was the wrong owner. The script starts ONE process with TWO doors — the
 * stdio MCP server and the device bridge — so `@devices/helper.ts` names it and everything
 * that has to say it out loud (refusals, node descriptions, OSC hints, the help panel) reads
 * it from there. That is the direction §V901 allows: mcp → devices, never the reverse.
 *
 * The paths in the snippet are ABSOLUTE, and that is deliberate too: the loader resolves
 * the repo from its own module URL, so an absolute invocation works from whatever
 * working directory the client happens to spawn with — and MCP clients do not agree on
 * what that directory is.
 */

/** The key an MCP client's config file lists this server under. */
export const MCP_SERVER_KEY = "loom";

/** The stdio server's entry point, relative to the repo root. */
export const MCP_ENTRY_PATH = "src/mcp/serve.ts";

/** The path-alias loader the entry point needs (see `alias-hooks.ts`). */
export const MCP_LOADER_PATH = "src/tooling/alias-hooks.ts";

/**
 * The `package.json` script that starts the same PROCESS for a human at a terminal.
 *
 * Re-exported rather than re-spelled: `client-config.test.ts` asserts this name against
 * `package.json`, so the assertion covers the constant every refusal in the product uses.
 */
export const HELPER_SCRIPT_NAME = HELPER_SCRIPT;

/**
 * The name the script had until T1110, kept in `package.json` as an alias for one release.
 *
 * It is published here for ONE reason: `client-config.test.ts` asserts the alias still
 * starts the same entry point. README recipes and hand-written `.mcp.json` files in the
 * wild spawn `pnpm --dir <repo> mcp:serve`, and a rename that silently broke them would be
 * the rename doing harm. T1110: delete this and the alias together, one release on.
 */
export const LEGACY_HELPER_SCRIPT = "mcp:serve";

/**
 * T334/§V38: pixels and readbacks leave the process only when the INVOCATION says so.
 * Default-off, and the refusal names this flag, so the tools are present-but-denied
 * rather than silently absent.
 */
export const MCP_GRANT_EXPORT_FLAG = "--grant-export";

/** Stands in for the repo root when nobody has told us where it is. */
export const REPO_PATH_PLACEHOLDER = "/absolute/path/to/this-repo";

export interface McpClientConfigOptions {
  /** Absolute path to this checkout. Defaults to a placeholder the user must replace. */
  readonly repoPath?: string;
  /** Include `--grant-export`, letting the agent read pixels and point buffers. */
  readonly grantExport?: boolean;
}

/** The `node` argv an MCP client should spawn, absolute paths and all. */
export function mcpServerArgv(options: McpClientConfigOptions = {}): readonly string[] {
  const root = (options.repoPath ?? REPO_PATH_PLACEHOLDER).replace(/\/+$/, "");
  return [
    "--import",
    `${root}/${MCP_LOADER_PATH}`,
    `${root}/${MCP_ENTRY_PATH}`,
    ...(options.grantExport === true ? [MCP_GRANT_EXPORT_FLAG] : []),
  ];
}

/**
 * The JSON an MCP client pastes into its server config, ready to copy.
 *
 * `mcpServers` is the shape Claude Desktop's `claude_desktop_config.json` uses; other
 * clients take the same `command`/`args` pair under their own key.
 */
export function mcpClientConfigSnippet(options: McpClientConfigOptions = {}): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_KEY]: { command: "node", args: mcpServerArgv(options) } } },
    null,
    2,
  );
}
