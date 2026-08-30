import type { AgentToolSurface } from "../agent/surface.ts";
import { TRANSPORT_LABEL, type McpTransportRegistry } from "./connections.ts";
import { publishedTools } from "./published-tools.ts";
import { toolResultContent } from "./server.ts";

/**
 * THE RELAY TRANSPORT — AN EXTERNAL AGENT DRIVES *THIS* TAB (T453, §V378).
 *
 * ## What this is
 *
 * `serve.ts` gives an MCP client a complete HEADLESS Shaderloom: its own store, its own
 * GPU, and a graph the user cannot see. That was always the gap. This module is the other
 * shape — the page connects OUT to a loopback relay the user's MCP client already speaks
 * to, publishes the SAME tool surface, and every `tools/call` then lands on the LIVE
 * store behind the visible canvas. Nodes appear on screen while the model works.
 *
 * ## The protocol was read, not guessed
 *
 * T398 concluded this could not be built and was wrong; §V378 records why. The wire
 * format here is taken from the reference client that ships in `@jason.today/webmcp`
 * (`src/webmcp.js` in the published package), not reconstructed from observed traffic,
 * so the parts nobody exercises are right too. In full:
 *
 *  1. The pasted token is base64 of `{"server":"ws://localhost:PORT","token":"…"}`.
 *  2. The page opens `${server}/register` and sends back base64 of that same object with
 *     `host` added — the page's own `location.host` with `.` and `:` replaced by `_`.
 *  3. The relay answers `{type:"registerSuccess", channel, token}` with a SESSION token,
 *     invalidating the registration token, and closes.
 *  4. The page opens `${server}/${formattedHost}?token=${sessionToken}` — its channel.
 *  5. On open the page sends one `registerTool` per tool.
 *  6. The relay then sends `callTool` / `listTools` / `ping`, and the page answers
 *     `toolResponse` / `listToolsResponse` / `pong`, correlating on `id`.
 *
 * The MCP client on the other end sees ordinary MCP: the relay's stdio half turns our
 * `toolResponse.result` into the CallToolResult verbatim, which is why the result travels
 * as `toolResultContent` — the exact envelope `server.ts` puts on the stdio pipe (§V39).
 *
 * ## Security, and what is deliberately NOT copied
 *
 *  - **Loopback only, enforced HERE.** `decodeRelayToken` refuses any token whose server
 *    is not `ws:` on localhost. The relay's own listener is not loopback-bound (measured:
 *    it binds `*:4797`), so the page is the half that can still be strict, and a pasted
 *    token is exactly the kind of thing that arrives from somewhere else.
 *  - **The page initiates, always by hand.** Nothing here dials on load. The reference
 *    client keeps its token in `sessionStorage` and reconnects on every navigation; we
 *    drop that on purpose. Attaching hands an outside model write access to the open
 *    document, so it is an explicit act each time, and `McpConnectionPanel` shows the
 *    state and the Disconnect beside it.
 *  - **The session token in the channel URL is the relay's design, and it is stated, not
 *    hidden.** We cannot avoid it from the page side without a different relay; the row's
 *    `detail` says so, so a user can weigh it (§V288). It is loopback-only and never
 *    written to storage by us.
 *  - **A message off the socket is DATA, never instruction.** `callTool` arguments go
 *    through `surface.callTool`, which validates against the tool's zod schema and
 *    reports a refusal as a RESULT (§V66). Nothing here inspects, trusts or acts on the
 *    content of a message beyond its `type` and `id`.
 *
 * ## Transport only (§V192)
 *
 * No tool definitions, no schemas of its own, no document logic. `publishedTools` derives
 * what is announced; `surface.callTool` does the work; this file moves bytes.
 */

/**
 * The idle row's sentence. It has to do two jobs in one line (§V90/§V92): say what the
 * state is (§V91) and say where the token comes from, because "paste a token" is useless
 * to a user who does not know which token.
 */
const RELAY_IDLE_DETAIL =
  "Not attached. Paste the token your MCP client's get-token tool prints; the relay must be on localhost.";

/** A relay endpoint, decoded from the token the user pastes. */
export interface RelayEndpoint {
  /** `ws://localhost:PORT`, validated loopback. */
  readonly server: string;
  /** The one-shot registration token. Never rendered, never stored. */
  readonly token: string;
}

export type RelayTokenDecode =
  | { readonly ok: true; readonly endpoint: RelayEndpoint }
  /** §V288: the refusal names the problem, and never quotes the token back. */
  | { readonly ok: false; readonly reason: string };

/** Hosts a pasted token is allowed to point at. Anything else is refused by name. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The relay's channel naming, which the page must reproduce exactly or its tools land on
 * a channel the MCP client never reads. `localhost:5173` → `localhost_5173`.
 */
export function relayChannelFor(host: string): string {
  return host.replace(/[.:]/g, "_");
}

/**
 * Decodes and VETS the pasted token.
 *
 * Exported and pure because this is the security boundary of the whole transport: it is
 * the single point where "somebody pasted a string" becomes "we will hand this endpoint
 * every tool that can rewrite the document". It is worth being able to test on its own.
 */
export function decodeRelayToken(pasted: string): RelayTokenDecode {
  const trimmed = pasted.trim();
  if (trimmed === "") return { ok: false, reason: "No token pasted." };

  let decoded: string;
  try {
    decoded = atob(trimmed);
  } catch {
    return { ok: false, reason: "That is not a WebMCP token — it is not base64." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "That is not a WebMCP token — it does not decode to JSON." };
  }

  const shaped = parsed as { server?: unknown; token?: unknown };
  if (typeof shaped.server !== "string" || typeof shaped.token !== "string") {
    return { ok: false, reason: "That token carries no server and token pair." };
  }

  let url: URL;
  try {
    url = new URL(shaped.server);
  } catch {
    return { ok: false, reason: "That token's server address is not a URL." };
  }
  if (url.protocol !== "ws:") {
    return {
      ok: false,
      reason: `Refused: a relay token must name a ws:// address, and this one names ${url.protocol}//.`,
    };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    // The whole point of the refusal: these tools rewrite the user's document, so they
    // are not published to a machine that is not this one, however the token got here.
    return {
      ok: false,
      reason: `Refused: this token points at ${url.hostname}, not at this machine. Shaderloom attaches to a relay on localhost only.`,
    };
  }

  return { ok: true, endpoint: { server: shaped.server.replace(/\/+$/, ""), token: shaped.token } };
}

/**
 * The socket shape this module needs — four callbacks and two methods.
 *
 * Narrow on purpose: a test supplies one in six lines and drives the entire handshake
 * with no network, and the browser adapter below is the only place a real `WebSocket`
 * appears. `RelayClient` never sees a DOM type.
 */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

/** The real thing, adapted field by field so no cast is needed anywhere. */
function browserSocket(url: string): RelaySocket {
  const socket = new WebSocket(url);
  const relay: RelaySocket = {
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
  socket.onopen = () => relay.onopen?.();
  socket.onmessage = (event: MessageEvent) => relay.onmessage?.({ data: event.data });
  socket.onclose = () => relay.onclose?.();
  socket.onerror = () => relay.onerror?.();
  return relay;
}

export interface RelayClientOptions {
  /**
   * The CURRENT tool surface, read at every use rather than captured once.
   *
   * MEASURED, and the reason this is a getter: the app rebuilds its surface whenever the
   * runtime identity changes (autosave ticks it), and a client pinned to one instance had
   * to be torn down and rebuilt with it — which closed the socket. An attached agent was
   * dropped roughly every thirty seconds, silently, mid-session. A transport outlives any
   * one surface object; asking for the live one is what makes that true.
   */
  readonly surface: () => AgentToolSurface;
  /** Where the state a human reads is published (T397/§V338). */
  readonly registry?: McpTransportRegistry;
  /** This page's `location.host`. The relay keys its channel on it. */
  readonly host: string;
  /** Injectable transport. Defaults to a real browser `WebSocket`. */
  readonly socketFactory?: RelaySocketFactory;
}

export interface RelayClient {
  /** Attaches, given the token the user pasted. Only ever called from a user action. */
  connect(pastedToken: string): void;
  /** Withdraws the tools and closes the socket. Safe to call when not connected. */
  disconnect(): void;
}

/** One message off the relay. Only `type` and `id` are ever trusted (§V37). */
interface RelayMessage {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly tool?: unknown;
  readonly arguments?: unknown;
  readonly token?: unknown;
  readonly message?: unknown;
}

function parseMessage(data: unknown): RelayMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as RelayMessage) : null;
  } catch {
    return null;
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const { surface, registry, host } = options;
  const openSocket = options.socketFactory ?? browserSocket;
  const channel = relayChannelFor(host);

  let socket: RelaySocket | null = null;
  /** Set while the user has asked to be attached. Guards late socket events. */
  let wanted = false;

  const publish = (
    state: "disconnected" | "connecting" | "connected" | "error",
    detail: string,
    toolNames: readonly string[] = [],
  ): void => {
    registry?.publish({
      kind: "relay",
      label: TRANSPORT_LABEL.relay,
      state,
      detail,
      toolNames,
      lastInvocation: null,
      // The affordance survives every state EXCEPT connected: a failed attach must leave
      // the user able to try again with a fresh token, which is the whole recovery path.
      connect: state === "connected" ? null : (token) => {
        client.connect(token);
      },
      disconnect: state === "connected" || state === "connecting" ? () => {
        client.disconnect();
      } : null,
    });
  };

  const send = (message: Record<string, unknown>): void => {
    socket?.send(JSON.stringify(message));
  };

  /** Answers one relay request. Everything else on the wire is ignored, deliberately. */
  const handle = (message: RelayMessage): void => {
    switch (message.type) {
      case "callTool": {
        const tool = message.tool;
        if (typeof tool !== "string") return;
        registry?.noteInvocation("relay", tool);
        // The arguments are DATA. `callTool` validates them against the tool's zod schema
        // and returns a refusal as a RESULT — this is not a place that decides anything.
        void surface()
          .callTool(tool, message.arguments ?? {})
          .then((result) => {
            send({ id: message.id, type: "toolResponse", result: { content: toolResultContent(result), isError: false } });
          })
          .catch((error: unknown) => {
            send({
              id: message.id,
              type: "toolResponse",
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      case "listTools":
        // Answered from the surface LIVE rather than from what was announced at open, so
        // a port that mounted since (pixels arriving with the GPU) is visible immediately.
        send({ id: message.id, type: "listToolsResponse", tools: publishedTools(surface()) });
        return;
      case "listPrompts":
        // We publish neither, and say so rather than leaving the client's request to time
        // out — an empty answer is a fact, silence is a hang.
        send({ id: message.id, type: "listPromptsResponse", prompts: [] });
        return;
      case "listResources":
        send({ id: message.id, type: "listResourcesResponse", resources: [], resourceTemplates: [] });
        return;
      case "ping":
        send({ type: "pong", id: message.id, timestamp: Date.now() });
        return;
      default:
        return;
    }
  };

  /** Step 4-6: the channel socket, which is where the actual work happens. */
  const openChannel = (endpoint: RelayEndpoint, sessionToken: string): void => {
    // The session token rides in the query string. That is the relay's handshake, not our
    // choice; it is stated in the row rather than hidden, and it never leaves loopback.
    const live = openSocket(`${endpoint.server}/${channel}?token=${encodeURIComponent(sessionToken)}`);
    socket = live;
    live.onopen = () => {
      if (!wanted) {
        live.close();
        return;
      }
      const tools = publishedTools(surface());
      for (const tool of tools) {
        live.send(
          JSON.stringify({
            type: "registerTool",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }),
        );
      }
      publish(
        "connected",
        `Attached on ${channel}. An external agent can call these tools, which edit this document. The relay's session token travels in the socket URL, on localhost.`,
        tools.map((tool) => tool.name),
      );
    };
    live.onmessage = (event) => {
      const message = parseMessage(event.data);
      if (message !== null) handle(message);
    };
    live.onclose = () => {
      if (socket !== live) return;
      socket = null;
      if (!wanted) return;
      wanted = false;
      // §V288: a connection that dies says so. Silence here would leave the panel reading
      // "Connected" while nothing on the other end could reach the document.
      publish("error", "The relay closed the connection. Paste a fresh token to attach again.");
    };
    live.onerror = () => {
      if (socket !== live) return;
      publish("error", "The relay connection failed. Check that the relay is still running.");
    };
  };

  /** Steps 2-3: exchange the pasted registration token for a session token. */
  const register = (endpoint: RelayEndpoint): void => {
    const registration = openSocket(`${endpoint.server}/register`);
    socket = registration;
    registration.onopen = () => {
      registration.send(btoa(JSON.stringify({ ...endpoint, host: channel })));
    };
    registration.onmessage = (event) => {
      const message = parseMessage(event.data);
      if (message === null) return;
      if (message.type === "registerSuccess" && typeof message.token === "string") {
        const sessionToken = message.token;
        registration.onclose = null;
        registration.close();
        socket = null;
        if (!wanted) return;
        publish("connecting", "Registered. Opening the channel…");
        openChannel(endpoint, sessionToken);
        return;
      }
      if (message.type === "error") {
        wanted = false;
        registration.onclose = null;
        registration.close();
        socket = null;
        // The relay's own words, carried as DATA into a field rendered as a text node —
        // never interpolated into anything a model reads (§V37).
        const said = typeof message.message === "string" ? message.message : "no reason given";
        publish("error", `The relay refused the token: ${said}`);
      }
    };
    registration.onclose = () => {
      if (socket !== registration) return;
      socket = null;
      if (!wanted) return;
      wanted = false;
      publish(
        "error",
        "The relay closed the registration before issuing a session. The token may already have been used — generate a new one.",
      );
    };
    registration.onerror = () => {
      if (socket !== registration) return;
      wanted = false;
      publish("error", `Could not reach the relay at ${endpoint.server}. Is it running?`);
    };
  };

  const client: RelayClient = {
    connect(pastedToken) {
      if (wanted) return;
      const decoded = decodeRelayToken(pastedToken);
      if (!decoded.ok) {
        // Refused before a single byte leaves the page: nothing was opened, nothing was
        // published, and the row says exactly what was wrong with the paste (§V288).
        publish("error", decoded.reason);
        return;
      }
      wanted = true;
      publish("connecting", `Registering with the relay at ${decoded.endpoint.server}…`);
      register(decoded.endpoint);
    },

    disconnect() {
      wanted = false;
      const live = socket;
      socket = null;
      if (live !== null) {
        live.onclose = null;
        live.close();
      }
      publish("disconnected", RELAY_IDLE_DETAIL);
    },
  };

  publish("disconnected", RELAY_IDLE_DETAIL);
  return client;
}

