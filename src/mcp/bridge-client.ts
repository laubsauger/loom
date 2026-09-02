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
 *  - **Nothing dials on load.** `createBridgeClient` opens no socket; it publishes an idle
 *    row carrying the `connect` the panel renders a field for. An agent cannot attach to a
 *    tab whose owner did not attach it.
 *  - **The pairing code is typed by the human, and never persisted.** It is minted by the
 *    bridge process and published only through the bridge's own channels, so a page the user
 *    did not open cannot produce one — which is what stops any site in any other tab from
 *    opening `ws://127.0.0.1` and driving this document. It travels as the first MESSAGE on
 *    the socket, never in the URL: T398's finding about the deprecated relay, whose session
 *    token rode the query string into every log that touched it.
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

/** The real thing, adapted field by field so no cast is needed anywhere. */
function browserSocket(url: string): BridgeSocket {
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
}

export interface BridgeClient {
  /** Attaches with the pairing code the user typed. Only ever called from a user action. */
  connect(pairingCode: string): void;
  /** Withdraws the tools and closes the socket. Safe to call when not attached. */
  disconnect(): void;
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

  let socket: BridgeSocket | null = null;
  /** Set while the user has asked to be attached. Guards late socket events. */
  let wanted = false;
  /** Set once the bridge has confirmed the pairing. */
  let attached = false;

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
              client.disconnect();
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
        wanted = false;
        attached = false;
        const live = socket;
        socket = null;
        if (live !== null) {
          live.onclose = null;
          live.close();
        }
        publish("error", `The bridge refused: ${typeof said === "string" ? said : "no reason given"}`);
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
      const code = normalisePairingCode(pairingCode);
      if (code === "") {
        // Refused before a byte leaves the page: nothing opened, nothing published (§V288).
        publish("error", "No pairing code entered. The Loom MCP server prints one at startup; the agent connected to it can read it out.");
        return;
      }
      wanted = true;
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

    disconnect() {
      wanted = false;
      attached = false;
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
  return client;
}
