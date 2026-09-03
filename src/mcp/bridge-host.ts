import {
  BRIDGE_ATTACH_TIMEOUT_MS,
  BRIDGE_HOST,
  BRIDGE_PORT,
  bridgeFailureResult,
  headlessNote,
  isPermittedOrigin,
  mintPairingCode,
  pairingCodeMatches,
  parseBridgeMessage,
  proxyTokenMatches,
  type BridgeToolListing,
} from "./bridge-protocol.ts";
import {
  clearHandoff,
  defaultHandoffDir,
  mintProxyToken,
  writeHandoff,
} from "./bridge-handoff.ts";
import { createBridgeProxy, type BridgeProxy } from "./bridge-proxy.ts";
import type { DeviceHub, DeviceSession } from "./device-hub.ts";
import type { BridgeSocket } from "./bridge-client.ts";
import {
  createLoopbackWebSocketServer,
  type LoopbackConnection,
  type LoopbackWebSocketServer,
} from "./loopback-ws.ts";
import type { McpToolListing, McpToolSource } from "./server.ts";

/**
 * THE NODE HALF OF THE BRIDGE (T451, T921, §V288, §V338).
 *
 * ## What changes for the owner
 *
 * Nothing in their config. Claude Desktop spawns the same `node … serve.ts --grant-export`
 * it already spawns; that process now ALSO listens on loopback, and a Loom tab can
 * attach to it from a button. A `tools/call` arriving on stdio then runs against the LIVE
 * store behind the canvas they are watching, instead of against the headless twin.
 *
 * ## The fallback is loud, which is the whole point
 *
 * With no tab attached the server behaves exactly as it did — full catalogue, real GPU,
 * everything works — and SAYS SO, three times over: in the MCP `instructions` the client
 * reads at initialize, in every tool description, and in every tool result. §V338 is the
 * rule this is paying: a detected-and-branched-on integration that reports nothing is
 * indistinguishable from a broken one. "The agent built a graph I cannot see" was the exact
 * silent failure, and it now cannot happen without the agent being told.
 *
 * That honesty runs the other way too. When a tab IS attached, the result says which tab,
 * so the model knows its edit landed somewhere a human is looking.
 *
 * ## TWO SERVERS, ONE PORT — AND WHY THE LOSER NOW PROXIES (T921)
 *
 * MEASURED: Claude Desktop spawns **two** of these processes from **one** config entry
 * (PIDs 91036 and 91053, one second apart), and `BRIDGE_PORT` is a constant, so exactly one
 * of them binds it. The previous behaviour was the defect this section fixes: the loser
 * emitted a warning into its own stdio — a channel Desktop captures and the owner never
 * reads — and then kept serving a FULL tool catalogue from a headless copy of the project.
 * Every session was a coin flip, `attached: false` was permanent whenever Desktop routed to
 * the loser, and the pairing code the loser printed named a listener that never bound. That
 * is the "I entered the code and nothing happened" report, exactly.
 *
 * Refusing the second instance would have been honest and still broken — Desktop would keep
 * routing half its calls into a dead end. So on `EADDRINUSE` this host stops being a server
 * and becomes a CLIENT of the incumbent (`bridge-proxy.ts`): it forwards `tools/list` and
 * `tools/call` over loopback, and both of Desktop's processes drive the same live tab.
 *
 * Three properties are load-bearing and each is defended below:
 *
 *  - **The proxy role does not widen the one-page rule.** A proxy never occupies the page
 *    slot; it is a separate role with a separate credential, and a proxied call still
 *    executes against the one attached page and still carries that page's name. See
 *    `bridge-protocol.ts` for the widened rule stated in full.
 *  - **The proxy's credential is not the pairing code.** It is a 192-bit token that exists
 *    only in a `0600` file (`bridge-handoff.ts`) and is never printed to stderr, into
 *    `instructions`, or onto a tool result. A page — the attacker the pairing gate actually
 *    defends against — cannot read a file, so the page-facing gate is unchanged.
 *  - **A disconnected proxy REFUSES.** It never falls back to its own headless document
 *    while an incumbent exists. That is the original defect, and the one thing this file
 *    must not do.
 *
 * ## `bridge_status`, and why a transport publishes a tool at all
 *
 * The pairing code reached the client exactly once, as an MCP NOTIFICATION — the one channel
 * a client can paraphrase from memory, and it did: the owner was handed `Q6NCSE` twice,
 * which `mintPairingCode` makes impossible across two processes. So the bridge publishes a
 * tool that returns the CURRENT code, port, PID and attach state, and a client can stop
 * answering from recall.
 *
 * This is the only tool defined outside the catalogue, and §V39 is not bent by it: it
 * describes the TRANSPORT, which is the one thing the shared surface cannot know. It is
 * added by the bridge and only by the bridge, so a page's own surface never grows a tool
 * about a bridge it does not host.
 *
 * ## One source, chosen per call
 *
 * `source` is an `McpToolSource` — the two methods an MCP connection uses. It delegates to
 * the page when attached, to the incumbent when proxying, and to the headless surface
 * otherwise, so `tools/list` always describes WHAT WILL ACTUALLY EXECUTE and a
 * `tools/list_changed` fires the moment that flips. No transport in this file duplicates a
 * CATALOGUE tool definition (§V39): the page sends its OWN `listTools()` verdict, because
 * availability is the one thing the two processes genuinely disagree about — the browser has
 * ports the headless twin does not.
 *
 * ## Pairing, and what it is defending against
 *
 * Loopback is not authorisation. Any page in any tab can open `ws://127.0.0.1:43919` — a
 * WebSocket is not subject to the same-origin policy — so without a secret, a site the user
 * merely VISITED could attach and drive twenty-eight document-mutating tools. The host mints
 * a code per process, publishes it only through its own channels (stderr, MCP instructions,
 * headless tool results, `bridge_status`), and the human types it into the panel. See
 * `bridge-protocol.ts` for the full posture, including why the code never travels in a URL
 * (T398).
 */

/** What a human is told about the bridge, by whoever is rendering (§V338). */
export interface BridgeStatus {
  /**
   * Which of the three things this process is (T921).
   *
   * `starting` — the bind has not resolved yet, and NOTHING is known. `listening` — it owns
   * the port. `proxying` — another Loom server owns it and this one forwards to it.
   * `unavailable` — the bind failed for a reason proxying cannot fix.
   *
   * `starting` exists because the alternative was reporting `listening` with a null port
   * for the first tick of the process's life, which is the same class of lie this row is
   * here to prevent — and a caller polling for "did I win the race" would read it and stop.
   */
  readonly mode: "starting" | "listening" | "proxying" | "unavailable";
  /** THIS process. Named because Claude Desktop runs two and the owner must tell them apart. */
  readonly pid: number;
  readonly listening: boolean;
  /** The port actually bound, or — while proxying — the port the incumbent holds. */
  readonly port: number | null;
  readonly attached: boolean;
  /** The page's self-description, when one is attached. Rendered as text, never trusted. */
  readonly client: string | null;
  /**
   * The pairing code that WORKS RIGHT NOW.
   *
   * While proxying this is the INCUMBENT's code, not this process's own — the loser's code
   * names a listener that never bound, and offering it was the measured cause of the owner
   * entering a code and watching nothing happen (T921).
   */
  readonly pairingCode: string | null;
  /** Set only while proxying: who really owns the port. */
  readonly incumbent: { readonly port: number; readonly pid: number | null } | null;
  /**
   * Whether a tab holds this bridge's DEVICE role, and which (T942 tier 3).
   *
   * Separate from `attached` because the two are independent by design: an agent can drive
   * the document with nothing listening for OSC, and a patch can listen for OSC with no
   * agent attached. Reported rather than inferred (§V338) — "why is my OSC node quiet" is
   * answerable from here.
   */
  readonly deviceAttached: boolean;
  readonly deviceClient: string | null;
  /** Why the status is what it is, in one sentence (§V288). */
  readonly detail: string;
}

export interface BridgeHost {
  /**
   * The tool source an `McpConnection` should read. Delegates live; do not cache what it
   * returns, because which surface answers changes when a tab attaches.
   */
  readonly source: McpToolSource;
  readonly pairingCode: string;
  /** The one-paragraph `instructions` the MCP client hands its model at initialize. */
  instructions(): string;
  status(): BridgeStatus;
  dispose(): void;
}

export interface BridgeHostOptions {
  /** The headless surface that answers when no tab is attached. */
  readonly headless: McpToolSource;
  /** `0` for an OS-assigned port (tests). Defaults to the shared constant. */
  readonly port?: number;
  /** Attachment changed, or the page's tool list moved — wire to `refreshTools`. */
  readonly onToolsChanged?: () => void;
  /** Something a human should read: bind failure, refusal, attach, detach (§V288). */
  readonly onNotice?: (notice: { severity: "info" | "warning"; message: string }) => void;
  /** Injectable so a test can watch the clock without waiting on it. */
  readonly callTimeoutMs?: number;
  /**
   * Where the port handoff is published and read (T921). Defaults to `~/.loom`.
   *
   * Injectable so a test never writes into the developer's real home directory, and so two
   * hosts in one test can be pointed at one temporary directory.
   */
  readonly handoffDir?: string;
  /** How often a losing host retries the incumbent. Injectable so a test does not wait. */
  readonly proxyRetryMs?: number;
  /** The proxy's socket, for a test that wants to watch the bytes. */
  readonly proxySocketFactory?: (url: string) => BridgeSocket;
  /**
   * The DEVICE hub — OSC and, later, anything else a page cannot speak (T942 tier 3).
   *
   * Absent means this bridge serves no devices, and a `deviceAttach` is refused BY NAME
   * rather than ignored: "this bridge was started without device support" is a different
   * sentence from "wrong code", and a caller needs to know which (§V359).
   */
  readonly devices?: DeviceHub;
  /**
   * T950 — the laser door, present only when the helper was built with one. Commands
   * dispatch through `handleDeviceMessage` exactly as OSC's do; its unsolicited state
   * changes (the dead-man firing, a device e-stop) ride `deviceStreamState` under the
   * stream name "laser". When the device client dies, `releaseDevice` DISPOSES it —
   * which is G2's page-death case: a session that ends mid-stream blanks, stops and
   * e-stops the DAC on the helper's own clock before anything else happens.
   */
  readonly laser?: import("./laser-host.ts").LaserHost;
}

/**
 * How long a forwarded `tools/call` may take before the bridge answers for the page.
 *
 * Generous: a call can compile a graph and render a frame in a real browser on a real GPU.
 * The timeout exists so a tab that was closed mid-call cannot hang the MCP client forever —
 * and when it fires the answer is a RESULT carrying a diagnostic, never a transport error,
 * because "the tab went away" is something the model should read and act on (§V66).
 */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * How often a bridge that could not bind tries again — to reach the incumbent, and to TAKE
 * the port once nobody holds it.
 *
 * MEASURED, and it is the second half of T921: `onListenError` fired exactly once and the
 * process then served headless forever. Killing the winner left the port FREE and rescued
 * nothing, so there was no manual workaround at all — not even "stop the other one". The
 * concurrent case needs the proxy; the SEQUENTIAL case (the incumbent exits when its Desktop
 * session ends, minutes later) needs this, and neither covers the other.
 *
 * Two seconds: a bind attempt on loopback costs nothing, and the thing being waited for is a
 * human closing an app.
 */
const DEFAULT_PROXY_RETRY_MS = 2_000;

/** The transport's own tool. Not in the catalogue, and deliberately so — see the docblock. */
export const BRIDGE_STATUS_TOOL = "bridge_status";

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { headless } = options;
  const pairingCode = mintPairingCode();
  const proxyToken = mintProxyToken();
  const wantedPort = options.port ?? BRIDGE_PORT;
  const handoffDir = options.handoffDir ?? defaultHandoffDir();
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const retryMs = options.proxyRetryMs ?? DEFAULT_PROXY_RETRY_MS;
  const notice = options.onNotice ?? ((): void => undefined);

  let boundPort: number | null = null;
  let listenError: string | null = null;
  let disposed = false;
  /** The attached page, or null. Exactly one at a time — see the docblock. */
  let page: LoopbackConnection | null = null;
  let pageClient: string | null = null;
  let pageTools: readonly BridgeToolListing[] | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCall>();
  /** Sibling servers forwarding their stdio traffic here. NOT the page slot (T921). */
  const proxies = new Set<LoopbackConnection>();
  /**
   * The attached DEVICE client, or null. ONE at a time, refused by name — the same rule
   * the page slot has, for the same reason: §T458(b) is a relay that let any connected
   * client reach another's surface, and one-at-a-time is what makes cross-client reach
   * structurally impossible rather than merely unimplemented. A device client never
   * occupies the page slot and never sees a tool.
   */
  let device: LoopbackConnection | null = null;
  let deviceClient: string | null = null;
  let deviceSession: DeviceSession | null = null;
  /** Set when THIS process lost the race and forwards to somebody else instead. */
  let proxy: BridgeProxy | null = null;
  let server: LoopbackWebSocketServer | null = null;
  let rebind: ReturnType<typeof setTimeout> | null = null;

  const send = (socket: LoopbackConnection, message: Record<string, unknown>): void => {
    socket.send(JSON.stringify(message));
  };

  const refuse = (socket: LoopbackConnection, reason: string): void => {
    // Refusals name the problem to BOTH sides (§V288): the page renders this sentence in
    // its panel, and the operator reads it beside the server's own log.
    send(socket, { type: "refused", reason });
    notice({ severity: "warning", message: `Bridge refused a connection: ${reason}` });
    socket.close();
  };

  /**
   * The roster moved. Tells this process's MCP client AND every proxying sibling, because a
   * sibling that is not told keeps describing a tool list that changed hands.
   */
  const toolsMoved = (): void => {
    for (const socket of proxies) send(socket, { type: "toolsChanged" });
    options.onToolsChanged?.();
  };

  const detach = (reason: string): void => {
    if (page === null) return;
    page = null;
    pageClient = null;
    pageTools = null;
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.resolve(
        bridgeFailureResult(
          "bridge",
          "bridge/detached",
          `The Loom tab detached before this call finished (${reason}). ${headlessNote(pairingCode)}`,
        ),
      );
    }
    pending.clear();
    notice({ severity: "info", message: `Bridge detached: ${reason}. Serving headless again.` });
    toolsMoved();
  };

  /**
   * Marks every result with WHICH document it touched.
   *
   * A model that cannot tell the live tab from the headless twin will happily report "I
   * added the node" for an edit nobody can see. This is the sentence that makes that
   * impossible — §V338 applied to the tool result rather than to a UI. A proxied call
   * carries the INCUMBENT's annotation, verbatim, because the incumbent is the process that
   * knows which document it ran against.
   */
  const annotate = (result: unknown, attached: boolean): unknown => {
    if (typeof result !== "object" || result === null) return result;
    return {
      ...(result as Record<string, unknown>),
      bridge: attached
        ? {
            attached: true,
            target: pageClient ?? "the attached Loom tab",
            note: "Executed against the LIVE document in the attached Loom tab; the user can see this change.",
          }
        : { attached: false, pairingCode, note: headlessNote(pairingCode) },
    };
  };

  /** What THIS process would execute — the page's roster, or the headless one, marked. */
  const localList = (): readonly McpToolListing[] => {
    const live = pageTools;
    if (live === null) {
      return headless.listTools().map((tool) => ({
        ...tool,
        // The second sentence is the one the owner needed and did not have: the catalogue
        // tools keep working while unattached, which made the surface look half-alive
        // rather than disconnected (T921, §V469).
        description: `${tool.description} [headless: no Loom tab is attached to this bridge, so this edits a document the user cannot see. Catalogue tools such as get_node_definition answer correctly whether or not a tab is attached — a correct answer from one is not evidence of an attachment; call bridge_status to find out.]`,
      }));
    }
    return live;
  };

  /** What THIS process would run a call against — the page, or the headless surface. */
  const localCall = async (name: string, input: unknown): Promise<unknown> => {
    const socket = page;
    if (socket === null || pageTools === null) {
      return annotate(await headless.callTool(name, input), false);
    }
    const id = nextId++;
    const answered = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(
          bridgeFailureResult(
            name,
            "bridge/timeout",
            `The attached Loom tab did not answer within ${Math.round(callTimeoutMs / 1000)}s. It may be busy or gone; the bridge is still attached.`,
          ),
        );
      }, callTimeoutMs);
      pending.set(id, { resolve, timer });
    });
    // The arguments are forwarded VERBATIM and validated on the far side by the tool's own
    // zod schema. Nothing here inspects or reshapes them (§V66/§V37).
    send(socket, { type: "callTool", id, tool: name, arguments: input ?? {} });
    return annotate(await answered, true);
  };

  /**
   * A proxying sibling's request. It asks the two questions a bridge host asks a page, and
   * gets the answer THIS process would have given its own client — so the two stdio pipes
   * are answered by one document.
   */
  const handleProxyMessage = (socket: LoopbackConnection, message: Record<string, unknown>): void => {
    switch (message["type"]) {
      case "listTools": {
        const id = message["id"];
        if (typeof id !== "number") return;
        // The UNDERLYING list, without this transport's own `bridge_status` — the sibling
        // prepends its own, and two of them on one list would be a tool published twice.
        send(socket, { type: "listToolsResult", id, tools: localList() });
        return;
      }
      case "callTool": {
        const id = message["id"];
        const tool = message["tool"];
        if (typeof id !== "number" || typeof tool !== "string") return;
        void localCall(tool, message["arguments"] ?? {}).then(
          (result) => {
            send(socket, { type: "callToolResult", id, result });
          },
          (error: unknown) => {
            send(socket, {
              type: "callToolError",
              id,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return;
      }
      default:
        return;
    }
  };

  /** Every device client's connection dies here, with its subscriptions and its sockets. */
  const releaseDevice = (reason: string): void => {
    if (device === null) return;
    device = null;
    deviceClient = null;
    deviceSession?.close();
    deviceSession = null;
    // T950/G2 — the page-death case: dispose fires the dead-man sequence if a stream
    // was live, so a closed tab never leaves a beam. Unconditional and first-class,
    // not an afterthought of socket cleanup.
    options.laser?.dispose();
    notice({ severity: "info", message: `Device bridge released: ${reason}.` });
  };

  /**
   * One device client's request (T942 tier 3).
   *
   * Three requests carry an `id` and are answered exactly once; `deviceAck` carries none
   * and is answered never. Nothing here reads a message from another role, which is what
   * makes the role gate structural rather than procedural (§T458(b)).
   */
  const handleDeviceMessage = (socket: LoopbackConnection, message: Record<string, unknown>): void => {
    const session = deviceSession;
    if (session === null) return;
    switch (message["type"]) {
      case "deviceSubscribe": {
        const id = message["id"];
        if (typeof id !== "number") return;
        const opened = session.subscribe(message["source"]);
        if ("reason" in opened) {
          send(socket, { type: "deviceRefused", id, reason: opened.reason });
          return;
        }
        send(socket, {
          type: "deviceSubscribed",
          id,
          stream: opened.stream,
          flow: opened.flow,
          detail: opened.detail,
        });
        return;
      }
      case "deviceUnsubscribe": {
        const id = message["id"];
        if (typeof id !== "number") return;
        session.unsubscribe(message["stream"]);
        return;
      }
      case "deviceSend": {
        const id = message["id"];
        if (typeof id !== "number") return;
        void session.send(message["to"], message["packets"]).then(
          (outcome) => {
            send(socket, { type: "deviceSendResult", id, outcome });
          },
          (error: unknown) => {
            // A THROW is a local failure, never an arrival: it takes the `failed` word,
            // which is the one that claims least (§T950 gap 3).
            send(socket, {
              type: "deviceSendResult",
              id,
              outcome: {
                delivery: "failed",
                reason: error instanceof Error ? error.message : String(error),
              },
            });
          },
        );
        return;
      }
      case "deviceLaser": {
        const id = message["id"];
        if (typeof id !== "number") return;
        const laser = options.laser;
        if (laser === undefined) {
          send(socket, {
            type: "deviceLaserResult",
            id,
            outcome: {
              ok: false,
              reason: "this helper was built without a laser driver — nothing here can reach a DAC.",
              state: { phase: "disconnected", clearRefused: false, underflowed: false, bufferFullness: 0 },
            },
          });
          return;
        }
        void laser.command(message["command"] as never).then(
          (outcome) => {
            send(socket, { type: "deviceLaserResult", id, outcome });
          },
          (error: unknown) => {
            send(socket, {
              type: "deviceLaserResult",
              id,
              outcome: {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
                state: { phase: "disconnected", clearRefused: false, underflowed: false, bufferFullness: 0 },
              },
            });
          },
        );
        return;
      }
      case "deviceAck":
        // Flow control. A coalescing stream has no window to advance, so this is accepted
        // and ignored on purpose — the message exists so a credit-based device can land
        // without a protocol revision (§T950 gap 2).
        return;
      default:
        return;
    }
  };

  const onConnection = (socket: LoopbackConnection): void => {
    if (!isPermittedOrigin(socket.origin)) {
      refuse(
        socket,
        `this bridge accepts connections from a Loom page served from localhost only, and that socket announced origin ${socket.origin ?? "none"}.`,
      );
      return;
    }

    /** Which of the THREE roles this socket claimed, once it has claimed one. */
    let role: "none" | "page" | "proxy" | "device" = "none";
    const silence = setTimeout(() => {
      if (role !== "none") return;
      refuse(socket, "no pairing code or proxy token arrived; the socket was closed.");
    }, BRIDGE_ATTACH_TIMEOUT_MS);

    socket.onClose = () => {
      clearTimeout(silence);
      proxies.delete(socket);
      if (device === socket) releaseDevice("the tab closed the connection");
      if (page === socket) detach("the tab closed the connection");
    };

    socket.onMessage = (text) => {
      const message = parseBridgeMessage(text);
      if (message === null) return;
      const type = message["type"];

      if (role === "none") {
        if (type === "proxyAttach") {
          // The proxy role is gated by a secret that lives ONLY in a 0600 file, so a page —
          // which cannot read a file — can reach this branch and never past it (T921).
          if (!proxyTokenMatches(proxyToken, message["token"])) {
            clearTimeout(silence);
            refuse(socket, "that proxy token does not match the one this bridge published.");
            return;
          }
          role = "proxy";
          clearTimeout(silence);
          proxies.add(socket);
          const said = message["client"];
          const label = typeof said === "string" ? said.slice(0, 120) : "another Loom server";
          send(socket, {
            type: "proxyAttached",
            serverInfo: "loom-bridge",
            port: boundPort ?? wantedPort,
            pid: process.pid,
            // Handing over the pairing code is the point: the sibling can then name a bridge
            // that actually exists instead of its own, which never bound (T921).
            pairingCode,
          });
          notice({
            severity: "info",
            message: `Bridge accepted a proxying Loom server (${label}); its tool calls now run against this bridge's document, so both processes drive one tab.`,
          });
          return;
        }
        if (type === "deviceAttach") {
          // The DEVICE role, gated by the SAME human-typed pairing code the page role is
          // — not the proxy token, which exists only in a 0600 file. A device attachment
          // is exactly as hard to obtain as a page attachment, and no easier (T942).
          const devices = options.devices;
          if (devices === undefined) {
            clearTimeout(silence);
            refuse(
              socket,
              "this Loom bridge was started without device support, so it cannot listen for OSC. That is a different problem from a wrong pairing code.",
            );
            return;
          }
          const given = message["code"];
          if (typeof given !== "string" || !pairingCodeMatches(pairingCode, given)) {
            clearTimeout(silence);
            refuse(socket, "that pairing code does not match the one this bridge printed.");
            return;
          }
          if (device !== null) {
            clearTimeout(silence);
            refuse(
              socket,
              "a Loom tab is already using this bridge's devices. Disconnect it first — one at a time, so a stream always has one identifiable owner.",
            );
            return;
          }
          role = "device";
          clearTimeout(silence);
          const said = message["client"];
          deviceClient = typeof said === "string" ? said.slice(0, 120) : "a Loom tab";
          device = socket;
          deviceSession = devices.open({
            // PUSHES. No id, nothing waiting, straight onto the socket (§T950 gap 1).
            onEvents: (stream, at, seq, dropped, values) => {
              if (device !== socket) return;
              send(socket, { type: "deviceEvents", stream, at, seq, dropped, values });
            },
            onState: (stream, state, detail) => {
              if (device !== socket) return;
              send(socket, { type: "deviceStreamState", stream, state, detail });
            },
          });
          // T950: the laser's unsolicited state changes ride the same push channel.
          options.laser?.onState((state, detail) => {
            if (device !== socket) return;
            send(socket, {
              type: "deviceStreamState",
              stream: "laser",
              state: state.phase === "estopped" ? "error" : "open",
              detail: `${detail} [laser:${state.phase}]`,
            });
          });
          send(socket, { type: "deviceAttached", sources: devices.sources });
          notice({
            severity: "info",
            message: `Device bridge attached to ${deviceClient}; it can now open loopback UDP sockets for OSC and transmit to destinations it names explicitly.`,
          });
          return;
        }
        if (type !== "attach") return;
        const code = message["code"];
        if (typeof code !== "string" || !pairingCodeMatches(pairingCode, code)) {
          clearTimeout(silence);
          refuse(socket, "that pairing code does not match the one this bridge printed.");
          return;
        }
        // The one-PAGE rule, checked at the moment a page claims the role rather than at
        // connect: a proxying sibling is not a page and must never consume the slot (T921).
        if (page !== null) {
          clearTimeout(silence);
          refuse(
            socket,
            "a Loom tab is already attached to this bridge. Disconnect it first — one tab at a time, so an agent's edits always land somewhere identifiable.",
          );
          return;
        }
        role = "page";
        clearTimeout(silence);
        // The page's own name is DATA — carried into a field somebody renders as text,
        // never interpolated into anything a model is asked to act on (§V37).
        const client = message["client"];
        pageClient = typeof client === "string" ? client.slice(0, 120) : "a Loom tab";
        page = socket;
        // Ask for its roster BEFORE announcing the attach: `tools/list` must describe what
        // will actually execute, and until the answer lands the headless list is still the
        // truthful one.
        send(socket, { type: "listTools", id: nextId++ });
        return;
      }

      if (role === "proxy") {
        handleProxyMessage(socket, message);
        return;
      }

      if (role === "device") {
        if (device !== socket) return;
        handleDeviceMessage(socket, message);
        return;
      }

      if (page !== socket) return;

      switch (type) {
        case "listToolsResult": {
          const tools = message["tools"];
          if (!Array.isArray(tools)) return;
          const first = pageTools === null;
          pageTools = tools as readonly BridgeToolListing[];
          if (first) {
            send(socket, { type: "attached", serverInfo: "loom-bridge" });
            notice({
              severity: "info",
              message: `Bridge attached to ${pageClient ?? "a Loom tab"}; tool calls now run against the live document.`,
            });
          }
          toolsMoved();
          return;
        }
        case "toolsChanged":
          send(socket, { type: "listTools", id: nextId++ });
          return;
        case "callToolResult": {
          const id = message["id"];
          if (typeof id !== "number") return;
          const call = pending.get(id);
          if (call === undefined) return;
          pending.delete(id);
          clearTimeout(call.timer);
          call.resolve(message["result"]);
          return;
        }
        case "callToolError": {
          const id = message["id"];
          if (typeof id !== "number") return;
          const call = pending.get(id);
          if (call === undefined) return;
          pending.delete(id);
          clearTimeout(call.timer);
          const said = message["message"];
          call.resolve(
            bridgeFailureResult(
              "bridge",
              "bridge/page-error",
              `The Loom tab could not run that tool: ${typeof said === "string" ? said : "no reason given"}`,
            ),
          );
          return;
        }
        default:
          return;
      }
    };
  };

  /**
   * Becomes a client of whoever owns the port (T921).
   *
   * Guarded, because the bind can fail more than once over a process's life: a promoted
   * proxy that loses a second race must not stack a second proxy on the first.
   */
  /**
   * Tries the bind again, later.
   *
   * The proxy is deliberately NOT torn down first. Between "the incumbent is gone" and "this
   * process owns the port" there is a window, and a host with no proxy in that window would
   * answer from its own headless document — the exact defect. So the refusing proxy stays up
   * until `onListening` succeeds and disposes it.
   */
  const scheduleRebind = (): void => {
    if (disposed || rebind !== null || server !== null) return;
    rebind = setTimeout(() => {
      rebind = null;
      if (disposed || server !== null) return;
      startListening();
    }, retryMs);
    (rebind as { unref?: () => void }).unref?.();
  };

  const enterProxyMode = (): void => {
    if (disposed || proxy !== null) return;
    notice({
      severity: "warning",
      message: `Bridge could not bind ${BRIDGE_HOST}:${wantedPort} — something already owns it. This server (PID ${process.pid}) will PROXY that bridge if it is a Loom one, so its tool calls reach the same document rather than a headless copy the user cannot see, and will keep retrying the bind until the port frees.`,
    });
    proxy = createBridgeProxy({
      port: wantedPort,
      handoffDir,
      callTimeoutMs,
      retryMs,
      client: `Loom MCP server, PID ${process.pid}`,
      onNotice: notice,
      onToolsChanged: toolsMoved,
      onIncumbentGone: () => {
        // No live Loom bridge is registered for that port, so taking it is a promotion rather
        // than a second collision. This is the path that makes closing a Desktop session, or
        // stopping a terminal `pnpm mcp:serve`, hand the bridge to a process that is still
        // running instead of leaving the port free and every server useless.
        if (disposed) return;
        listenError = null;
        scheduleRebind();
      },
      ...(options.proxySocketFactory === undefined ? {} : { socketFactory: options.proxySocketFactory }),
    });
  };

  function startListening(): void {
    if (disposed) return;
    server = createLoopbackWebSocketServer({
      port: wantedPort,
      host: BRIDGE_HOST,
      onListening: (port) => {
        boundPort = port;
        listenError = null;
        // Published BEFORE the banner, so a sibling that reads it the same millisecond finds
        // a complete file rather than a port with no token (T921).
        const failure = writeHandoff(handoffDir, {
          port,
          pid: process.pid,
          proxyToken,
          startedAt: Date.now(),
        });
        const promoted = proxy !== null;
        if (proxy !== null) {
          proxy.dispose();
          proxy = null;
        }
        notice({
          severity: "info",
          message: `${promoted ? `The port freed and this server (PID ${process.pid}) took it. ` : ""}Bridge listening on ${BRIDGE_HOST}:${port}. Pairing code ${pairingCode}. Open Loom, find Connections in the agent panel, and enter it to drive the tab you are looking at.`,
        });
        if (failure !== null) {
          // Not fatal — this bridge works. What is lost is a SIBLING's ability to find it,
          // and that has to be said or the sibling's refusal looks like a different bug.
          notice({
            severity: "warning",
            message: `Bridge could not publish its handoff file (${failure.message}); a second Loom server started from the same MCP client will not be able to proxy this one and will refuse instead.`,
          });
        }
        toolsMoved();
      },
      onListenError: (error) => {
        server = null;
        listenError = error.message;
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          enterProxyMode();
          return;
        }
        // Not fatal, and not silent: the stdio server is still a working headless Loom.
        // The bridge is the part that is gone, and the reason is the one thing that makes
        // "why does Connect not work" answerable (§V288). It is also not PERMANENT any
        // more — a bind that failed once is retried, because the condition that broke it
        // is usually another process's lifetime (T921).
        notice({
          severity: "warning",
          message: `Bridge could not listen on ${BRIDGE_HOST}:${wantedPort} (${error.message}). Serving headless only; no tab can attach. Retrying every ${Math.round(retryMs / 1000)}s.`,
        });
        scheduleRebind();
      },
      onConnection,
    });
  }

  startListening();

  const attachedNow = (): boolean => page !== null && pageTools !== null;

  const status = (): BridgeStatus => {
    if (proxy !== null) {
      const live = proxy.state();
      return {
        mode: "proxying",
        pid: process.pid,
        listening: false,
        port: live.port,
        // This process holds no page. Whether the INCUMBENT does is its business, and every
        // forwarded result carries that answer in its own `bridge` field.
        attached: false,
        client: null,
        pairingCode: live.pairingCode,
        incumbent: { port: live.port, pid: live.pid },
        deviceAttached: false,
        deviceClient: null,
        detail: live.detail,
      };
    }
    if (listenError !== null) {
      return {
        mode: "unavailable",
        pid: process.pid,
        listening: false,
        port: null,
        attached: false,
        client: null,
        pairingCode: null,
        incumbent: null,
        deviceAttached: false,
        deviceClient: null,
        detail: `The bridge could not listen: ${listenError}.`,
      };
    }
    if (attachedNow()) {
      return {
        mode: "listening",
        pid: process.pid,
        listening: true,
        port: boundPort,
        attached: true,
        client: pageClient,
        pairingCode,
        incumbent: null,
        deviceAttached: device !== null,
        deviceClient,
        detail: `Attached to ${pageClient ?? "a Loom tab"}; tool calls run against the live document.`,
      };
    }
    if (boundPort === null) {
      return {
        mode: "starting",
        pid: process.pid,
        listening: false,
        port: null,
        attached: false,
        client: null,
        // The code is already minted and already correct; what is not yet known is whether
        // this process will own a listener for it.
        pairingCode,
        incumbent: null,
        deviceAttached: device !== null,
        deviceClient,
        detail: `Binding ${BRIDGE_HOST}:${wantedPort}; it is not yet known whether this process owns the bridge.`,
      };
    }
    return {
      mode: "listening",
      pid: process.pid,
      listening: true,
      port: boundPort,
      attached: false,
      client: null,
      pairingCode,
      incumbent: null,
      deviceAttached: device !== null,
      deviceClient,
      detail: `Listening on ${BRIDGE_HOST}:${boundPort}, nothing attached. Tool calls run headless. Pairing code ${pairingCode}.`,
    };
  };

  /**
   * The transport's own tool, always available (T921).
   *
   * The description is the instruction that matters: the pairing code arrives once, in a
   * notification, and a client that repeats it from memory hands the user a code for a
   * process that has since exited. That happened, and it is what this tool exists to stop.
   */
  const bridgeStatusListing = (): McpToolListing => ({
    name: BRIDGE_STATUS_TOOL,
    title: "Bridge status",
    description:
      "Reports this Loom MCP server's bridge AS IT IS RIGHT NOW: the pairing code that currently works, the bound port, this process's PID, whether a Loom tab is attached, and — if another Loom server owns the port — which PID that is. " +
      "Call this before telling a user a pairing code. The code is minted per process and announced only once, as a notification, so a code repeated from earlier in the conversation may name a server that no longer exists. Takes no arguments.",
    available: true,
    missing: { commands: [], queries: [], ports: [] },
  });

  const bridgeStatusResult = (): Record<string, unknown> => ({
    tool: BRIDGE_STATUS_TOOL,
    status: "ok",
    data: { host: BRIDGE_HOST, ...status() },
    diagnostics: [],
    revision: null,
  });

  /**
   * The incumbent's roster while proxying — or, while the proxy is down, the catalogue
   * marked UNAVAILABLE by name.
   *
   * The marked list is the honest half of the refusal: a client that reads `tools/list`
   * before it reads a result should already know these calls will not run, and should know
   * whose port to look at.
   */
  const proxiedList = (): readonly McpToolListing[] => {
    const live = proxy?.tools() ?? null;
    if (live !== null) return live;
    const state = proxy?.state();
    const owner = `the Loom bridge on ${BRIDGE_HOST}:${state?.port ?? wantedPort}${state?.pid == null ? "" : ` (PID ${state.pid})`}`;
    return headless.listTools().map((tool) => ({
      ...tool,
      available: false,
      missing: { ...tool.missing, ports: [...tool.missing.ports, owner] },
      description: `${tool.description} [REFUSED: this Loom MCP server does not own the bridge port — ${owner} does — and is not connected to it, so it will not answer from a headless copy the user cannot see]`,
    }));
  };

  const source: McpToolSource = {
    listTools() {
      return [bridgeStatusListing(), ...(proxy === null ? localList() : proxiedList())];
    },
    async callTool(name, input) {
      // Answered HERE in every mode, including while proxying: this process is the only one
      // that knows what this process is, and a forwarded answer would describe the wrong one.
      if (name === BRIDGE_STATUS_TOOL) return bridgeStatusResult();
      // While proxying, the proxy answers — forwarding when connected, refusing by name when
      // not. It NEVER falls through to `localCall`, because a headless answer under a live
      // incumbent is the defect T921 exists to remove.
      if (proxy !== null) return await proxy.callTool(name, input);
      return await localCall(name, input);
    },
  };

  return {
    source,
    pairingCode,
    instructions() {
      const current = status();
      const readTheTool =
        `Call \`${BRIDGE_STATUS_TOOL}\` to read the CURRENT pairing code, port and attach state; ` +
        "never repeat a pairing code from earlier in this conversation, because it may name a server that has exited.";
      if (current.mode === "proxying") {
        if (current.pairingCode === null) {
          return (
            `Loom MCP server, PID ${current.pid}. This process did NOT bind the bridge port: another Loom server owns ` +
            `${BRIDGE_HOST}:${current.port}, and this one is proxying it but is NOT connected right now (${current.detail}). ` +
            "Every tool call below is REFUSED rather than answered from a HEADLESS copy the user cannot see. " +
            `${readTheTool}`
          );
        }
        return (
          `Loom MCP server, PID ${current.pid}. This process did NOT bind the bridge port — another Loom server ` +
          `(PID ${current.incumbent?.pid ?? "unknown"}) owns ${BRIDGE_HOST}:${current.port} — so it PROXIES that bridge and your tool ` +
          "calls reach the same document that bridge serves. There is no second HEADLESS copy in play. " +
          `The pairing code for that bridge is ${current.pairingCode}; tell the user to open the agent panel's Connections section and enter it. ` +
          `${readTheTool} ` +
          "Every tool result carries a `bridge` field saying which document it touched."
        );
      }
      if (current.mode === "unavailable") {
        return (
          `Loom MCP server, PID ${current.pid}. The loopback bridge could NOT start (${listenError ?? "no reason given"}), so every tool below ` +
          "runs against a HEADLESS in-memory document the user cannot see. Tell the user: another Loom " +
          `bridge is probably already running. ${readTheTool}`
        );
      }
      return (
        `Loom MCP server, PID ${current.pid}, with a loopback bridge on ${BRIDGE_HOST}:${current.port ?? wantedPort}. ` +
        "By default these tools edit a HEADLESS document the user cannot see. To drive the Loom tab they " +
        `are actually looking at, tell them to open the agent panel's Connections section and enter the pairing code ${pairingCode}. ` +
        `${readTheTool} ` +
        "Every tool result carries a `bridge` field saying which document it touched; if it says attached:false, say so " +
        "rather than reporting a change the user cannot find."
      );
    },
    status,
    dispose() {
      disposed = true;
      releaseDevice("the server shut down");
      options.devices?.dispose();
      detach("the server shut down");
      if (rebind !== null) clearTimeout(rebind);
      rebind = null;
      proxy?.dispose();
      proxy = null;
      if (boundPort !== null) clearHandoff(handoffDir, boundPort, process.pid);
      server?.close();
      server = null;
    },
  };
}
