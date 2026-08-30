import { createInterface } from "node:readline";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { createMcpConnection } from "./server.ts";

/**
 * The out-of-process MCP server (T290): `node --experimental-strip-types src/mcp/serve.ts`
 * (or the packaged equivalent) puts a HEADLESS Shaderloom on stdio — store, bus, full
 * node catalogue, the whole agent tool surface — so any MCP client builds, edits,
 * validates and compiles projects without a browser in sight. Newline-delimited
 * JSON-RPC, per the MCP stdio transport.
 *
 * Pixel-producing tools (render_preview, read_points) report unavailable-as-data here
 * — no GPU is attached in v1 — which the surface already does gracefully; everything
 * graph-shaped works in full. Revision notifications stream from the store the moment
 * any edit lands, so an observing client watches the document move.
 */
export function serveStdio(): void {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const surface = createAgentToolSurface({
    bus,
    actor: { kind: "agent", id: "mcp", label: "MCP client" },
    projectId: "mcp-session",
  });

  const connection = createMcpConnection({
    surface,
    send: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
  });

  store.view.subscribe((state) => {
    connection.notifyRevision(state.graph.revision);
  });

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    void connection.receive(parsed);
  });
}

// Started directly (not imported): serve.
if (process.argv[1]?.endsWith("serve.ts") === true) {
  serveStdio();
}
