import {
  BRIDGE_ATTACH_TIMEOUT_MS,
  BRIDGE_HOST,
  BRIDGE_PORT,
  headlessNote,
  isPermittedOrigin,
  mintPairingCode,
  pairingCodeMatches,
  parseBridgeMessage,
  type BridgeToolListing,
} from "./bridge-protocol.ts";
import { createLoopbackWebSocketServer, type LoopbackConnection } from "./loopback-ws.ts";
import type { McpToolSource } from "./server.ts";

/**
 * THE NODE HALF OF THE BRIDGE (T451, §V338, §V288).
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
 * ## One source, chosen per call
 *
 * `source` is an `McpToolSource` — the two methods an MCP connection uses. It delegates to
 * the page when attached and to the headless surface otherwise, so `tools/list` always
 * describes WHAT WILL ACTUALLY EXECUTE and a `tools/list_changed` fires the moment that
 * flips. No transport in this file duplicates a tool definition (§V39): the page sends its
 * OWN `listTools()` verdict, because availability is the one thing the two processes
 * genuinely disagree about — the browser has ports the headless twin does not.
 *
 * ## Pairing, and what it is defending against
 *
 * Loopback is not authorisation. Any page in any tab can open `ws://127.0.0.1:43919` — a
 * WebSocket is not subject to the same-origin policy — so without a secret, a site the user
 * merely VISITED could attach and drive twenty-eight document-mutating tools. The host mints
 * a code per process, publishes it only through its own channels (stderr, MCP instructions,
 * headless tool results), and the human types it into the panel. See `bridge-protocol.ts`
 * for the full posture, including why the code never travels in a URL (T398).
 */

/** What a human is told about the bridge, by whoever is rendering (§V338). */
export interface BridgeStatus {
  readonly listening: boolean;
  /** The port actually bound, once it is. */
  readonly port: number | null;
  readonly attached: boolean;
  /** The page's self-description, when one is attached. Rendered as text, never trusted. */
  readonly client: string | null;
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

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A tool result shaped like the surface's own, for failures the bridge itself must report. */
function bridgeFailure(tool: string, code: string, message: string): Record<string, unknown> {
  return {
    tool,
    status: "error",
    data: null,
    diagnostics: [{ severity: "error", code, message }],
    revision: null,
  };
}

export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { headless } = options;
  const pairingCode = mintPairingCode();
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const notice = options.onNotice ?? ((): void => undefined);

  let boundPort: number | null = null;
  let listenError: string | null = null;
  /** The attached page, or null. Exactly one at a time — see the docblock. */
  let page: LoopbackConnection | null = null;
  let pageClient: string | null = null;
  let pageTools: readonly BridgeToolListing[] | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

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

  const detach = (reason: string): void => {
    if (page === null) return;
    page = null;
    pageClient = null;
    pageTools = null;
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.resolve(
        bridgeFailure(
          "bridge",
          "bridge/detached",
          `The Loom tab detached before this call finished (${reason}). ${headlessNote(pairingCode)}`,
        ),
      );
    }
    pending.clear();
    notice({ severity: "info", message: `Bridge detached: ${reason}. Serving headless again.` });
    options.onToolsChanged?.();
  };

  const server = createLoopbackWebSocketServer({
    port: options.port ?? BRIDGE_PORT,
    host: BRIDGE_HOST,
    onListening: (port) => {
      boundPort = port;
      notice({
        severity: "info",
        message: `Bridge listening on ${BRIDGE_HOST}:${port}. Pairing code ${pairingCode}. Open Loom, find Connections in the agent panel, and enter it to drive the tab you are looking at.`,
      });
    },
    onListenError: (error) => {
      // NOT fatal, and not silent: the stdio server is still a working headless Loom.
      // The bridge is the part that is gone, and the reason is the one thing that makes
      // "why does Connect not work" answerable (§V288).
      listenError = error.message;
      notice({
        severity: "warning",
        message: `Bridge could not listen on ${BRIDGE_HOST}:${options.port ?? BRIDGE_PORT} (${error.message}). Serving headless only; no tab can attach.`,
      });
    },
    onConnection: (socket) => {
      if (!isPermittedOrigin(socket.origin)) {
        refuse(
          socket,
          `this bridge accepts connections from a Loom page served from localhost only, and that socket announced origin ${socket.origin ?? "none"}.`,
        );
        return;
      }
      if (page !== null) {
        refuse(
          socket,
          "a Loom tab is already attached to this bridge. Disconnect it first — one tab at a time, so an agent's edits always land somewhere identifiable.",
        );
        return;
      }

      /** Set once this socket has paired; guards the silence timer and late messages. */
      let paired = false;
      const silence = setTimeout(() => {
        if (paired) return;
        refuse(socket, "no pairing code arrived; the socket was closed.");
      }, BRIDGE_ATTACH_TIMEOUT_MS);

      socket.onClose = () => {
        clearTimeout(silence);
        if (page === socket) detach("the tab closed the connection");
      };

      socket.onMessage = (text) => {
        const message = parseBridgeMessage(text);
        if (message === null) return;
        const type = message["type"];

        if (!paired) {
          if (type !== "attach") return;
          const code = message["code"];
          if (typeof code !== "string" || !pairingCodeMatches(pairingCode, code)) {
            clearTimeout(silence);
            refuse(socket, "that pairing code does not match the one this bridge printed.");
            return;
          }
          paired = true;
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
            options.onToolsChanged?.();
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
              bridgeFailure(
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
    },
  });

  const attachedNow = (): boolean => page !== null && pageTools !== null;

  /**
   * Marks every result with WHICH document it touched.
   *
   * A model that cannot tell the live tab from the headless twin will happily report "I
   * added the node" for an edit nobody can see. This is the sentence that makes that
   * impossible — §V338 applied to the tool result rather than to a UI.
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

  const source: McpToolSource = {
    listTools() {
      const live = pageTools;
      if (live === null) {
        return headless.listTools().map((tool) => ({
          ...tool,
          description: `${tool.description} [headless: no Loom tab is attached to this bridge, so this edits a document the user cannot see]`,
        }));
      }
      return live;
    },
    async callTool(name, input) {
      const socket = page;
      if (socket === null || pageTools === null) {
        return annotate(await headless.callTool(name, input), false);
      }
      const id = nextId++;
      const answered = new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(
            bridgeFailure(
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
    },
  };

  return {
    source,
    pairingCode,
    instructions() {
      if (listenError !== null) {
        return (
          `Loom MCP server. The loopback bridge could NOT start (${listenError}), so every tool below ` +
          "runs against a headless in-memory document the user cannot see. Tell the user: another Loom " +
          "bridge is probably already running."
        );
      }
      return (
        `Loom MCP server, with a loopback bridge on ${BRIDGE_HOST}:${boundPort ?? options.port ?? BRIDGE_PORT}. ` +
        "By default these tools edit a HEADLESS document the user cannot see. To drive the Loom tab they " +
        `are actually looking at, tell them to open the agent panel's Connections section and enter the pairing code ${pairingCode}. ` +
        "Every tool result carries a `bridge` field saying which document it touched; if it says attached:false, say so " +
        "rather than reporting a change the user cannot find."
      );
    },
    status() {
      if (listenError !== null) {
        return {
          listening: false,
          port: null,
          attached: false,
          client: null,
          detail: `The bridge could not listen: ${listenError}.`,
        };
      }
      if (attachedNow()) {
        return {
          listening: true,
          port: boundPort,
          attached: true,
          client: pageClient,
          detail: `Attached to ${pageClient ?? "a Loom tab"}; tool calls run against the live document.`,
        };
      }
      return {
        listening: boundPort !== null,
        port: boundPort,
        attached: false,
        client: null,
        detail: `Listening on ${BRIDGE_HOST}:${boundPort ?? "?"}, nothing attached. Tool calls run headless. Pairing code ${pairingCode}.`,
      };
    },
    dispose() {
      detach("the server shut down");
      server.close();
    },
  };
}
