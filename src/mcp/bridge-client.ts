import type { AgentToolSurface } from "../agent/surface.ts";
import {
  bridgeUrl,
  normalisePairingCode,
  parseBridgeMessage,
  BRIDGE_HOST,
  BRIDGE_PORT,
} from "./bridge-protocol.ts";
import { TRANSPORT_LABEL, type McpTransportRegistry } from "./connections.ts";
import { toolListings } from "./published-tools.ts";

/**
 * THE PAGE HALF OF THE BRIDGE — AN AGENT DRIVES *THIS* TAB (T451).
 *
 * ## The shape, and why it is this way round
 *
 * `serve.ts` is a headless Loom with its own store; an agent talking to it builds a
 * graph the owner never sees. So the same process now listens on loopback and THIS module
 * dials it, on a click. From then on a `tools/call` that arrived over the MCP client's stdio
 * pipe is forwarded here and executed against the LIVE store — nodes appear on the canvas
 * the user is watching, which is the entire point of the task.
 *
 * The page connects OUT rather than the server connecting in, because a browser tab cannot
 * be dialled and because the direction encodes the consent: nothing reaches this document
 * that the person in front of it did not start.
 *
 * ## Security, stated where it is implemented
 *
 *  - **Nothing dials on load unless THIS TAB attached in THIS SESSION.** `createBridgeClient`
 *    opens no socket and publishes an idle row carrying the `connect` the panel renders a
 *    field for. The one exception is T925's, and its consent is real rather than assumed:
 *    if the human attached this tab earlier in this browser session, the code is in
 *    `sessionStorage` and one silent attempt is made. An agent still cannot attach to a tab
 *    whose owner never attached it, and a tab the owner closed forgets everything.
 *  - **The pairing code is typed by the human, and outlives only the tab.** It is minted by
 *    the bridge process and published only through the bridge's own channels, so a page the
 *    user did not open cannot produce one — which is what stops any site in any other tab
 *    from opening `ws://127.0.0.1` and driving this document. It travels as the first
 *    MESSAGE on the socket, never in the URL: T398's finding about the deprecated relay,
 *    whose session token rode the query string into every log that touched it. It is never
 *    logged, and never written anywhere that survives the tab — see `PAIRING_STORAGE_KEY`.
 *  - **Explicit connect, explicit disconnect, visible state.** Every transition publishes a
 *    row with a reason (§V288/§V338); `McpConnectionPanel` renders it and the Disconnect
 *    beside it. Unmount disconnects, so a closed tab leaves no live attachment.
 *  - **A message off the socket is DATA.** `callTool` arguments go to `surface.callTool`,
 *    which validates them against the tool's zod schema and returns a refusal as a RESULT
 *    (§V66). Nothing here inspects or acts on message content beyond `type` and `id`.
 *
 * ## Transport only (§V192)
 *
 * No tool definitions and no schemas: `toolListings` derives what is announced from the one
 * surface, `surface.callTool` does the work, this file moves bytes. The RESULT is sent
 * unwrapped — the node half puts it through `toolResultContent`, the same envelope the stdio
 * path uses, so there is exactly one MCP envelope in the repo (§V39).
 */

/**
 * The idle row's sentence: the state, HOW TO START, and what an agent talks to until
 * then (§V90/§V91/§V288, T533). The owner tried Claude Desktop and "didn't really get
 * how that is supposed to work" — because the only place that named the door was a
 * terminal log. This row is the signpost now: the command, the code, and the §V338
 * honesty that an unattached stdio agent is editing a HEADLESS copy, not this tab.
 */
const BRIDGE_IDLE_DETAIL =
  `Not attached — a desktop client (Claude Desktop, any stdio MCP client) drives THIS tab through the bridge: run \`pnpm mcp:serve\` in the project, read the pairing code it prints, and enter it here. Until a tab attaches, that server answers from a headless copy of the project — an agent can build a graph there that this tab never shows. Bridge expected on ${BRIDGE_HOST}:${BRIDGE_PORT}.`;

/**
 * WHERE THE PAIRING CODE IS REMEMBERED, AND FOR EXACTLY HOW LONG (T925).
 *
 * ## The pain, in the owner's words
 *
 * *"maybe we should try to reconnect to the last known mcp code on hot reload… its super
 * painful right now with any edit from an agent reloading the page and killing the link and
 * having me to repaste the code."* Note the shape of that: the agent's OWN edit triggers the
 * HMR reload that drops the attachment, so the tool stops working because of the work it
 * enables. Every such edit cost a hand-carried six-character secret between two windows.
 *
 * ## `sessionStorage`, and why not `localStorage`
 *
 * This code gates control of the user's open document. `sessionStorage` survives a reload
 * and dies with the tab — exactly the lifetime of the pain, and no longer. `localStorage`
 * would outlive the bridge PROCESS that minted the code and leave a stale control secret on
 * disk for days, buying nothing: the code is minted per process, so a value that outlives
 * the process is guaranteed worthless and merely dangerous.
 *
 * ## Why this key does not carry the legacy prefix (§V813)
 *
 * §V813 keeps the thirteen existing storage keys on the OLD prefix because MOVING a key
 * orphans data the user already has. A brand-new address has nothing to orphan, so it takes
 * the current name. Two prefixes is the honest state of a renamed product mid-flight; it is
 * a decision, not an oversight.
 */
const PAIRING_STORAGE_KEY = "loom.bridge.pairing.v1";

/** The three things this module does with a remembered code. Injectable for tests. */
export interface PairingMemory {
  read(): string | null;
  write(code: string): void;
  forget(): void;
}

/**
 * The real thing, and every call is wrapped.
 *
 * Reaching `sessionStorage` THROWS rather than returning null in a browser configured to
 * block site data, and `setItem` throws on quota. Remembering a code is a convenience; it
 * must never be able to stop a tab from attaching by hand.
 */
export function sessionPairingMemory(): PairingMemory {
  const store = (): Storage | null => {
    try {
      return globalThis.sessionStorage as Storage | undefined ?? null;
    } catch {
      return null;
    }
  };
  return {
    read() {
      try {
        return store()?.getItem(PAIRING_STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(code) {
      try {
        store()?.setItem(PAIRING_STORAGE_KEY, code);
      } catch {
        // Nothing to say and nothing to do: the next reload asks the human, as before.
      }
    },
    forget() {
      try {
        store()?.removeItem(PAIRING_STORAGE_KEY);
      } catch {
        // Same.
      }
    },
  };
}

/**
 * The socket shape this module needs.
 *
 * Narrow on purpose: the browser adapter below is the only place a DOM `WebSocket` appears,
 * and a test can hand in a real client or a fake with equal ease. Note that a test which
 * fakes this proves the CALLBACKS, not the bytes (§V382) — `bridge-e2e.test.ts` runs both
 * halves over a real socket for the claim that matters.
 */
export interface BridgeSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type BridgeSocketFactory = (url: string) => BridgeSocket;

/**
 * The real thing, adapted field by field so no cast is needed anywhere.
 *
 * Exported for `device-client.ts`, which held a byte-identical copy while ALREADY
 * importing `BridgeSocket` from this module — the type crossed the seam and the one
 * adapter that produces it did not.
 */
export function browserSocket(url: string): BridgeSocket {
  const socket = new WebSocket(url);
  const bridge: BridgeSocket = {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => bridge.onopen?.();
  socket.onmessage = (event: MessageEvent) => bridge.onmessage?.({ data: event.data });
  socket.onclose = () => bridge.onclose?.();
  socket.onerror = () => bridge.onerror?.();
  return bridge;
}

export interface BridgeClientOptions {
  /**
   * The CURRENT tool surface, read at every use rather than captured once.
   *
   * MEASURED under the previous transport (B76): the app mints a new surface whenever the
   * runtime identity changes, and a client pinned to one instance had to be rebuilt with it,
   * which closed the socket — an attached agent dropped roughly every thirty seconds with no
   * symptom anywhere, because an accidental teardown travels the same path as a deliberate
   * one. A transport outlives any one surface object; asking for the live one is what makes
   * that true.
   */
  readonly surface: () => AgentToolSurface;
  /** Where the state a human reads is published (T397/§V338). */
  readonly registry?: McpTransportRegistry;
  /** Overridable for tests; the product uses the shared constant. */
  readonly port?: number;
  /** How this tab names itself to the bridge. Shown to the operator, never trusted. */
  readonly client?: string;
  readonly socketFactory?: BridgeSocketFactory;
  /** Where a code is remembered across a reload (T925). Injectable for tests. */
  readonly memory?: PairingMemory;
  /**
   * Whether to make the one silent attempt with a remembered code on construction.
   *
   * Default on — that is the whole feature. Off is for a test that wants a cold client.
   */
  readonly autoReconnect?: boolean;
}

export interface BridgeClient {
  /** Attaches with the pairing code the user typed. Only ever called from a user action. */
  connect(pairingCode: string): void;
  /**
   * Withdraws the tools and closes the socket. Safe to call when not attached.
   *
   * `forget` separates a HUMAN revoking the attachment from a component unmounting. The
   * panel's Disconnect forgets; a React teardown (a StrictMode double-mount, an HMR module
   * swap) must not, or T925's memory would be wiped by the very reload it exists to survive.
   */
  disconnect(options?: { readonly forget?: boolean }): void;
  /**
   * Tells the bridge this tab's tool roster moved, so the MCP client gets a
   * `tools/list_changed` and stops describing ports that have since mounted or gone.
   */
  toolsChanged(): void;
}

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const { surface, registry } = options;
  const openSocket = options.socketFactory ?? browserSocket;
  const url = bridgeUrl(options.port ?? BRIDGE_PORT);
  const clientName = options.client ?? "a Loom tab";
  const memory = options.memory ?? sessionPairingMemory();

  let socket: BridgeSocket | null = null;
  /** Set while the user has asked to be attached. Guards late socket events. */
  let wanted = false;
  /** Set once the bridge has confirmed the pairing. */
  let attached = false;
  /** The code of the attempt in flight, so a confirmed attach can remember it (T925). */
  let attempting: string | null = null;
  /** Whether the attempt in flight came from memory rather than from a person typing. */
  let attemptWasRemembered = false;
  /**
   * Latch consumed by the next `connect`.
   *
   * `connect` is the ONE public door — a remembered attempt has to walk through the same
   * one a typed code does, or the two paths drift. This carries the single bit that
   * distinguishes them without widening the interface with an argument no caller should pass.
   */
  let nextAttemptIsRemembered = false;

  const publish = (
    state: "disconnected" | "connecting" | "connected" | "error",
    detail: string,
    toolNames: readonly string[] = [],
  ): void => {
    registry?.publish({
      kind: "bridge",
      label: TRANSPORT_LABEL.bridge,
      state,
      detail,
      toolNames,
      lastInvocation: null,
      // The affordance survives every state EXCEPT connected: a failed attach must leave the
      // user able to try again with the right code, which is the whole recovery path.
      connect:
        state === "connected"
          ? null
          : (code) => {
              client.connect(code);
            },
      disconnect:
        state === "connected" || state === "connecting"
          ? () => {
              // A HUMAN pressed this, so the remembered code goes with it (T925).
              client.disconnect({ forget: true });
            }
          : null,
    });
  };

  const send = (message: Record<string, unknown>): void => {
    socket?.send(JSON.stringify(message));
  };

  /** Answers one bridge request. Everything else on the wire is ignored, deliberately. */
  const handle = (message: Record<string, unknown>): void => {
    switch (message["type"]) {
      case "listTools": {
        const id = message["id"];
        if (typeof id !== "number") return;
        // Answered LIVE from the surface, so a port that mounted since the attach (pixels
        // arriving with the GPU) is visible to the agent immediately.
        send({ type: "listToolsResult", id, tools: toolListings(surface()) });
        return;
      }
      case "callTool": {
        const id = message["id"];
        const tool = message["tool"];
        if (typeof id !== "number" || typeof tool !== "string") return;
        registry?.noteInvocation("bridge", tool);
        // The arguments are DATA. `callTool` validates them against the tool's zod schema and
        // returns a refusal as a RESULT; this is not a place that decides anything.
        void surface()
          .callTool(tool, message["arguments"] ?? {})
          .then((result) => {
            send({ type: "callToolResult", id, result });
          })
          .catch((error: unknown) => {
            send({
              type: "callToolError",
              id,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      case "attached": {
        attached = true;
        // Remembered only once the bridge has CONFIRMED it, so a wrong code is never stored
        // and never replayed on the next reload (T925).
        if (attempting !== null) memory.write(attempting);
        publish(
          "connected",
          "Attached. An agent on your MCP client is driving THIS document — every tool call it makes lands on the graph you are looking at.",
          toolListings(surface()).map((tool) => tool.name),
        );
        return;
      }
      case "refused": {
        // The bridge's own words, carried as DATA into a field rendered as a text node —
        // never interpolated into anything a model reads (§V37).
        const said = message["reason"];
        const wasRemembered = attemptWasRemembered;
        wanted = false;
        attached = false;
        // A refused code is forgotten, and NOT retried. Codes are minted per process, so a
        // stale one after the server respawned is the EXPECTED case, not an exceptional one
        // — and a retry loop would hammer a bridge that can never accept it (T925).
        memory.forget();
        const live = socket;
        socket = null;
        if (live !== null) {
          live.onclose = null;
          live.close();
        }
        publish(
          "error",
          wasRemembered
            ? `The code this tab remembered from before the reload is no longer valid — the Loom MCP server mints a new pairing code every time it starts. Enter the current one; an agent connected to that server can read it out with the bridge_status tool. (The bridge said: ${typeof said === "string" ? said : "no reason given"})`
            : `The bridge refused: ${typeof said === "string" ? said : "no reason given"}`,
        );
        return;
      }
      case "ping": {
        const id = message["id"];
        if (typeof id === "number") send({ type: "pong", id });
        return;
      }
      default:
        return;
    }
  };

  const client: BridgeClient = {
    connect(pairingCode) {
      if (wanted) return;
      const fromMemory = nextAttemptIsRemembered;
      nextAttemptIsRemembered = false;
      const code = normalisePairingCode(pairingCode);
      if (code === "") {
        // Refused before a byte leaves the page: nothing opened, nothing published (§V288).
        publish("error", "No pairing code entered. The Loom MCP server prints one at startup; the agent connected to it can read it out.");
        return;
      }
      wanted = true;
      attemptWasRemembered = fromMemory;
      // Held for the `attached` confirmation. NEVER put into a published detail or a log —
      // the panel row is rendered on screen and copied into bug reports.
      attempting = code;
      publish("connecting", `Attaching to the bridge at ${url}…`);
      let live: BridgeSocket;
      try {
        live = openSocket(url);
      } catch (error) {
        wanted = false;
        publish("error", `Could not open a socket to ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      socket = live;
      live.onopen = () => {
        if (!wanted) {
          live.close();
          return;
        }
        // The code goes in the first MESSAGE, never in the URL (T398).
        live.send(JSON.stringify({ type: "attach", code, client: clientName }));
      };
      live.onmessage = (event) => {
        const message = parseBridgeMessage(event.data);
        if (message !== null) handle(message);
      };
      live.onclose = () => {
        if (socket !== live) return;
        socket = null;
        attempting = null;
        if (!wanted) return;
        wanted = false;
        // §V288: a connection that dies says so. Silence would leave the panel reading
        // "Connected" while nothing on the other end could reach the document.
        publish(
          "error",
          attached
            ? "The bridge closed the connection. The MCP server may have stopped; tool calls are running headless again."
            : `Could not attach to a bridge at ${url}. Is the Loom MCP server running?`,
        );
        attached = false;
      };
      live.onerror = () => {
        if (socket !== live) return;
        publish("error", `The bridge connection failed. Check that the Loom MCP server is running on ${url}.`);
      };
    },

    disconnect(disconnectOptions) {
      wanted = false;
      attached = false;
      attempting = null;
      attemptWasRemembered = false;
      // Explicit revocation is explicit: a human pressing Disconnect must not be silently
      // re-attached by the next reload. A component teardown passes nothing (T925).
      if (disconnectOptions?.forget === true) memory.forget();
      const live = socket;
      socket = null;
      if (live !== null) {
        live.onclose = null;
        live.close();
      }
      publish("disconnected", BRIDGE_IDLE_DETAIL);
    },

    toolsChanged() {
      if (!attached) return;
      send({ type: "toolsChanged" });
    },
  };

  publish("disconnected", BRIDGE_IDLE_DETAIL);

  /**
   * ONE silent attempt with the code this tab attached with earlier in this session (T925).
   *
   * Exactly one, and only from memory that a CONFIRMED attach wrote. If it is refused the
   * code is forgotten and the field comes back — a respawned server minting a new code is
   * the expected outcome here, not an error condition, so there is no retry.
   *
   * `import.meta.hot` was considered for holding the socket across a partial HMR swap and
   * deliberately skipped: this client is owned by a React effect that tears it down and
   * rebuilds it on the swap anyway, so a module-level hook would be fighting the lifecycle
   * for the case that already costs nothing. The reload that actually hurt is a FULL one,
   * which no module hook survives and this memory does.
   */
  const remembered = memory.read();
  if (remembered !== null && options.autoReconnect !== false) {
    nextAttemptIsRemembered = true;
    client.connect(remembered);
  }

  return client;
}
