import { createRequire } from "node:module";
import { platform } from "node:os";

import { isPermittedOrigin } from "./transport/bridge-wire.ts";

/**
 * T1263 — THE HELPER'S TERMINAL DOOR: one pseudo-terminal per pane, for the bridge's
 * `terminal` role. The vision door's sibling in shape — the helper owns the child
 * processes, every refusal is a sentence naming its mechanism, and nothing spawns until
 * a pane asks.
 *
 * ## Why this is a door at all
 *
 * A browser tab cannot spawn a shell. The owner wanted *"access to our terminal within
 * a window pane in the app instead of juggling multiple windows"*, so the shell lives
 * in the LOCAL HELPER (§T1111) beside the UDP socket, the DAC connection and the Vision
 * worker — the fourth thing a page cannot do for itself, built in `doors.ts` with the
 * other three so both entry points carry it.
 *
 * ## The posture, and why it is stricter than the other three doors
 *
 * Whoever holds a session here holds a SHELL AS THE USER. The other doors hand out a
 * UDP socket or a mask; this one hands out everything. So, on top of the pairing code
 * every role presents (§T942's rule: a device attachment is exactly as hard to obtain
 * as a page attachment), this door adds four things, each a test in `terminal-host.test.ts`:
 *
 *  (a) it is OPT-IN per helper launch — `doors.ts` builds it only when told to, and the
 *      bridge refuses the role BY NAME when it was not built (like `attach` on a
 *      devices-only helper, §T1111);
 *  (b) `open()` refuses any origin that is not a loopback page, using the SAME
 *      predicate the listener applies at connect (`isPermittedOrigin`, §T451) — one
 *      rule, applied a second time at the one door where a wrong answer is a shell;
 *  (c) the page never reconnects a terminal session from remembered state — a reconnect
 *      is a NEW shell and only when a pane asks (`terminal-client.ts`);
 *  (d) the helper prints one line at startup saying the door is open and for whom.
 *
 * ## One pty per pane, and nothing survives a pane
 *
 * The owner's answer: *"one shell per pane"*. A pane opens a session, writes to it,
 * reads from it and resizes it; closing the pane KILLS it; a layout restore opens a
 * fresh one — there is no re-attach, because a session nobody can see is a session
 * nobody should be able to reach. `dispose()` kills every session, which is what the
 * helper's own exit does.
 *
 * ## Every OS call is a parameter with a real default
 *
 * `spawn` is `node-pty`'s by default and injectable so a gate can prove the wiring —
 * resize forwarded, close kills, dispose kills all — without a real shell; the
 * round-trip test uses the real one, because "a pty spawns and `echo $$` comes back"
 * is the claim that matters and a fake cannot make it.
 */

/** The slice of a pseudo-terminal this module uses; `node-pty`'s `IPty`, narrowed. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (exit: { readonly exitCode: number }) => void): void;
}

export interface PtySpawnRequest {
  readonly shell: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type PtySpawn = (request: PtySpawnRequest) => PtyProcess;

export interface TerminalHostOptions {
  /** How a pty is forked. The real one is `nodePtySpawn()`; a gate injects a fake. */
  readonly spawn?: PtySpawn;
  /** The shell to run. Defaults to `$SHELL`, then the platform's usual one. */
  readonly shell?: string;
  /** Where the shell starts. Defaults to the helper's own working directory — the project. */
  readonly cwd?: string;
}

export interface TerminalOpenRequest {
  /**
   * The `Origin` the socket announced, verbatim, or undefined for a peer that is not a
   * page. Vetted HERE with the wire's own predicate — see the module docblock, (b).
   */
  readonly origin: string | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (data: string) => void;
  readonly onExit: (exitCode: number) => void;
}

export interface TerminalSession {
  /** The shell's own process id — what `echo $$` prints, and what a gate checks is gone. */
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Kills the shell. Idempotent; the pane's close and the socket's death both call it. */
  close(): void;
}

export interface TerminalHost {
  /** Spawns a fresh shell, or refuses with the reason named. Never re-attaches. */
  open(request: TerminalOpenRequest): TerminalSession | { readonly refusal: string };
  /** How many shells are alive right now. Read by the banner and by the gates. */
  sessionCount(): number;
  /** The shell and directory every session gets — for the startup line, so it says what it does. */
  describe(): { readonly shell: string; readonly cwd: string };
  /** Kills every session. The helper's exit path. */
  dispose(): void;
}

/** The sizes a page may ask for. Anything else is a peer that is not our page. */
const MAX_COLS = 1000;
const MAX_ROWS = 1000;

function usableSize(value: number, max: number): number | null {
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

export function defaultShell(): string {
  const named = process.env["SHELL"];
  if (named !== undefined && named !== "") return named;
  return platform() === "darwin" ? "/bin/zsh" : "/bin/sh";
}

export function createTerminalHost(options: TerminalHostOptions = {}): TerminalHost {
  const spawn = options.spawn ?? nodePtySpawn();
  const shell = options.shell ?? defaultShell();
  const cwd = options.cwd ?? process.cwd();
  const live = new Set<TerminalSession>();
  let disposed = false;

  return {
    open(request) {
      if (disposed) return { refusal: "the terminal door is closed — this helper is shutting down" };
      if (!isPermittedOrigin(request.origin)) {
        return {
          refusal: `a shell is opened only for a Loom page served from localhost, and this request announced origin ${request.origin ?? "none"}`,
        };
      }
      const cols = usableSize(request.cols, MAX_COLS);
      const rows = usableSize(request.rows, MAX_ROWS);
      if (cols === null || rows === null) {
        return {
          refusal: `a terminal size must be whole numbers within 1..${String(MAX_COLS)} columns and 1..${String(MAX_ROWS)} rows, not ${String(request.cols)}x${String(request.rows)}`,
        };
      }
      let pty: PtyProcess;
      try {
        pty = spawn({
          shell,
          cwd,
          cols,
          rows,
          env: { ...process.env, TERM: "xterm-256color" },
        });
      } catch (error: unknown) {
        return {
          refusal: `the shell could not be started (${shell} in ${cwd}): ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      let closed = false;
      const session: TerminalSession = {
        pid: pty.pid,
        write(data) {
          if (closed) return;
          pty.write(data);
        },
        resize(nextCols, nextRows) {
          if (closed) return;
          const c = usableSize(nextCols, MAX_COLS);
          const r = usableSize(nextRows, MAX_ROWS);
          if (c === null || r === null) return;
          pty.resize(c, r);
        },
        close() {
          if (closed) return;
          closed = true;
          live.delete(session);
          // The direct child handle, never a pattern (§V843).
          pty.kill();
        },
      };
      pty.onData((data) => {
        if (closed) return;
        request.onData(data);
      });
      pty.onExit(({ exitCode }) => {
        // The shell ended on its own (`exit`, a crash). The pane hears it once; the
        // session is already dead so `close` becomes a no-op that just forgets it.
        const wasOpen = !closed;
        closed = true;
        live.delete(session);
        if (wasOpen) request.onExit(exitCode);
      });
      live.add(session);
      return session;
    },
    sessionCount: () => live.size,
    describe: () => ({ shell, cwd }),
    dispose() {
      disposed = true;
      for (const session of [...live]) session.close();
    },
  };
}

/* ------------------------------------------------------------------ real process */

/**
 * The real `spawn`: `node-pty`, loaded on first use rather than at import.
 *
 * Lazy because it is a NATIVE module: importing it at the top of this file would make
 * every consumer of `doors.ts` — the devices-only helper included — load a binary for a
 * door it never opens, and would turn a missing build into a crash at startup rather
 * than a refusal at the one door that needs it (§V288).
 */
export function nodePtySpawn(): PtySpawn {
  let loaded: typeof import("node-pty") | null = null;
  return (request) => {
    // `require`, not a dynamic `import()`: `spawn` is synchronous by contract, so the
    // one place a Promise cannot be returned is here. CommonJS is what `node-pty` ships.
    loaded ??= createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
    const pty = loaded.spawn(request.shell, [], {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: request.env as Record<string, string>,
    });
    return {
      pid: pty.pid,
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      kill: () => pty.kill(),
      onData: (handler) => {
        pty.onData(handler);
      },
      onExit: (handler) => {
        pty.onExit(handler);
      },
    };
  };
}
