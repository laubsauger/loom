/**
 * WHAT IS ATTACHED TO THIS TAB (T397, §V338).
 *
 * ## The gap this closes
 *
 * `registerWebMcp` returned `{ registered, toolCount }` and every caller threw it away,
 * so the only honest answer to "is an agent connected?" was that the app could not tell
 * you — §V338's exact shape: a feature-detected integration that registers nowhere is
 * indistinguishable from a broken one. Detection had to become STATE somebody renders,
 * not a boolean somebody branches on.
 *
 * ## Declared, not discovered
 *
 * The transports are DECLARED up front and each one always has a row. A transport that
 * is absent reports `unavailable` WITH THE REASON rather than vanishing, because a row
 * that disappears when the feature is missing reproduces the original bug in the UI:
 * "no WebMCP row" and "WebMCP row we forgot to render" look identical on screen.
 *
 * ## Transport + status only
 *
 * §V39/§V192: this holds no tool definitions, no schemas and no app logic. It records
 * what an adapter reports about ITS OWN pipe. `toolNames` is a copy of what that adapter
 * published, so the panel can show what an attached agent can actually reach without
 * asking the surface a second question and getting a different answer.
 *
 * ## `disconnect` is nullable on purpose
 *
 * A transport that cannot be revoked reports `null` and says why (§V288). Rendering a
 * dead Disconnect button would be worse than not offering one: the user would believe
 * they had revoked an agent's write access to their document when they had not.
 */

/**
 * The pipes this build can speak. One row each, always.
 *
 * A union of one, for now, and deliberately not more: T398 went looking for the relay
 * transport (the page connects OUT, an external client attaches to the same relay) and
 * found no protocol to implement — see the note at the foot of this file. A `"relay"`
 * member with no implementation behind it would be the §V220 failure inverted: a UI row
 * for a capability that does not exist, which reads on screen as a feature you have not
 * switched on yet.
 */
export type McpTransportKind = "webmcp";

export type McpTransportState =
  /** The host provides no such transport. `detail` says which capability is missing. */
  | "unavailable"
  /** Available, nothing attached. The user has not connected, or has disconnected. */
  | "disconnected"
  | "connecting"
  /** Tools are published on this transport right now. */
  | "connected"
  /** It tried and failed. `detail` says why (§V288). */
  | "error";

export interface McpInvocation {
  readonly tool: string;
  readonly at: number;
}

export interface McpTransportStatus {
  readonly kind: McpTransportKind;
  /** What the user calls this pipe. */
  readonly label: string;
  readonly state: McpTransportState;
  /**
   * WHY the state is what it is, in one sentence — the missing capability, the refusal,
   * the reason a disconnect is not on offer (§V288).
   *
   * Rendered verbatim, so nothing that constructs one may put a credential in it.
   */
  readonly detail: string;
  /** The tools THIS transport published. Empty unless connected. */
  readonly toolNames: readonly string[];
  /** The most recent tool call that arrived over this transport, if any. */
  readonly lastInvocation: McpInvocation | null;
  /** Revokes the publication. `null` when the transport genuinely cannot be revoked. */
  readonly disconnect: (() => void) | null;
}

export interface McpTransportRegistry {
  /** Stable identity between publishes — safe as a `useSyncExternalStore` getSnapshot. */
  snapshot(): readonly McpTransportStatus[];
  subscribe(listener: () => void): () => void;
  /** An adapter reports its own state. Replaces the row for `status.kind`. */
  publish(status: McpTransportStatus): void;
  /** Records a tool call that arrived over `kind`. No-op for an unknown transport. */
  noteInvocation(kind: McpTransportKind, tool: string): void;
}

/**
 * What each pipe is called. Exported so the adapter that publishes a row and the
 * registry that declares it cannot drift into two names for one transport.
 */
export const TRANSPORT_LABEL: Readonly<Record<McpTransportKind, string>> = {
  webmcp: "In-page (WebMCP)",
};

/** Row order in the panel, and the set §V338 insists always has a row. */
const DECLARED: ReadonlyArray<{ kind: McpTransportKind; detail: string }> = [
  {
    kind: "webmcp",
    detail: "Not detected yet.",
  },
];

export function createMcpTransportRegistry(options: { now?: () => number } = {}): McpTransportRegistry {
  const now = options.now ?? Date.now;
  const rows = new Map<McpTransportKind, McpTransportStatus>(
    DECLARED.map((declared) => [
      declared.kind,
      {
        kind: declared.kind,
        label: TRANSPORT_LABEL[declared.kind],
        state: "unavailable" as const,
        detail: declared.detail,
        toolNames: [],
        lastInvocation: null,
        disconnect: null,
      },
    ]),
  );
  const listeners = new Set<() => void>();
  let cached: readonly McpTransportStatus[] = [...rows.values()];

  const republish = (): void => {
    cached = [...rows.values()];
    for (const listener of listeners) listener();
  };

  return {
    snapshot: () => cached,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(status) {
      // A publish for an undeclared kind is dropped rather than appended: the declared
      // set is what the panel promises to always show, and a row appearing out of
      // nowhere is the discovery model this module exists to avoid.
      if (!rows.has(status.kind)) return;
      rows.set(status.kind, status);
      republish();
    },
    noteInvocation(kind, tool) {
      const row = rows.get(kind);
      if (row === undefined) return;
      rows.set(kind, { ...row, lastInvocation: { tool, at: now() } });
      republish();
    },
  };
}

/**
 * WHY THERE IS NO RELAY ROW (T398).
 *
 * The brief was: the page connects OUT to a relay with a user-pasted TOKEN, an external
 * MCP client attaches to the same relay, and the live tab's tools become that client's
 * tools. Researched from primary sources before designing anything, per the standing rule
 * about confident-and-wrong transports. What is actually out there, as of 2026-08:
 *
 *  - The paste-token design is `@jason.today/webmcp` (github.com/jasonjmcghee/WebMCP,
 *    webmcp.dev). Last release 0.1.13, 2025-03-22; the protocol files have not moved
 *    since March 2025. Its own README now says "This implementation is not compliant with
 *    the W3C spec" and points at webmachinelearning/webmcp instead. Its token travels as
 *    a WebSocket QUERY PARAMETER — a credential in a URL, which is the one place a
 *    credential must never go, and by itself a reason not to copy the design.
 *  - The MAINTAINED relay is MCP-B (`@mcp-b/webmcp-local-relay`, WebMCP-org). It has no
 *    credential of any kind: the only gate is an HTTP Origin allow-list defaulting to
 *    `['*']`, and its README states the consequence itself — any site open in the browser
 *    can publish tools to it. `--relay-id` / `--workspace` are discovery filters
 *    broadcast in an unauthenticated hello, not credentials. Its wire format is prose
 *    plus exported zod schemas, with no conformance language, no versioning policy, and a
 *    breaking rewrite at 5.0.0.
 *  - MCP's own transport specification defines stdio and HTTP. It defines no WebSocket
 *    transport and no relay.
 *
 * So the token this panel would have collected does not exist to be collected, and the
 * envelope an implementation would have to speak is one project's internal detail. A
 * transport written against a guess is worse than no transport: no client could talk to
 * it, and the failure would present as a network problem rather than as a design error.
 *
 * The path that DOES work today is `serve.ts` over stdio — a real MCP server an external
 * client attaches to directly, with no relay in the middle and no credential to leak.
 * `pnpm mcp:serve` starts it; `client-config.ts` is the snippet that points a client at
 * it, and the help panel's Agents tab is where a user finds that snippet.
 */
