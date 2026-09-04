import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MCP_ENTRY_PATH,
  MCP_GRANT_EXPORT_FLAG,
  MCP_LOADER_PATH,
  HELPER_SCRIPT_NAME,
  LEGACY_HELPER_SCRIPT,
  REPO_PATH_PLACEHOLDER,
  mcpClientConfigSnippet,
  mcpServerArgv,
} from "./client-config.ts";

/**
 * THE SNIPPET IS CHECKED AGAINST THE THING IT DOCUMENTS (T399).
 *
 * Help that is wrong is worse than no help, because it is trusted. The paths and the
 * script name this module publishes are facts about `package.json` and the filesystem, so
 * they are asserted against `package.json` and the filesystem — rename the script, move
 * the loader, or delete the entry point and this goes red instead of the Agents tab
 * quietly teaching an invocation that no longer starts anything.
 *
 * What this does NOT prove is that the server RUNS: that is `serve.gpu.test.ts`, which
 * drives the same entry point through the protocol end to end on Dawn.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PackageJson;

describe("MCP client config (T399)", () => {
  it("names an entry point and a loader that exist on disk", () => {
    expect(existsSync(join(ROOT, MCP_ENTRY_PATH)), `${MCP_ENTRY_PATH} is missing`).toBe(true);
    expect(existsSync(join(ROOT, MCP_LOADER_PATH)), `${MCP_LOADER_PATH} is missing`).toBe(true);
  });

  it("has a package script that starts the SAME entry point through the SAME loader", () => {
    const script = packageJson.scripts?.[HELPER_SCRIPT_NAME];
    expect(script, `package.json has no "${HELPER_SCRIPT_NAME}" script`).toBeTypeOf("string");
    expect(script).toContain(MCP_LOADER_PATH);
    expect(script).toContain(MCP_ENTRY_PATH);
  });

  /**
   * T1110 — THE RENAME MUST NOT BREAK A CONFIG THAT IS ALREADY ON SOMEBODY'S DISK.
   *
   * The task's premise was that no MCP client config depends on the script NAME, because
   * `mcpServerArgv` spawns `node` directly. That is true of the config this module GENERATES
   * and false of the one the README taught by hand: `pnpm --dir <repo> mcp:serve`, which
   * names the script and is in `.mcp.json` files we cannot reach. So the old name stays as an
   * alias for one release, and it has to start the same thing — an alias that drifts is worse
   * than no alias, because it fails later and elsewhere.
   */
  it("keeps the retired name as an alias that starts the SAME entry point (one release)", () => {
    const alias = packageJson.scripts?.[LEGACY_HELPER_SCRIPT];
    expect(alias, `package.json has no "${LEGACY_HELPER_SCRIPT}" alias`).toBeTypeOf("string");
    expect(alias).toContain(MCP_LOADER_PATH);
    expect(alias).toContain(MCP_ENTRY_PATH);
    // Spelled out rather than delegating through `pnpm run helper`: MEASURED on pnpm 9.15.4,
    // `pnpm run X` writes its banner to STDOUT, so an alias that shelled out would put TWO
    // banners in front of the JSON-RPC stream a `pnpm --dir … mcp:serve` client reads.
    expect(alias).not.toContain("pnpm");
  });

  it("spawns node directly rather than through pnpm, because pnpm writes to stdout", () => {
    // MEASURED: `pnpm run` prints its banner on STDOUT, which is the JSON-RPC channel —
    // a client reading that stream sees `> loom@0.0.0 helper` before the first
    // message. The script is for a human at a terminal; the snippet is for a client.
    const config = JSON.parse(mcpClientConfigSnippet()) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = config.mcpServers["loom"];
    expect(server?.command).toBe("node");
    expect(server?.args.join(" ")).not.toContain("pnpm");
  });

  it("emits ABSOLUTE paths, so the client's working directory cannot matter", () => {
    const args = mcpServerArgv({ repoPath: "/tmp/checkout/" });
    // Trailing slash absorbed rather than doubled — a "//" in an argv path is the kind
    // of thing that works everywhere until it does not.
    expect(args).toEqual(["--import", `/tmp/checkout/${MCP_LOADER_PATH}`, `/tmp/checkout/${MCP_ENTRY_PATH}`]);
    for (const arg of args.slice(1)) expect(arg.startsWith("/")).toBe(true);
  });

  it("leaves the export grant OFF unless asked, and names the flag when asked (§V38)", () => {
    expect(mcpServerArgv()).not.toContain(MCP_GRANT_EXPORT_FLAG);
    expect(mcpServerArgv({ grantExport: true })).toContain(MCP_GRANT_EXPORT_FLAG);
  });

  it("uses a placeholder the user cannot mistake for a working path", () => {
    expect(mcpClientConfigSnippet()).toContain(REPO_PATH_PLACEHOLDER);
  });
});
