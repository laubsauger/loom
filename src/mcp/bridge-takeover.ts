import { execFileSync } from "node:child_process";

import type { BridgeHolderDescription } from "@devices/helper.ts";
import { processAlive, readHandoff } from "./bridge-handoff.ts";
import { MCP_ENTRY_PATH } from "./client-config.ts";

/**
 * WHO HOLDS THE BRIDGE PORT, AND TAKING IT FROM THEM (T1773b).
 *
 * The port is one constant (`BRIDGE_PORT`) and the first helper to bind it holds it until
 * it exits. Every agent session on a machine starts its own helper, so the one a person
 * starts at a terminal usually loses the bind: it proxies (T921) or waits (T1111), and the
 * doors on ITS command line are not open. `--force` stops the holder first.
 *
 * ## What is verified before a signal is sent
 *
 * The listening PID comes from the operating system (`lsof`), never from a file. That
 * process is stopped only when it is a Loom helper, which is true when either holds:
 *
 *  - its command line runs the helper's entry file (`MCP_ENTRY_PATH`), or
 *  - the `0600` handoff file for this port names that same PID (T921). Only a Loom bridge
 *    writes one, and `readHandoff` drops a file whose process is gone.
 *
 * Anything else that merely owns the port is named and left running. Where `lsof` or `ps`
 * is missing (Windows) the holder is unidentified and the answer is the same refusal.
 */

export type BridgeHolderLookup =
  | { readonly kind: "free" }
  | { readonly kind: "unidentified" }
  | { readonly kind: "held"; readonly holder: BridgeHolderDescription };

function run(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  } catch (error) {
    // `lsof` exits 1 with nothing printed when no process matches: an answer, not a failure.
    const failure = error as { status?: number | null; stdout?: string };
    return failure.status === 1 && typeof failure.stdout === "string" ? failure.stdout : null;
  }
}

export function findBridgeHolder(port: number, handoffDir: string): BridgeHolderLookup {
  const listed = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (listed === null) return { kind: "unidentified" };
  const match = /^p(\d+)$/m.exec(listed);
  if (match === null) return { kind: "free" };
  const pid = Number(match[1]);
  const command = (run("ps", ["-p", String(pid), "-o", "command="]) ?? "").trim();
  const loom = command.includes(MCP_ENTRY_PATH) || readHandoff(handoffDir, port)?.pid === pid;
  return { kind: "held", holder: { pid, command, loom } };
}

export type BridgeTakeover =
  | { readonly kind: "free" }
  | { readonly kind: "stopped"; readonly holder: BridgeHolderDescription; readonly signal: "SIGTERM" | "SIGKILL" }
  | {
      readonly kind: "refused";
      readonly holder: BridgeHolderDescription | null;
      readonly why: "notLoom" | "unidentified" | "survived";
    };

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Stops the Loom helper that holds `port`, if one does. SIGTERM first, because a helper
 * with a laser or shells open cleans up on it; SIGKILL only when it outlives `termWaitMs`.
 */
export async function takeOverBridge(options: {
  readonly port: number;
  readonly handoffDir: string;
  readonly termWaitMs?: number;
  readonly killWaitMs?: number;
}): Promise<BridgeTakeover> {
  const found = findBridgeHolder(options.port, options.handoffDir);
  if (found.kind === "free") return found;
  if (found.kind === "unidentified") return { kind: "refused", holder: null, why: "unidentified" };
  const { holder } = found;
  if (!holder.loom || holder.pid === process.pid) return { kind: "refused", holder, why: "notLoom" };
  const signal = (name: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(holder.pid, name);
    } catch {
      // Already gone, or not ours to signal. The wait that follows tells the two apart.
    }
  };
  signal("SIGTERM");
  if (await gone(holder.pid, options.termWaitMs ?? 3_000)) return { kind: "stopped", holder, signal: "SIGTERM" };
  signal("SIGKILL");
  if (await gone(holder.pid, options.killWaitMs ?? 2_000)) return { kind: "stopped", holder, signal: "SIGKILL" };
  return { kind: "refused", holder, why: "survived" };
}
