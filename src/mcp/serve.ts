import { userInfo } from "node:os";
import { createInterface } from "node:readline";

import { createGraphStore } from "../domain/graph/store.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createAgentToolSurface } from "../agent/surface.ts";
import { attachStateSources } from "../domain/commands/index.ts";
import { registerCompileCommand } from "../app/compile-command.ts";
import { registerResetFeedbackCommand } from "../app/runtime-commands.ts";
import { readProblemSources, type ProblemSource } from "../app/problem-sources.ts";
import { retainDiagnostic } from "../app/diagnostic-buffer.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import { compileGraph, timelineStructureRequest, type CompileRequest } from "../compiler/index.ts";
import { buildTimelineStructure } from "../domain/presets/timeline-cues.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import { frameFromClock } from "../domain/types/frame.ts";
import type { ProjectSettings } from "../domain/types/graph.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createAgentPorts } from "../runtime/export/agent-ports.ts";
import { createNodeLibraryCatalogue } from "../examples/catalogue.ts";
import { createMcpConnection, type McpConnection } from "./server.ts";
import { createBridgeHost, type BridgeStatus } from "./bridge-host.ts";
import { createDeviceDoors, type DeviceDoors } from "@devices/doors.ts";
import type { TerminalHost } from "@devices/terminal-host.ts";
import type { UdpSocketFactory } from "@devices/device-hub.ts";
import {
  HELPER_ALL_BANNER,
  HELPER_ALL_DEVICES_ONLY_REFUSAL,
  HELPER_ALL_FLAG,
  HELPER_DEVICES_ONLY_FLAG,
  HELPER_FORCE_FLAG,
  HELPER_PHONE_BANNER,
  HELPER_PHONE_FLAG,
  HELPER_TERMINAL_FLAG,
  bridgeForceRefused,
  bridgeHeldRemedy,
  bridgeTakenOver,
  pairingCodeBlock,
} from "@devices/helper.ts";
import { BRIDGE_PORT } from "@devices/transport/bridge-wire.ts";
import { defaultHandoffDir } from "./bridge-handoff.ts";
import { findBridgeHolder, takeOverBridge } from "./bridge-takeover.ts";

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
 *
 * ## TWO ENTRY POINTS LIVE HERE, AND ONE OF THEM IS NOT AN MCP SERVER (T1111)
 *
 * `serveStdio()` is the above. `serveDevices()` — `pnpm helper --devices-only` — is the
 * loopback DEVICE bridge and nothing else: no store, no bus, no catalogue, no tool surface,
 * no GPU and no JSON-RPC on stdin. It is here rather than under `src/devices/` because the
 * listener it needs is `bridge-host.ts` and §V901 runs mcp → devices, never the reverse;
 * `createDeviceHelper` below carries that trade in full.
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

/** The rate this server steps its offline frames at: frame n is n / 60 s (§T1544b reads the timeline at it). */
const HEADLESS_FPS = 60;

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
    /** T1773b — see `BridgeHostOptions.heldRemedy`. Given by `serveStdio` only. */
    readonly heldRemedy?: (port: number) => string;
    /**
     * Where a HUMAN reads the bridge's news — the pairing code above all.
     *
     * Separate from the diagnostics notification on purpose: the notification reaches the
     * MCP client's model, this reaches the operator's terminal or log. The pairing code has
     * to arrive on a channel a person can see, or the gate it guards is unusable (§V233:
     * a check with no reachable grant path is a permanent denial in a costume).
     */
    readonly announce?: (message: string) => void;
    /**
     * T950 — the laser door. Defaults to the REAL one (node TCP + UDP discovery + wall
     * clock for the dead-man); injectable so the emulator-backed test drives the whole
     * message path with no network and no timers of its own.
     */
    readonly laser?: import("@devices/laser-host.ts").LaserHost;
    /** T1029 — the vision door. Defaults to the REAL one (swiftc-compiled worker). */
    readonly vision?: import("@devices/vision-host.ts").VisionHost;
    /**
     * T1263 — the terminal door. OFF unless the invocation carried `--terminal`; the
     * flag→enabled mapping is the entry points' below and nowhere else. A gate passes
     * `{ enabled: true, spawn }` to prove the wiring without a real shell.
     */
    readonly terminal?: import("@devices/doors.ts").TerminalDoorOptions;
    /**
     * T1396b — the phone door. OFF unless the invocation carried `--phone`, mapped by the
     * entry points below like the terminal's flag. A gate passes `{ enabled: true, … }`
     * with a loopback address and a temp certificate directory.
     */
    readonly phone?: import("@devices/doors.ts").PhoneDoorEnableOptions;
    /**
     * How the DEVICE role opens UDP sockets (T942 tier 3). Injected ONLY by tests.
     *
     * A gate cannot make a phone send OSC, and binding a real UDP port inside a suite that
     * runs several servers at once is how a test starts depending on the machine. So the
     * ONE call to the operating system is a parameter, defaulting to the real thing — the
     * same shape `useMidiInput` gives `requestMIDIAccess` and `bridge-host` gives
     * `proxySocketFactory`. A fake socket then drives the whole path: subscribe, decode,
     * coalesce, push, encode, send, and every refusal, with only the OS replaced.
     */
    readonly udpSocketFactory?: UdpSocketFactory;
    /** How often coalesced OSC readings are pushed. Injectable so a gate flushes on demand. */
    readonly deviceFlushMs?: number;
    /** Host clock for device timestamps. Injectable so a gate asserts an exact `at`. */
    readonly deviceNow?: () => number;
  };
}

export function createHeadlessMcpServer(options: HeadlessMcpServerOptions): HeadlessMcpServer {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });

  let backend: ReturnType<typeof createVgpuBackend> | undefined;
  let compiled: ReturnType<typeof compileGraph> | null = null;
  /*
   * B244: the compile last ATTEMPTED, which is what `diagnostics.get` reports. `compiled` is
   * the plan the backend accepted and renders, which the pixel tools and metrics describe;
   * after a backend refusal the two differ, and the problems belong to the refused one.
   */
  let attempted: ReturnType<typeof compileGraph> | null = null;
  // T1555b: why there is no GPU, and what the backend has reported, held for `diagnostics.get`.
  let gpuProblems: readonly RuntimeDiagnostic[] = [];
  let backendProblems: readonly RuntimeDiagnostic[] = [];
  let frameIndex = 0;
  let disposed = false;
  /**
   * §T1544b — the compile request for the frame `at`: the document with the timeline's
   * structural overrides at that playhead applied (`timelineStructureRequest`), so a timed
   * cue that switches a Layer, a picture or a compile-time key renders switched here too.
   * This server steps one offline frame per change at `HEADLESS_FPS`.
   */
  const requestAt = (at: number, capabilities: BackendCapabilities): CompileRequest => {
    const graph = store.view.getGraph();
    const request: CompileRequest = { graph, settings: HEADLESS_SETTINGS, registry, capabilities };
    const structure = buildTimelineStructure({ document: graph, registry });
    return structure === null
      ? request
      : timelineStructureRequest(request, structure.at({ timeSeconds: at / HEADLESS_FPS, fps: HEADLESS_FPS, subframes: 1 }));
  };

  // MUTABLE on purpose: the surface reads `ports[name]` at list/call time, so
  // assigning the pixel ports once the GPU is up flips availability live — and
  // refreshTools() turns that flip into a tools/list_changed.
  const ports: Record<string, unknown> = {};
  /*
   * T1211: the shipped corpus, attached from the first call and never conditional on the
   * GPU — an agent talking to a Dawn-less helper still gets the 57 examples and 9 starter
   * components, which are the only two artefacts that show how nodes COMBINE. The browser
   * builds the same catalogue from its own glob; both derive their rows from §T1162's tag
   * table, so the two surfaces cannot describe one file differently.
   */
  ports["library"] = createNodeLibraryCatalogue();
  const surface = createAgentToolSurface({
    bus,
    actor: { kind: "agent", id: "mcp", label: "MCP client" },
    projectId: "mcp-session",
    ports,
    /**
     * T1097 (§V38): here the export grant IS reachable, and the refusal now says how.
     * Unlike a browser tab — which has no in-page grant path at all and says so — this
     * process holds the flag that issues it, so "not granted yet" is the truthful reading
     * and a client that restarts with the flag gets a different answer. `localFile` is
     * absent on purpose: nothing in this process can ever issue it, and `save_project`
     * reports unavailable here anyway (no `project.save` in a headless twin).
     */
    grantRoutes: {
      export: {
        obtainable: true,
        guidance:
          "Restart this MCP server with the `--grant-export` flag on its own invocation (T334); nothing on the wire can grant it.",
      },
      // T1220: the same flag issues both here, so the same sentence is the truthful route.
      // A reader who sees this on a tile refusal and `export` on a `read_points` refusal is
      // being told the accurate thing: one flag, two capabilities, and the smaller one is
      // also the only one a paired browser tab can ever hold.
      previewSnapshot: {
        obtainable: true,
        guidance:
          "Restart this MCP server with the `--grant-export` flag on its own invocation, which issues the tile-bounded snapshot capability alongside export (T334, T1220); nothing on the wire can grant it.",
      },
    },
  });

  /*
   * T597 (§V39): the headless twin registers the SAME commands and queries the page
   * registers, with headless-truthful sources — so an in-page agent and a desktop
   * client are told one story about one product. `selection.get` answers empty (no
   * editor is open, and empty IS the truth); `diagnostics.get` reads `problemSources`
   * below (T1555b); `runtime.metrics` counts the offline frames this server rendered.
   * `project.compile` and `runtime.resetFeedback` come from the same registration
   * modules the app uses, never a re-implementation. What is NOT registered is waived
   * BY NAME in the T597 parity gates: transport.play/pause (there is no frame loop —
   * this server renders one offline frame per change), project.save (the page's save
   * targets a browser project store this process does not have), graph.setOutput
   * (a deliberate stub on every surface, see mutate.ts), and component.import/export
   * (T1494b: this twin has no component catalogue at all).
   *
   * T1555b: `problemSources` is the Problems registry the page reads too
   * (`app/problem-sources.ts`), holding the sources this process actually has. Every other
   * app source is named, with the reason, in `HEADLESS_ABSENT_PROBLEM_SOURCES`, and
   * `problem-sources.test.ts` checks that the two agree.
   */
  const problemSources: readonly ProblemSource[] = [
    { id: "gpu", read: () => gpuProblems },
    { id: "compile", read: () => attempted?.diagnostics ?? [] },
    { id: "backend", read: () => backendProblems },
  ];
  attachStateSources(bus, {
    selection: () => ({ nodeIds: [], edgeIds: [] }),
    diagnostics: () => ({
      diagnostics: readProblemSources(problemSources),
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
      // T1295: this server has no GPU timer at all (`timingAvailable: false` above), so no
      // frame's timing can be lost. Zero is the honest count, not a stub.
      droppedTimingFrames: 0,
    }),
  });
  const compileHolder = registerCompileCommand(bus);
  registerResetFeedbackCommand(bus, {
    backend: () => backend,
    compiled: () => compiled,
    // This surface has no CPU ValueGraphSession; the backend owns all its temporal state.
    resetState: () => {
      if (backend === undefined) throw new Error("No GPU backend is attached.");
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
    },
  });

  // T334 (§V38): export — pixels and readbacks leaving the process — is granted only
  // when the INVOCATION carried --grant-export. Default-OFF fails loudly (the refusal
  // names the flag) where default-ON would fail silently; and with a webcam node in
  // the catalogue, "pixels leave the process" can mean a camera. The authority model
  // is intact either way: the grant lives in the bus store, nothing on the wire can
  // write one, and the MCP host's own approval flow gates tool USE, not our grants.
  //
  // T1220: the flag issues BOTH classes. `previewSnapshot` is the tile-bounded half that
  // `render_preview` and `describe_output` now need, and a person who typed a flag allowing
  // full-fidelity pixels has already allowed a 384px thumbnail — so withholding it would be
  // a wall in front of nothing. The implication runs one way only: `previewSnapshot` never
  // implies `export`, and this composition root is the only party that may decide either.
  if (options.grantExport === true) {
    const mcpActor = { kind: "agent", id: "mcp", label: "MCP client" } as const;
    bus.grants.grant(mcpActor, "export");
    bus.grants.grant(mcpActor, "previewSnapshot");
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
  /*
   * T942/T950/T1029 — the three doors a page cannot open for itself, built beside the bridge
   * rather than as second servers, and built by `@devices/doors.ts` so the devices-only
   * helper (T1111) and this one cannot end up with different sets of them.
   *
   * They bind, dial and spawn NOTHING on construction: a running MCP server is not a
   * listening OSC server, is not connected to a DAC and is not holding the camera until an
   * attached page says so. Same "nothing dials on load" consent the page attachment has.
   */
  const doors: DeviceDoors | null =
    options.bridge === undefined
      ? null
      : createDeviceDoors({
          ...(options.bridge.udpSocketFactory === undefined
            ? {}
            : { udpSocketFactory: options.bridge.udpSocketFactory }),
          ...(options.bridge.deviceFlushMs === undefined ? {} : { deviceFlushMs: options.bridge.deviceFlushMs }),
          ...(options.bridge.deviceNow === undefined ? {} : { deviceNow: options.bridge.deviceNow }),
          ...(options.bridge.laser === undefined ? {} : { laser: options.bridge.laser }),
          ...(options.bridge.vision === undefined ? {} : { vision: options.bridge.vision }),
          ...(options.bridge.terminal === undefined ? {} : { terminal: options.bridge.terminal }),
          ...(options.bridge.phone === undefined ? {} : { phone: options.bridge.phone }),
        });
  if (doors?.terminal) options.bridge?.announce?.(terminalDoorBanner(doors.terminal));
  if (doors?.phone) options.bridge?.announce?.(HELPER_PHONE_BANNER);
  const bridge =
    options.bridge === undefined
      ? null
      : createBridgeHost({
          headless: surface,
          // T1220: the operator's out-of-band consent, carried to whichever tab the
          // operator then pairs. The bridge only reports it; the page composes it.
          operatorGrantedSnapshots: options.grantExport === true,
          ...(doors === null
            ? {}
            : { devices: doors.devices, laser: doors.laser, vision: doors.vision, models: doors.models }),
          ...(doors?.terminal ? { terminal: doors.terminal } : {}),
          ...(doors?.phone ? { phone: doors.phone } : {}),
          ...(options.bridge.port === undefined ? {} : { port: options.bridge.port }),
          ...(options.bridge.handoffDir === undefined ? {} : { handoffDir: options.bridge.handoffDir }),
          ...(options.bridge.proxyRetryMs === undefined ? {} : { proxyRetryMs: options.bridge.proxyRetryMs }),
          ...(options.bridge.heldRemedy === undefined ? {} : { heldRemedy: options.bridge.heldRemedy }),
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
    // §T1544b: in the timeline's structure at the frame this renders.
    const plan = compileGraph(requestAt(frameIndex, capabilities));
    attempted = plan;
    if (!plan.ok) {
      compiled = plan;
      return;
    }
    const built = await live.compile(plan);
    compiled = plan;
    live.render(built, {
      // T1554b: the rate is stated, so `fps` reads HEADLESS_FPS rather than agreeing with
      // the default by coincidence. This frame index never wraps, so the absolute pair the
      // constructor fills from the timeline is the absolute clock; and the server mints no
      // epoch (no app attaches a frame clock here, so a morph commits as a cut, T1497b).
      frame: frameFromClock({
        timeSeconds: frameIndex / HEADLESS_FPS,
        deltaSeconds: 1 / HEADLESS_FPS,
        frameIndex,
        mode: "offline",
        randomSeed: HEADLESS_SETTINGS.randomSeed,
        fps: HEADLESS_FPS,
      }),
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
      gpuProblems = [
        {
          severity: "info",
          code: "mcp/no-gpu",
          message: `No GPU attached (${probe.error ?? "Dawn unavailable"}); graph tools work in full, pixel tools report unavailable.`,
        },
      ];
      connection.notifyDiagnostics(gpuProblems as unknown as Record<string, unknown>[]);
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
      // T1555b: and are held, one slot per condition (T596), so `diagnostics.get` has them too.
      backendProblems = retainDiagnostic(backendProblems, diagnostic);
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
        // §T1544b: in the timeline's structure at the frame last rendered — the plan the
        // backend holds — so the report and the pixels describe one structure.
        const plan = compileGraph(requestAt(Math.max(0, frameIndex - 1), capabilities));
        compiled = plan;
        attempted = plan;
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

/**
 * T1263 (d) — the ONE startup line that says the terminal door is open and for whom.
 *
 * Printed by both entry points from this one function so the two modes cannot describe
 * the same door differently. "For whom" is not decoration: the reader is the person who
 * typed the flag, and the sentence tells them what that flag let in — a paired Loom tab
 * served from this machine's loopback, nothing else — before the first pane opens.
 */
function terminalDoorBanner(door: TerminalHost): string {
  const { shell, cwd } = door.describe();
  return `Terminal door OPEN: paired Loom tabs served from localhost (and only those) may open one ${shell} per terminal pane in ${cwd}, as ${userInfo().username}. Every shell dies with its pane, and all of them with this helper.`;
}

/**
 * T1773b — where the two entry points bind, and the sentence they add when they cannot.
 * `port` and `handoffDir` are set only by a gate (through the environment, see the entry
 * block below): a tab dials `BRIDGE_PORT` and nothing else.
 */
export interface HelperBinding {
  readonly port?: number;
  readonly handoffDir?: string;
}

function heldRemedyFor(binding: HelperBinding): (port: number) => string {
  return (port) => {
    const found = findBridgeHolder(port, binding.handoffDir ?? defaultHandoffDir());
    return bridgeHeldRemedy(port, found.kind === "held" ? found.holder : null);
  };
}

/**
 * T1778b — prints `pairingCodeBlock` on stderr after the notices of the same turn, once per
 * code that works: this helper's own once it is listening, the holder's while proxying. A
 * changed code, port or owner (a promotion after the holder left, a new holder) prints it
 * again. Call the returned function after every announced line.
 */
function pairingBlockPrinter(status: () => BridgeStatus | null): () => void {
  let printed = "";
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    // Deferred, so a notice written in the same turn (a handoff warning) lands above it.
    setImmediate(() => {
      pending = false;
      const now = status();
      if (now === null || now.pairingCode === null || now.port === null) return;
      if (!now.listening && now.mode !== "proxying") return;
      const key = `${now.mode}:${now.port}:${now.pairingCode}`;
      if (key === printed) return;
      printed = key;
      process.stderr.write(
        pairingCodeBlock({
          pairingCode: now.pairingCode,
          port: now.port,
          ...(now.mode === "proxying" ? { holderPid: now.incumbent?.pid ?? null } : {}),
          emphasis: process.stderr.isTTY === true && process.env["NO_COLOR"] === undefined,
        }),
      );
    });
  };
}

export function serveStdio(
  options: { readonly terminal?: boolean; readonly grantExport?: boolean; readonly phone?: boolean } & HelperBinding = {},
): void {
  const showPairingCode = pairingBlockPrinter(() => server.bridgeStatus());
  const server: HeadlessMcpServer = createHeadlessMcpServer({
    send: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    // T1343b: the argv read moved to `resolveHelperInvocation` with the other two, so ONE
    // function answers "which doors does this command line open" and a test can ask it.
    grantExport: options.grantExport === true,
    // The listener is ON here and nowhere else: this is the one caller that owns a process
    // (T451). stdout is the JSON-RPC channel, so everything a HUMAN reads goes to stderr.
    bridge: {
      announce: (message) => {
        process.stderr.write(`[loom bridge] ${message}\n`);
        showPairingCode();
      },
      ...(options.terminal === true ? { terminal: { enabled: true } } : {}),
      ...(options.phone === true ? { phone: { enabled: true } } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.handoffDir === undefined ? {} : { handoffDir: options.handoffDir }),
      heldRemedy: heldRemedyFor(options),
    },
  });
  if (options.terminal === true || options.phone === true) {
    // T1263: an MCP client kills this process with a signal, and every shell it opened
    // must go with it (and, T1396b, every phone is told the door closed). The device
    // helper below has always done this for the laser (G2); here it is worth doing only
    // once there is a child process or a LAN listener to take along.
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      server.dispose();
      process.exit(0);
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }

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

/**
 * THE DEVICE DOOR, OPENED ALONE (T1111).
 *
 * ## The owner's sentence, as a function
 *
 * *"why would that depend on the mcp server?"* — asked about the Person Mask node. T1103
 * proved it does not and made the folder, the refusals and the Connections panel say so.
 * This is the last of it: `pnpm helper --devices-only` starts the loopback listener with the
 * three device doors and NOTHING else. No store, no bus, no node catalogue, no agent tool
 * surface, no Dawn, and no JSON-RPC on stdin. `bridge-host.ts` refuses `attach` and
 * `proxyAttach` by name, so there is no agent server here in any sense a person or a
 * process could observe.
 *
 * ## What it deliberately shares with the full helper
 *
 * The LISTENER, the PAIRING CODE and the device doors — one implementation each. The
 * Connections row is the only pairing surface in the product and the device role rides its
 * code, so a devices-only helper that paired differently would need a second ceremony to
 * explain. It pairs identically; what differs is what the other two roles answer.
 *
 * ## Why this is a mode and not a second file under `src/devices/`
 *
 * §V901: nothing under `src/devices/` may import `src/mcp/`, and the listener lives in
 * `bridge-host.ts` because it multiplexes the two MCP roles. Making the listener itself
 * role-agnostic and moving it down is a REWRITE of a 1100-line file against two large
 * suites, and it buys no fact the user can observe — the user types a command and gets a
 * device bridge either way. It would buy a path that no longer says `mcp`, and structural
 * proof that the device role cannot reach an `McpToolSource`. That trade is named here so
 * the next reader does not have to rediscover it.
 */
export interface DeviceHelperOptions {
  /** `0` for an OS-assigned port (tests). Defaults to the shared constant. */
  readonly port?: number;
  /**
   * T1263 — open the terminal door. Read from `--terminal` by `serveDevices` and nowhere
   * else; ignored when `doors` is injected whole (the gate then decided already).
   */
  readonly terminal?: boolean;
  /** T1396b — arm the phone door. Read from `--phone`; ignored when `doors` is injected. */
  readonly phone?: boolean;
  /** Where a HUMAN reads the pairing code and every refusal (§V233/§V288). */
  readonly announce?: (message: string) => void;
  /** The three doors. Defaulted to the real ones; injected whole by a gate. */
  readonly doors?: DeviceDoors;
  /** Injectable so a test never writes into the developer's real home directory. */
  readonly handoffDir?: string;
  /** How often a helper that lost the bind retries it. Injectable so a test does not wait. */
  readonly retryMs?: number;
  /** T1773b — see `BridgeHostOptions.heldRemedy`. Given by `serveDevices` only. */
  readonly heldRemedy?: (port: number) => string;
}

export interface DeviceHelper {
  /**
   * What the listener is doing, for whoever is printing it (§V338). The same `BridgeStatus`
   * the MCP path reports, because it is the same listener — `detail` names the mode.
   */
  status(): BridgeStatus;
  /** The pairing code a human types into Connections. */
  readonly pairingCode: string;
  dispose(): void;
}

export function createDeviceHelper(options: DeviceHelperOptions = {}): DeviceHelper {
  const announce = options.announce ?? ((): void => undefined);
  const doors =
    options.doors ??
    createDeviceDoors({
      terminal: { enabled: options.terminal === true },
      phone: { enabled: options.phone === true },
    });
  if (doors.terminal) announce(terminalDoorBanner(doors.terminal));
  if (doors.phone) announce(HELPER_PHONE_BANNER);
  const bridge = createBridgeHost({
    // NO `headless` — that absence IS the mode, and it is what makes the agent doors
    // unserveable rather than merely closed. See `bridge-host.ts`.
    devices: doors.devices,
    laser: doors.laser,
    vision: doors.vision,
    models: doors.models,
    ...(doors.terminal ? { terminal: doors.terminal } : {}),
    ...(doors.phone ? { phone: doors.phone } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.handoffDir === undefined ? {} : { handoffDir: options.handoffDir }),
    ...(options.retryMs === undefined ? {} : { proxyRetryMs: options.retryMs }),
    ...(options.heldRemedy === undefined ? {} : { heldRemedy: options.heldRemedy }),
    onNotice: (report) => {
      // One audience here, not two: there is no MCP client to notify, so the operator's
      // terminal is the whole channel and the pairing code has to reach it (§V233).
      announce(report.message);
    },
  });
  return {
    status: () => bridge.status(),
    pairingCode: bridge.pairingCode,
    dispose() {
      // Order matters: the bridge fires the laser's dead-man through `releaseDevice` while
      // the host is still alive, and only then are the doors torn down.
      bridge.dispose();
      doors.dispose();
    },
  };
}

/** `pnpm helper --devices-only`: the device bridge, and a process that stays up for it. */
export function serveDevices(
  options: { readonly terminal?: boolean; readonly phone?: boolean } & HelperBinding = {},
): void {
  const showPairingCode = pairingBlockPrinter(() => helper.status());
  const helper: DeviceHelper = createDeviceHelper({
    ...(options.terminal === true ? { terminal: true } : {}),
    ...(options.phone === true ? { phone: true } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.handoffDir === undefined ? {} : { handoffDir: options.handoffDir }),
    heldRemedy: heldRemedyFor(options),
    announce: (message) => {
      // stderr, exactly as `serveStdio` uses it, so there is one announce channel and one
      // shape of line in the two modes. Nothing writes stdout here — there is no protocol
      // on it — but a human piping the output should still find the code where it always is.
      process.stderr.write(`[loom helper] ${message}\n`);
      showPairingCode();
    },
  });
  /*
   * A helper started at a terminal is one somebody will Ctrl-C, which the stdio server —
   * spawned and killed by an MCP client — never was. Disposing on the signal runs the
   * bridge's release path first, so a laser that is mid-stream is blanked, stopped and
   * e-stopped by this process before it exits (G2) rather than left to the DAC's own
   * timeout. Both signals, because a supervisor sends TERM and a keyboard sends INT.
   */
  /*
   * T1773b: a helper that LOST the bind has no listener, and the bridge's retry timer is
   * unref'd, so nothing held this process open: it printed "Retrying the bind every 2s" and
   * exited 0 before the first retry. This is what "stays up" rests on when the port is held.
   */
  const stayUp = setInterval(() => undefined, 0x7fffffff);
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(stayUp);
    helper.dispose();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

/**
 * WHICH DOORS A COMMAND LINE OPENS, DECIDED IN ONE PLACE (T1111, T1263, T1343b).
 *
 * The flag→door mapping has always belonged to the entry points and nowhere else; T1343b
 * makes that one PURE FUNCTION instead of three `process.argv.includes` calls in two scopes,
 * because `--all` is the first flag whose meaning is a COMBINATION and the first that can
 * CONTRADICT another. Both of those are decisions, and a decision spread across the file is
 * a decision no test can ask about. The entry point below is now a switch over the answer.
 *
 * `--grant-export` is read here too, having been read inside `serveStdio` until now — one
 * command line, one reader. `--terminal` and `--devices-only` stay orthogonal (a shell with
 * no agent server is a real thing to want, §T1263); `--all` implies both grants and is
 * refused BY NAME against `--devices-only` rather than losing to precedence.
 *
 * T1396b — `--phone` is read here and ONLY on its own: `--all` does not imply it, because
 * `--all` is "every door on this machine" and this door is on the LAN. It combines with
 * either mode, since the phone door rides the device role both modes have.
 */
export type HelperInvocation =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "devices"; readonly terminal: boolean; readonly phone: boolean; readonly force: boolean }
  | {
      readonly kind: "stdio";
      readonly terminal: boolean;
      readonly phone: boolean;
      /** T1773b — stop the Loom helper that holds the bridge port before binding. */
      readonly force: boolean;
      readonly grantExport: boolean;
      /** The `--all` startup line, or null when this invocation opened nothing extra. */
      readonly banner: string | null;
    };

export function resolveHelperInvocation(args: readonly string[]): HelperInvocation {
  const all = args.includes(HELPER_ALL_FLAG);
  const devicesOnly = args.includes(HELPER_DEVICES_ONLY_FLAG);
  // Additive meets subtractive: there is no reading of the pair that is not a guess, and
  // one of the doors at stake is a shell. Refuse before anything binds, dials or spawns.
  if (all && devicesOnly) return { kind: "refused", reason: HELPER_ALL_DEVICES_ONLY_REFUSAL };
  const terminal = all || args.includes(HELPER_TERMINAL_FLAG);
  const phone = args.includes(HELPER_PHONE_FLAG);
  // T1773b: no door and no grant, so it combines with every mode and `--all` does not imply it.
  const force = args.includes(HELPER_FORCE_FLAG);
  if (devicesOnly) return { kind: "devices", terminal, phone, force };
  return {
    kind: "stdio",
    terminal,
    phone,
    force,
    grantExport: all || args.includes("--grant-export"),
    banner: all ? HELPER_ALL_BANNER : null,
  };
}

/**
 * T1773b — `--force`, run before anything binds: stop the Loom helper that holds the port,
 * say who it was, or refuse by name. Returns whether this helper may start.
 */
async function forceBridge(binding: HelperBinding): Promise<boolean> {
  const port = binding.port ?? BRIDGE_PORT;
  const taken = await takeOverBridge({ port, handoffDir: binding.handoffDir ?? defaultHandoffDir() });
  if (taken.kind === "free") return true;
  if (taken.kind === "refused") {
    process.stderr.write(`[loom helper] ${bridgeForceRefused(port, taken.holder, taken.why)}\n`);
    return false;
  }
  process.stderr.write(`[loom helper] ${bridgeTakenOver(port, taken.holder, taken.signal)}\n`);
  return true;
}

// Started directly (not imported): serve.
if (process.argv[1]?.endsWith("serve.ts") === true) {
  const invocation = resolveHelperInvocation(process.argv.slice(2));
  /*
   * T1773b: the gate's seam, and only that. `helper-force.test.ts` runs this entry point on
   * a port no tab dials and a handoff directory outside the home directory, so it can never
   * meet a helper somebody is using. Not a flag and not documented for users: a helper on
   * another port is one no Loom tab can find.
   */
  const testPort = Number(process.env["LOOM_TEST_BRIDGE_PORT"]);
  const testHandoffDir = process.env["LOOM_TEST_HANDOFF_DIR"];
  const binding: HelperBinding = {
    ...(Number.isInteger(testPort) && testPort > 0 ? { port: testPort } : {}),
    ...(testHandoffDir === undefined || testHandoffDir === "" ? {} : { handoffDir: testHandoffDir }),
  };
  if (invocation.kind === "refused") {
    // stderr and a non-zero exit, because the caller asked for two incompatible things and
    // got neither: a refusal that exits 0 reads as a helper that started (§V288).
    process.stderr.write(`[loom helper] ${invocation.reason}\n`);
    process.exit(2);
  } else {
    const start = (): void => {
      if (invocation.kind === "devices") {
        serveDevices({ terminal: invocation.terminal, phone: invocation.phone, ...binding });
        return;
      }
      // Before the doors open, not after: the reader of the one-command form learns what is
      // reachable from the line that scrolls past first (T1343b).
      if (invocation.banner !== null) process.stderr.write(`[loom helper] ${invocation.banner}\n`);
      serveStdio({
        terminal: invocation.terminal,
        grantExport: invocation.grantExport,
        phone: invocation.phone,
        ...binding,
      });
    };
    if (invocation.force) {
      void forceBridge(binding).then((mayStart) => {
        // The same exit as the refusal above, for the same reason: asked for, and not done.
        if (mayStart) start();
        else process.exit(2);
      });
    } else {
      start();
    }
  }
}
