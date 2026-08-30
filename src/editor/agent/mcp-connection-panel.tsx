import { useState } from "react";
import { Button } from "@ui/index.ts";

import type { McpTransportKind, McpTransportState, McpTransportStatus } from "../../mcp/connections.ts";
import styles from "./mcp-connection-panel.module.css";

/**
 * WHAT IS ATTACHED, AND WHAT IT CAN DO (T397, §V338, §V42).
 *
 * ## The question this answers
 *
 * "Is an agent connected?" had no answer inside the app. `registerWebMcp` published the
 * whole tool surface — twenty-eight tools that add, delete and rewire nodes, rewrite
 * shaders and undo — and returned a result nobody rendered, so a browser that supports
 * WebMCP and a build whose registration is broken looked exactly alike. §V338 is the
 * rule that came out of it: SHOW the detection result, do not merely branch on it.
 *
 * ## Every declared transport keeps its row
 *
 * A transport reporting `unavailable` is rendered, with the reason, rather than hidden.
 * Hiding it would rebuild the original bug in the UI — an absent row and a forgotten row
 * are the same pixels.
 *
 * ## The consent line, and why it is one line
 *
 * Attaching an agent grants write access to the open document, so what that costs is on
 * screen where the state is — but as a LABEL, not a paragraph (§V90/§V92). Six words when
 * something is attached, two when nothing is; the full account of what the tools do lives
 * one click away in the tool list, and in help's Agents tab, which is what a documentation
 * surface is for. A paragraph here would be read once and then sit permanently in front of
 * the states it is supposed to introduce.
 *
 * ## Presentational
 *
 * Like `AgentPresencePanel` beside it: a snapshot and callbacks in, no bus, no surface,
 * no transport. It never decides whether something is connected; it renders what the
 * adapter reported about its own pipe. Tool names, descriptions and schemas are DATA
 * (§V37) — text nodes, never markup, never interpolated into prose this file authors.
 */

const STATE_LABEL: Readonly<Record<McpTransportState, string>> = {
  unavailable: "Unavailable",
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Failed",
};

/** One tool as the panel shows it: what an attached client is handed, verbatim. */
export interface McpToolDetail {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** False when a port or query the tool needs is not wired — the surface's own verdict. */
  readonly available: boolean;
  /** The JSON Schema published for this tool, pretty-printed. */
  readonly schema: string;
}

export interface McpConnectionPanelProps {
  readonly transports: readonly McpTransportStatus[];
  /** Resolves one tool for the drill-in. Returns null for a name the surface does not have. */
  readonly describeTool: (name: string) => McpToolDetail | null;
  /** Opens the setup documentation (help → Agents). Omitted → the button is not offered. */
  readonly onOpenSetup?: (() => void) | undefined;
}

export function McpConnectionPanel({ transports, describeTool, onOpenSetup }: McpConnectionPanelProps) {
  const [expanded, setExpanded] = useState<McpTransportKind | null>(null);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const anyConnected = transports.some((transport) => transport.state === "connected");

  return (
    <section className={styles.panel} aria-labelledby="mcp-connections-heading" data-testid="mcp-connection-panel">
      <div className={styles.head}>
        <h3 className={styles.sectionTitle} id="mcp-connections-heading">
          Connections
        </h3>
        {onOpenSetup === undefined ? null : (
          <Button variant="ghost" onClick={onOpenSetup}>
            Set up…
          </Button>
        )}
      </div>

      {/*
        §V90/§V92 keep this to one short line, and §V91 makes the disconnected half name
        the STATE. The full account of what an attached agent may do lives one click away
        in the tool list beside each row, and in help's Agents tab — a paragraph here
        would be read once and then permanently in the way of the states it sits above.
      */}
      <p className={styles.consent} data-testid="mcp-consent">
        {anyConnected ? "Attached agents can edit this document." : "Nothing attached."}
      </p>

      <ul className={styles.rows}>
        {transports.map((transport) => {
          const isOpen = expanded === transport.kind;
          return (
            <li className={styles.row} key={transport.kind} data-transport={transport.kind}>
              <div className={styles.rowHead}>
                <span className={styles.dot} data-state={transport.state} aria-hidden="true" />
                <span className={styles.label}>{transport.label}</span>
                <span className={styles.state} data-testid={`mcp-state-${transport.kind}`}>
                  {STATE_LABEL[transport.state]}
                </span>
                {transport.state === "connected" ? (
                  <button
                    type="button"
                    className={styles.toolToggle}
                    aria-expanded={isOpen}
                    onClick={() => {
                      setExpanded(isOpen ? null : transport.kind);
                      setOpenTool(null);
                    }}
                    data-testid={`mcp-tools-toggle-${transport.kind}`}
                  >
                    {transport.toolNames.length} tools
                  </button>
                ) : null}
                {transport.disconnect === null ? null : (
                  <Button variant="outline" onClick={transport.disconnect}>
                    Disconnect
                  </Button>
                )}
              </div>

              {/*
                The reason, always — §V288. An "Unavailable" with no cause is the refusal
                that names nothing, and this row's whole job is to be readable.
              */}
              <p className={styles.detail} data-testid={`mcp-detail-${transport.kind}`}>
                {transport.detail}
              </p>

              {transport.lastInvocation === null ? null : (
                <p className={styles.meta} data-testid={`mcp-last-${transport.kind}`}>
                  Last call: {transport.lastInvocation.tool}
                </p>
              )}

              {transport.connect === null ? null : (
                <ConnectForm kind={transport.kind} onConnect={transport.connect} />
              )}

              {isOpen ? (
                <ToolList
                  names={transport.toolNames}
                  openTool={openTool}
                  onOpenTool={setOpenTool}
                  describeTool={describeTool}
                  lastTool={transport.lastInvocation?.tool ?? null}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface ConnectFormProps {
  readonly kind: McpTransportKind;
  readonly onConnect: (token: string) => void;
}

/**
 * ATTACHING, BY HAND (T451).
 *
 * Rendered only for a transport that reports a `connect` — the bridge does, because it
 * dials OUT and needs the pairing code the server printed; WebMCP does not, because it
 * publishes on load and has nothing to start. That is why the affordance is a nullable
 * callback on the status rather than a prop on the panel: the transport that can be
 * attached says so, and this file never decides which one that is.
 *
 * The field is PLAIN TEXT, and it used to be a password field. That was right for the
 * deleted relay, whose pasted token was a long-lived credential; it is wrong for a
 * six-character pairing code that the user READS off one surface and TYPES into this one.
 * Masking a transcribed code hides the typo it exists to prevent, and hides nothing worth
 * hiding — the same code is printed in the server log the user is reading it from. The
 * panel still keeps no copy after submit.
 */
function ConnectForm({ kind, onConnect }: ConnectFormProps) {
  const [token, setToken] = useState("");
  return (
    <form
      className={styles.connect}
      onSubmit={(event) => {
        event.preventDefault();
        onConnect(token);
        setToken("");
      }}
    >
      <input
        type="text"
        className={styles.tokenField}
        value={token}
        placeholder="Pairing code"
        aria-label="Pairing code"
        spellCheck={false}
        autoComplete="off"
        data-testid={`mcp-token-${kind}`}
        onChange={(event) => setToken(event.target.value)}
        // The graph canvas binds single letters; a token typed here must not also be a
        // keymap invocation (§V78's hazard, the same guard the help panel's field uses).
        onKeyDown={(event) => event.stopPropagation()}
      />
      <Button type="submit" variant="outline">
        Connect
      </Button>
    </form>
  );
}

interface ToolListProps {
  readonly names: readonly string[];
  readonly openTool: string | null;
  readonly onOpenTool: (name: string | null) => void;
  readonly describeTool: (name: string) => McpToolDetail | null;
  readonly lastTool: string | null;
}

function ToolList({ names, openTool, onOpenTool, describeTool, lastTool }: ToolListProps) {
  return (
    <ul className={styles.tools} data-testid="mcp-tool-list">
      {names.map((name) => {
        const isOpen = openTool === name;
        const detail = isOpen ? describeTool(name) : null;
        return (
          <li className={styles.tool} key={name}>
            <button
              type="button"
              className={styles.toolName}
              aria-expanded={isOpen}
              onClick={() => {
                onOpenTool(isOpen ? null : name);
              }}
            >
              {name}
            </button>
            {detail === null ? null : (
              <div className={styles.toolDetail} data-testid={`mcp-tool-detail-${name}`}>
                <p className={styles.detail}>{detail.description}</p>
                {detail.available ? null : <p className={styles.detail}>Published, not wired.</p>}
                {lastTool === name ? <p className={styles.meta}>Last call.</p> : null}
                <pre className={styles.schema}>{detail.schema}</pre>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
