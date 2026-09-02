import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * HOW A SECOND SERVER FINDS THE FIRST (T921).
 *
 * ## The measurement this file exists for
 *
 * Claude Desktop spawns **two** `serve.ts` processes from **one** config entry — measured:
 * PIDs 91036 and 91053, one second apart, one config block. `BRIDGE_PORT` is a constant, so
 * exactly one of them binds it; the other took `EADDRINUSE` and kept serving a full tool
 * catalogue from a headless copy of the project. Every session was a coin flip, and the
 * pairing code the loser printed named a listener that never existed.
 *
 * The fix is that the loser PROXIES the incumbent (`bridge-proxy.ts`). To do that it needs
 * two things it cannot derive: which port the incumbent actually bound, and a credential to
 * open a connection with. Neither can travel through the MCP client — the two processes
 * share a parent and nothing else. So the incumbent leaves them on disk, and the loser
 * reads them.
 *
 * ## Why this is a credential and not just a port number
 *
 * The pairing code is the PAGE's gate: a human reads it off one surface and types it into
 * another, and it is published in the clear on the host's own channels (stderr, the MCP
 * `instructions`, every headless tool result) precisely so a person can find it. Reusing it
 * here would mean anything that can see a log line can open an unlimited number of
 * tool-driving connections and step around the one-page rule.
 *
 * So a proxying sibling gets its OWN secret, minted per process and written NOWHERE except
 * this file: never to stderr, never into `instructions`, never onto a tool result. Holding
 * it proves exactly one thing — that the holder can read a `0600` file in the user's own
 * home directory. That actor is already out of scope by the posture stated in
 * `bridge-protocol.ts`: a local process running as the user could read the pairing code out
 * of the same log the user does, and needs no browser bug to do anything it wants. A PAGE,
 * which is the attacker that posture is actually defending against, cannot read a file at
 * all — so the page-facing gate is not widened by one bit.
 *
 * ## Why `~/.loom` rather than a temp directory
 *
 * `os.tmpdir()` is per-user on macOS and world-writable on Linux; the home directory is
 * user-owned on both. The directory is created `0700` and the file `0600`, and the file is
 * removed on a clean shutdown by the process that wrote it — checked by PID, so a server
 * that lost the race can never delete the incumbent's handoff.
 */

export interface BridgeHandoff {
  /** The port the incumbent actually bound. */
  readonly port: number;
  /** The incumbent's PID, so a stale file can be told from a live one. */
  readonly pid: number;
  /** The proxy-role credential. Never printed anywhere a human or a model can read it. */
  readonly proxyToken: string;
  /** Epoch ms, for a human reading the file during a diagnosis. */
  readonly startedAt: number;
}

/** Where the handoff lives when nobody overrides it. Tests pass their own directory. */
export function defaultHandoffDir(): string {
  return join(homedir(), ".loom");
}

/** One file per port, because the port IS the identity of a bridge. */
export function handoffPath(directory: string, port: number): string {
  return join(directory, `bridge-${port}.json`);
}

/**
 * A proxy-role credential.
 *
 * 192 bits from the platform CSPRNG. Unlike the pairing code this is never transcribed by a
 * person, so there is no reason to make it short or to trim the alphabet.
 */
export function mintProxyToken(): string {
  return randomBytes(24).toString("hex");
}

/** Whether a PID is still running, without signalling it. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else — alive, for our purposes.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Publishes the incumbent's handoff. Never throws: a bridge that cannot write this file is
 * still a working bridge, it just cannot be proxied, and the caller says so (§V288).
 */
export function writeHandoff(directory: string, handoff: BridgeHandoff): Error | null {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = handoffPath(directory, handoff.port);
    // `mode` on `writeFileSync` applies only when the file is CREATED, so an inherited file
    // from an older run keeps its old permissions. The explicit chmod closes that.
    writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Reads a handoff, or null if there is none, it is unreadable, it is malformed, or the
 * process it names is gone.
 *
 * The liveness check is what stops a crashed server's file from sending a fresh one into a
 * proxy loop against a port nobody is listening on.
 */
export function readHandoff(directory: string, port: number): BridgeHandoff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(handoffPath(directory, port), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const filePort = record["port"];
  const pid = record["pid"];
  const proxyToken = record["proxyToken"];
  const startedAt = record["startedAt"];
  if (typeof filePort !== "number" || filePort !== port) return null;
  if (typeof pid !== "number" || typeof proxyToken !== "string" || proxyToken.length === 0) {
    return null;
  }
  if (!processAlive(pid)) return null;
  return {
    port: filePort,
    pid,
    proxyToken,
    startedAt: typeof startedAt === "number" ? startedAt : 0,
  };
}

/**
 * Removes the handoff, but ONLY if it still names this process.
 *
 * A server that lost the race must never delete the winner's file, and a restarted winner
 * must never have its file deleted by the shutdown of the process it replaced.
 */
export function clearHandoff(directory: string, port: number, pid: number): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(handoffPath(directory, port), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return;
    if ((parsed as Record<string, unknown>)["pid"] !== pid) return;
    rmSync(handoffPath(directory, port), { force: true });
  } catch {
    // No file, or not ours to read. Either way there is nothing to clean up.
  }
}
