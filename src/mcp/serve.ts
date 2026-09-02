import { createInterface } from "node:readline";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { attachStateSources } from "../domain/commands/index.ts";
import { registerCompileCommand } from "../app/compile-command.ts";
import { registerResetFeedbackCommand } from "../app/runtime-commands.ts";
import { compileGraph } from "../compiler/index.ts";
import type { ProjectSettings } from "../domain/types/graph.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createAgentPorts } from "../runtime/export/agent-ports.ts";
import { createMcpConnection, type McpConnection } from "./server.ts";
import { createBridgeHost, type BridgeStatus } from "./bridge-host.ts";

/**
 * The out-of-process MCP server (T290, T294): a HEADLESS Loom on stdio — store,
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
 *
 * ## AND IT IS THE BRIDGE (T451)
 *
 * The headless twin was always the gap: an agent talking to this process builds a graph the
 * owner will never see. So this process ALSO listens on loopback, and a Loom tab can
 * attach to it from a button in the agent panel with a pairing code this server prints.
 * While a tab is attached, `tools/list` and `tools/call` are answered by THAT tab's surface,
 * against the live document behind the visible canvas.
 *
 * The owner's MCP client config does not change, which is the constraint the whole design
 * is built around: the same `node … serve.ts --grant-export` invocation, one new listener.
 *
 * ## TWO OF THESE PROCESSES CAN EXIST AT ONCE, AND THAT IS NOT A MISCONFIGURATION (T921)
 *
 * MEASURED: Claude Desktop spawns TWO of this process from ONE config entry, a second apart.
 * The port is a constant, so one binds and one does not — and the one Desktop actually talks
 * to was consistently the second, which is always the loser. It used to keep serving a full
 * catalogue from its own headless document, so the owner's canvas never moved and the
 * pairing code it printed named a listener that had never bound. Now the loser PROXIES the
 * winner, and a server that cannot bind keeps retrying until the port frees. `bridge_status`
 * makes all of it readable on demand. See `bridge-host.ts`.
 *
 * With nothing attached this serves headless exactly as before — that path works and the
 * tests depend on it — but says so in the `instructions`, in every tool description and in
 * every tool result, so "the agent built a graph I cannot see" is never silent (§V338).
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
  /**
   * What the loopback bridge is doing, or null when this server was built without one.
   *
   * §V338: the detection result is READABLE, not merely branched on. `serveStdio` prints it;
   * a test asserts on it; nothing has to infer the bridge's state from behaviour.
   */
  bridgeStatus(): BridgeStatus | null;
  dispose(): void;
}

export interface HeadlessMcpServerOptions {
  send: (message: Record<string, unknown>) => void;
  /** T334: pixels/readbacks leave the process only when the INVOCATION said so. */
  grantExport?: boolean;
  /**
   * Open the loopback bridge so a Loom tab can attach and take over execution (T451).
   *
   * Default OFF, and ON in `serveStdio` — which is the only caller that owns a process. A
   * server constructed inside a test suite must not bind a port: several of them run at once
   * and a listener nobody closed outlives the test that made it.
   */
  bridge?: {
    readonly port?: number;
    /**
     * Where the port handoff is published and read (T921). Defaults to `~/.loom`.
     *
     * Injectable for the same reason `port` is: a test must not write into the developer's
     * real home directory, and two servers racing for one port inside one test have to be
     * pointed at one temporary directory.
     */
    readonly handoffDir?: string;
    /** How often a server that lost the bind retries. Injectable so a test does not wait. */
    readonly proxyRetryMs?: number;
    /**
     * Where a HUMAN reads the bridge's news — the pairing code above all.
     *
     * Separate from the diagnostics notification on purpose: the notification reaches the
     * MCP client's model, this reaches the operator's terminal or log. The pairing code has
     * to arrive on a channel a person can see, or the gate it guards is unusable (§V233:
     * a check with no reachable grant path is a permanent denial in a costume).
     */
    readonly announce?: (message: string) => void;
  };
}

export function createHeadlessMcpServer(options: HeadlessMcpServerOptions): HeadlessMcpServer {
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

  /*
   * T597 (§V39): the headless twin registers the SAME commands and queries the page
   * registers, with headless-truthful sources — so an in-page agent and a desktop
   * client are told one story about one product. `selection.get` answers empty (no
   * editor is open, and empty IS the truth); `diagnostics.get` reports the last
   * compile; `runtime.metrics` counts the offline frames this server rendered.
   * `project.compile` and `runtime.resetFeedback` come from the same registration
   * modules the app uses, never a re-implementation. What is NOT registered is waived
   * BY NAME in the T597 parity gates: transport.play/pause (there is no frame loop —
   * this server renders one offline frame per change), project.save (the page's save
   * targets a browser project store this process does not have), and graph.setOutput
   * (a deliberate stub on every surface, see mutate.ts).
   */
  attachStateSources(bus, {
    selection: () => ({ nodeIds: [], edgeIds: [] }),
    diagnostics: () => ({
      diagnostics: compiled?.diagnostics ?? [],
      revision: store.view.getGraph().revision,
    }),
    metrics: () => ({
      timingAvailable: false,
      framesRendered: frameIndex,
      lastFrameIndex: frameIndex - 1,
      frameGpuMs: null,
      passCount: compiled?.passes.length ?? 0,
      nodeCount: compiled?.order.length ?? 0,
      prunedCount: compiled?.pruned.length ?? 0,
      estimatedResourceBytes: compiled?.estimatedResourceBytes ?? null,
      memoryBudgetBytes: HEADLESS_SETTINGS.limits.memoryBudgetBytes,
      overBudget: false,
    }),
  });
  const compileHolder = registerCompileCommand(bus);
  registerResetFeedbackCommand(bus, { backend: () => backend, compiled: () => compiled });

  // T334 (§V38): export — pixels and readbacks leaving the process — is granted only
  // when the INVOCATION carried --grant-export. Default-OFF fails loudly (the refusal
  // names the flag) where default-ON would fail silently; and with a webcam node in
  // the catalogue, "pixels leave the process" can mean a camera. The authority model
  // is intact either way: the grant lives in the bus store, nothing on the wire can
  // write one, and the MCP host's own approval flow gates tool USE, not our grants.
  if (options.grantExport === true) {
    bus.grants.grant({ kind: "agent", id: "mcp", label: "MCP client" }, "export");
  }

  /**
   * The bridge sits BETWEEN the connection and the surface (T451).
   *
   * Not a branch inside the connection and not a second connection: one module decides which
   * document a call lands on, and `tools/list` therefore describes whatever will actually
   * execute. Without a bridge the connection reads the headless surface directly, exactly as
   * before — `bridgeStatus()` returns null and nothing in the protocol changes.
   */
  // Declared before the bridge and assigned just after it, because the two genuinely refer
  // to each other: the connection reads the bridge's source, and the bridge pushes
  // list-changed and diagnostics back down the connection. Not `const`, because the
  // assignment cannot be at the declaration. The bridge's callbacks fire only from a socket
  // event or a `listen` callback — both later ticks — so nothing reads this before it is set.
  // eslint-disable-next-line prefer-const
  let connection: McpConnection;
  const bridge =
    options.bridge === undefined
      ? null
      : createBridgeHost({
          headless: surface,
          ...(options.bridge.port === undefined ? {} : { port: options.bridge.port }),
          ...(options.bridge.handoffDir === undefined ? {} : { handoffDir: options.bridge.handoffDir }),
          ...(options.bridge.proxyRetryMs === undefined ? {} : { proxyRetryMs: options.bridge.proxyRetryMs }),
          onToolsChanged: () => {
            connection.refreshTools();
          },
          onNotice: (report) => {
            // Two audiences, both told. T294: the bridge's verdicts ride the EXISTING
            // notification channel to the MCP client; `announce` carries the same sentence
            // to the human whose terminal or log holds the pairing code.
            connection.notifyDiagnostics([
              { severity: report.severity, code: "mcp/bridge", message: report.message },
            ]);
            options.bridge?.announce?.(report.message);
          },
        });

  connection = createMcpConnection({
    surface: bridge?.source ?? surface,
    send: options.send,
    ...(bridge === null ? {} : { instructions: () => bridge.instructions() }),
  });

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
    if (options.grantExport !== true) {
      connection.notifyDiagnostics([
        {
          severity: "info",
          code: "mcp/export-ungranted",
          message:
            "Pixel tools (render_preview, describe_output, read_points) are present but ungranted; start the server with --grant-export to enable them (T334).",
        },
      ]);
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
    // T597: project.compile becomes live once a device report exists (§V12 — no
    // capabilities, no compile; before this point the command is registered and
    // rejects with its own reason, exactly as the page does before its first compile).
    compileHolder.current = {
      compileNow: () => {
        const capabilities = live.capabilities;
        if (capabilities === null || capabilities === undefined) {
          return { compiled: null, diagnostics: [] };
        }
        const plan = compileGraph({
          graph: store.view.getGraph(),
          settings: HEADLESS_SETTINGS,
          registry,
          capabilities,
        });
        compiled = plan;
        return { compiled: plan, diagnostics: [...plan.diagnostics] };
      },
    };
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
    bridgeStatus: () => bridge?.status() ?? null,
    dispose() {
      disposed = true;
      bridge?.dispose();
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
    grantExport: process.argv.includes("--grant-export"),
    // The listener is ON here and nowhere else: this is the one caller that owns a process
    // (T451). stdout is the JSON-RPC channel, so everything a HUMAN reads goes to stderr.
    bridge: {
      announce: (message) => {
        process.stderr.write(`[loom bridge] ${message}\n`);
      },
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
