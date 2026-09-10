import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceHelper } from "../mcp/serve.ts";
import { createDeviceDoors } from "./doors.ts";
import { DEVICE_HELPER_TERMINAL_COMMAND } from "./helper.ts";
import { createTerminalClient, type TerminalPaneRequest, type TerminalRefusal } from "./terminal-client.ts";
import type { PtySpawn } from "./terminal-host.ts";
import type { BridgeSocket, PairingMemory } from "./transport/bridge-socket.ts";

/**
 * T1263 (c) — THE PAGE NEVER RECONNECTS A TERMINAL SESSION ON ITS OWN.
 *
 * The device client's pairing memory exists so a reload silently re-attaches. The
 * terminal client reads the SAME memory and must do the opposite: no socket at
 * construction, no socket after a drop, no socket ever except inside a pane's `open()`
 * — and what that open gets is a new `terminalOpen`, never a resume of an id it had.
 * Faked at the socket so the claim is about calls the client makes; the last test runs
 * both halves over a real socket so the two fakes are known to agree on the wire.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface FakeSocket extends BridgeSocket {
  readonly sent: Record<string, unknown>[];
  closed: boolean;
  /** The helper speaks. */
  hear(message: Record<string, unknown>): void;
  /** The helper goes away. */
  drop(): void;
}

function fakeSockets(): { readonly factory: (url: string) => BridgeSocket; readonly opened: FakeSocket[] } {
  const opened: FakeSocket[] = [];
  return {
    opened,
    factory: () => {
      const socket: FakeSocket = {
        sent: [],
        closed: false,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => {
          socket.sent.push(JSON.parse(data) as Record<string, unknown>);
        },
        close: () => {
          socket.closed = true;
        },
        hear: (message) => socket.onmessage?.({ data: JSON.stringify(message) }),
        drop: () => socket.onclose?.(),
      };
      opened.push(socket);
      // Open on the next tick, as a real socket would — never inside the factory call.
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  };
}

function memoryWith(code: string | null): PairingMemory & { code: string | null } {
  const memory = {
    code,
    read: () => memory.code,
    write: (next: string) => {
      memory.code = next;
    },
    forget: () => {
      memory.code = null;
    },
  };
  return memory;
}

interface PaneLog {
  readonly opened: number[];
  readonly output: string[];
  readonly exits: (number | null)[];
  readonly refusals: [string, TerminalRefusal][];
  readonly request: TerminalPaneRequest;
}

function pane(cols = 80, rows = 24): PaneLog {
  const log: PaneLog = {
    opened: [],
    output: [],
    exits: [],
    refusals: [],
    request: {
      cols,
      rows,
      onOpened: (info) => log.opened.push(info.pid),
      onOutput: (data) => log.output.push(data),
      onExit: (code) => log.exits.push(code),
      onRefused: (reason, detail) => log.refusals.push([reason, detail]),
    },
  };
  return log;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("T1263 (c) — the terminal client connects only inside a pane's open()", () => {
  it("opens NO socket at construction, even with a remembered code", async () => {
    const sockets = fakeSockets();
    const client = createTerminalClient({ socketFactory: sockets.factory, memory: memoryWith("ABCD-1234") });
    cleanups.push(() => client.dispose());
    await tick();
    expect(sockets.opened).toHaveLength(0);
  });

  it("connects from the remembered code when a pane asks, and the pane's shell rides that socket", async () => {
    const sockets = fakeSockets();
    const memory = memoryWith("ABCD-1234");
    const client = createTerminalClient({ socketFactory: sockets.factory, memory, client: "vitest" });
    cleanups.push(() => client.dispose());

    const first = pane(100, 30);
    const session = client.open(first.request);
    await tick();
    const socket = sockets.opened[0];
    expect(socket?.sent).toEqual([{ type: "terminalAttach", code: "ABCD-1234", client: "vitest" }]);
    // Nothing is asked for until the role is granted.
    expect(socket?.sent).toHaveLength(1);
    socket?.hear({ type: "terminalAttached", shell: "/bin/zsh", cwd: "/tmp" });
    expect(socket?.sent[1]).toMatchObject({ type: "terminalOpen", cols: 100, rows: 30 });
    const id = socket?.sent[1]?.["id"];
    socket?.hear({ type: "terminalOpened", id, pid: 4242 });
    expect(first.opened).toEqual([4242]);

    session.write("ls\r");
    session.resize(101, 31);
    socket?.hear({ type: "terminalOutput", id, data: "file.txt\r\n" });
    expect(first.output).toEqual(["file.txt\r\n"]);
    expect(socket?.sent.slice(2)).toEqual([
      { type: "terminalInput", id, data: "ls\r" },
      { type: "terminalResize", id, cols: 101, rows: 31 },
    ]);

    // A second pane shares the socket and gets its OWN id.
    const second = pane();
    client.open(second.request);
    expect(socket?.sent[4]).toMatchObject({ type: "terminalOpen" });
    expect(socket?.sent[4]?.["id"]).not.toBe(id);
    expect(sockets.opened).toHaveLength(1);

    session.close();
    expect(socket?.sent[5]).toEqual({ type: "terminalClose", id });
    expect(client.sessionCount()).toBe(0);
  });

  it("does NOT reconnect when the socket drops; the next open() is a new socket and a new shell", async () => {
    const sockets = fakeSockets();
    const memory = memoryWith("ABCD-1234");
    const client = createTerminalClient({ socketFactory: sockets.factory, memory });
    cleanups.push(() => client.dispose());

    const first = pane();
    client.open(first.request);
    await tick();
    const socket = sockets.opened[0];
    socket?.hear({ type: "terminalAttached", shell: "sh", cwd: "/" });
    const id = socket?.sent[1]?.["id"];
    socket?.hear({ type: "terminalOpened", id, pid: 1 });

    socket?.drop();
    // The pane hears that its shell is gone — with no exit code, because nothing exited.
    expect(first.exits).toEqual([null]);
    await tick();
    await tick();
    // THE CLAIM: no second socket, though the code is still remembered.
    expect(sockets.opened).toHaveLength(1);
    expect(memory.code).toBe("ABCD-1234");

    // Only a pane asking again reconnects — and what it asks for is a fresh shell.
    const again = pane();
    client.open(again.request);
    await tick();
    expect(sockets.opened).toHaveLength(2);
    const next = sockets.opened[1];
    next?.hear({ type: "terminalAttached", shell: "sh", cwd: "/" });
    expect(next?.sent[1]).toMatchObject({ type: "terminalOpen" });
    expect(next?.sent[1]?.["id"]).not.toBe(id);
    expect(next?.sent.some((message) => String(message["type"]).includes("resume"))).toBe(false);
  });

  it("refuses `unpaired` without opening a socket when nothing has paired this tab, naming the command", () => {
    const sockets = fakeSockets();
    const client = createTerminalClient({ socketFactory: sockets.factory, memory: memoryWith(null) });
    cleanups.push(() => client.dispose());
    const log = pane();
    client.open(log.request);
    expect(sockets.opened).toHaveLength(0);
    expect(log.refusals).toHaveLength(1);
    expect(log.refusals[0]?.[1]).toBe("unpaired");
    expect(log.refusals[0]?.[0]).toContain(DEVICE_HELPER_TERMINAL_COMMAND);
  });

  it("keeps the remembered code on a `terminalUnavailable` refusal, and forgets it on any other", async () => {
    const sockets = fakeSockets();
    const memory = memoryWith("ABCD-1234");
    const client = createTerminalClient({ socketFactory: sockets.factory, memory });
    cleanups.push(() => client.dispose());

    const first = pane();
    client.open(first.request);
    await tick();
    sockets.opened[0]?.hear({ type: "refused", reason: "no door", terminalUnavailable: true });
    expect(first.refusals).toEqual([["no door", "unavailable"]]);
    expect(memory.code).toBe("ABCD-1234");
    expect(sockets.opened[0]?.closed).toBe(true);

    const second = pane();
    client.open(second.request);
    await tick();
    sockets.opened[1]?.hear({ type: "refused", reason: "that pairing code does not match" });
    expect(second.refusals).toEqual([["that pairing code does not match", "refused"]]);
    expect(memory.code).toBeNull();
  });

  it("both halves agree on the wire: a page pane opens a shell through a real helper socket", async () => {
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-terminal-client-"));
    cleanups.push(() => {
      rmSync(handoffDir, { recursive: true, force: true });
    });
    const spawned: { written: string[]; killed: boolean }[] = [];
    const spawn: PtySpawn = () => {
      const record = { written: [] as string[], killed: false };
      spawned.push(record);
      let data: ((chunk: string) => void) | null = null;
      return {
        pid: 777,
        write: (chunk) => {
          record.written.push(chunk);
          data?.(`echoed:${chunk}`);
        },
        resize: () => undefined,
        kill: () => {
          record.killed = true;
        },
        onData: (handler) => {
          data = handler;
        },
        onExit: () => undefined,
      };
    };
    const helper = createDeviceHelper({
      port: 0,
      handoffDir,
      doors: createDeviceDoors({
        udpSocketFactory: () => {
          throw new Error("no UDP here");
        },
        terminal: { enabled: true, spawn },
      }),
    });
    cleanups.push(() => helper.dispose());
    const until = async (predicate: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await until(() => helper.status().port != null, "the helper to bind");

    const client = createTerminalClient({
      port: helper.status().port ?? 0,
      memory: memoryWith(helper.pairingCode),
      // Node's own WebSocket, adapted the way `browserSocket` adapts the DOM's.
      socketFactory: (url) => {
        const socket = new WebSocket(url);
        const bridge: BridgeSocket = {
          send: (data) => socket.send(data),
          close: () => socket.close(),
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        };
        socket.onopen = () => bridge.onopen?.();
        socket.onmessage = (event: MessageEvent) => bridge.onmessage?.({ data: event.data as unknown });
        socket.onclose = () => bridge.onclose?.();
        socket.onerror = () => bridge.onerror?.();
        return bridge;
      },
    });
    cleanups.push(() => client.dispose());

    const log = pane();
    const session = client.open(log.request);
    await until(() => log.opened.length === 1, "the shell to open");
    expect(log.opened).toEqual([777]);
    session.write("pwd\r");
    await until(() => log.output.length === 1, "the echo to come back");
    expect(log.output).toEqual(["echoed:pwd\r"]);
    session.close();
    await until(() => spawned[0]?.killed === true, "the close to kill the pty");
  });
});
