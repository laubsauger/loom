import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceHelper, createHeadlessMcpServer } from "../mcp/serve.ts";
import { createDeviceDoors, openTerminalDoor } from "./doors.ts";
import { DEVICE_HELPER_TERMINAL_COMMAND } from "./helper.ts";
import { createTerminalHost, type PtyProcess, type PtySpawn, type PtySpawnRequest } from "./terminal-host.ts";
import type { UdpSocketFactory } from "./device-hub.ts";

/**
 * T1263 — THE TERMINAL DOOR, PROVEN FROM THE WIRE.
 *
 * The four security claims the task names are each one test here, by name:
 *
 *  (a) `refuses the terminal role BY NAME when the helper was not started with it`
 *  (b) `refuses a shell for a page whose origin is not this machine's loopback`
 *  (c) is the page half — `terminal-client.test.ts` — and is cross-referenced there.
 *  (d) `prints one startup line saying the door is open, and for whom`
 *
 * Everything else is the contract of "one pty per pane": open, `echo $$` round-trips the
 * shell's own pid (the REAL `node-pty`, because a fake cannot make that claim), resize is
 * forwarded, close kills — the pid is GONE from the process table, not merely marked —
 * and disposing the helper kills every shell it had.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ------------------------------------------------------------------ fakes */

interface FakePty extends PtyProcess {
  readonly request: PtySpawnRequest;
  readonly written: string[];
  readonly sizes: [number, number][];
  killed: boolean;
  emit(data: string): void;
  exit(code: number): void;
}

function fakeSpawn(): { readonly spawn: PtySpawn; readonly ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  let nextPid = 40_000;
  const spawn: PtySpawn = (request) => {
    const dataHandlers: ((data: string) => void)[] = [];
    const exitHandlers: ((exit: { readonly exitCode: number }) => void)[] = [];
    const pty: FakePty = {
      pid: nextPid++,
      request,
      written: [],
      sizes: [],
      killed: false,
      write: (data) => {
        pty.written.push(data);
      },
      resize: (cols, rows) => {
        pty.sizes.push([cols, rows]);
      },
      kill: () => {
        pty.killed = true;
      },
      onData: (handler) => {
        dataHandlers.push(handler);
      },
      onExit: (handler) => {
        exitHandlers.push(handler);
      },
      emit: (data) => {
        for (const handler of dataHandlers) handler(data);
      },
      exit: (exitCode) => {
        for (const handler of exitHandlers) handler({ exitCode });
      },
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

/** No UDP in this file: the OSC door is built (it is always built) and never bound. */
const noUdp: UdpSocketFactory = () => {
  throw new Error("this test opens no UDP socket");
};

interface Helper {
  readonly port: number;
  readonly pairingCode: string;
  readonly notices: string[];
  readonly dispose: () => void;
}

/** The devices-only helper, exactly as `serveDevices()` builds it, with `--terminal` or not. */
async function helperWith(terminal: { enabled: boolean; spawn?: PtySpawn }): Promise<Helper> {
  const handoffDir = mkdtempSync(join(tmpdir(), "loom-terminal-"));
  cleanups.push(() => {
    rmSync(handoffDir, { recursive: true, force: true });
  });
  const notices: string[] = [];
  const helper = createDeviceHelper({
    port: 0,
    handoffDir,
    announce: (message) => notices.push(message),
    doors: createDeviceDoors({ udpSocketFactory: noUdp, terminal }),
  });
  cleanups.push(() => {
    helper.dispose();
  });
  await until(() => helper.status().port != null, "the helper to bind a port");
  const port = helper.status().port;
  if (port == null) throw new Error("helper reported no port");
  return { port, pairingCode: helper.pairingCode, notices, dispose: () => helper.dispose() };
}

/** A raw page: Node's own WebSocket (no Origin header, so a permitted non-browser peer). */
function rawPage(port: number): { readonly heard: Record<string, unknown>[]; send(message: object): void; close(): void } {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
  const heard: Record<string, unknown>[] = [];
  const queued: string[] = [];
  let open = false;
  socket.onopen = () => {
    open = true;
    for (const text of queued) socket.send(text);
    queued.length = 0;
  };
  socket.onmessage = (event: MessageEvent) => {
    heard.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  };
  cleanups.push(() => {
    socket.close();
  });
  return {
    heard,
    send(message) {
      const text = JSON.stringify(message);
      if (open) socket.send(text);
      else queued.push(text);
    },
    close: () => socket.close(),
  };
}

const ofType = (heard: Record<string, unknown>[], type: string): Record<string, unknown>[] =>
  heard.filter((message) => message["type"] === type);

/** The wire's own handshake with a chosen Origin — see `bridge.test.ts` for why by hand. */
async function rawHandshake(port: number, origin: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        Origin: origin,
      },
    });
    outgoing.on("error", reject);
    const readFrame = (frame: Buffer, socket: Socket): void => {
      const short = frame[1] ?? 0;
      const offset = short < 126 ? 2 : short === 126 ? 4 : 10;
      const length =
        short < 126 ? short : short === 126 ? frame.readUInt16BE(2) : Number(frame.readBigUInt64BE(2));
      socket.destroy();
      resolve(JSON.parse(frame.subarray(offset, offset + length).toString("utf8")) as Record<string, unknown>);
    };
    outgoing.on("upgrade", (_response, socket: Socket, head: Buffer) => {
      if (head.length > 0) readFrame(head, socket);
      else socket.once("data", (frame: Buffer) => readFrame(frame, socket));
    });
    outgoing.end();
    setTimeout(() => reject(new Error("no refusal frame arrived")), 5_000);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the real shell */

describe("T1263 — a terminal pane's shell, through the helper, on the real pty", () => {
  it("opens a shell whose `echo $$` round-trips the pid the door reported, and close KILLS it", async () => {
    const helper = await helperWith({ enabled: true });
    const page = rawPage(helper.port);
    page.send({ type: "terminalAttach", code: helper.pairingCode, client: "vitest" });
    await until(() => ofType(page.heard, "terminalAttached").length === 1, "the terminal role");

    page.send({ type: "terminalOpen", id: "pane-1", cols: 80, rows: 24 });
    await until(() => ofType(page.heard, "terminalOpened").length === 1, "the shell to open", 15_000);
    const pid = ofType(page.heard, "terminalOpened")[0]?.["pid"];
    expect(typeof pid).toBe("number");
    expect(alive(pid as number)).toBe(true);

    // `$$` expands to the shell's OWN pid — the literal typed command carries `$$`, so
    // only the expansion can match the digits, and only the right shell prints them.
    page.send({ type: "terminalInput", id: "pane-1", data: "echo LOOM_$$_END\r" });
    const output = (): string =>
      ofType(page.heard, "terminalOutput")
        .map((message) => String(message["data"]))
        .join("");
    await until(() => /LOOM_(\d+)_END/.test(output()), "the shell to echo its pid", 15_000);
    const echoed = /LOOM_(\d+)_END/.exec(output());
    expect(Number(echoed?.[1])).toBe(pid);

    page.send({ type: "terminalClose", id: "pane-1" });
    await until(() => !alive(pid as number), "the shell process to be gone", 10_000);
    expect(alive(pid as number)).toBe(false);
  });

  it("kills every shell when the helper exits, whether or not a socket still holds the door", async () => {
    const helper = await helperWith({ enabled: true });
    const page = rawPage(helper.port);
    page.send({ type: "terminalAttach", code: helper.pairingCode });
    page.send({ type: "terminalOpen", id: "a", cols: 80, rows: 24 });
    page.send({ type: "terminalOpen", id: "b", cols: 80, rows: 24 });
    await until(() => ofType(page.heard, "terminalOpened").length === 2, "two shells", 15_000);
    const pids = ofType(page.heard, "terminalOpened").map((message) => message["pid"] as number);
    expect(pids.every(alive)).toBe(true);

    helper.dispose();
    await until(() => pids.every((pid) => !alive(pid)), "both shells to be gone", 10_000);
    expect(pids.map(alive)).toEqual([false, false]);
  });
});

/* ------------------------------------------------------------------ the wiring */

describe("T1263 — the terminal role on the bridge", () => {
  it("forwards input and resize to THAT pane's pty, and nothing to another pane's", async () => {
    const fake = fakeSpawn();
    const helper = await helperWith({ enabled: true, spawn: fake.spawn });
    const page = rawPage(helper.port);
    page.send({ type: "terminalAttach", code: helper.pairingCode });
    page.send({ type: "terminalOpen", id: "left", cols: 100, rows: 30 });
    page.send({ type: "terminalOpen", id: "right", cols: 60, rows: 20 });
    await until(() => ofType(page.heard, "terminalOpened").length === 2, "two shells");
    const [left, right] = fake.ptys;
    expect(left?.request).toMatchObject({ cols: 100, rows: 30 });
    expect(right?.request).toMatchObject({ cols: 60, rows: 20 });
    expect(left?.request.env["TERM"]).toBe("xterm-256color");

    page.send({ type: "terminalInput", id: "right", data: "ls\r" });
    page.send({ type: "terminalResize", id: "right", cols: 61, rows: 21 });
    await until(() => (right?.sizes.length ?? 0) === 1, "the resize to land");
    expect(right?.written).toEqual(["ls\r"]);
    expect(right?.sizes).toEqual([[61, 21]]);
    expect(left?.written).toEqual([]);
    expect(left?.sizes).toEqual([]);

    // Output rides back under the pane's id, and an exit is reported once and forgets it.
    left?.emit("hello");
    await until(() => ofType(page.heard, "terminalOutput").length === 1, "output");
    expect(ofType(page.heard, "terminalOutput")[0]).toMatchObject({ id: "left", data: "hello" });
    left?.exit(3);
    await until(() => ofType(page.heard, "terminalExit").length === 1, "exit");
    expect(ofType(page.heard, "terminalExit")[0]).toMatchObject({ id: "left", exitCode: 3 });
  });

  it("kills a pane's pty on `terminalClose`, and every remaining one when the socket dies", async () => {
    const fake = fakeSpawn();
    const helper = await helperWith({ enabled: true, spawn: fake.spawn });
    const page = rawPage(helper.port);
    page.send({ type: "terminalAttach", code: helper.pairingCode });
    page.send({ type: "terminalOpen", id: "a", cols: 80, rows: 24 });
    page.send({ type: "terminalOpen", id: "b", cols: 80, rows: 24 });
    await until(() => ofType(page.heard, "terminalOpened").length === 2, "two shells");

    page.send({ type: "terminalClose", id: "a" });
    await until(() => fake.ptys[0]?.killed === true, "pane a's pty to be killed");
    expect(fake.ptys[1]?.killed).toBe(false);

    page.close();
    await until(() => fake.ptys[1]?.killed === true, "the socket's death to kill pane b's pty");
  });

  it("(a) refuses the terminal role BY NAME when the helper was not started with it — code checked first", async () => {
    const fake = fakeSpawn();
    const helper = await helperWith({ enabled: false, spawn: fake.spawn });

    const wrong = rawPage(helper.port);
    wrong.send({ type: "terminalAttach", code: "nope" });
    await until(() => ofType(wrong.heard, "refused").length === 1, "the wrong code to be refused");
    // A wrong code learns nothing about which doors exist.
    expect(ofType(wrong.heard, "refused")[0]).not.toHaveProperty("terminalUnavailable");
    expect(String(ofType(wrong.heard, "refused")[0]?.["reason"])).toContain("pairing code does not match");

    const right = rawPage(helper.port);
    right.send({ type: "terminalAttach", code: helper.pairingCode });
    await until(() => ofType(right.heard, "refused").length === 1, "the role to be refused by name");
    const refusal = ofType(right.heard, "refused")[0];
    // Marked, so the page KEEPS a code that was right (T1111's order of checks), and the
    // sentence names the one command that opens the door — spelled by `helper.ts`.
    expect(refusal?.["terminalUnavailable"]).toBe(true);
    expect(String(refusal?.["reason"])).toContain(DEVICE_HELPER_TERMINAL_COMMAND);
    expect(String(refusal?.["reason"])).toContain("without a terminal door");
    expect(fake.ptys).toHaveLength(0);
    expect(helper.notices.some((line) => line.includes("Terminal door OPEN"))).toBe(false);
  });

  it("(b) refuses a shell for a page whose origin is not this machine's loopback", async () => {
    const fake = fakeSpawn();
    const helper = await helperWith({ enabled: true, spawn: fake.spawn });
    // The listener's fence, on bytes: a site the user merely VISITED opens a socket to
    // loopback and cannot lie about `Origin`; it never reaches a role, let alone a shell.
    const said = await rawHandshake(helper.port, "https://evil.example");
    expect(said["type"]).toBe("refused");
    expect(String(said["reason"])).toContain("served from localhost only");

    // And the door's own check, applied a second time with the wire's SAME predicate,
    // for a host that hands it a connection the listener did not vet.
    const door = createTerminalHost({ spawn: fake.spawn });
    const refused = door.open({
      origin: "https://evil.example",
      cols: 80,
      rows: 24,
      onData: () => undefined,
      onExit: () => undefined,
    });
    expect(refused).toHaveProperty("refusal");
    expect(String((refused as { refusal: string }).refusal)).toContain("served from localhost");
    const allowed = door.open({
      origin: "http://localhost:5173",
      cols: 80,
      rows: 24,
      onData: () => undefined,
      onExit: () => undefined,
    });
    expect(allowed).not.toHaveProperty("refusal");
    expect(fake.ptys).toHaveLength(1);
    door.dispose();
    expect(fake.ptys[0]?.killed).toBe(true);
  });

  it("(d) prints one startup line saying the door is open, and for whom", async () => {
    const fake = fakeSpawn();
    const helper = await helperWith({ enabled: true, spawn: fake.spawn });
    const banner = helper.notices.filter((line) => line.includes("Terminal door OPEN"));
    expect(banner).toHaveLength(1);
    // For whom: paired loopback pages and nobody else. What: the shell, where, as whom.
    expect(banner[0]).toContain("served from localhost (and only those)");
    expect(banner[0]).toContain(process.cwd());
    expect(banner[0]).toContain("dies with its pane");
  });

  it("opens the same door from the MCP server when the flag reached it, and takes the shells down with it", async () => {
    const fake = fakeSpawn();
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-terminal-mcp-"));
    cleanups.push(() => {
      rmSync(handoffDir, { recursive: true, force: true });
    });
    const notices: string[] = [];
    const server = createHeadlessMcpServer({
      send: () => undefined,
      bridge: {
        port: 0,
        handoffDir,
        announce: (message) => notices.push(message),
        udpSocketFactory: noUdp,
        terminal: { enabled: true, spawn: fake.spawn },
      },
    });
    cleanups.push(() => {
      server.dispose();
    });
    await until(() => server.bridgeStatus()?.port != null, "the bridge to bind");
    const status = server.bridgeStatus();
    if (status?.port == null || status.pairingCode === null) throw new Error("no bridge");
    expect(notices.filter((line) => line.includes("Terminal door OPEN"))).toHaveLength(1);

    const page = rawPage(status.port);
    page.send({ type: "terminalAttach", code: status.pairingCode });
    page.send({ type: "terminalOpen", id: "p", cols: 80, rows: 24 });
    await until(() => ofType(page.heard, "terminalOpened").length === 1, "a shell through the MCP server");
    expect(fake.ptys).toHaveLength(1);

    // Disposing the server takes the shell with it.
    server.dispose();
    expect(fake.ptys[0]?.killed).toBe(true);
  });

  it("a host that is not serve.ts opens the door with no flag through `openTerminalDoor`", () => {
    const fake = fakeSpawn();
    const door = openTerminalDoor({ spawn: fake.spawn, shell: "/bin/sh", cwd: "/" });
    expect(door.describe()).toEqual({ shell: "/bin/sh", cwd: "/" });
    const session = door.open({
      origin: undefined,
      cols: 10,
      rows: 5,
      onData: () => undefined,
      onExit: () => undefined,
    });
    expect(session).not.toHaveProperty("refusal");
    expect(fake.ptys[0]?.request).toMatchObject({ shell: "/bin/sh", cwd: "/", cols: 10, rows: 5 });
    // Sizes a page could never mean are refused before anything spawns.
    expect(
      door.open({ origin: undefined, cols: 0, rows: 5, onData: () => undefined, onExit: () => undefined }),
    ).toHaveProperty("refusal");
    expect(fake.ptys).toHaveLength(1);
    door.dispose();
  });
});
