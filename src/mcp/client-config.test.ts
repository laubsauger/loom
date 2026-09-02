import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MCP_ENTRY_PATH,
  MCP_GRANT_EXPORT_FLAG,
  MCP_LOADER_PATH,
  MCP_SERVE_SCRIPT,
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
    const script = packageJson.scripts?.[MCP_SERVE_SCRIPT];
    expect(script, `package.json has no "${MCP_SERVE_SCRIPT}" script`).toBeTypeOf("string");
    expect(script).toContain(MCP_LOADER_PATH);
    expect(script).toContain(MCP_ENTRY_PATH);
  });

  it("spawns node directly rather than through pnpm, because pnpm writes to stdout", () => {
    // MEASURED: `pnpm run` prints its banner on STDOUT, which is the JSON-RPC channel —
    // a client reading that stream sees `> loom@0.0.0 mcp:serve` before the first
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
