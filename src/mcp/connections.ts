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
 *  - `bridge` — OUR own loopback bridge (T451): the SAME node process the user's MCP client
 *    already spawns also listens, and the page connects OUT to it with a pairing code. No
 *    third party, no token in a URL, and the owner's client config does not change.
 *
 * A third row, `relay`, spoke the webmcp.dev protocol (T453) and is gone — see the note at
 * the foot of this file for what it was and why it was removed rather than kept as an
 * alternative.
 */
export type McpTransportKind = "webmcp" | "bridge";

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
   * Present ONLY so a human can start it, and the reason the bridge does not dial on load:
   * attaching hands an outside model write access to the open document, so it is an
   * explicit act with a visible result, never a side effect of opening a tab (T451).
   */
  readonly connect: ((secret: string) => void) | null;
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
  // T1103 — the row used to read "(stdio MCP server)", which is only half of what this one
  // connection is. The SAME process is the device bridge, and the SAME pairing is what lets
  // this tab reach OSC, a laser DAC or the Vision worker. Labelling it for the agent half
  // alone is what made a person-mask node look like it depended on an agent protocol.
  bridge: "Loom bridge (local helper: agents + devices)",
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
 * THE RELAY ROW, AND WHY IT IS GONE (T451, T453, T458, §V378).
 *
 * A third transport lived here: the page connected OUT to the webmcp.dev relay
 * (`@jason.today/webmcp`) so the owner's existing MCP client could drive this tab. It
 * WORKED, and it is worth writing down that T398's research was right about every fact and
 * wrong in its verdict — "the paste-token flow does not exist" was disproved by the owner
 * running it, which is what §V378 records.
 *
 * It is deleted for two reasons, in this order:
 *
 *  1. **The owner removed it from their MCP client**, in their words: "we dont want to
 *     attach to their mcp any more." A transport nobody is connected to is not an
 *     alternative, it is a second path to keep working.
 *  2. **T458 measured what it does.** It binds the WILDCARD address (`lsof`: `TCP *:4797`),
 *     not loopback; it does not isolate channels, so any second page on the same relay can
 *     invoke Loom's document-mutating tools by `<channel>-<name>`; and its session
 *     token travels in the socket URL, which is the specific mistake
 *     `@devices/transport/bridge-wire.ts` is built not to repeat.
 *
 * `bridge` replaces it with strictly less trust: our own process, loopback-bound, a pairing
 * code the page cannot guess, one attachment at a time, and no third party in the path. The
 * deletion happened AFTER the bridge was proven end to end — a Chrome tab attached to a
 * spawned `serve.ts`, with a stdio `tools/call` landing on the visible canvas — because
 * removing the working path first would have left the owner with nothing.
 */
