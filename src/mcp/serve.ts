import { createInterface } from "node:readline";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { compileGraph } from "../compiler/index.ts";
import type { ProjectSettings } from "../domain/types/graph.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createAgentPorts } from "../runtime/export/agent-ports.ts";
import { createMcpConnection } from "./server.ts";

/**
 * The out-of-process MCP server (T290, T294): a HEADLESS Shaderloom on stdio — store,
 * bus, full node catalogue, the agent tool surface, and, when Dawn is available, a
 * REAL GPU: the graph compiles on every revision, a frame renders, and
 * `render_preview` / `describe_output` / `read_points` return actual pixels and
 * numbers over the wire. Backend diagnostics stream on the existing notification
 * channel, so an observing client sees failures the moment they happen instead of
 * polling get_diagnostics.
 *
 * Without a GPU everything graph-shaped still works in full and the pixel tools
 * report unavailable-as-data — stated once, loudly, at startup.
 *
 * Frames are OFFLINE mode with a monotonically stepped index (§V44: the frame is the
 * clock; there is no rAF here and no wall time in any evaluation).
 */

/** Mirrors the app's new-project defaults until documents carry settings (T272). */
const HEADLESS_SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

export interface HeadlessMcpServer {
  receive(message: unknown): Promise<void>;
  /** Resolves when the GPU decision (attached or degraded) has been made. */
  readonly ready: Promise<void>;
  dispose(): void;
}

export function createHeadlessMcpServer(options: {
  send: (message: Record<string, unknown>) => void;
}): HeadlessMcpServer {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });

  let backend: ReturnType<typeof createVgpuBackend> | undefined;
  let compiled: ReturnType<typeof compileGraph> | null = null;
  let frameIndex = 0;
  let disposed = false;

  // MUTABLE on purpose: the surface reads `ports[name]` at list/call time, so
  // assigning the pixel ports once the GPU is up flips availability live — and
  // refreshTools() turns that flip into a tools/list_changed.
  const ports: Record<string, unknown> = {};
  const surface = createAgentToolSurface({
    bus,
    actor: { kind: "agent", id: "mcp", label: "MCP client" },
    projectId: "mcp-session",
    ports,
  });

  // §V38's authority holds — grants live in the bus store and no TOOL CALL can write
  // one. Out of process, the user's consent act is LAUNCHING this server: stdio has no
  // confirm dialog, and an MCP host mediates tool use with its own approval flow. So
  // export (pixels/readbacks leaving the process) is granted HERE, at startup, by the
  // same hand that started the process — never from the wire.
  bus.grants.grant({ kind: "agent", id: "mcp", label: "MCP client" }, "export");

  const connection = createMcpConnection({ surface, send: options.send });

  /** Compile the current document and render ONE offline frame (§V44). */
  const compileAndRender = async (): Promise<void> => {
    const live = backend;
    if (live === undefined || disposed) return;
    const capabilities = live.capabilities;
    if (capabilities === null || capabilities === undefined) return;
    const plan = compileGraph({
      graph: store.view.getGraph(),
      settings: HEADLESS_SETTINGS,
      registry,
      capabilities,
    });
    if (!plan.ok) {
      compiled = plan;
      return;
    }
    const built = await live.compile(plan);
    compiled = plan;
    live.render(built, {
      frame: {
        timeSeconds: frameIndex / 60,
        deltaSeconds: 1 / 60,
        frameIndex,
        mode: "offline",
        randomSeed: HEADLESS_SETTINGS.randomSeed,
      },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [HEADLESS_SETTINGS.outputResolution.width, HEADLESS_SETTINGS.outputResolution.height],
    });
    frameIndex += 1;
  };

  let pending: Promise<void> = Promise.resolve();
  const scheduleCompile = (): void => {
    // Serialized, never concurrent: compile N+1 waits for N. A failed compile reports
    // through the backend's own diagnostics; the chain must not break on it.
    pending = pending.then(compileAndRender).catch(() => undefined);
  };

  const ready = (async () => {
    const probe = await probeDawn();
    if (!probe.available) {
      connection.notifyDiagnostics([
        {
          severity: "info",
          code: "mcp/no-gpu",
          message: `No GPU attached (${probe.error ?? "Dawn unavailable"}); graph tools work in full, pixel tools report unavailable.`,
        },
      ]);
      return;
    }
    const live = createVgpuBackend({ host: nodeGpuHost() });
    live.onDiagnostic((diagnostic) => {
      // T294: the backend's verdicts ride the EXISTING notification channel.
      connection.notifyDiagnostics([diagnostic as unknown as Record<string, unknown>]);
    });
    await live.initialize({});
    if (disposed) {
      live.dispose();
      return;
    }
    backend = live;
    Object.assign(
      ports,
      createAgentPorts({
        backend: live,
        compiled: () => compiled,
        playing: () => false,
        graph: () => store.view.getGraph(),
        now: Date.now,
      }),
    );
    connection.refreshTools();
    scheduleCompile();
  })();

  store.view.subscribe((state) => {
    connection.notifyRevision(state.graph.revision);
    // T294: registrations do not tick the store, but a store tick is the cheapest
    // plausible moment to re-check; identical lists send nothing.
    connection.refreshTools();
    scheduleCompile();
  });

  return {
    async receive(message) {
      // Pixel reads must see the latest document rendered, not race the compile chain.
      await pending;
      await connection.receive(message);
    },
    ready,
    dispose() {
      disposed = true;
      backend?.dispose();
      backend = undefined;
    },
  };
}

export function serveStdio(): void {
  const server = createHeadlessMcpServer({
    send: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
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
    void server.receive(parsed);
  });
}

// Started directly (not imported): serve.
if (process.argv[1]?.endsWith("serve.ts") === true) {
  serveStdio();
}
