import { describe, expect, it } from "vitest";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { createMcpConnection } from "./server.ts";
import { registerWebMcp } from "./webmcp.ts";
import { createMcpTransportRegistry } from "./connections.ts";
import { zodToJsonSchema } from "./json-schema.ts";
import { layoutGraphInput } from "../agent/schemas.ts";
import { registerTransportCommands } from "../app/transport-commands.ts";

/**
 * T290 (§V39, §V192): the adapters are transport + schema over the ONE agent surface —
 * an MCP client, a WebMCP host and the in-tab panel are the same product through
 * different pipes. These tests drive the real bus and the real catalogue through the
 * protocol shapes; nothing is mocked below the transport.
 */

function harness() {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const surface = createAgentToolSurface({
    bus,
    actor: { kind: "agent", id: "mcp-test", label: "MCP" },
    projectId: "p1",
  });
  const sent: Array<Record<string, unknown>> = [];
  const connection = createMcpConnection({ surface, send: (message) => sent.push(message) });
  store.view.subscribe((state) => connection.notifyRevision(state.graph.revision));
  const request = async (method: string, params?: Record<string, unknown>, id = 1) => {
    await connection.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return sent.findLast((m) => m["id"] === id) as { result?: Record<string, unknown>; error?: unknown };
  };
  return { store, surface, connection, sent, request, bus };
}

describe("MCP connection (T290)", () => {
  it("initializes, lists the real tool roster with JSON schemas, and calls through", async () => {
    const { request, sent, store } = harness();

    const init = await request("initialize", {});
    expect(init.result?.["protocolVersion"]).toBeDefined();

    const list = await request("tools/list", {}, 2);
    const tools = list.result?.["tools"] as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool["name"]);
    expect(names).toContain("add_node");
    expect(names).toContain("layout_graph");
    expect(names).toContain("render_preview");
    const layout = tools.find((tool) => tool["name"] === "layout_graph");
    const schema = layout?.["inputSchema"] as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(Object.keys(schema["properties"] as object)).toContain("nodeIds");

    // Build through the pipe: two nodes, wired, then laid out — the owner's demo shape.
    const add = await request(
      "tools/call",
      {
        name: "apply_graph_patch",
        arguments: {
          baseRevision: 0,
          operations: [
            { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
            { op: "addNode", ref: "$b", type: "output", position: { x: 0, y: 0 } },
            { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "input" } },
          ],
        },
      },
      3,
    );
    const payload = JSON.parse(
      (add.result?.["content"] as Array<{ text: string }>)[0]?.text ?? "{}",
    ) as { status: string; data: { createdIds: Record<string, string> } };
    expect(payload.status).toBe("ok");
    const aId = payload.data.createdIds["$a"];
    expect(aId).toBeDefined();

    const layoutCall = await request(
      "tools/call",
      { name: "layout_graph", arguments: { baseRevision: store.view.getRevision() } },
      4,
    );
    expect(layoutCall.error).toBeUndefined();
    const positions = store.view.getGraph().nodes[aId as string]?.position;
    expect(positions).toBeDefined();

    // The live half: every applied edit pushed a revision notification, unprompted.
    const revisions = sent
      .filter((m) => m["method"] === "notifications/shaderloom/revision")
      .map((m) => (m["params"] as { revision: number }).revision);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions.at(-1)).toBe(store.view.getRevision());
  });

  it("answers a tool refusal as DATA, and protocol misuse as a JSON-RPC error (§V66)", async () => {
    const { request } = harness();
    const bad = await request("tools/call", { name: "add_node", arguments: { type: "nope", baseRevision: 0 } }, 5);
    // The surface refused (unknown type) — but the TRANSPORT succeeded: data, not error.
    expect(bad.error).toBeUndefined();
    const payload = JSON.parse((bad.result?.["content"] as Array<{ text: string }>)[0]?.text ?? "{}") as {
      status: string;
    };
    expect(payload.status).not.toBe("ok");

    const missing = await request("tools/call", {}, 6);
    expect(missing.error).toBeDefined();
    const unknown = await request("no/such/method", {}, 7);
    expect(unknown.error).toBeDefined();
  });
});

describe("WebMCP registration (T290)", () => {
  it("publishes every tool to a provideContext host; absent host registers nothing", async () => {
    const { surface, store } = harness();
    const provided: Array<{ tools: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> }> = [];
    const host = { navigator: { modelContext: { provideContext: (ctx: never) => provided.push(ctx) } } };

    const registration = registerWebMcp(surface, { host });
    expect(registration.registered).toBe(true);
    expect(registration.toolCount).toBe(surface.listTools().length);

    // Execute through the WebMCP shape: same surface, same bus, real effect.
    const addNode = provided[0]?.tools.find((tool) => tool.name === "add_node");
    const result = (await addNode?.execute({ type: "solid", baseRevision: 0 })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]?.text ?? "{}").status).toBe("ok");
    expect(Object.keys(store.view.getGraph().nodes)).toHaveLength(1);

    expect(registerWebMcp(surface, { host: {} })).toEqual({ registered: false, toolCount: 0 });
  });
});

/**
 * §V338 / T397: the DETECTION RESULT is state somebody can read, not a boolean the
 * caller throws away. These assert the two sentences the app previously could not say —
 * "this browser has no WebMCP" and "twenty-eight tools are published right now" — and
 * that Disconnect is offered only where it actually revokes something.
 */
describe("WebMCP reports what it found (T397, §V338)", () => {
  const row = (registry: ReturnType<typeof createMcpTransportRegistry>) => {
    const found = registry.snapshot().find((status) => status.kind === "webmcp");
    if (found === undefined) throw new Error("the registry declared no webmcp row");
    return found;
  };

  it("publishes an `unavailable` row NAMING the missing capability when there is no host", () => {
    const { surface } = harness();
    const registry = createMcpTransportRegistry();
    registerWebMcp(surface, { host: {}, registry });

    expect(row(registry).state).toBe("unavailable");
    // §V288: the refusal names the problem. A bare "unavailable" is the state this
    // whole mechanism exists to stop being indistinguishable from a broken build.
    expect(row(registry).detail).toContain("navigator.modelContext");
    expect(row(registry).toolNames).toEqual([]);
    expect(row(registry).disconnect).toBeNull();
  });

  it("publishes the LIVE tool list, records an invocation, and revokes on disconnect", async () => {
    const { surface } = harness();
    const provided: Array<{ tools: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> }> = [];
    const host = { navigator: { modelContext: { provideContext: (ctx: never) => provided.push(ctx) } } };
    const registry = createMcpTransportRegistry({ now: () => 1234 });
    registerWebMcp(surface, { host, registry });

    expect(row(registry).state).toBe("connected");
    // The names the transport actually published, not a count it was told.
    expect(row(registry).toolNames).toEqual(surface.listTools().map((tool) => tool.name));
    expect(row(registry).lastInvocation).toBeNull();

    await provided[0]?.tools.find((tool) => tool.name === "add_node")?.execute({ type: "solid", baseRevision: 0 });
    expect(row(registry).lastInvocation).toEqual({ tool: "add_node", at: 1234 });

    // Disconnect genuinely withdraws the tools — the host is handed an empty set — and
    // the row says so. A button that left them published would be a lie about who can
    // still write to the document.
    row(registry).disconnect?.();
    expect(provided.at(-1)?.tools).toEqual([]);
    expect(row(registry).state).toBe("disconnected");
    expect(row(registry).toolNames).toEqual([]);
  });

  it("offers NO disconnect when the host only supports registerTool, and says why", () => {
    const { surface } = harness();
    const host = { navigator: { modelContext: { registerTool: () => undefined } } };
    const registry = createMcpTransportRegistry();
    registerWebMcp(surface, { host, registry });

    expect(row(registry).state).toBe("connected");
    expect(row(registry).disconnect).toBeNull();
  });
});

describe("zodToJsonSchema", () => {
  it("derives an honest object schema from a real tool input", () => {
    const schema = zodToJsonSchema(layoutGraphInput);
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["nodeIds"]).toMatchObject({ type: "array" });
    // Every field of this input is optional; an honest schema says so by omitting
    // `required` entirely rather than inventing one.
    expect(schema["required"]).toBeUndefined();
  });
});

describe("tools/list_changed (T294)", () => {
  it("notifies when availability moves, and only then", async () => {
    const { bus, connection, sent, request } = harness();
    const initialized = await request("initialize");
    expect(
      (initialized.result?.["capabilities"] as { tools?: { listChanged?: boolean } }).tools?.listChanged,
    ).toBe(true);
    await request("tools/list", undefined, 2);

    const changedCount = () =>
      sent.filter((message) => message["method"] === "notifications/tools/list_changed").length;

    // Nothing moved: any number of plausible triggers send nothing.
    connection.refreshTools();
    connection.refreshTools();
    expect(changedCount()).toBe(0);

    // A grant arrives late — the transport verbs register — and exactly one
    // notification goes out; re-checking after stays quiet.
    registerTransportCommands(bus);
    connection.refreshTools();
    connection.refreshTools();
    expect(changedCount()).toBe(1);
  });
});
