import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_HELPER_COMMAND } from "@devices/helper.ts";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { applyBridgeOperatorConsent, SNAPSHOT_MAX_SIZE } from "../agent/capabilities.ts";
import { createBridgeClient } from "./bridge-client.ts";
import { createMcpTransportRegistry } from "./connections.ts";
import { createHeadlessMcpServer } from "./serve.ts";
import { tagsOf } from "../examples/capabilities.ts";
import {
  isPermittedOrigin,
  mintPairingCode,
  normalisePairingCode,
  pairingCodeMatches,
} from "@devices/transport/bridge-wire.ts";

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

/**
 * T1129 — WAIT ON THE HALF YOU ARE ABOUT TO ASSERT. The server's view is not the page's.
 *
 * `bridgeStatus().attached` flips when the SERVER accepts the pairing and puts the
 * `attached` frame on the wire. The page's `memory.write` happens when the CLIENT reads
 * that frame — a socket round trip later — and `publish("connected")` happens immediately
 * after it (`bridge-client.ts`, the `attached` case: write, then publish). So a test that
 * waits on the server's flag and then asserts the page's remembered code is asserting
 * across a gap that nothing closes, and on a loaded machine the read lands inside it.
 *
 * Measured, not guessed. Eight concurrent runs of this file on a 14-core box failed twice
 * on the old wait, and twenty-four failed three times (`storage.current()` reading `null`
 * at the line after a server-side wait) — while every run finished in ~5.2s, nowhere near
 * the 5s poll budget. It was never a timeout, so a bigger budget would have hidden this
 * rather than fixed it. Twenty-four concurrent runs on this wait: 24 green.
 *
 * The client's own `connected` row is the event that happens-AFTER the write, so a test
 * gated on it cannot read the memory early. It is also a different observable from the
 * one being asserted, so the assertion stays real.
 */
async function untilPageAttached(
  registry: { snapshot(): ReadonlyArray<{ kind: string; state: string }> },
  what: string,
): Promise<void> {
  await until(
    () => registry.snapshot().find((transport) => transport.kind === "bridge")?.state === "connected",
    what,
  );
}

const PAGE_ACTOR = { kind: "agent", id: "page", label: "Page" } as const;

/** A real Loom document with a real bus and the real catalogue — the "page". */
function pageHarness(
  extras: {
    ports?: Parameters<typeof createAgentToolSurface>[0]["ports"];
    /**
     * T1220: hold NOTHING up front and let the attach decide, the way the product does.
     * The default keeps every test written before T1220 asserting what it asserted.
     */
    readonly grantsFromAttach?: boolean;
  } = {},
) {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const surface = createAgentToolSurface({
    bus,
    actor: PAGE_ACTOR,
    projectId: "page-project",
    ...(extras.ports === undefined ? {} : { ports: extras.ports }),
  });
  // The tab grants what the tab grants: pixels leaving the page are the page's decision,
  // the way serve.ts's --grant-export is the operator's (§V38). A tab exercising T1220's
  // SPLIT starts cold instead, and takes whatever the attach hands it — which for the
  // snapshot class is the product's own path and for `export` is nothing, ever.
  if (extras.grantsFromAttach !== true) bus.grants.grant(PAGE_ACTOR, "export");
  return { store, surface, bus };
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

/**
 * A temp directory for the port handoff (T921), never the developer's real `~/.loom`.
 *
 * A test that wrote there would leave a file naming a live PID on the machine of whoever
 * ran the suite, and two tests running in parallel would fight over it.
 */
function handoffDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "loom-bridge-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

interface BridgedServerOptions {
  /** Bind THIS port instead of asking the OS — how a second server loses the race. */
  readonly port?: number;
  readonly handoffDir?: string;
  readonly proxyRetryMs?: number;
  /** A server that is expected to LOSE does not wait for a bound port. */
  readonly expectBound?: boolean;
  /**
   * T1220: whether THIS helper's invocation carried `--grant-export`, which is the
   * out-of-band human consent the attach then reports to whichever tab pairs with it.
   */
  readonly grantExport?: boolean;
}

async function bridgedServer(options: BridgedServerOptions = {}): Promise<Harness> {
  const sent: Array<Record<string, unknown>> = [];
  const server = createHeadlessMcpServer({
    send: (message) => sent.push(message),
    ...(options.grantExport === undefined ? {} : { grantExport: options.grantExport }),
    bridge: {
      // Port 0: the OS picks, so parallel suites never collide on the shared constant.
      port: options.port ?? 0,
      handoffDir: options.handoffDir ?? handoffDirectory(),
      ...(options.proxyRetryMs === undefined ? {} : { proxyRetryMs: options.proxyRetryMs }),
    },
  });
  cleanups.push(() => {
    server.dispose();
  });
  if (options.expectBound === false) {
    return {
      server,
      sent,
      port: options.port ?? 0,
      async request(method, params, id) {
        await server.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        return sent.findLast((message) => message["id"] === id) as { result?: Record<string, unknown> };
      },
    };
  }
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
async function attachPage(
  harness: Harness,
  options: {
    code?: string;
    ports?: Parameters<typeof createAgentToolSurface>[0]["ports"];
    /** T1220: build a cold tab and let the attach hand it whatever it hands it. */
    readonly grantsFromAttach?: boolean;
  } = {},
) {
  const page = pageHarness({
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ...(options.grantsFromAttach === undefined ? {} : { grantsFromAttach: options.grantsFromAttach }),
  });
  const registry = createMcpTransportRegistry();
  const client = createBridgeClient({
    surface: () => page.surface,
    registry,
    port: harness.port,
    client: "vitest-page",
    // The PRODUCT's own composition-root call (T1220): `use-mcp-transports.ts` passes this
    // exact function, so what the transport reports lands in the bus-owned grant store by
    // the one path the app uses. A test that granted directly here would be asserting a
    // fixture; this asserts the seam.
    onOperatorConsent: (consent) => {
      applyBridgeOperatorConsent(page.bus.grants, PAGE_ACTOR, consent);
    },
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
    // Absent: not a browser. Documented in bridge-wire.ts, and the reason it is safe.
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
    expect(addNode?.["description"]).toContain("no Loom tab is attached");

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
      "no Loom tab is attached",
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

/**
 * V432 — ATTACHING GIVES THE UNION, and it is gated rather than promised.
 *
 * The other half of B93: the in-page transport was captured-wrong (B93/V431), but the
 * stdio server's missing tools are HONEST absence — compile_project, play and
 * get_diagnostics need app-side sources a headless process does not have. The designed
 * answer is T451's bridge: while a tab is attached, stdio's tools/list AND tools/call are
 * the TAB's, so an agent on the pipe gets everything the page can do — including seeing
 * what it drew. Nothing proved that end to end before this test; "attach gives the full
 * set" was the promise the owner was relying on.
 */
/**
 * T533 — the door is named where the user is, not only in a terminal log. The owner
 * tried Claude Desktop and could not find the path; the idle row is the signpost now:
 * the COMMAND to run, and the §V338 honesty that until a tab attaches, a stdio agent
 * edits a HEADLESS copy this tab never shows.
 */
describe("the idle bridge row is a signpost (T533, §V338)", () => {
  it("names the command and says what an unattached agent is talking to", () => {
    const registry = createMcpTransportRegistry();
    const client = createBridgeClient({ surface: () => pageHarness().surface, registry, client: "t533" });
    cleanups.push(() => client.disconnect());
    const row = registry.snapshot().find((transport) => transport.kind === "bridge");
    expect(row?.state).toBe("disconnected");
    expect(row?.detail).toContain(DEVICE_HELPER_COMMAND);
    expect(row?.detail).toContain("headless copy");
    expect(row?.detail).toContain("pairing code");
  });
});

describe("bridge union (V432, T451)", () => {
  it("a page-only port answers a stdio call: render_preview runs the TAB's exporter", async () => {
    // T1220: `render_preview` is gated on `previewSnapshot`, which a tab holds only while
    // attached to a helper whose operator typed the flag — so the union this test is about
    // now runs over the real consent path as well as the real socket.
    const harness = await bridgedServer({ grantExport: true });
    // The page brings what only a tab has: a preview read source. Width 7 is the marker
    // that THIS exporter answered, not any other surface's.
    const page = await attachPage(harness, {
      ports: {
        preview: {
          renderPreview: async () => ({
            ref: { nodeId: "n", portId: "out" },
            width: 7,
            height: 7,
            bytes: new Uint8Array([1, 2, 3]),
          }),
        },
      } as never,
    });
    await until(() => page.row()?.state === "connected", "the page to attach");

    // The node exists in the PAGE's document only — the headless twin knows nothing of it.
    const seeded = await harness.request(
      "tools/call",
      { name: "add_node", arguments: { type: "solid" } },
      30,
    );
    const seededPayload = JSON.parse(
      ((seeded.result?.["content"] as Array<{ text: string }>)[0]?.text ?? "{}"),
    ) as { status: string };
    expect(seededPayload.status).toBe("ok");
    // The created id, read from the PAGE's store — the proof of address doubles as the input.
    const nodeId = Object.keys(page.store.view.getGraph().nodes)[0] ?? "";
    expect(nodeId).not.toBe("");

    // tools/list over stdio describes render_preview as AVAILABLE — the tab's roster,
    // not the headless twin's honest refusal.
    const listed = await harness.request("tools/list", {}, 31);
    const preview = (listed.result?.["tools"] as Array<Record<string, unknown>>).find(
      (tool) => tool["name"] === "render_preview",
    );
    expect(String(preview?.["description"])).not.toContain("currently unavailable");

    // And the call is the union made real: a stdio request, the page's document, the
    // page's exporter — the agent on the pipe SEES what the tab drew.
    const call = await harness.request(
      "tools/call",
      { name: "render_preview", arguments: { nodeId } },
      32,
    );
    const payload = JSON.parse(
      ((call.result?.["content"] as Array<{ type: string; text: string }>).find((entry) => entry.type === "text")?.text ?? "{}"),
    ) as { status: string; data?: { width?: number }; bridge?: Record<string, unknown> };
    expect(payload.status).toBe("ok");
    expect(payload.data?.width).toBe(7);
    expect(payload.bridge?.["attached"]).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * T1220 — AN ATTACHED TAB CAN BE SEEN, AND STILL CANNOT BE READ OUT
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED, and the diagnosis is closed: the owner started the helper with
 * `--grant-export` exactly as the README says, attached his tab, and `read_points` came
 * back `capability.unobtainable` with `bridge.attached: true`. The flag grants `export` in
 * the SERVER's own bus store, for the server's own headless document; the attached tab is
 * a different bus, and nothing on the wire may write a grant (§V38). So the one mode he
 * actually wanted — an agent driving the document he is looking at — was the one mode
 * where the pixel tools could not work.
 *
 * His reframing is what these tests encode: *"in the end what we want is to be able to
 * pass out SNAPSHOTS of different canvases / node outputs."* That is not `export`. A tile
 * of a named output, at the size the tab already draws it, is a smaller act than
 * full-fidelity pixels of arbitrary content — so it is a smaller capability, composed from
 * two consents a PERSON gave outside the page (the flag on the invocation, the pairing code
 * typed into the tab) and never from anything the page or the wire decided for itself.
 *
 * Over a real socket and real JSON-RPC, because §V382 is exactly the trap here: a stubbed
 * transport would assert that the client calls the callback the test handed it, and would
 * stay green if the `attached` frame never carried the flag at all.
 *
 * The NEGATIVE is the assertion that matters most. The failure mode of splitting a
 * capability is that the split quietly becomes a widening, and no positive test can see
 * that happen.
 */
describe("preview snapshots from an attached tab (T1220, §V38, §V382)", () => {
  /**
   * The two ports only a TAB has. The exporter honours `maxSize`, so the tool's clamp is
   * what bounds the tile; the points port is present and REJECTS, so `read_points` is
   * refused by the capability gate rather than reported unavailable for want of a port —
   * availability is checked first, and a missing port would make the negative below pass
   * for the wrong reason.
   */
  const tabPorts = {
    preview: {
      renderPreview: async ({ ref, maxSize }: { ref: unknown; maxSize: number }) => ({
        ref,
        width: maxSize,
        height: maxSize,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    },
    points: {
      read: () => Promise.reject(new Error("read_points ran in the tab without export")),
    },
  } as never;

  it("hands a cold tab the snapshot capability — and nothing else — when the operator typed the flag", async () => {
    const harness = await bridgedServer({ grantExport: true });
    const page = await attachPage(harness, { grantsFromAttach: true, ports: tabPorts });
    await untilPageAttached(page.registry, "the page to attach");

    // The grant is in the BUS-OWNED store, which is the only authority §V38 recognises —
    // and it is the small class alone. `export` was never in the tab and is not now.
    expect(page.bus.grants.list(PAGE_ACTOR).map((grant) => grant.capability)).toEqual([
      "previewSnapshot",
    ]);
  });

  it("a stdio agent SEES the attached tab, bounded to the tile size, and still cannot read it out", async () => {
    const harness = await bridgedServer({ grantExport: true });
    const page = await attachPage(harness, { grantsFromAttach: true, ports: tabPorts });
    await untilPageAttached(page.registry, "the page to attach");

    // A node in the PAGE's document — the headless twin knows nothing of it.
    await harness.request("tools/call", { name: "add_node", arguments: { type: "solid" } }, 40);
    const nodeId = Object.keys(page.store.view.getGraph().nodes)[0] ?? "";
    expect(nodeId).not.toBe("");

    // THE POSITIVE: an agent on the stdio pipe asks for a full frame of the live document
    // and gets EYES — a tile, at the bound, of the thing the owner is looking at.
    const seen = await harness.request(
      "tools/call",
      { name: "render_preview", arguments: { nodeId, maxSize: 2048 } },
      41,
    );
    const snapshot = JSON.parse(
      (seen.result?.["content"] as Array<{ type: string; text: string }>).find(
        (entry) => entry.type === "text",
      )?.text ?? "{}",
    ) as {
      status: string;
      data?: { width?: number; base64?: string; snapshotBounded?: true };
      bridge?: Record<string, unknown>;
    };
    expect(snapshot.status).toBe("ok");
    expect(snapshot.bridge?.["attached"]).toBe(true);
    // The bound is enforced against the CAPABILITY, so the 2048 the caller asked for is not
    // the number that reached the tab's exporter.
    expect(snapshot.data?.width).toBe(SNAPSHOT_MAX_SIZE);
    expect(snapshot.data?.snapshotBounded).toBe(true);
    // The pixels reach the model as MCP image content — `toolResultContent` lifts the
    // base64 out of the JSON so a client that renders images shows the tile inline. This is
    // the byte-level form of "the agent can see the owner's document".
    const image = (seen.result?.["content"] as Array<{ type: string; data?: string }>).find(
      (entry) => entry.type === "image",
    );
    expect(image?.data).toBe("AQID");

    // THE NEGATIVE, and the whole reason to trust the positive: `export` did not move. The
    // same agent, the same attachment, the same second — and the full-fidelity readback is
    // still refused, by name.
    const readOut = await harness.request(
      "tools/call",
      { name: "read_points", arguments: { nodeId } },
      42,
    );
    const refusal = JSON.parse(
      (readOut.result?.["content"] as Array<{ type: string; text: string }>).find(
        (entry) => entry.type === "text",
      )?.text ?? "{}",
    ) as { status: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.status).toBe("denied");
    expect(refusal.diagnostics[0]?.message).toContain("export");
    // The refusal came from the TAB, not from the headless twin — which does hold `export`
    // on this server, and would have answered. Without this the negative could pass while
    // reading a document nobody can see (§V338).
    expect(
      (
        JSON.parse(
          (readOut.result?.["content"] as Array<{ type: string; text: string }>).find(
            (entry) => entry.type === "text",
          )?.text ?? "{}",
        ) as { bridge?: Record<string, unknown> }
      ).bridge?.["attached"],
    ).toBe(true);
    expect(page.bus.grants.has(PAGE_ACTOR, "export")).toBe(false);
  });

  it("hands a tab NOTHING when the operator did not type the flag — pairing alone grants no pixels", async () => {
    // Default: no `--grant-export` on this helper's invocation, which is the state the
    // owner's second consent cannot substitute for. Two consents, and one is missing.
    const harness = await bridgedServer();
    const page = await attachPage(harness, { grantsFromAttach: true, ports: tabPorts });
    await untilPageAttached(page.registry, "the page to attach");

    expect(page.bus.grants.list(PAGE_ACTOR)).toEqual([]);

    await harness.request("tools/call", { name: "add_node", arguments: { type: "solid" } }, 50);
    const nodeId = Object.keys(page.store.view.getGraph().nodes)[0] ?? "";
    const seen = await harness.request(
      "tools/call",
      { name: "render_preview", arguments: { nodeId } },
      51,
    );
    const payload = JSON.parse(
      (seen.result?.["content"] as Array<{ type: string; text: string }>).find(
        (entry) => entry.type === "text",
      )?.text ?? "{}",
    ) as { status: string };
    expect(payload.status).toBe("denied");
  });

  it("takes the capability back when the attachment ends", async () => {
    const harness = await bridgedServer({ grantExport: true });
    const page = await attachPage(harness, { grantsFromAttach: true, ports: tabPorts });
    await untilPageAttached(page.registry, "the page to attach");
    expect(page.bus.grants.has(PAGE_ACTOR, "previewSnapshot")).toBe(true);

    // The human presses Disconnect. A capability that outlived the consent that produced it
    // would be a page holding pixels rights with nothing on the other end of them.
    page.client.disconnect({ forget: true });

    expect(page.bus.grants.has(PAGE_ACTOR, "previewSnapshot")).toBe(false);
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

/**
 * T921 — TWO SERVERS, ONE PORT, AND NEITHER OF THEM A HEADLESS TWIN.
 *
 * ## The measurement these tests encode
 *
 * Claude Desktop spawns TWO `serve.ts` processes from ONE config entry — measured three
 * times (91036/91053, 97103/97114), one second apart, and Desktop consistently talked to the
 * SECOND spawn, which is always the one that lost the bind. So the failure was not a coin
 * flip, it was reproducible: the process the owner's client was actually using served a full
 * tool catalogue from a headless copy of the project, and the pairing code it printed named a
 * listener that had never bound. "I entered the code and nothing happened."
 *
 * Three claims, each with its own test, because they fail independently:
 *
 *  1. The loser PROXIES the winner, so both stdio pipes reach the same live tab.
 *  2. `bridge_status` reports the code and port that are true NOW — the loser reports the
 *     INCUMBENT's code, because its own names nothing.
 *  3. The loser NEVER answers from its own headless document while an incumbent exists, and
 *     it takes the port once the incumbent is gone rather than staying dead forever.
 *
 * Nothing here is stubbed: two real `createHeadlessMcpServer`s, one real listener, one real
 * loopback socket between them, and a real page attached to the winner (§V382).
 */

/** One `tools/call` over stdio, unwrapped to the surface's own result shape. */
async function callPayload(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<{
  status: string;
  data: Record<string, unknown> | null;
  diagnostics: Array<{ code?: string; message?: string }>;
  bridge?: Record<string, unknown>;
}> {
  const call = await harness.request("tools/call", { name, arguments: args }, id);
  const content = (call.result?.["content"] as Array<{ type: string; text: string }>).find(
    (entry) => entry.type === "text",
  );
  return JSON.parse(content?.text ?? "{}") as never;
}

/** A winner and a loser fighting over ONE port, with one handoff directory between them. */
async function racingServers(shared: { handoffDir?: string; proxyRetryMs?: number } = {}) {
  const handoffDir = shared.handoffDir ?? handoffDirectory();
  const incumbent = await bridgedServer({ handoffDir });
  const loser = await bridgedServer({
    port: incumbent.port,
    handoffDir,
    proxyRetryMs: shared.proxyRetryMs ?? 25,
    expectBound: false,
  });
  return { incumbent, loser, handoffDir };
}

describe("two servers, one port: the loser proxies the winner (T921, §V288)", () => {
  it("a tools/call on the LOSER's stdio edits the tab attached to the WINNER", async () => {
    const { incumbent, loser } = await racingServers();
    const page = await attachPage(incumbent);
    await until(() => page.row()?.state === "connected", "the page to attach to the incumbent");
    await until(
      () => loser.server.bridgeStatus()?.mode === "proxying",
      "the second server to lose the bind and enter proxy mode",
    );
    await until(
      () => (loser.server.bridgeStatus()?.pairingCode ?? null) !== null,
      "the proxy to reach the incumbent",
    );

    expect(Object.keys(page.store.view.getGraph().nodes)).toHaveLength(0);

    // THE CLAIM: the process that LOST the port drives the tab anyway. Before T921 this call
    // landed in a headless twin and the owner's canvas never moved.
    const viaLoser = await callPayload(loser, "add_node", { type: "solid" }, 900);
    expect(viaLoser.status).toBe("ok");
    expect(viaLoser.bridge?.["attached"]).toBe(true);
    expect(viaLoser.bridge?.["target"]).toBe("vitest-page");
    expect(Object.values(page.store.view.getGraph().nodes)).toHaveLength(1);

    // And the winner still drives the same tab, so BOTH of Desktop's processes are live —
    // which is why proxying beats refusing the second instance.
    const viaIncumbent = await callPayload(incumbent, "add_node", { type: "solid" }, 901);
    expect(viaIncumbent.status).toBe("ok");
    expect(viaIncumbent.bridge?.["attached"]).toBe(true);
    const nodes = Object.values(page.store.view.getGraph().nodes);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.type)).toEqual(["solid", "solid"]);
  });

  it("serves the WINNER's tool roster, and the one-page rule still refuses a second tab", async () => {
    const { incumbent, loser } = await racingServers();
    const code = pairingCodeOf(incumbent);
    /*
     * T1129 — THE PROXY IS SEATED BEFORE THE PAGE MOVES THE ROSTER, so the change this
     * test waits for is one particular change and not "some notification arrived".
     *
     * `pairingCode !== null` is set by `proxyAttached`, and the roster is a SECOND round
     * trip after it (`bridge-proxy.ts`: proxyAttached -> send listTools -> listToolsResult
     * -> onToolsChanged). Waiting on the code and then reading `tools/list` reads the
     * roster inside that gap — measured: 1 failure in 12 concurrent runs of this file, the
     * loser still publishing its REFUSED catalogue. And the other interleaving is worse
     * and quieter: proxy seated first, page attaches second, and the roster in hand is the
     * incumbent's HEADLESS one until the attach's `toolsChanged` moves it.
     *
     * So both moves are awaited in order, each on the notification the product itself
     * emits when the roster changes hands — an observable this test does not assert on.
     */
    const rosterMoves = (): number =>
      loser.sent.filter((message) => message["method"] === "notifications/tools/list_changed").length;
    await until(
      () =>
        loser.server.bridgeStatus()?.mode === "proxying" &&
        (loser.server.bridgeStatus()?.pairingCode ?? null) !== null,
      "the proxy to reach the incumbent",
    );
    await until(() => rosterMoves() >= 1, "the incumbent's roster to reach the proxy");
    const beforeAttach = rosterMoves();

    const first = await attachPage(incumbent, { code });
    await until(() => first.row()?.state === "connected", "the first page to attach");
    await until(() => rosterMoves() > beforeAttach, "the ATTACHED roster to reach the proxy");

    // The roster the loser publishes is the roster that will actually execute — the page's.
    const listed = await loser.request("tools/list", {}, 910);
    const tools = listed.result?.["tools"] as Array<Record<string, unknown>>;
    const addNode = tools.find((tool) => tool["name"] === "add_node");
    expect(String(addNode?.["description"])).not.toContain("headless");
    expect(String(addNode?.["description"])).not.toContain("REFUSED");
    // The transport's own tool is published exactly ONCE, by the process being talked to —
    // a proxied list that carried the incumbent's copy too would announce it twice.
    expect(tools.filter((tool) => tool["name"] === "bridge_status")).toHaveLength(1);

    // The widened rule is widened along ONE axis: a proxying SERVER is not a page, and the
    // one-tab-at-a-time rule for PAGES is untouched by it.
    const second = await attachPage(incumbent, { code });
    await until(() => second.row()?.state === "error", "the second page to be refused");
    expect(second.row()?.detail).toContain("already attached");
    expect(first.row()?.state).toBe("connected");
    // The proxy survived a page refusal it had nothing to do with.
    expect(loser.server.bridgeStatus()?.mode).toBe("proxying");
  });
});

describe("bridge_status reports the bridge as it is NOW (T921, §V288)", () => {
  it("returns the winner's real code, port and attach state", async () => {
    const harness = await bridgedServer();
    const code = pairingCodeOf(harness);

    const before = await callPayload(harness, "bridge_status", {}, 920);
    expect(before.status).toBe("ok");
    expect(before.data?.["mode"]).toBe("listening");
    expect(before.data?.["pairingCode"]).toBe(code);
    expect(before.data?.["port"]).toBe(harness.port);
    expect(before.data?.["host"]).toBe("127.0.0.1");
    expect(before.data?.["pid"]).toBe(process.pid);
    expect(before.data?.["attached"]).toBe(false);

    const page = await attachPage(harness, { code });
    await until(() => page.row()?.state === "connected", "the page to attach");

    // The point of the tool: the SAME call now reports a different, true, state. A client
    // paraphrasing its earlier notification could not have produced this.
    const after = await callPayload(harness, "bridge_status", {}, 921);
    expect(after.data?.["attached"]).toBe(true);
    expect(after.data?.["client"]).toBe("vitest-page");
    expect(after.data?.["pairingCode"]).toBe(code);
    expect(after.data?.["port"]).toBe(harness.port);
  });

  it("the LOSER reports the incumbent's code, not its own — the stale-code bug (T921)", async () => {
    const { incumbent, loser } = await racingServers();
    const code = pairingCodeOf(incumbent);
    await until(
      () =>
        loser.server.bridgeStatus()?.mode === "proxying" &&
        (loser.server.bridgeStatus()?.pairingCode ?? null) !== null,
      "the proxy to learn the incumbent's pairing code",
    );

    const status = await callPayload(loser, "bridge_status", {}, 930);
    expect(status.data?.["mode"]).toBe("proxying");
    expect(status.data?.["listening"]).toBe(false);
    // THE FIX FOR THE ACTUAL REPORT: the loser's own minted code names a listener that never
    // bound, so entering it can never work. It hands over the one that does.
    expect(status.data?.["pairingCode"]).toBe(code);
    expect(status.data?.["incumbent"]).toEqual({ port: incumbent.port, pid: process.pid });

    // And the same code reaches the model through `instructions`, so a client that never
    // calls the tool is still told something true.
    const init = await loser.request("initialize", {}, 931);
    const instructions = String(init.result?.["instructions"]);
    expect(instructions).toContain(code);
    expect(instructions).toContain("did NOT bind the bridge port");
  });
});

describe("the loser never answers from headless while an incumbent exists (T921, §V288/§V469)", () => {
  it("refuses by name, then TAKES the port once the incumbent is gone", async () => {
    // Separate handoff directories: the loser can see that the port is taken but cannot find
    // a Loom bridge to proxy. That is the worst case — and the one where answering from its
    // own twin would be most tempting and most wrong.
    const incumbent = await bridgedServer({ handoffDir: handoffDirectory() });
    const loser = await bridgedServer({
      port: incumbent.port,
      handoffDir: handoffDirectory(),
      proxyRetryMs: 25,
      expectBound: false,
    });
    await until(() => loser.server.bridgeStatus()?.mode === "proxying", "the loser to lose the bind");

    const refused = await callPayload(loser, "add_node", { type: "solid" }, 940);
    expect(refused.status).toBe("error");
    expect(refused.diagnostics[0]?.code).toBe("bridge/not-the-owner");
    // Actionable, not merely negative: the owner is told WHICH port and WHICH process.
    expect(String(refused.diagnostics[0]?.message)).toContain(`127.0.0.1:${incumbent.port}`);
    expect(String(refused.diagnostics[0]?.message)).toContain("headless");

    // tools/list says the same thing, so a client knows before it calls.
    const listed = await loser.request("tools/list", {}, 941);
    const addNode = (listed.result?.["tools"] as Array<Record<string, unknown>>).find(
      (tool) => tool["name"] === "add_node",
    );
    expect(String(addNode?.["description"])).toContain("does not own the bridge port");
    // bridge_status is the one thing that still answers, because it is the diagnosis.
    const status = await callPayload(loser, "bridge_status", {}, 942);
    expect(status.status).toBe("ok");
    expect(status.data?.["mode"]).toBe("proxying");

    // MEASURED SEPARATELY AND ALSO FIXED HERE: before T921 `onListenError` fired once and the
    // process served headless forever, so killing the winner left the port FREE and rescued
    // nobody. Now the loser takes it.
    incumbent.server.dispose();
    await until(
      () => loser.server.bridgeStatus()?.mode === "listening",
      "the loser to take the freed port",
      10_000,
    );
    expect(loser.server.bridgeStatus()?.port).toBe(incumbent.port);

    // THE EXACT-VALUE PROOF that the refusal was real: the loser's own document is EMPTY, so
    // the `add_node` it refused above never quietly landed in the twin.
    const graph = await callPayload(loser, "get_graph", {}, 943);
    expect(graph.status).toBe("ok");
    expect(graph.data?.["nodes"]).toEqual([]);
  });

  it("says a working get_node_definition is not evidence of an attachment (T921, §V469)", async () => {
    // The owner's own confusion: catalogue tools answer perfectly while unattached, so the
    // surface looks half-alive. A partial success hiding a total failure.
    const harness = await bridgedServer();
    const definition = await callPayload(
      harness,
      "get_node_definition",
      { type: "solid" },
      950,
    );
    expect(definition.status).toBe("ok");
    expect(String(definition.bridge?.["note"])).toContain("get_node_definition");
    expect(String(definition.bridge?.["note"])).toContain("NOT evidence");
    expect(definition.bridge?.["attached"]).toBe(false);
  });
});

/**
 * T925 — THE RELOAD THAT KILLED THE LINK.
 *
 * The owner: *"maybe we should try to reconnect to the last known mcp code on hot reload…
 * its super painful right now with any edit from an agent reloading the page and killing the
 * link and having me to repaste the code."* The agent's own edit triggers the HMR reload
 * that drops the attachment, so the tool stopped working because of the work it enabled.
 *
 * These run over the same real socket the rest of the file uses, with the STORAGE injected
 * rather than the transport — the thing under test is which codes get remembered and when,
 * and Node has no `sessionStorage` to remember them in.
 */

/** `sessionStorage` reduced to what the client uses, so a test can watch every write. */
function fakeMemory(seed: string | null = null) {
  let stored = seed;
  const writes: string[] = [];
  return {
    memory: {
      read: () => stored,
      write: (code: string) => {
        stored = code;
        writes.push(code);
      },
      forget: () => {
        stored = null;
      },
    },
    writes,
    current: () => stored,
  };
}

describe("the bridge survives a reload (T925)", () => {
  it("remembers a CONFIRMED code and re-attaches with nobody typing", async () => {
    const harness = await bridgedServer();
    const code = pairingCodeOf(harness);
    const storage = fakeMemory();

    const firstRegistry = createMcpTransportRegistry();
    const first = createBridgeClient({
      surface: () => pageHarness().surface,
      registry: firstRegistry,
      port: harness.port,
      client: "vitest-page",
      memory: storage.memory,
    });
    cleanups.push(() => first.disconnect());
    first.connect(code);
    await untilPageAttached(firstRegistry, "the first attach to reach the page");
    // Remembered only once the bridge CONFIRMED it — one write, the accepted code.
    expect(storage.writes).toEqual([code]);

    // The reload: the effect tears the client down without forgetting, and a new one is built.
    first.disconnect();
    await until(() => harness.server.bridgeStatus()?.attached === false, "the reload to detach");

    const page = pageHarness();
    const registry = createMcpTransportRegistry();
    const second = createBridgeClient({
      surface: () => page.surface,
      registry,
      port: harness.port,
      client: "vitest-reloaded",
      memory: storage.memory,
    });
    cleanups.push(() => second.disconnect());

    // THE CLAIM: nobody called connect. The tab re-attached itself from what it remembered.
    await until(() => harness.server.bridgeStatus()?.attached === true, "the silent re-attach");
    expect(harness.server.bridgeStatus()?.client).toBe("vitest-reloaded");

    // And it is genuinely attached, not merely connected: a stdio call lands on the new page.
    const call = await callPayload(harness, "add_node", { type: "solid" }, 960);
    expect(call.status).toBe("ok");
    expect(Object.values(page.store.view.getGraph().nodes)).toHaveLength(1);
  });

  it("never remembers a code the bridge refused", async () => {
    const harness = await bridgedServer();
    const storage = fakeMemory();
    const registry = createMcpTransportRegistry();
    const client = createBridgeClient({
      surface: () => pageHarness().surface,
      registry,
      port: harness.port,
      client: "vitest-page",
      memory: storage.memory,
    });
    cleanups.push(() => client.disconnect());
    client.connect("AAAAAA");
    await until(
      () => registry.snapshot().find((row) => row.kind === "bridge")?.state === "error",
      "the bridge to refuse",
    );
    expect(storage.writes).toEqual([]);
    expect(storage.current()).toBeNull();
  });

  it("forgets a stale remembered code, says why, and does NOT retry", async () => {
    const harness = await bridgedServer();
    // The expected case, not an exceptional one: the server respawned and minted a new code.
    const storage = fakeMemory("AAAAAA");
    const registry = createMcpTransportRegistry();
    const client = createBridgeClient({
      surface: () => pageHarness().surface,
      registry,
      port: harness.port,
      client: "vitest-page",
      memory: storage.memory,
    });
    cleanups.push(() => client.disconnect());

    const row = () => registry.snapshot().find((transport) => transport.kind === "bridge");
    await until(() => row()?.state === "error", "the remembered code to be refused");
    expect(storage.current()).toBeNull();
    // The sentence names the real cause — a per-process code — and the way to read the new
    // one, which is the tool T921 added. Not "the bridge refused", which reads as user error.
    expect(row()?.detail).toContain("no longer valid");
    expect(row()?.detail).toContain("bridge_status");
    // The field comes back so the human can recover.
    expect(row()?.connect).not.toBeNull();
    // NO RETRY LOOP: a stale code can never be accepted, and hammering the bridge with it
    // would burn its one-socket-at-a-time slot forever.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(row()?.state).toBe("error");
    expect(storage.current()).toBeNull();
    expect(harness.server.bridgeStatus()?.attached).toBe(false);
  });

  it("a human's Disconnect forgets; a component teardown does not", async () => {
    const harness = await bridgedServer();
    const code = pairingCodeOf(harness);

    const kept = fakeMemory();
    const keptRegistry = createMcpTransportRegistry();
    const teardown = createBridgeClient({
      surface: () => pageHarness().surface,
      registry: keptRegistry,
      port: harness.port,
      client: "vitest-page",
      memory: kept.memory,
    });
    cleanups.push(() => teardown.disconnect());
    teardown.connect(code);
    await untilPageAttached(keptRegistry, "the attach to reach the page");
    teardown.disconnect();
    // The reload path. Forgetting here would defeat the whole feature.
    expect(kept.current()).toBe(code);
    await until(() => harness.server.bridgeStatus()?.attached === false, "the teardown to detach");

    const dropped = fakeMemory();
    const registry = createMcpTransportRegistry();
    const revoked = createBridgeClient({
      surface: () => pageHarness().surface,
      registry,
      port: harness.port,
      client: "vitest-page",
      memory: dropped.memory,
    });
    cleanups.push(() => revoked.disconnect());
    revoked.connect(code);
    await untilPageAttached(registry, "the second attach to reach the page");
    expect(dropped.current()).toBe(code);

    // The panel's own affordance — the button a human presses — is explicit revocation.
    registry.snapshot().find((transport) => transport.kind === "bridge")?.disconnect?.();
    expect(dropped.current()).toBeNull();
  });

  it("never publishes the pairing code into a row a human can read off the screen", async () => {
    const harness = await bridgedServer();
    const code = pairingCodeOf(harness);
    const storage = fakeMemory();
    const details: string[] = [];
    const inner = createMcpTransportRegistry();
    const registry = {
      ...inner,
      snapshot: () => inner.snapshot(),
      subscribe: (listener: () => void) => inner.subscribe(listener),
      noteInvocation: (kind: Parameters<typeof inner.noteInvocation>[0], tool: string) =>
        inner.noteInvocation(kind, tool),
      publish: (status: Parameters<typeof inner.publish>[0]) => {
        details.push(status.detail);
        inner.publish(status);
      },
    };
    const client = createBridgeClient({
      surface: () => pageHarness().surface,
      registry,
      port: harness.port,
      client: "vitest-page",
      memory: storage.memory,
    });
    cleanups.push(() => client.disconnect());
    client.connect(code);
    await untilPageAttached(inner, "the attach to reach the page");

    // The secret is remembered and transmitted, and appears in NOTHING that gets rendered,
    // screenshotted or pasted into a bug report.
    expect(storage.current()).toBe(code);
    expect(details.length).toBeGreaterThan(0);
    expect(details.filter((detail) => detail.includes(code))).toEqual([]);
  });
});

/**
 * T1207 — the two surfaces a pure-MCP client actually reads.
 *
 * An agent set a parameter to `bind` mode with a cross-node ref and got a refusal it
 * could not act on, because nothing in this surface had ever said what the five mode
 * names REACH. A client over stdio has no repo and no `AGENTS.md`; it has `instructions`
 * at initialize and the tool schemas at `tools/list`, and that is all. So both are
 * asserted the way the client receives them — off a real JSON-RPC round trip — rather
 * than by reading the constant back out of the module that defines it.
 */
describe("the parameter modes reach an MCP client (T1207)", () => {
  it("says what `bind` reaches, and what to use instead, in the initialize instructions", async () => {
    const harness = await bridgedServer();
    const init = await harness.request("initialize", {}, 1);
    const instructions = String(init.result?.["instructions"]);

    // The trap, named: bind is scope-local, and the cross-node route is an expression.
    expect(instructions).toContain("`bind` a parameter ALREADY IN SCOPE");
    expect(instructions).toContain("NOTHING on another node");
    expect(instructions).toContain("op('constant1').par.value");
    expect(instructions).toContain("op('lfo1').chan.value");
    // The mechanism that shipped and nobody found (T1204).
    expect(instructions).toContain("op('mask1').chan.lagFrames");
  });

  it("publishes the same mode list on the schema of the tool that sets parameters", async () => {
    const harness = await bridgedServer();
    const list = await harness.request("tools/list", {}, 1);
    const tools = list.result?.["tools"] as Array<Record<string, unknown>>;
    const schema = tools.find((tool) => tool["name"] === "set_parameters")?.["inputSchema"] as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const described = schema?.properties?.["parameters"]?.description ?? "";

    expect(described).toContain("`bind` a parameter ALREADY IN SCOPE");
    expect(described).toContain("op('constant1').par.value");
    // T1208: `driven` was writable through this very schema until the write boundary
    // started refusing it, so the one thing the description must not do is let it read as
    // a working choice.
    expect(described).toContain("`driven` is RETIRED and refused");
  });
});

/**
 * T1211 — THE POINTER, AND THE ASSEMBLIES.
 *
 * The owner's report was that an agent repeatedly could not get a Mouse node to do anything,
 * and read that as "the mouse integration is not accessible to it". The cause, measured here
 * end to end rather than argued: a HEADLESS session has no cursor AND no value graph, so a
 * perfectly wired pointer drive produces nothing and the only thing that ever said so was an
 * `info` diagnostic nobody had a reason to fetch.
 *
 * Both halves are asserted the way a pure-MCP client receives them — `instructions` at
 * initialize and a real `tools/call` round trip — because that is the entire text such a
 * client ever gets. Reading the constants back out of the modules that define them would
 * prove the modules, not the reach.
 */
describe("a headless session says what it cannot supply (T1211, §V941)", () => {
  it("names the pointer as UNAVAILABLE in the instructions, rather than publishing a working zero", async () => {
    const harness = await bridgedServer();
    const instructions = String((await harness.request("initialize", {}, 1)).result?.["instructions"]);

    // The claim the owner asked for: the unavailable case is NAMED, before any attempt.
    expect(instructions).toContain("NO LIVE INPUT");
    expect(instructions).toContain("Mouse, LFO, Timer, Analyze, OSC and MIDI publish NOTHING");
    expect(instructions).toContain("parameter.channels.unavailable");
    // And that it is the PROCESS, not the graph — the misreading that cost the owner the day.
    expect(instructions).toContain("not of your graph");
    expect(instructions).toContain("attach a Loom tab");
  });

  it("names the failure on the parameter when a pointer drive is wired through the real tools", async () => {
    const harness = await bridgedServer();
    const call = async (name: string, args: Record<string, unknown>, id: number) => {
      const response = await harness.request("tools/call", { name, arguments: args }, id);
      const content = (response.result?.["content"] as Array<{ text: string }>)[0];
      return JSON.parse(content?.text ?? "{}") as { status: string; data: Record<string, unknown> };
    };

    // Wired the way the owner's agent wired it, through the shipped tools and nothing else.
    await call("add_node", { type: "mouse" }, 1);
    const blur = await call("add_node", { type: "blur" }, 2);
    const blurId = (blur.data["createdIds"] as Record<string, string>)["$node"];
    const set = await call(
      "set_parameters",
      {
        nodeId: blurId,
        parameters: {
          size: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('mouse1').chan.x * 40" } } },
        },
      },
      3,
    );
    expect(set.status).toBe("ok");

    const diagnostics = (await call("get_diagnostics", {}, 4)).data["diagnostics"] as Array<Record<string, string>>;
    const pointer = diagnostics.find((entry) => entry.code === "parameter.channels.unavailable");

    /*
     * THE ASSERTION IS THAT THE STATE IS NAMED, NOT THAT A VALUE IS ZERO. A zero is exactly
     * what a working pointer at the origin looks like, so "size resolved to 0" would pass
     * whether the pointer were dead or parked, and that ambiguity IS the bug. The diagnostic
     * names the parameter, the expression and the reason.
     */
    expect(pointer).toBeDefined();
    expect(pointer?.["nodeId"]).toBe(blurId);
    expect(pointer?.["message"]).toContain("no channel resolver");
    expect(pointer?.["suggestion"]).toContain("headless caller has none");
  });
});

/**
 * T1211 — THE ASSEMBLIES ARE REACHABLE, AND THEIR TAGS COME OUT OF THE FILES.
 *
 * Before this, the read surface could enumerate every node TYPE and reached no example and
 * no component: a parts bin and no assemblies. The listing is asserted over a real round
 * trip, and the tags are checked against the graph `get_example` returns for the SAME file —
 * so a row claiming `points` for a file whose graph carries no point system reddens here.
 * Neither test names an example or a count, so a 58th example does not have to be
 * remembered into a gate (§T675).
 */
describe("the shipped corpus is reachable over MCP (T1211, T1162)", () => {
  const callTool = async (harness: Harness, name: string, args: Record<string, unknown>, id: number) => {
    const response = await harness.request("tools/call", { name, arguments: args }, id);
    const content = (response.result?.["content"] as Array<{ text: string }>)[0];
    return JSON.parse(content?.text ?? "{}") as { status: string; data: Record<string, unknown> };
  };

  it("says the catalogue exists, in the one text a stdio client always reads", async () => {
    const harness = await bridgedServer();
    const instructions = String((await harness.request("initialize", {}, 1)).result?.["instructions"]);
    expect(instructions).toContain("`list_examples`");
    expect(instructions).toContain("`get_example`");
    expect(instructions).toContain("WORKED ANSWERS");
    // No count in the prose: a number here is a claim that goes stale against a directory.
    expect(instructions).not.toMatch(/\d+ shipped example/);
  });

  it("publishes both tools with their filters on tools/list", async () => {
    const harness = await bridgedServer();
    const tools = (await harness.request("tools/list", {}, 1)).result?.["tools"] as Array<Record<string, unknown>>;
    const listing = tools.find((tool) => tool["name"] === "list_examples");
    const schema = listing?.["inputSchema"] as { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["kind", "tag"]);
    expect(tools.some((tool) => tool["name"] === "get_example")).toBe(true);
    // The parts bin points at the assemblies, at the moment an agent is reading the parts.
    const catalogue = tools.find((tool) => tool["name"] === "list_node_definitions");
    expect(String(catalogue?.["description"])).toContain("list_examples");
  });

  it("lists examples AND components, each with the tag vocabulary that filters them", async () => {
    const harness = await bridgedServer();
    const listing = await callTool(harness, "list_examples", {}, 1);
    const entries = listing.data["entries"] as Array<Record<string, unknown>>;
    const tags = listing.data["tags"] as Array<Record<string, string>>;

    expect(listing.status).toBe("ok");
    expect(entries.some((entry) => entry["kind"] === "example")).toBe(true);
    expect(entries.some((entry) => entry["kind"] === "component")).toBe(true);
    // Every tag a row can carry is DEFINED in the same result: a filter vocabulary whose
    // meanings live somewhere else is a guessing game (§T1209's lesson, one surface over).
    const defined = new Set(tags.map((tag) => tag.tag));
    expect(defined.size).toBe(tags.length);
    for (const entry of entries) {
      expect(entry["tags"]).not.toEqual([]);
      for (const tag of entry["tags"] as string[]) expect(defined.has(tag)).toBe(true);
    }
    for (const tag of tags) expect(tag["meaning"]?.length).toBeGreaterThan(20);
  });

  it("filters by tag, and the filter is a real cut of the same corpus", async () => {
    const harness = await bridgedServer();
    const all = await callTool(harness, "list_examples", {}, 1);
    const total = (all.data["entries"] as unknown[]).length;
    const tag = (all.data["tags"] as Array<{ tag: string }>)[0]?.tag ?? "points";

    const filtered = await callTool(harness, "list_examples", { tag }, 2);
    const kept = filtered.data["entries"] as Array<{ tags: string[] }>;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(total);
    // What differs if the filter were cut: nothing would be removed, and the count would lie.
    expect(filtered.data["filteredOut"]).toBe(total - kept.length);
    for (const entry of kept) expect(entry.tags).toContain(tag);
  });

  it("opens each one as a graph whose nodes earn exactly the tags its row claimed", async () => {
    const harness = await bridgedServer();
    const entries = (await callTool(harness, "list_examples", {}, 1)).data["entries"] as Array<{
      fileName: string;
      tags: string[];
      nodeCount: number;
    }>;
    expect(entries.length).toBeGreaterThan(0);

    /*
     * THE WHOLE CORPUS, not a sample. A sampled version of this test passed with a bogus
     * `audio` tag injected into every row, because the one file it sampled happened to carry
     * audio already — which is exactly the hole a spot-check leaves.
     *
     * THE CLAIM THAT COSTS SOMETHING: each row's tags are what THAT graph earns. The listing
     * derives them from the shipped bytes; this re-derives them from the graph the OTHER tool
     * returned through the real parse path (migrations included), so a row still describing
     * the file an example USED TO BE fails here. Neither side names a file or a tag, so a 58th
     * example is covered the day it lands (§T675).
     */
    let id = 2;
    let edgeBearing = 0;
    for (const entry of entries) {
      const opened = await callTool(harness, "get_example", { fileName: entry.fileName }, (id += 1));
      const nodes = opened.data["nodes"] as Array<{ type: string }>;
      expect(opened.status).toBe("ok");
      expect(nodes).toHaveLength(entry.nodeCount);
      // Parameters are the bulk of a document and are omitted unless asked for.
      expect(nodes.every((node) => !("parameters" in node))).toBe(true);
      expect([...entry.tags].sort()).toEqual([...tagsOf(nodes.map((node) => node.type))].sort());
      if ((opened.data["edges"] as unknown[]).length > 0) edgeBearing += 1;
    }
    // Wiring is the question these files answer; a corpus of unconnected nodes would not.
    expect(edgeBearing).toBe(entries.length);
  });

  it("returns the authored parameter slots when asked, which is where a technique lives", async () => {
    const harness = await bridgedServer();
    const entries = (await callTool(harness, "list_examples", {}, 1)).data["entries"] as Array<{
      fileName: string;
      nodeCount: number;
    }>;
    const biggest = [...entries].sort((a, b) => b.nodeCount - a.nodeCount)[0];
    if (biggest === undefined) throw new Error("the catalogue listed nothing");
    const opened = await callTool(harness, "get_example", { fileName: biggest.fileName, includeParameters: true }, 2);
    const nodes = opened.data["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.every((node) => "parameters" in node)).toBe(true);
    // What differs if `includeParameters` were ignored: nothing here would carry a value.
    expect(nodes.some((node) => Object.keys(node["parameters"] as object).length > 0)).toBe(true);
  });

  it("refuses a name it does not ship, with the tool that would have told it", async () => {
    const harness = await bridgedServer();
    const missing = await callTool(harness, "get_example", { fileName: "E999-Nope.loom.json" }, 1);
    expect(missing.status).toBe("error");
  });
});
