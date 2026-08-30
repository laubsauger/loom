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
 *  - `webmcp` — `navigator.modelContext`, the standards-track in-page API (`webmcp.ts`).
 *  - `relay` — the webmcp.dev loopback relay, which the page connects OUT to so an
 *    external MCP client drives THIS tab (`relay-client.ts`, T453).
 *  - `bridge` — OUR own loopback bridge (T451): the SAME node process the user's MCP client
 *    already spawns also listens, and the page connects OUT to it with a pairing code. No
 *    third party, no token in a URL, and the owner's client config does not change.
 *
 * `relay` exists here because the protocol was READ, not guessed — see the note at the
 * foot of this file, and §V378 for why the previous verdict was wrong.
 */
export type McpTransportKind = "webmcp" | "relay" | "bridge";

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
  /**
   * ATTACHES this transport, given whatever the user pastes for it. `null` when the
   * transport cannot be initiated from here — `webmcp` publishes on page load and has
   * nothing to start, so it reports `null` rather than offering a button that means
   * nothing (§V90: a control that does nothing is worse than no control).
   *
   * Present ONLY so a human can start it. T453's rule, and the reason the relay does not
   * dial on load: attaching hands an outside model write access to the open document, so
   * it is an explicit act with a visible result, never a side effect of opening a tab.
   */
  readonly connect: ((token: string) => void) | null;
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
  relay: "Relay (webmcp.dev)",
  bridge: "Shaderloom bridge (stdio MCP server)",
};

/** Row order in the panel, and the set §V338 insists always has a row. */
const DECLARED: ReadonlyArray<{ kind: McpTransportKind; detail: string }> = [
  // The bridge is FIRST because it is the one we ship and the one that needs no third party
  // (T451); order in this array is the order the panel renders.
  {
    kind: "bridge",
    detail: "Not detected yet.",
  },
  {
    kind: "webmcp",
    detail: "Not detected yet.",
  },
  {
    kind: "relay",
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
        connect: null,
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
 * THE RELAY ROW, AND THE VERDICT THAT HAD TO BE WITHDRAWN (T453, §V378).
 *
 * T398 researched this transport from primary sources and concluded it could not be
 * built. Every fact in that research held up: `@jason.today/webmcp` (webmcp.dev) carries
 * its author's own deprecation notice, its last release is 0.1.13 from 2025-03-22, its
 * session token really does travel as a WebSocket QUERY PARAMETER, the maintained fork
 * (MCP-B) really has no credential at all, and MCP's transport specification really does
 * define only stdio and HTTP.
 *
 * The CONCLUSION drawn from those facts — "the paste-token flow does not exist" — was
 * wrong, and the owner disproved it by running it. Deprecated is not non-functional, and
 * a release date is not a measurement. §V378 records that against the verdict, not
 * against the research.
 *
 * So the protocol is not a guess any more. `relay-client.ts` implements the page half of
 * it, READ OFF the published client (`src/webmcp.js` in the package) rather than
 * reconstructed from behaviour, and this registry declares the row it publishes into.
 *
 * ## What is deliberately NOT copied from the reference client
 *
 *  - Its session token in the channel URL is inherent to the relay's own handshake and
 *    cannot be avoided from the page side. It is stated in the row's `detail` instead of
 *    being hidden, because a user who can see the cost can decide about it (§V288).
 *  - Its `sessionStorage` persistence and silent reconnect on page load. Attaching hands
 *    an outside model write access to the open document; that is an explicit act every
 *    time, never a thing a reload restores.
 *  - Its floating widget. The state belongs in the one panel that already answers "what
 *    is attached", beside every other transport (§V338).
 *
 * The stdio path (`serve.ts`, `client-config.ts`) is unaffected and remains the way to
 * drive a HEADLESS Shaderloom. This row is the way to drive the tab the user is looking
 * at, which is a different product question with the same tools behind it.
 */
