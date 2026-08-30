import { describe, expect, it } from "vitest";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { createMcpTransportRegistry } from "./connections.ts";
import type { McpTransportStatus } from "./connections.ts";
import { createRelayClient, decodeRelayToken, relayChannelFor } from "./relay-client.ts";
import type { RelaySocket } from "./relay-client.ts";

/**
 * THE RELAY WIRE, DRIVEN END TO END WITHOUT A NETWORK (T453).
 *
 * Everything below the socket is REAL: the real store, the real command bus, the whole
 * node catalogue and the real agent surface with its real zod schemas. Only the socket is
 * a fake, and it is a dumb one — it records what was sent and lets a test hand back what
 * the relay would say. So "the agent added a node" here means a node genuinely entered a
 * document, not that a mock was called.
 *
 * The wire format under test was read off the reference client in `@jason.today/webmcp`
 * (`src/webmcp.js`), which is why the assertions are on exact frames — a handshake that is
 * merely plausible fails against the real relay and passes against a mock built from the
 * same guess. §V378 is the reason this file exists at all.
 *
 * What it does NOT prove: that a real relay accepts these frames. `relay-live.gpu.test.ts`
 * is the file for that, and it is skipped unless a relay is actually running.
 */

/** `{"server":"ws://localhost:4797","token":"…"}`, base64 — the shape the relay mints. */
function tokenFor(server: string, token = "0123456789abcdef0123456789abcdef"): string {
  return btoa(JSON.stringify({ server, token }));
}

class FakeSocket implements RelaySocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** What the relay says to us. */
  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function harness(host = "localhost:5173") {
  const store = createGraphStore();
  const nodes = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry: nodes });
  const surface = createAgentToolSurface({
    bus,
    actor: { kind: "agent", id: "relay-test", label: "Relay" },
    projectId: "p1",
  });
  const registry = createMcpTransportRegistry();
  const sockets: FakeSocket[] = [];
  // A getter, exactly as the app passes one — the surface object is replaced under a
  // live connection and the transport must follow it (see `use-mcp-transports.ts`).
  let live = surface;
  const client = createRelayClient({
    surface: () => live,
    registry,
    host,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const row = (): McpTransportStatus => {
    const found = registry.snapshot().find((transport) => transport.kind === "relay");
    if (found === undefined) throw new Error("the registry declares no relay row");
    return found;
  };
  return {
    store,
    surface,
    registry,
    sockets,
    client,
    row,
    /** Swaps the surface the way a runtime change does, without touching the socket. */
    replaceSurface: (next: typeof surface) => {
      live = next;
    },
  };
}

/** Runs the documented handshake to the point where the channel socket is open. */
function attach(fixture: ReturnType<typeof harness>, session = "session-token-abc") {
  fixture.client.connect(tokenFor("ws://localhost:4797"));
  const registration = fixture.sockets[0];
  if (registration === undefined) throw new Error("no registration socket was opened");
  registration.onopen?.();
  registration.emit({ type: "registerSuccess", channel: "/localhost_5173", token: session });
  const channel = fixture.sockets[1];
  if (channel === undefined) throw new Error("no channel socket was opened");
  channel.onopen?.();
  return { registration, channel };
}

describe("decodeRelayToken — the security boundary (T453)", () => {
  it("accepts the relay's own token shape and normalises the server", () => {
    const decoded = decodeRelayToken(` ${tokenFor("ws://localhost:4797/")} `);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.endpoint.server).toBe("ws://localhost:4797");
    expect(decoded.endpoint.token).toBe("0123456789abcdef0123456789abcdef");
  });

  it("accepts every loopback spelling, because the relay may use any of them", () => {
    for (const server of ["ws://localhost:4797", "ws://127.0.0.1:4797", "ws://[::1]:4797"]) {
      expect(decodeRelayToken(tokenFor(server)).ok, server).toBe(true);
    }
  });

  /**
   * The refusal that matters. A token is a string that arrives from somewhere else, and
   * what is on the other end of it is every tool that can rewrite the user's document.
   */
  it("REFUSES a token pointing off this machine, and names the host (§V288)", () => {
    const decoded = decodeRelayToken(tokenFor("ws://evil.example.com:4797"));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toContain("evil.example.com");
    expect(decoded.reason).toContain("localhost only");
  });

  it("refuses a non-ws scheme, naming the scheme it got", () => {
    const decoded = decodeRelayToken(tokenFor("https://localhost:4797"));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toContain("https://");
  });

  it("names what is wrong with a paste that is not a token at all", () => {
    const reasons = [
      decodeRelayToken(""),
      decodeRelayToken("!!!not base64!!!"),
      decodeRelayToken(btoa("plain text, not json")),
      decodeRelayToken(btoa(JSON.stringify({ server: "ws://localhost:4797" }))),
    ].map((decoded) => (decoded.ok ? "accepted" : decoded.reason));
    expect(reasons).toEqual([
      "No token pasted.",
      "That is not a WebMCP token — it is not base64.",
      "That is not a WebMCP token — it does not decode to JSON.",
      "That token carries no server and token pair.",
    ]);
  });

  it("reproduces the relay's channel naming exactly, or the tools land nowhere", () => {
    expect(relayChannelFor("localhost:5173")).toBe("localhost_5173");
    expect(relayChannelFor("127.0.0.1:8080")).toBe("127_0_0_1_8080");
  });
});

describe("the relay handshake, frame for frame (T453)", () => {
  it("opens nothing at all until the user connects — no dialling on construction", () => {
    const fixture = harness();
    expect(fixture.sockets).toHaveLength(0);
    expect(fixture.row().state).toBe("disconnected");
    // The affordance is there; the socket is not. That distinction is the security model.
    expect(fixture.row().connect).not.toBeNull();
  });

  it("REFUSES a remote token without opening a socket, and says why", () => {
    const fixture = harness();
    fixture.client.connect(tokenFor("ws://192.168.1.9:4797"));
    expect(fixture.sockets).toHaveLength(0);
    expect(fixture.row().state).toBe("error");
    expect(fixture.row().detail).toContain("192.168.1.9");
    // Recoverable: the user can paste a correct token without reloading.
    expect(fixture.row().connect).not.toBeNull();
  });

  it("registers at /register with the decoded token plus this page's channel", () => {
    const fixture = harness();
    fixture.client.connect(tokenFor("ws://localhost:4797"));
    const registration = fixture.sockets[0];
    expect(registration?.url).toBe("ws://localhost:4797/register");
    expect(fixture.row().state).toBe("connecting");

    registration?.onopen?.();
    const frame = registration?.sent[0] ?? "";
    // The relay expects base64 of the connection object with `host` added — not JSON.
    expect(JSON.parse(atob(frame))).toEqual({
      server: "ws://localhost:4797",
      token: "0123456789abcdef0123456789abcdef",
      host: "localhost_5173",
    });
  });

  it("opens the channel with the SESSION token, not the pasted one", () => {
    const fixture = harness();
    const { channel } = attach(fixture, "fresh-session");
    expect(channel.url).toBe("ws://localhost:4797/localhost_5173?token=fresh-session");
    expect(channel.url).not.toContain("0123456789abcdef");
  });

  it("announces every tool the surface publishes, and says so on the row", () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    const registered = channel
      .frames()
      .filter((frame) => frame["type"] === "registerTool")
      .map((frame) => frame["name"]);
    expect(registered).toEqual(fixture.surface.listTools().map((tool) => tool.name));
    expect(registered.length).toBeGreaterThan(0);

    const row = fixture.row();
    expect(row.state).toBe("connected");
    expect(row.toolNames).toEqual(registered);
    expect(row.disconnect).not.toBeNull();
    // §V288: what the user is consenting to is on the row, including the URL-borne token.
    expect(row.detail).toContain("edit this document");
    expect(row.detail).toContain("session token travels in the socket URL");
  });

  it("answers listTools from the LIVE surface, with real schemas", () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    channel.emit({ type: "listTools", id: "7" });

    const answer = channel.frames().find((frame) => frame["type"] === "listToolsResponse");
    expect(answer?.["id"]).toBe("7");
    const tools = answer?.["tools"] as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    expect(tools.map((tool) => tool.name)).toEqual(fixture.surface.listTools().map((t) => t.name));
    const addNode = tools.find((tool) => tool.name === "add_node");
    expect((addNode?.inputSchema["properties"] as Record<string, unknown>)["type"]).toBeDefined();
  });

  it("answers a ping, so the relay does not reap the channel", () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    channel.emit({ type: "ping", id: "p1" });
    const pong = channel.frames().find((frame) => frame["type"] === "pong");
    expect(pong?.["id"]).toBe("p1");
  });

  it("says nothing to a message type it does not implement, rather than guessing", () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    const before = channel.sent.length;
    channel.emit({ type: "somethingElse", id: "x" });
    channel.onmessage?.({ data: "not json at all" });
    expect(channel.sent.length).toBe(before);
  });
});

describe("a tool call off the wire reaches the REAL document (T453)", () => {
  it("adds a node to the live store and returns MCP content", async () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    expect(Object.keys(fixture.store.view.getGraph().nodes)).toHaveLength(0);

    channel.emit({
      type: "callTool",
      id: "42",
      tool: "add_node",
      arguments: { type: "solid", position: { x: 10, y: 20 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The document moved. This is the claim the whole task is about.
    const nodes = Object.values(fixture.store.view.getGraph().nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("solid");

    const response = channel.frames().find((frame) => frame["id"] === "42");
    expect(response?.["type"]).toBe("toolResponse");
    expect(response?.["error"]).toBeUndefined();
    // The relay hands `result` to the MCP client verbatim, so it must BE a CallToolResult.
    const result = response?.["result"] as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.type).toBe("text");
    expect((JSON.parse(result.content[0]?.text ?? "{}") as { status: string }).status).toBe("ok");

    // §V42: the panel shows what the agent just reached for.
    expect(fixture.row().lastInvocation?.tool).toBe("add_node");
  });

  /**
   * The message is DATA. A `callTool` whose arguments do not match the tool's zod schema
   * is refused by `surface.callTool` and comes back as a RESULT — the socket does not get
   * to bypass validation by virtue of having come from the agent.
   */
  it("still validates arguments through zod, and refuses without touching the store", async () => {
    const fixture = harness();
    const { channel } = attach(fixture);

    channel.emit({ type: "callTool", id: "9", tool: "add_node", arguments: { type: 42 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Object.keys(fixture.store.view.getGraph().nodes)).toHaveLength(0);
    const response = channel.frames().find((frame) => frame["id"] === "9");
    const result = response?.["result"] as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      diagnostics: Array<{ message: string }>;
    };
    expect(payload.status).toBe("error");
    expect(payload.diagnostics[0]?.message).toContain('Input to "add_node" is invalid');
  });

  it("refuses a tool name the surface does not have, as data rather than a throw", async () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    channel.emit({ type: "callTool", id: "3", tool: "rm_rf_slash", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = channel.frames().find((frame) => frame["id"] === "3");
    expect(response?.["error"]).toBeUndefined();
    const result = response?.["result"] as { content: Array<{ text: string }> };
    expect((JSON.parse(result.content[0]?.text ?? "{}") as { status: string }).status).toBe("error");
  });
});

describe("the connection outlives the surface object (T453 regression)", () => {
  /**
   * MEASURED against a real relay in a real tab before this existed: the app mints a new
   * `AgentToolSurface` whenever its runtime identity changes, and the transport used to be
   * rebuilt with it — closing the socket about every thirty seconds and silently dropping
   * an attached agent. A disconnect is indistinguishable from a disconnect, so nothing
   * anywhere reported it; the only symptom was that the agent's next call failed with the
   * relay's "no clients available in channel".
   *
   * The fix is that the client reads the CURRENT surface at every use. This asserts both
   * halves: the socket survives the swap, and the calls land on the NEW surface.
   */
  it("keeps the socket open when the app replaces the surface, and calls the new one", async () => {
    const fixture = harness();
    const { channel } = attach(fixture);

    const second = createGraphStore();
    const nodes = createNodeRegistry(allNodeDefinitions).view();
    const { bus } = createDomainBus({ store: second, registry: nodes });
    fixture.replaceSurface(
      createAgentToolSurface({
        bus,
        actor: { kind: "agent", id: "relay-test-2", label: "Relay" },
        projectId: "p2",
      }),
    );

    channel.emit({ type: "callTool", id: "swap", tool: "add_node", arguments: { type: "solid" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.closed).toBe(false);
    expect(fixture.row().state).toBe("connected");
    // The edit landed on the CURRENT document, not on the one captured at connect time.
    expect(Object.keys(second.view.getGraph().nodes)).toHaveLength(1);
    expect(Object.keys(fixture.store.view.getGraph().nodes)).toHaveLength(0);
  });
});

describe("attaching is revocable, and its failures are legible (T453)", () => {
  it("disconnect closes the socket and puts the row back to attachable", () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    const disconnect = fixture.row().disconnect;
    expect(disconnect).not.toBeNull();
    disconnect?.();

    expect(channel.closed).toBe(true);
    const row = fixture.row();
    expect(row.state).toBe("disconnected");
    expect(row.toolNames).toEqual([]);
    expect(row.connect).not.toBeNull();
    expect(row.disconnect).toBeNull();
  });

  it("a relay that drops the channel is REPORTED, not left reading Connected", () => {
    const fixture = harness();
    const { channel } = attach(fixture);
    channel.onclose?.();
    expect(fixture.row().state).toBe("error");
    expect(fixture.row().detail).toContain("closed the connection");
  });

  it("a relay that rejects the token carries the relay's own reason", () => {
    const fixture = harness();
    fixture.client.connect(tokenFor("ws://localhost:4797"));
    const registration = fixture.sockets[0];
    registration?.onopen?.();
    registration?.emit({ type: "error", message: "Invalid token provided" });

    expect(fixture.row().state).toBe("error");
    expect(fixture.row().detail).toContain("Invalid token provided");
    // It refused before ever opening a channel — no tools were published.
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.row().toolNames).toEqual([]);
  });

  it("an unreachable relay names the address rather than failing silently", () => {
    const fixture = harness();
    fixture.client.connect(tokenFor("ws://localhost:4797"));
    fixture.sockets[0]?.onerror?.();
    expect(fixture.row().state).toBe("error");
    expect(fixture.row().detail).toContain("ws://localhost:4797");
  });
});
