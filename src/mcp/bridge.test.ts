import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { createBridgeClient } from "./bridge-client.ts";
import { createMcpTransportRegistry } from "./connections.ts";
import { createHeadlessMcpServer } from "./serve.ts";
import {
  isPermittedOrigin,
  mintPairingCode,
  normalisePairingCode,
  pairingCodeMatches,
} from "./bridge-protocol.ts";

/**
 * THE BRIDGE, OVER A REAL SOCKET (T451, §V382).
 *
 * ## Why this suite refuses to stub the transport
 *
 * §V382: a test stubbed at the boundary the author wrote asserts the CALLBACK, not the
 * bytes. A fake `BridgeSocket` handed to `createBridgeClient` would prove that the client
 * calls what the test told it to call, and would stay green if the frame codec, the
 * handshake, the masking or the message names were wrong in either direction. So every
 * test below opens a REAL TCP connection to a REAL listener:
 *
 *  - the page half is the product's own `createBridgeClient` with its default browser
 *    socket (Node's global `WebSocket`), against
 *  - the node half inside a real `createHeadlessMcpServer`, driven by real JSON-RPC.
 *
 * What that leaves unproven is exactly one thing, and it is named rather than implied: this
 * runs in Node, not in Chrome, so it does not prove a BROWSER's WebSocket handshake against
 * this hand-rolled server. That claim needs a browser, and it was made separately.
 *
 * ## The assertion that matters
 *
 * A `tools/call` arriving on the STDIO pipe must mutate the PAGE's store — the live document
 * behind a visible canvas — and not the headless twin's. That is the whole task, so it is
 * asserted on the store, at both ends of the attach.
 */

/** Nothing here waits on wall time; everything waits on a condition (§V44's spirit). */
async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A real Shaderloom document with a real bus and the real catalogue — the "page". */
function pageHarness() {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const surface = createAgentToolSurface({
    bus,
    actor: { kind: "agent", id: "page", label: "Page" },
    projectId: "page-project",
  });
  return { store, surface };
}

interface Harness {
  readonly server: ReturnType<typeof createHeadlessMcpServer>;
  readonly sent: Array<Record<string, unknown>>;
  readonly port: number;
  request(method: string, params: Record<string, unknown> | undefined, id: number): Promise<{
    result?: Record<string, unknown>;
    error?: unknown;
  }>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function bridgedServer(): Promise<Harness> {
  const sent: Array<Record<string, unknown>> = [];
  const server = createHeadlessMcpServer({
    send: (message) => sent.push(message),
    // Port 0: the OS picks, so parallel suites never collide on the shared constant.
    bridge: { port: 0 },
  });
  cleanups.push(() => {
    server.dispose();
  });
  await until(() => server.bridgeStatus()?.port !== null, "the bridge to bind a port");
  const port = server.bridgeStatus()?.port;
  if (port == null) throw new Error("bridge reported no port");
  return {
    server,
    sent,
    port,
    async request(method, params, id) {
      await server.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      return sent.findLast((message) => message["id"] === id) as { result?: Record<string, unknown> };
    },
  };
}

function pairingCodeOf(harness: Harness): string {
  // The code a HUMAN reads: the same sentence that reaches stderr and the notification
  // channel. Parsing it here is deliberate — if the operator cannot find the code in that
  // sentence, neither can this test.
  const detail = harness.server.bridgeStatus()?.detail ?? "";
  const match = /Pairing code ([A-Z0-9]+)/.exec(detail);
  if (match?.[1] === undefined) throw new Error(`No pairing code in bridge status: ${detail}`);
  return match[1];
}

/**
 * Attaches a real page client to a real bridge and resolves once the bridge confirms.
 *
 * Uses the product's DEFAULT socket factory, so the handshake, the masking and the frame
 * codec are all exercised for real.
 */
async function attachPage(harness: Harness, options: { code?: string } = {}) {
  const page = pageHarness();
  const registry = createMcpTransportRegistry();
  const client = createBridgeClient({
    surface: () => page.surface,
    registry,
    port: harness.port,
    client: "vitest-page",
  });
  cleanups.push(() => {
    client.disconnect();
  });
  const row = () => registry.snapshot().find((transport) => transport.kind === "bridge");
  client.connect(options.code ?? pairingCodeOf(harness));
  return { ...page, client, registry, row };
}

describe("bridge pairing code (T451)", () => {
  it("mints a transcribable code and matches it case- and dash-insensitively", () => {
    const code = mintPairingCode();
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // The characters a person confuses when retyping are simply not in the alphabet.
    expect(code).not.toMatch(/[01OIL]/);
    expect(pairingCodeMatches(code, code.toLowerCase())).toBe(true);
    expect(pairingCodeMatches(code, ` ${code.slice(0, 3)}-${code.slice(3)} `)).toBe(true);
    expect(pairingCodeMatches(code, `${code}X`)).toBe(false);
    expect(normalisePairingCode(" ab-cd ")).toBe("ABCD");
  });

  it("permits a loopback page and a non-browser peer, and refuses everything else", () => {
    expect(isPermittedOrigin("http://localhost:5173")).toBe(true);
    expect(isPermittedOrigin("http://127.0.0.1:4173")).toBe(true);
    // Absent: not a browser. Documented in bridge-protocol.ts, and the reason it is safe.
    expect(isPermittedOrigin(undefined)).toBe(true);
    expect(isPermittedOrigin("https://evil.example")).toBe(false);
    expect(isPermittedOrigin("null")).toBe(false);
    // The one that would matter most if the regex were sloppy.
    expect(isPermittedOrigin("http://localhost.evil.example")).toBe(false);
  });
});

describe("bridge, headless fallback (T451, §V338)", () => {
  it("says which document it touched, in the result, the list and the instructions", async () => {
    const harness = await bridgedServer();
    const code = pairingCodeOf(harness);

    const init = await harness.request("initialize", {}, 1);
    const instructions = init.result?.["instructions"];
    expect(typeof instructions).toBe("string");
    // The pairing code has to reach the person through the agent, because the agent is the
    // only one of the two who can definitely see this server's output.
    expect(instructions as string).toContain(code);
    expect(instructions as string).toContain("HEADLESS");

    const list = await harness.request("tools/list", {}, 2);
    const tools = list.result?.["tools"] as Array<Record<string, unknown>>;
    const addNode = tools.find((tool) => tool["name"] === "add_node");
    expect(addNode?.["description"]).toContain("no Shaderloom tab is attached");

    const call = await harness.request(
      "tools/call",
      { name: "add_node", arguments: { type: "solid" } },
      3,
    );
    const content = (call.result?.["content"] as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content?.text ?? "{}") as { status: string; bridge: Record<string, unknown> };
    expect(payload.status).toBe("ok");
    // §V338: the detection result is SHOWN, not merely branched on. A model that reads this
    // cannot honestly tell the user "I added a node to your graph".
    expect(payload.bridge["attached"]).toBe(false);
    expect(payload.bridge["pairingCode"]).toBe(code);
    expect(String(payload.bridge["note"])).toContain("cannot see");
  });
});

describe("bridge, attached to a live page (T451, §V382)", () => {
  it("runs a stdio tools/call against the PAGE's store, over a real socket", async () => {
    const harness = await bridgedServer();
    const page = await attachPage(harness);
    await until(() => page.row()?.state === "connected", "the page to attach");

    expect(harness.server.bridgeStatus()?.attached).toBe(true);
    expect(Object.keys(page.store.view.getGraph().nodes)).toHaveLength(0);

    const call = await harness.request(
      "tools/call",
      { name: "add_node", arguments: { type: "solid" } },
      10,
    );
    const content = (call.result?.["content"] as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content?.text ?? "{}") as {
      status: string;
      bridge: Record<string, unknown>;
    };

    // THE CLAIM: a call that arrived on the stdio pipe edited the document the user is
    // looking at. Nothing about this can pass with a broken socket, a broken frame codec or
    // a broken handshake, because there is no stub anywhere between the two halves.
    expect(payload.status).toBe("ok");
    expect(payload.bridge["attached"]).toBe(true);
    expect(payload.bridge["target"]).toBe("vitest-page");
    const nodes = Object.values(page.store.view.getGraph().nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("solid");

    // And the panel's row says so, with the tools it published.
    const row = page.row();
    expect(row?.toolNames).toContain("add_node");
    expect(row?.lastInvocation?.tool).toBe("add_node");
  });

  it("serves tools/list from the attached page and announces the change", async () => {
    const harness = await bridgedServer();
    const before = await harness.request("tools/list", {}, 20);
    const beforeNames = (before.result?.["tools"] as Array<Record<string, unknown>>).map(
      (tool) => tool["name"],
    );

    const page = await attachPage(harness);
    await until(() => page.row()?.state === "connected", "the page to attach");

    // A list that changed hands must be announced, or a client keeps describing the twin.
    await until(
      () => harness.sent.some((message) => message["method"] === "notifications/tools/list_changed"),
      "a tools/list_changed notification",
    );

    const after = await harness.request("tools/list", {}, 21);
    const tools = after.result?.["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool["name"])).toEqual(beforeNames);
    // The headless marker is GONE, because a headless marker on an attached bridge would be
    // the same lie in the other direction.
    expect(String(tools.find((tool) => tool["name"] === "add_node")?.["description"])).not.toContain(
      "no Shaderloom tab is attached",
    );
  });

  it("falls back to headless, loudly, when the page disconnects", async () => {
    const harness = await bridgedServer();
    const page = await attachPage(harness);
    await until(() => page.row()?.state === "connected", "the page to attach");

    page.client.disconnect();
    await until(() => harness.server.bridgeStatus()?.attached === false, "the bridge to detach");
    expect(page.row()?.state).toBe("disconnected");

    const call = await harness.request(
      "tools/call",
      { name: "add_node", arguments: { type: "solid" } },
      30,
    );
    const content = (call.result?.["content"] as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content?.text ?? "{}") as { bridge: Record<string, unknown> };
    expect(payload.bridge["attached"]).toBe(false);
    // The page's own store is untouched: execution really did move back.
    expect(Object.keys(page.store.view.getGraph().nodes)).toHaveLength(0);
  });
});

describe("bridge refusals (T451, §V288)", () => {
  it("refuses a wrong pairing code by name and stays headless", async () => {
    const harness = await bridgedServer();
    const page = await attachPage(harness, { code: "AAAAAA" });
    await until(() => page.row()?.state === "error", "the bridge to refuse");
    expect(page.row()?.detail).toContain("pairing code does not match");
    expect(harness.server.bridgeStatus()?.attached).toBe(false);
    // Recovery is offered: the row still carries a connect, so the user can retype.
    expect(page.row()?.connect).not.toBeNull();
  });

  it("refuses a second page while one is attached", async () => {
    const harness = await bridgedServer();
    // Read the code BEFORE anything attaches: the status line then reports the attachment
    // rather than the code, which is the right thing for it to say.
    const code = pairingCodeOf(harness);
    const first = await attachPage(harness, { code });
    await until(() => first.row()?.state === "connected", "the first page to attach");

    const second = await attachPage(harness, { code });
    await until(() => second.row()?.state === "error", "the second page to be refused");
    expect(second.row()?.detail).toContain("already attached");
    // The first is undisturbed — a refusal must not cost the attachment it protected.
    expect(first.row()?.state).toBe("connected");
    expect(harness.server.bridgeStatus()?.attached).toBe(true);
  });

  it("refuses a page from an off-machine origin, over a real handshake", async () => {
    const harness = await bridgedServer();
    const said = await rawHandshake(harness.port, "https://evil.example");
    // The whole reason the Origin fence exists: a site the user merely VISITED can open a
    // WebSocket to loopback, and it cannot lie about this header.
    expect(said.type).toBe("refused");
    expect(String(said.reason)).toContain("served from localhost only");
    expect(harness.server.bridgeStatus()?.attached).toBe(false);
  });
});

/**
 * One raw RFC 6455 handshake with a chosen `Origin`, because no WebSocket client in Node
 * will send one.
 *
 * Reads exactly one server frame, which is unmasked by the RFC, so the decode is four lines.
 * This is the only place a test speaks the wire by hand, and it is here so the origin refusal
 * is proven on BYTES rather than on `isPermittedOrigin` — the predicate's own test above
 * proves the rule, not that the server applies it.
 */
async function rawHandshake(port: number, origin: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        Origin: origin,
      },
    });
    outgoing.on("error", reject);
    const readFrame = (frame: Buffer, socket: Socket): void => {
      const short = frame[1] ?? 0;
      const offset = short < 126 ? 2 : short === 126 ? 4 : 10;
      const length =
        short < 126 ? short : short === 126 ? frame.readUInt16BE(2) : Number(frame.readBigUInt64BE(2));
      socket.destroy();
      resolve(JSON.parse(frame.subarray(offset, offset + length).toString("utf8")) as Record<string, unknown>);
    };
    outgoing.on("upgrade", (_response, socket: Socket, head: Buffer) => {
      // The refusal usually rides the SAME segment as the 101, so node hands it over as
      // `head` and no `data` event ever fires. Both arrivals have to be read.
      if (head.length > 0) readFrame(head, socket);
      else socket.once("data", (frame: Buffer) => readFrame(frame, socket));
    });
    outgoing.end();
    setTimeout(() => reject(new Error("no refusal frame arrived")), 5_000);
  });
}
