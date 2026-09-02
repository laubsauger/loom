import type { BridgeSocket } from "./bridge-client.ts";
import {
  bridgeFailureResult,
  bridgeUrl,
  parseBridgeMessage,
  type BridgeToolListing,
} from "./bridge-protocol.ts";
import { readHandoff } from "./bridge-handoff.ts";

/**
 * THE LOSER OF THE PORT RACE, TURNED INTO A CLIENT OF THE WINNER (T921).
 *
 * ## What was actually wrong
 *
 * MEASURED, not inferred: Claude Desktop spawns TWO `serve.ts` processes from ONE config
 * entry (PIDs 91036 and 91053, one second apart). `BRIDGE_PORT` is a constant, so one binds
 * and one takes `EADDRINUSE`. Before this module the loser emitted a warning into its own
 * stdio — a channel Desktop captures and the owner never reads — and then went on serving a
 * FULL tool catalogue from a headless copy of the project. Every session was a coin flip on
 * which of the two Desktop routed a call to, `attached: false` was permanent when it lost,
 * and the pairing code the loser printed named a listener that had never bound.
 *
 * ## Why proxying rather than refusing
 *
 * Refusing the second instance would have been honest and still broken: Desktop would keep
 * routing to whichever of its two it liked, and one of the two would be a dead end. The only
 * fix that removes the coin flip is for BOTH processes to reach the same live tab. So the
 * loser connects to the incumbent as a client and forwards `tools/list` and `tools/call`
 * over the same loopback socket a page uses, in the proxy role — see `bridge-protocol.ts`
 * for why that role does not widen the one-page rule, and `bridge-handoff.ts` for why its
 * credential is a `0600` file rather than the pairing code.
 *
 * ## The behaviour when it cannot connect, which is the part §V288 is about
 *
 * There is exactly one thing this module must never do, because it is the original defect:
 * answer a tool call from its own headless document while an incumbent exists. So while the
 * proxy is in mode and not connected, every call is REFUSED by name — the incumbent's port
 * and PID in the sentence — and `tools/list` says the same in every description. A loud
 * refusal is a bug report the owner can act on. A silent twin is not.
 *
 * ## And when the incumbent dies
 *
 * The handoff names a PID, so "the file is gone or that process is not running" is a fact
 * this module can establish rather than guess. It then tells its owner, which re-attempts
 * the bind — so stopping a terminal `pnpm mcp:serve` promotes one of Desktop's pair into the
 * listener instead of leaving three processes that can all only refuse.
 */

/** How the proxy sees the incumbent, for `status()`, `instructions()` and `bridge_status`. */
export interface BridgeProxyState {
  readonly connected: boolean;
  /** The port the incumbent owns — the one this process failed to bind. */
  readonly port: number;
  readonly pid: number | null;
  /**
   * The INCUMBENT's pairing code, once it has told us.
   *
   * This is the code a tab must actually type. The loser's own minted code names nothing,
   * and printing it was the measured cause of "I entered it and nothing happened".
   */
  readonly pairingCode: string | null;
  readonly detail: string;
}

export interface BridgeProxyOptions {
  /** The port that was already taken. */
  readonly port: number;
  /** Where `bridge-handoff.ts` looks. Injected so tests never touch the real home. */
  readonly handoffDir: string;
  /** The incumbent's roster moved, or the connection came up or went down. */
  readonly onToolsChanged?: () => void;
  /** Something a human should read (§V288). */
  readonly onNotice?: (notice: { severity: "info" | "warning"; message: string }) => void;
  /**
   * No live incumbent is findable: the handoff is missing, malformed, or names a dead PID.
   *
   * The owner re-attempts the bind. Not called while merely disconnected from a LIVE
   * incumbent, because taking the port from a running server is the collision this fixes.
   */
  readonly onIncumbentGone?: () => void;
  readonly callTimeoutMs: number;
  /** How this process names itself to the incumbent. Rendered as text, never trusted. */
  readonly client: string;
  /** Retry cadence. Injected so a test does not wait on wall time. */
  readonly retryMs?: number;
  readonly socketFactory?: (url: string) => BridgeSocket;
}

export interface BridgeProxy {
  /** The incumbent's roster, or null while not connected — the caller decides what to say. */
  tools(): readonly BridgeToolListing[] | null;
  callTool(name: string, input: unknown): Promise<unknown>;
  state(): BridgeProxyState;
  dispose(): void;
}

const DEFAULT_RETRY_MS = 2_000;

/** The real thing, adapted field by field. Node has a WebSocket CLIENT; this is it. */
function nodeSocket(url: string): BridgeSocket {
  const socket = new WebSocket(url);
  const shim: BridgeSocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => shim.onopen?.();
  socket.onmessage = (event: MessageEvent) => shim.onmessage?.({ data: event.data });
  socket.onclose = () => shim.onclose?.();
  socket.onerror = () => shim.onerror?.();
  return shim;
}

export function createBridgeProxy(options: BridgeProxyOptions): BridgeProxy {
  const openSocket = options.socketFactory ?? nodeSocket;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const notice = options.onNotice ?? ((): void => undefined);
  const url = bridgeUrl(options.port);

  let socket: BridgeSocket | null = null;
  let disposed = false;
  let connected = false;
  let incumbentPid: number | null = null;
  let incumbentCode: string | null = null;
  let tools: readonly BridgeToolListing[] | null = null;
  let detail = `Another Loom bridge owns ${url}; connecting to it so both servers drive the same tab.`;
  let nextId = 1;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  /** The sentence a refusal carries, with everything the owner needs to act (§V288). */
  const refusalMessage = (): string =>
    `This Loom MCP server does NOT own the bridge: ${incumbentPid === null ? "another process" : `PID ${incumbentPid}`} owns 127.0.0.1:${options.port}, and this server is proxying it but is not connected right now (${detail}). Refusing rather than answering from a headless copy the user cannot see.`;

  const send = (message: Record<string, unknown>): void => {
    socket?.send(JSON.stringify(message));
  };

  const failPending = (why: string): void => {
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.resolve(bridgeFailureResult("bridge", "bridge/proxy-lost", why));
    }
    pending.clear();
  };

  const drop = (why: string, severity: "info" | "warning" = "warning"): void => {
    const live = socket;
    socket = null;
    if (live !== null) {
      live.onclose = null;
      live.onerror = null;
      live.close();
    }
    const wasConnected = connected;
    connected = false;
    tools = null;
    detail = why;
    failPending(why);
    if (wasConnected) {
      notice({ severity, message: `Bridge proxy lost the incumbent on ${url}: ${why}` });
      options.onToolsChanged?.();
    }
    schedule();
  };

  function schedule(): void {
    if (disposed || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, retryMs);
    // Node hands back a Timeout, the DOM lib types a number; this process is a server either
    // way and must not be held open by a retry nobody is waiting for.
    (retry as { unref?: () => void }).unref?.();
  }

  function connect(): void {
    if (disposed || socket !== null) return;
    const handoff = readHandoff(options.handoffDir, options.port);
    if (handoff === null) {
      // Not "cannot reach it" — "there is nobody there". A different fact, and the only one
      // that makes taking the port back the right move rather than a second collision.
      detail = `No live Loom bridge is registered for 127.0.0.1:${options.port}.`;
      incumbentPid = null;
      incumbentCode = null;
      options.onIncumbentGone?.();
      schedule();
      return;
    }
    incumbentPid = handoff.pid;
    let live: BridgeSocket;
    try {
      live = openSocket(url);
    } catch (error) {
      drop(`could not open a socket (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    socket = live;
    live.onopen = () => {
      // The token goes in the first MESSAGE, never in the URL — T398, the same rule the
      // pairing code follows and for the same reason.
      live.send(JSON.stringify({ type: "proxyAttach", token: handoff.proxyToken, client: options.client }));
    };
    live.onmessage = (event) => {
      const message = parseBridgeMessage(event.data);
      if (message !== null) handle(message);
    };
    live.onclose = () => {
      if (socket !== live) return;
      drop("the incumbent closed the connection");
    };
    live.onerror = () => {
      if (socket !== live) return;
      drop("the connection to the incumbent failed");
    };
  }

  function handle(message: Record<string, unknown>): void {
    switch (message["type"]) {
      case "proxyAttached": {
        connected = true;
        const pid = message["pid"];
        const code = message["pairingCode"];
        if (typeof pid === "number") incumbentPid = pid;
        incumbentCode = typeof code === "string" ? code : null;
        detail = `Proxying the Loom bridge on 127.0.0.1:${options.port}${incumbentPid === null ? "" : ` (PID ${incumbentPid})`}; tool calls reach the same document that bridge serves.`;
        notice({ severity: "info", message: detail });
        send({ type: "listTools", id: nextId++ });
        return;
      }
      case "refused": {
        const said = message["reason"];
        drop(`the incumbent refused: ${typeof said === "string" ? said : "no reason given"}`);
        return;
      }
      case "listToolsResult": {
        const listed = message["tools"];
        if (!Array.isArray(listed)) return;
        tools = listed as readonly BridgeToolListing[];
        options.onToolsChanged?.();
        return;
      }
      case "toolsChanged":
        send({ type: "listTools", id: nextId++ });
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
            `The Loom bridge this server proxies could not run that tool: ${typeof said === "string" ? said : "no reason given"}`,
          ),
        );
        return;
      }
      default:
        return;
    }
  }

  // DEFERRED, and the reason is a real ordering bug rather than style: `connect()` can call
  // `onIncumbentGone` on its very first attempt, and that callback disposes this proxy — which
  // it cannot do while the constructor has not yet returned the object to assign.
  queueMicrotask(connect);

  return {
    tools: () => (connected ? tools : null),
    async callTool(name, input) {
      if (!connected || socket === null) {
        return bridgeFailureResult(name, "bridge/not-the-owner", refusalMessage());
      }
      const id = nextId++;
      const answered = new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(
            bridgeFailureResult(
              name,
              "bridge/timeout",
              `The Loom bridge on 127.0.0.1:${options.port} did not answer within ${Math.round(options.callTimeoutMs / 1000)}s.`,
            ),
          );
        }, options.callTimeoutMs);
        pending.set(id, { resolve, timer });
      });
      // Forwarded VERBATIM. The far side validates against the tool's own zod schema, and
      // the result comes back with its `bridge` annotation intact (§V66/§V37).
      send({ type: "callTool", id, tool: name, arguments: input ?? {} });
      return await answered;
    },
    state: () => ({
      connected,
      port: options.port,
      pid: incumbentPid,
      pairingCode: incumbentCode,
      detail,
    }),
    dispose() {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      const live = socket;
      socket = null;
      connected = false;
      failPending("this server shut down");
      if (live !== null) {
        live.onclose = null;
        live.onerror = null;
        live.close();
      }
    },
  };
}
