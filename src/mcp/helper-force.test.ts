import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { HELPER_DEVICES_ONLY_FLAG, HELPER_FORCE_FLAG, pairingCodeBlock } from "@devices/helper.ts";
import { resolveHelperInvocation } from "./serve.ts";

/**
 * T1773b — `--force` TAKES THE BRIDGE FROM A LOOM HELPER, AND FROM NOTHING ELSE.
 *
 * The owner's report: some other session's helper holds the one bridge port, and the helper
 * they start at a terminal prints no pairing code of its own. What matters is what the
 * second command line does to the first PROCESS, so these run the real entry point as real
 * processes. Two things must hold together, and each fails alone:
 *
 *  - with the flag, the holder is stopped and the newcomer binds and prints ITS code;
 *  - a holder that is not a Loom helper is never signalled, whatever the flag says.
 *
 * Every helper here binds a port the OS just handed out and writes its handoff to a temp
 * directory (`LOOM_TEST_*`), so no helper anybody is using can be met. Devices-only, so no
 * process boots a GPU.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Running {
  readonly child: ChildProcess;
  stderr(): string;
  /** The exit code, or the signal's name, once the process has ended. */
  ended(): number | string | null;
}

const started: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function track(child: ChildProcess): Running {
  started.push(child);
  let text = "";
  let ended: number | string | null = null;
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  child.on("exit", (code, signal) => {
    ended = code ?? signal ?? "unknown";
  });
  return { child, stderr: () => text, ended: () => ended };
}

function helper(port: number, handoffDir: string, flags: readonly string[]): Running {
  return track(
    spawn(process.execPath, ["--import", "./src/tooling/alias-hooks.ts", "./src/mcp/serve.ts", ...flags], {
      cwd: ROOT,
      env: { ...process.env, LOOM_TEST_BRIDGE_PORT: String(port), LOOM_TEST_HANDOFF_DIR: handoffDir },
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
}

async function until(condition: () => boolean, what: string, running: readonly Running[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}:\n${running.map((one) => one.stderr()).join("\n---\n")}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        done(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

function handoffDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "loom-force-"));
  directories.push(directory);
  return directory;
}

/** Real processes, and `until` owns the deadline: vitest's 5 s default would cut it short under load. */
const PROCESS_TEST_MS = 60_000;

const pairingCode = (text: string): string | null => /Pairing code ([A-Z0-9]{6})/.exec(text)?.[1] ?? null;

/**
 * T1778b — the block the entry point prints for a code, as a piped stream gets it: what the
 * output must END with, and the code spaced on a line that holds nothing else.
 */
function expectBlockLast(text: string, port: number): void {
  const code = pairingCode(text);
  if (code === null) throw new Error(`no pairing code in:\n${text}`);
  expect(text.endsWith(pairingCodeBlock({ pairingCode: code, port, emphasis: false })), `the block is not last in:\n${text}`).toBe(true);
  expect(text.split("\n").map((line) => line.trim())).toContain(code.split("").join(" "));
  // Piped, so no escape sequence may reach the log.
  expect(text).not.toContain("\u001b");
}

describe("`--force` takes the bridge from the Loom helper that holds it (T1773b)", () => {
  it("labels a holder's code as the holder's, and emphasises only when told to (T1778b)", () => {
    const held = pairingCodeBlock({ pairingCode: "ABC234", port: 43919, holderPid: 77, emphasis: false });
    expect(held).toContain("the helper that holds port 43919, PID 77");
    expect(held.split("\n")).toContain("      A B C 2 3 4");
    expect(pairingCodeBlock({ pairingCode: "ABC234", port: 43919, emphasis: true })).toContain("\u001b[1;7m  A B C 2 3 4  \u001b[0m");
  });

  it("is read on its own, in either mode, and is not implied by any other flag", () => {
    const bare = resolveHelperInvocation([]);
    expect(bare.kind === "stdio" && bare.force).toBe(false);
    const forced = resolveHelperInvocation([HELPER_FORCE_FLAG]);
    expect(forced.kind === "stdio" && forced.force).toBe(true);
    const devices = resolveHelperInvocation([HELPER_DEVICES_ONLY_FLAG, HELPER_FORCE_FLAG]);
    expect(devices.kind === "devices" && devices.force).toBe(true);
  });

  it("without the flag the holder keeps running, and the newcomer names it and the flag", async () => {
    const port = await freePort();
    const handoffDir = handoffDirectory();
    const first = helper(port, handoffDir, [HELPER_DEVICES_ONLY_FLAG]);
    await until(() => pairingCode(first.stderr()) !== null, "the first helper to bind", [first]);

    const second = helper(port, handoffDir, [HELPER_DEVICES_ONLY_FLAG]);
    await until(() => second.stderr().includes(HELPER_FORCE_FLAG), "the newcomer to name the remedy", [first, second]);
    await until(() => first.stderr().includes("LOOM PAIRING CODE"), "the holder's pairing block", [first]);
    expectBlockLast(first.stderr(), port);
    // No code that works, so no block: a block here would hand out a code for no listener.
    expect(second.stderr()).not.toContain("LOOM PAIRING CODE");

    expect(second.stderr()).toContain(`held by PID ${String(first.child.pid)} (a Loom helper`);
    // It did not bind, so it must not hand out a code: that code would name no listener.
    expect(pairingCode(second.stderr())).toBeNull();
    expect(first.ended(), "the holder was stopped without anybody asking").toBeNull();

    // And it WAITS, as its own notice says: when the holder stops, the newcomer binds. It
    // used to exit 0 right after promising to retry, having nothing to keep it running.
    first.child.kill("SIGTERM");
    await until(() => pairingCode(second.stderr()) !== null, "the waiting helper to take the freed port", [second]);
    expect(second.stderr()).toContain(`listening on 127.0.0.1:${String(port)}`);
    await until(() => second.stderr().includes("LOOM PAIRING CODE"), "the block once it holds the port", [second]);
    expectBlockLast(second.stderr(), port);
    expect(second.ended()).toBeNull();
  }, PROCESS_TEST_MS);

  it("with the flag the holder is stopped, named, and the newcomer prints its own pairing code", async () => {
    const port = await freePort();
    const handoffDir = handoffDirectory();
    const first = helper(port, handoffDir, [HELPER_DEVICES_ONLY_FLAG]);
    await until(() => pairingCode(first.stderr()) !== null, "the first helper to bind", [first]);

    const second = helper(port, handoffDir, [HELPER_DEVICES_ONLY_FLAG, HELPER_FORCE_FLAG]);
    await until(() => pairingCode(second.stderr()) !== null, "the forcing helper to bind", [first, second]);

    // The serving helper exits 0 on SIGTERM (its own handler): asked to stop, not killed.
    expect(first.ended()).toBe(0);
    expect(second.stderr()).toContain(`stopped PID ${String(first.child.pid)} (a Loom helper`);
    expect(second.stderr()).toContain("with SIGTERM");
    expect(second.stderr()).toContain(`listening on 127.0.0.1:${String(port)}`);
    expect(pairingCode(second.stderr())).not.toBe(pairingCode(first.stderr()));
    // T1778b: after the takeover line and the banner, the code stands alone and last.
    await until(() => second.stderr().includes("LOOM PAIRING CODE"), "the forcing helper's block", [second]);
    expectBlockLast(second.stderr(), port);
    expect(second.stderr().indexOf("stopped PID")).toBeLessThan(second.stderr().indexOf("LOOM PAIRING CODE"));
    expect(second.ended()).toBeNull();
  }, PROCESS_TEST_MS);

  it("refuses to stop a process that is not a Loom helper, names it, and starts nothing", async () => {
    const port = await freePort();
    const squatter = track(
      spawn(
        process.execPath,
        ["-e", `require("node:net").createServer().listen(${String(port)}, "127.0.0.1", () => console.error("up"))`],
        { stdio: ["ignore", "ignore", "pipe"] },
      ),
    );
    await until(() => squatter.stderr().includes("up"), "the other listener to bind", [squatter]);

    const forcing = helper(port, handoffDirectory(), [HELPER_DEVICES_ONLY_FLAG, HELPER_FORCE_FLAG]);
    await until(() => forcing.ended() !== null, "the forcing helper to give up", [squatter, forcing]);

    expect(forcing.ended()).toBe(2);
    expect(forcing.stderr()).toContain(`held by PID ${String(squatter.child.pid)} (NOT a Loom helper`);
    expect(forcing.stderr()).toContain("Nothing was stopped and nothing was started");
    expect(pairingCode(forcing.stderr())).toBeNull();
    expect(squatter.ended(), "a process that merely owned the port was signalled").toBeNull();
  }, PROCESS_TEST_MS);
});
