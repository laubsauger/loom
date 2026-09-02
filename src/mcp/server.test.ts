import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface, toolInputSchema } from "../agent/surface.ts";
import { createMcpConnection } from "./server.ts";
import { registerWebMcp } from "./webmcp.ts";
import { toolListings } from "./published-tools.ts";
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
      .filter((m) => m["method"] === "notifications/loom/revision")
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
    expect(row(registry).detail).toContain("document.modelContext");
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

/**
 * B93 — the SAME agent surface had DIFFERENT capabilities by TRANSPORT, which §V39
 * forbids. Cause, measured in a live tab: the in-page registration CAPTURED the surface
 * minted before the backend arrived (ports `{}`), and every re-registration after the
 * real one existed threw `InvalidStateError: Duplicate tool name` out of the host's
 * `registerTool` — so the model context kept the portless tools for the life of the
 * page, and the agent could draw but never see. These pin the cure and the invariant.
 */
describe("WebMCP answers from the CURRENT surface (B93)", () => {
  it("a call lands on the surface the provider returns NOW, not the one registration saw", async () => {
    const first = harness();
    const second = harness();
    let live = first.surface;
    const provided: Array<{ tools: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> }> = [];
    const host = { navigator: { modelContext: { provideContext: (ctx: never) => provided.push(ctx) } } };
    registerWebMcp(() => live, { host });

    // The swap is the app's reality: the backend arrives, the surface is re-minted.
    live = second.surface;
    const addNode = provided[0]?.tools.find((tool) => tool.name === "add_node");
    const result = (await addNode?.execute({ type: "solid", baseRevision: 0 })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]?.text ?? "{}").status).toBe("ok");
    // The node landed in the CURRENT store; the captured-at-registration one stays empty.
    expect(Object.keys(second.store.view.getGraph().nodes)).toHaveLength(1);
    expect(Object.keys(first.store.view.getGraph().nodes)).toHaveLength(0);
  });

  it("tolerates a registerTool host that throws Duplicate on re-registration", async () => {
    const { surface, store } = harness();
    const registered = new Map<string, { execute: (args: unknown) => Promise<unknown> }>();
    const host = {
      navigator: {
        modelContext: {
          registerTool: (tool: { name: string; execute: (args: unknown) => Promise<unknown> }) => {
            if (registered.has(tool.name)) throw new Error("InvalidStateError: Duplicate tool name");
            registered.set(tool.name, tool);
          },
        },
      },
    };
    registerWebMcp(() => surface, { host });
    // The re-run React StrictMode and a surface re-mint both produce. Before the fix this
    // threw out of the effect on the first tool and published nothing new either way.
    expect(() => registerWebMcp(() => surface, { host })).not.toThrow();
    expect(registered.size).toBe(surface.listTools().length);
    const result = (await registered.get("add_node")?.execute({ type: "solid", baseRevision: 0 })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]?.text ?? "{}").status).toBe("ok");
    expect(Object.keys(store.view.getGraph().nodes)).toHaveLength(1);
  });

  it("V39 made mechanical: both transports publish the SAME names from one surface", () => {
    const { surface } = harness();
    const provided: Array<{ tools: Array<{ name: string }> }> = [];
    const host = { navigator: { modelContext: { provideContext: (ctx: never) => provided.push(ctx) } } };
    registerWebMcp(() => surface, { host });
    const webmcpNames = provided[0]?.tools.map((tool) => tool.name);
    // The bridge's wire listing (what stdio's tools/list serves when this tab attaches)
    // and the in-page publication must be two spellings of surface.listTools() — a
    // capability that depends on which pipe you arrived down is a bug, not a design.
    expect(webmcpNames).toEqual(toolListings(surface).map((tool) => tool.name));
    expect(webmcpNames).toEqual(surface.listTools().map((tool) => tool.name));
  });
});

/**
 * B91 (T487) — the published schema and the validator agree about record KEYS, for
 * every tool. An agent reported parameter bindings as unusable and was right: the
 * conversion dropped key constraints, so the contract said "any key" while zod
 * demanded a mode enum — and for an agent the schema IS the documentation. The gate
 * walks every tool's REAL zod tree rather than pinning one field, so the next keyed
 * record is covered the day it is written.
 */
describe("record keys survive publication (B91, T487)", () => {
  type DefLike = {
    typeName?: string;
    keyType?: z.ZodType<unknown>;
    valueType?: z.ZodType<unknown>;
    innerType?: z.ZodType<unknown>;
    schema?: z.ZodType<unknown>;
    type?: z.ZodType<unknown>;
    options?: ReadonlyArray<z.ZodType<unknown>>;
    values?: ReadonlyArray<string>;
    shape?: () => Record<string, z.ZodType<unknown>>;
  };
  const defOf = (schema: z.ZodType<unknown>): DefLike =>
    (schema as unknown as { _def: DefLike })._def;

  const keyedRecords = (schema: z.ZodType<unknown>, out: z.ZodType<unknown>[] = []): z.ZodType<unknown>[] => {
    const def = defOf(schema);
    if (def.typeName === "ZodRecord" && def.keyType !== undefined && defOf(def.keyType).typeName === "ZodEnum") {
      out.push(schema);
    }
    for (const child of [def.innerType, def.schema, def.type, def.valueType, def.keyType]) {
      if (child !== undefined) keyedRecords(child, out);
    }
    for (const option of def.options ?? []) keyedRecords(option, out);
    for (const field of Object.values(def.shape?.() ?? {})) keyedRecords(field, out);
    return out;
  };

  it("every keyed record in every tool publishes its key enum as propertyNames", () => {
    const { surface } = harness();
    let checked = 0;
    for (const tool of surface.listTools()) {
      const schema = toolInputSchema(tool.name);
      if (schema === null) continue;
      for (const record of keyedRecords(schema)) {
        const keys = defOf(defOf(record).keyType as z.ZodType<unknown>).values ?? [];
        const emitted = zodToJsonSchema(record) as { propertyNames?: { enum?: string[] } };
        expect(emitted.propertyNames?.enum, `${tool.name}: a keyed record published without its keys`).toEqual([
          ...keys,
        ]);
        checked += 1;
      }
    }
    // The gate must have found the record the report was about — zero would mean the
    // walker went blind, not that the codebase went recordless.
    expect(checked).toBeGreaterThan(0);
  });

  it("set_parameters: what zod refuses is outside the published keys, what it accepts is inside", () => {
    const schema = toolInputSchema("set_parameters");
    if (schema === null) throw new Error("set_parameters has no schema");
    const slot = (bindings: Record<string, unknown>) => ({
      nodeId: "n1",
      parameters: { level: { mode: "map", bindings } },
    });
    const good = slot({ map: { kind: "map", attribute: "position", channel: "y" } });
    const bad = slot({ wat: { kind: "static", value: 1 } });
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse(bad).success).toBe(false);
    // And the published contract says the same thing the validator does.
    const record = keyedRecords(schema)[0];
    if (record === undefined) throw new Error("no keyed record inside set_parameters");
    const emitted = zodToJsonSchema(record) as { propertyNames?: { enum?: string[] } };
    expect(emitted.propertyNames?.enum).toContain("map");
    expect(emitted.propertyNames?.enum).not.toContain("wat");
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

/**
 * T597/§V39 — THE HEADLESS TWIN IS COMPLETE: every catalogue tool available, except
 * the ones waived BY NAME with a reason. The page gate lives in
 * `composition-wiring.test.tsx` with its own (smaller) waiver set; between them the
 * property §V39 promises — one tool surface, whichever transport an agent arrives by —
 * fails loudly instead of drifting one registration at a time. Measured before the
 * fix: NINE tools were dead headless (selection/diagnostics/metrics queries,
 * project.compile, runtime.resetFeedback among them) while every one worked in-page.
 */
describe("T597/§V39 — the headless server offers the full catalogue", () => {
  it("no tool is unavailable beyond the named waivers", async () => {
    const { createHeadlessMcpServer } = await import("./serve.ts");
    let captured: Record<string, unknown> | undefined;
    const server = createHeadlessMcpServer({
      send: (message) => {
        if (message["id"] === 1) captured = message;
      },
    });
    try {
      await server.ready.catch(() => {});
      await server.receive({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
      await server.receive({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const tools = (captured?.["result"] as { tools: Array<{ name: string; description: string }> })
        .tools;
      expect(tools.length).toBeGreaterThanOrEqual(29);

      /**
       * WAIVED BY NAME (the serve.ts registration comment states each reason):
       *  - set_output: a deliberate stub on EVERY surface — no graph.setOutput exists.
       *  - play/pause: this server has no frame loop; it renders one offline frame per
       *    change, so a transport verb would be a button that lies (§V123).
       *  - save_project: the page's save targets a browser project store this process
       *    does not have.
       */
      const waived = new Set(["set_output", "play", "pause", "save_project"]);
      const marker = "currently unavailable";
      const dead = tools
        .filter((tool) => tool.description.includes(marker) && !waived.has(tool.name))
        .map((tool) => `${tool.name}: ${tool.description.split(marker)[1] ?? ""}`);
      expect(
        dead,
        "a catalogue tool is dead on the headless server: register its command/query/source in serve.ts or waive it by name with the reason (§V39)",
      ).toEqual([]);
      // Waivers cannot rot: a waived tool that becomes available must be un-waived.
      for (const name of waived) {
        expect(
          tools.find((tool) => tool.name === name)?.description.includes(marker),
          `"${name}" is waived as unavailable but the server now offers it — delete the waiver`,
        ).toBe(true);
      }
    } finally {
      server.dispose();
    }
  }, 60_000);
});
