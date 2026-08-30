import type { AgentToolSurface } from "../agent/surface.ts";
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

export interface McpConnectionOptions {
  readonly surface: AgentToolSurface;
  /** Where outgoing messages go — a stdio writer, a test array, a WebSocket later. */
  readonly send: (message: Record<string, unknown>) => void;
  readonly serverInfo?: { name: string; version: string };
}

export interface McpConnection {
  /** Feed one parsed incoming message. Malformed input gets a JSON-RPC error, never a throw. */
  receive(message: unknown): Promise<void>;
  /** Pushes `notifications/shaderloom/revision` — wire to the store's subscription. */
  notifyRevision(revision: number): void;
  /** Pushes `notifications/shaderloom/diagnostics` — wire to the diagnostics stream. */
  notifyDiagnostics(diagnostics: ReadonlyArray<Record<string, unknown>>): void;
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export function createMcpConnection(options: McpConnectionOptions): McpConnection {
  const { surface, send } = options;
  const serverInfo = options.serverInfo ?? { name: "shaderloom", version: "0.1.0" };

  const respond = (id: JsonRpcRequest["id"], result: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", id: id ?? null, result });
  };
  const respondError = (id: JsonRpcRequest["id"], code: number, message: string): void => {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  };

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
          case "initialize":
            respond(request.id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo,
            });
            return;
          case "notifications/initialized":
            return; // client ack; nothing to do
          case "ping":
            respond(request.id, {});
            return;
          case "tools/list":
            respond(request.id, toolList());
            return;
          case "tools/call": {
            const name = request.params?.["name"];
            if (typeof name !== "string") {
              respondError(request.id, -32602, "tools/call needs a tool name.");
              return;
            }
            const result = await surface.callTool(name, request.params?.["arguments"] ?? {});
            // The whole ToolResult travels as structured JSON text: refusals, conflicts
            // and diagnostics are DATA the calling model reads (§V66), so `isError` is
            // reserved for transport-level failure, not for a tool saying "no".
            respond(request.id, {
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false,
            });
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
