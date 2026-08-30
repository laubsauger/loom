import { toolInputSchema } from "../agent/surface.ts";
import { zodToJsonSchema } from "./json-schema.ts";

/**
 * The MCP adapter (T290, §V39, §V192): transport + schema over the agent surface,
 * ZERO logic duplication — every request lands on `surface.listTools` / `callTool`
 * exactly as an in-tab agent's would, so an MCP client and the panel agent are the
 * same product seen through different pipes.
 *
 * Protocol: MCP's JSON-RPC 2.0 subset — `initialize`, `ping`, `tools/list`,
 * `tools/call` — hand-rolled rather than a dependency, because the message set is
 * seven shapes and an injectable `send` makes the whole thing testable without a
 * process or a socket. The stdio framing lives in `stdio.ts`; THIS module never
 * touches a stream (§V192's structural enforcement, applied to ourselves).
 *
 * The live half: `notifyRevision` / `notifyDiagnostics` push notifications the moment
 * the store publishes, so an observing client sees the graph move without polling —
 * the difference between "an API" and "watching an agent build in quasi-realtime".
 */

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/**
 * One tool as a connection announces it — everything except the zod schema.
 *
 * The schema is derived locally from `toolInputSchema`, never carried: a connection whose
 * tools come from ANOTHER PROCESS (the bridge, T451) runs the same catalogue, so shipping a
 * serialised schema would create a second copy that can disagree with the zod the call is
 * actually validated against (§V39).
 */
export interface McpToolListing {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly available: boolean;
  readonly missing: {
    readonly commands: readonly string[];
    readonly queries: readonly string[];
    readonly ports: readonly string[];
  };
}

/**
 * WHAT AN MCP CONNECTION ACTUALLY USES.
 *
 * Two methods, and `AgentToolSurface` satisfies it structurally, so the ordinary case is
 * unchanged. It is named because T451's bridge is a source too: it answers from the
 * ATTACHED PAGE's surface when a tab is attached and from the headless one otherwise, and
 * `tools/list` must therefore describe whichever will actually execute. Narrowing the
 * dependency is what lets that be a decision one module makes rather than a branch here.
 */
export interface McpToolSource {
  listTools(): readonly McpToolListing[];
  callTool(name: string, input?: unknown): Promise<unknown>;
}

export interface McpConnectionOptions {
  readonly surface: McpToolSource;
  /** Where outgoing messages go — a stdio writer, a test array, a WebSocket later. */
  readonly send: (message: Record<string, unknown>) => void;
  readonly serverInfo?: { name: string; version: string };
  /**
   * The `instructions` the MCP client hands its model at initialize, read at request time.
   *
   * A function, not a string: the bridge's advice depends on whether a tab is attached and
   * on a pairing code minted after this connection is built (§V338 — the detection result
   * is REPORTED, and this is the channel that reaches the model rather than a human).
   */
  readonly instructions?: () => string;
}

export interface McpConnection {
  /** Feed one parsed incoming message. Malformed input gets a JSON-RPC error, never a throw. */
  receive(message: unknown): Promise<void>;
  /** Pushes `notifications/shaderloom/revision` — wire to the store's subscription. */
  notifyRevision(revision: number): void;
  /** Pushes `notifications/shaderloom/diagnostics` — wire to the diagnostics stream. */
  notifyDiagnostics(diagnostics: ReadonlyArray<Record<string, unknown>>): void;
  /**
   * T294: diffs the surface's tool list against what this connection last announced
   * and pushes the standard `notifications/tools/list_changed` IF it moved — a grant
   * arriving, a port mounting, a tool family registering late. Safe to call on any
   * plausible trigger (a store tick, a mount effect): identical lists send nothing.
   */
  refreshTools(): void;
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** MCP image content for a tool result carrying a base64 PNG, else null. */
function imageContentOf(result: unknown): { type: "image"; data: string; mimeType: string } | null {
  const data = (result as { data?: { mimeType?: unknown; base64?: unknown } }).data;
  if (data?.mimeType !== "image/png" || typeof data.base64 !== "string") return null;
  return { type: "image", data: data.base64, mimeType: "image/png" };
}

function withoutBase64(result: unknown): unknown {
  const shaped = result as { data?: Record<string, unknown> };
  if (shaped.data === undefined) return result;
  const { base64: _lifted, ...rest } = shaped.data;
  return { ...shaped, data: rest };
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * One tool result as MCP content blocks (T291, T453).
 *
 * The whole ToolResult travels as structured JSON text: refusals, conflicts and
 * diagnostics are DATA the calling model reads (§V66), so nothing here is ever an error.
 * An image-shaped result ALSO travels as image content, so a client that renders images
 * shows the picture inline — the agent literally looks at the node — and the base64 is
 * lifted out of the JSON text so the pixels are never paid for twice.
 *
 * Exported because the bridge (T451) hands a result that was produced in ANOTHER PROCESS
 * to the same MCP client through this same pipe, and must not invent a second envelope
 * (§V39): the page returns the raw `ToolResult` and this is the one place it is wrapped.
 */
export function toolResultContent(result: unknown): McpContent[] {
  const image = imageContentOf(result);
  return image === null
    ? [{ type: "text", text: JSON.stringify(result) }]
    : [image, { type: "text", text: JSON.stringify(withoutBase64(result)) }];
}

export function createMcpConnection(options: McpConnectionOptions): McpConnection {
  const { surface, send } = options;
  const serverInfo = options.serverInfo ?? { name: "shaderloom", version: "0.1.0" };

  const respond = (id: JsonRpcRequest["id"], result: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", id: id ?? null, result });
  };
  const respondError = (id: JsonRpcRequest["id"], code: number, message: string): void => {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  };

  /** What list_changed diffing considers "the list": names + availability. */
  const toolSignature = (): string =>
    JSON.stringify(surface.listTools().map((tool) => [tool.name, tool.available]));
  let announcedTools = toolSignature();

  const toolList = (): Record<string, unknown> => ({
    tools: surface.listTools().map((tool) => {
      const schema = toolInputSchema(tool.name);
      return {
        name: tool.name,
        title: tool.title,
        description: tool.available
          ? tool.description
          : `${tool.description} (currently unavailable: missing ${[...tool.missing.commands, ...tool.missing.queries, ...tool.missing.ports].join(", ") || "capabilities"})`,
        inputSchema: schema === null ? { type: "object" } : zodToJsonSchema(schema),
      };
    }),
  });

  return {
    async receive(message) {
      if (typeof message !== "object" || message === null) return;
      const request = message as JsonRpcRequest;
      if (request.method === undefined) return; // a response to us; we send no requests

      try {
        switch (request.method) {
          case "initialize": {
            const instructions = options.instructions?.();
            respond(request.id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: true } },
              serverInfo,
              ...(instructions === undefined ? {} : { instructions }),
            });
            return;
          }
          case "notifications/initialized":
            return; // client ack; nothing to do
          case "ping":
            respond(request.id, {});
            return;
          case "tools/list":
            announcedTools = toolSignature();
            respond(request.id, toolList());
            return;
          case "tools/call": {
            const name = request.params?.["name"];
            if (typeof name !== "string") {
              respondError(request.id, -32602, "tools/call needs a tool name.");
              return;
            }
            const result = await surface.callTool(name, request.params?.["arguments"] ?? {});
            // `isError` is reserved for transport-level failure, not for a tool saying
            // "no" — see `toolResultContent` for the envelope and why (§V66, T291).
            respond(request.id, { content: toolResultContent(result), isError: false });
            return;
          }
          default:
            if (request.id !== undefined) {
              respondError(request.id, -32601, `Unknown method "${request.method}".`);
            }
            return;
        }
      } catch (error) {
        respondError(request.id, -32603, error instanceof Error ? error.message : String(error));
      }
    },

    refreshTools() {
      const current = toolSignature();
      if (current === announcedTools) return;
      announcedTools = current;
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    },

    notifyRevision(revision) {
      send({ jsonrpc: "2.0", method: "notifications/shaderloom/revision", params: { revision } });
    },
    notifyDiagnostics(diagnostics) {
      send({
        jsonrpc: "2.0",
        method: "notifications/shaderloom/diagnostics",
        params: { diagnostics },
      });
    },
  };
}
