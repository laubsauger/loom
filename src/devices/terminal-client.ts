import { bridgeUrl, parseBridgeMessage, BRIDGE_PORT } from "./transport/bridge-wire.ts";
import {
  browserSocket,
  sessionPairingMemory,
  type BridgeSocket,
  type BridgeSocketFactory,
  type PairingMemory,
} from "./transport/bridge-socket.ts";
import { TERMINAL_UNPAIRED_REFUSAL } from "./helper.ts";

/**
 * T1263 — THE PAGE HALF OF THE TERMINAL DOOR: one socket per tab holding the bridge's
 * `terminal` role, one shell per pane on it.
 *
 * ## What it deliberately does NOT do (the (c) rule)
 *
 * The device client reconnects silently from `sessionPairingMemory` on a reload and on
 * every `reconnectRemembered`. This client NEVER connects on its own: no attempt at
 * construction, no retry when the socket drops, no re-attach of a shell a pane had. The
 * remembered code is READ only when a pane calls `open()`, and what it gets is a fresh
 * shell — the pane is the unit of consent, so a shell exists exactly while a pane is
 * asking for one. `terminal-client.test.ts` proves a dropped socket stays dropped until
 * the next `open()`, and that the next `open()` sends a `terminalOpen`, never a resume.
 *
 * ## Why the code is read from memory rather than typed here
 *
 * The one pairing surface is the agent panel's Connections section (T1111); it writes
 * the confirmed code into session memory, and the device role rides it. This is the
 * third rider. A tab that never paired gets `TERMINAL_UNPAIRED_REFUSAL` from `helper.ts`
 * — the command to run and where to pair it (B213) — instead of a second code prompt, so
 * there is still exactly one place to type a code.
 */

export interface TerminalClientOptions {
  readonly port?: number;
  readonly client?: string;
  readonly socketFactory?: BridgeSocketFactory;
  readonly memory?: PairingMemory;
}

/** What a pane hears about its own shell. Every callback names the pane's session. */
export interface TerminalPaneRequest {
  readonly cols: number;
  readonly rows: number;
  /** The shell is up; `pid` is what `echo $$` will print. */
  readonly onOpened: (info: { readonly pid: number; readonly shell: string; readonly cwd: string }) => void;
  readonly onOutput: (data: string) => void;
  /** The shell ended — `exit`, a kill, or the helper going away (`exitCode` null then). */
  readonly onExit: (exitCode: number | null) => void;
  /** No shell: the helper is unpaired, unreachable, without the door, or said no. */
  readonly onRefused: (reason: string, detail: TerminalRefusal) => void;
}

export type TerminalRefusal =
  /** No pairing code in this tab's memory: nothing has paired the helper yet. */
  | "unpaired"
  /** No socket could be opened, or it closed before the role was granted. */
  | "unreachable"
  /** The helper answered, and it has no terminal door (`terminalUnavailable`). */
  | "unavailable"
  /** Any other refusal: wrong code, second tab, bad size, spawn failure. */
  | "refused";

export interface TerminalPaneSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Kills the shell. Idempotent; the pane's unmount is the usual caller. */
  close(): void;
}

export interface TerminalClient {
  /**
   * Asks for ONE fresh shell. Connects the tab's terminal socket first if none is up —
   * from the remembered code, or refuses `unpaired`. Never resumes anything.
   */
  open(request: TerminalPaneRequest): TerminalPaneSession;
  /** How many panes currently hold a shell through this client. */
  sessionCount(): number;
  /** Kills every shell and drops the socket. The tab going away. */
  dispose(): void;
}

interface PaneEntry {
  readonly id: string;
  readonly request: TerminalPaneRequest;
  /** Sent `terminalOpen` and heard `terminalOpened`. */
  opened: boolean;
  /** Sent `terminalOpen`, answer pending. */
  asked: boolean;
  closed: boolean;
}

export function createTerminalClient(options: TerminalClientOptions = {}): TerminalClient {
  const openSocket = options.socketFactory ?? browserSocket;
  const url = bridgeUrl(options.port ?? BRIDGE_PORT);
  const clientName = options.client ?? "a Loom tab";
  const memory = options.memory ?? sessionPairingMemory();

  let socket: BridgeSocket | null = null;
  let attached: { readonly shell: string; readonly cwd: string } | null = null;
  let disposed = false;
  let nextId = 1;
  /** Every pane that asked and has not been answered with an exit or a refusal. */
  const panes = new Map<string, PaneEntry>();

  const send = (message: Record<string, unknown>): void => {
    socket?.send(JSON.stringify(message));
  };

  const askFor = (pane: PaneEntry): void => {
    if (pane.asked || pane.closed) return;
    pane.asked = true;
    send({ type: "terminalOpen", id: pane.id, cols: pane.request.cols, rows: pane.request.rows });
  };

  /** Everything waiting or open is told once, and forgotten. */
  const failAll = (reason: string, detail: TerminalRefusal): void => {
    const waiting = [...panes.values()];
    panes.clear();
    for (const pane of waiting) {
      if (pane.closed) continue;
      pane.closed = true;
      if (pane.opened) pane.request.onExit(null);
      else pane.request.onRefused(reason, detail);
    }
  };

  const dropSocket = (): void => {
    const live = socket;
    socket = null;
    attached = null;
    if (live !== null) {
      live.onclose = null;
      live.close();
    }
  };

  const handle = (message: Record<string, unknown>): void => {
    const type = message["type"];
    if (type === "terminalAttached") {
      const shell = message["shell"];
      const cwd = message["cwd"];
      attached = {
        shell: typeof shell === "string" ? shell : "a shell",
        cwd: typeof cwd === "string" ? cwd : "",
      };
      for (const pane of panes.values()) askFor(pane);
      return;
    }
    if (type === "refused") {
      const said = message["reason"];
      const reason = typeof said === "string" ? said : "no reason given";
      const unavailable = message["terminalUnavailable"] === true;
      // A marked refusal means the CODE WAS RIGHT (T1111's order of checks); only an
      // unmarked one says the remembered code is stale for this helper.
      if (!unavailable) memory.forget();
      dropSocket();
      failAll(reason, unavailable ? "unavailable" : "refused");
      return;
    }
    const id = message["id"];
    if (typeof id !== "string") return;
    const pane = panes.get(id);
    if (pane === undefined || pane.closed) return;
    switch (type) {
      case "terminalOpened": {
        const pid = message["pid"];
        pane.opened = true;
        pane.request.onOpened({
          pid: typeof pid === "number" ? pid : -1,
          shell: attached?.shell ?? "a shell",
          cwd: attached?.cwd ?? "",
        });
        return;
      }
      case "terminalOutput": {
        const data = message["data"];
        if (typeof data === "string") pane.request.onOutput(data);
        return;
      }
      case "terminalExit": {
        const code = message["exitCode"];
        pane.closed = true;
        panes.delete(id);
        pane.request.onExit(typeof code === "number" ? code : null);
        return;
      }
      case "terminalRefused": {
        const said = message["reason"];
        pane.closed = true;
        panes.delete(id);
        pane.request.onRefused(typeof said === "string" ? said : "no reason given", "refused");
        return;
      }
      default:
        return;
    }
  };

  /** Connects with the remembered code, or reports why it cannot. Never called on its own. */
  const connect = (): TerminalRefusal | null => {
    if (socket !== null) return null;
    const code = memory.read();
    if (code === null) return "unpaired";
    let live: BridgeSocket;
    try {
      live = openSocket(url);
    } catch {
      return "unreachable";
    }
    socket = live;
    live.onopen = () => {
      if (socket !== live) {
        live.close();
        return;
      }
      // The code goes in the first MESSAGE, never in the URL (T398).
      live.send(JSON.stringify({ type: "terminalAttach", code, client: clientName }));
    };
    live.onmessage = (event) => {
      const message = parseBridgeMessage(event.data);
      if (message !== null) handle(message);
    };
    live.onclose = () => {
      if (socket !== live) return;
      socket = null;
      attached = null;
      // The (c) rule: nothing here reconnects. Every pane hears it and decides.
      failAll("The local helper closed the terminal connection.", "unreachable");
    };
    live.onerror = () => {
      if (socket !== live) return;
      dropSocket();
      failAll("The local helper could not be reached.", "unreachable");
    };
    return null;
  };

  return {
    open(request) {
      const id = `t${String(nextId++)}`;
      const pane: PaneEntry = { id, request, opened: false, asked: false, closed: false };
      const session: TerminalPaneSession = {
        write(data) {
          if (pane.closed || !pane.opened) return;
          send({ type: "terminalInput", id, data });
        },
        resize(cols, rows) {
          if (pane.closed || !pane.opened) return;
          send({ type: "terminalResize", id, cols, rows });
        },
        close() {
          if (pane.closed) return;
          pane.closed = true;
          panes.delete(id);
          if (pane.asked) send({ type: "terminalClose", id });
        },
      };
      if (disposed) {
        pane.closed = true;
        request.onRefused("This tab is going away.", "unreachable");
        return session;
      }
      const failure = connect();
      if (failure !== null) {
        pane.closed = true;
        request.onRefused(
          failure === "unpaired" ? TERMINAL_UNPAIRED_REFUSAL : "The local helper could not be reached.",
          failure,
        );
        return session;
      }
      panes.set(id, pane);
      if (attached !== null) askFor(pane);
      return session;
    },
    sessionCount: () => [...panes.values()].filter((pane) => pane.opened).length,
    dispose() {
      disposed = true;
      dropSocket();
      failAll("This tab is going away.", "unreachable");
    },
  };
}
