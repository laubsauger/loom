import { useMemo, useState } from "react";
import { Button } from "@ui/index.ts";

import {
  MCP_GRANT_EXPORT_FLAG,
  HELPER_SCRIPT_NAME,
  REPO_PATH_PLACEHOLDER,
  mcpClientConfigSnippet,
} from "../../mcp/client-config.ts";
import { DEVICE_HELPER_DEVICES_ONLY_COMMAND } from "@devices/helper.ts";
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
 *
 * ## Why an AGENTS tab ends by talking about lasers (T1110/T1111)
 *
 * Because the process this tab teaches is the SAME process an OSC node, a laser DAC and the
 * Person Mask node reach, and this tab was the last surface still implying otherwise. The
 * owner's question was "why would that depend on the mcp server?" — it does not, and the
 * final line says so, with the flag that starts the device door on its own.
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
        Same server at a terminal: <code>pnpm {HELPER_SCRIPT_NAME}</code>
      </p>
      {/*
        §V338/§V288: the fact that these are ONE process is only useful if it is stated
        where the wrong inference is made. Both halves, both commands, one sentence.
      */}
      <p>
        That one process is also Loom&rsquo;s device helper: OSC, a laser DAC and Person
        Mask reach hardware through it, with the same pairing code, and need no agent and no
        MCP client. For devices alone, with no MCP server:{" "}
        <code>{DEVICE_HELPER_DEVICES_ONLY_COMMAND}</code>
      </p>
    </div>
  );
}
