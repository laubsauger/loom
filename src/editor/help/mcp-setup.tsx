import { useMemo, useState } from "react";
import { Button } from "@ui/index.ts";

import {
  MCP_GRANT_EXPORT_FLAG,
  MCP_SERVE_SCRIPT,
  REPO_PATH_PLACEHOLDER,
  mcpClientConfigSnippet,
} from "../../mcp/client-config.ts";
import styles from "./help.module.css";

/**
 * ATTACHING AN EXTERNAL AGENT (T399, T290).
 *
 * The stdio MCP server has existed since T290 and had no documented way in, so the one
 * path that works with Claude Desktop today was unreachable in practice. This is the way
 * in: the JSON a user pastes into their client's server config, with the two things they
 * have to decide — where this checkout lives, and whether the agent may read pixels.
 *
 * ## It states no fact of its own (§V105)
 *
 * The help panel's rule is that every tab is a projection of the thing that owns the
 * fact. `mcp/client-config.ts` owns the invocation, and its test checks that invocation
 * against `package.json` and the filesystem — so a renamed script or a moved entry point
 * turns a test red instead of leaving this tab teaching a command that no longer runs.
 *
 * ## Why the path is a field and not a guess
 *
 * A browser cannot know where its own repository is checked out. Rather than print a
 * placeholder and hope, the field makes the one edit the user must make anyway, and the
 * snippet below it is then genuinely paste-ready.
 */
export function McpSetup() {
  const [repoPath, setRepoPath] = useState("");
  const [grantExport, setGrantExport] = useState(false);
  const [copied, setCopied] = useState(false);

  const snippet = useMemo(
    () =>
      mcpClientConfigSnippet({
        ...(repoPath.trim() === "" ? {} : { repoPath: repoPath.trim() }),
        grantExport,
      }),
    [repoPath, grantExport],
  );

  return (
    <div className={styles.agents}>
      {/*
        The one long sentence on this tab, and it is the CONSENT statement: pasting the
        snippet below hands an external process write access to the open document, so
        what it may do is spelled out where the decision is made, not summarised.
      */}
      <p>
        An external MCP client starts this server as a subprocess and gets the same tools
        the in-app agent has: read the graph, add and rewire nodes, edit parameters and
        shader source, compile, and undo.
      </p>

      <label className={styles.field}>
        <span>This checkout</span>
        <input
          type="text"
          className={styles.search}
          value={repoPath}
          placeholder={REPO_PATH_PLACEHOLDER}
          spellCheck={false}
          onChange={(event) => setRepoPath(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>

      <label className={styles.field}>
        <input
          type="checkbox"
          checked={grantExport}
          onChange={(event) => setGrantExport(event.target.checked)}
        />
        <span>Read pixels and point buffers</span>
        <code>{MCP_GRANT_EXPORT_FLAG}</code>
      </label>
      {/* Why it is off by default, in the fewest words that still name the risk. */}
      <p>Off by default: output can include a webcam.</p>

      <div className={styles.snippetHead}>
        <span className={styles.snippetLabel}>Client config</span>
        <Button
          onClick={() => {
            // Best effort, exactly as the app's own clipboard sink is: a denied
            // permission must not throw, and the snippet is selectable either way.
            void globalThis.navigator?.clipboard?.writeText(snippet).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className={styles.snippet} data-testid="mcp-client-config">
        {snippet}
      </pre>

      <p>
        Same server at a terminal: <code>pnpm {MCP_SERVE_SCRIPT}</code>
      </p>
    </div>
  );
}
