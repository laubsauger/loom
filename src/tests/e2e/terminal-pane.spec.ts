import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { DEVICE_HELPER_TERMINAL_COMMAND, HELPER_SCRIPT, HELPER_TERMINAL_FLAG } from "@devices/helper.ts";
import { BRIDGE_HOST, BRIDGE_PORT } from "@devices/transport/bridge-wire.ts";

import { openApp } from "./app.ts";

/**
 * T1263 — THE TERMINAL PANE, END TO END: a real helper, a real pairing, a real pty.
 *
 * ## The gap this closes
 *
 * T1263 built the door, the wire and the pane, and shipped without this spec. The wire is
 * covered headlessly (`terminal-client.test.ts` drives a real helper over a real socket with
 * the pty faked); the React lifetime is covered (`use-terminal-client.test.tsx`, B213). The
 * two had never met in a browser — and B213 is what that costs: StrictMode's rehearsal
 * cleanup disposed the tab's one client, so every click answered "This tab is going away."
 * and the pane had never opened a shell in a dev build at all. Both halves were green
 * throughout. This is the spec that would have been red.
 *
 * So nothing here is faked. The spec starts the REAL helper as the user does, reads the
 * pairing code off its banner, types that code into the one pairing surface the product has,
 * clicks the pane's own button, and types into the shell. The dev server it runs against is
 * a dev build, so `<StrictMode>`'s double-mount is exercised for free — do not suppress it,
 * it is half of what this file is for.
 *
 * ## The assertion, and why it is `echo $$`
 *
 * `data-terminal-pid` is what the HELPER said the shell's pid is. `echo $$` is what the
 * SHELL says its pid is. They travel by completely different routes — one down the bridge
 * as a `terminalOpened` field, the other as pty bytes through xterm — and a mock cannot
 * make them agree by accident. Around it, two facts about the same number: it names a live
 * process in this OS while the pane is open, and it is gone once the helper is (T1263's
 * "every shell dies with the helper").
 *
 * ## One port, so one helper, so serial
 *
 * `BRIDGE_PORT` is a constant and the page has no way to be pointed anywhere else, so this
 * spec needs that port to itself: a second helper finds the bind taken and enters PROXY
 * mode, where its terminal door is unreachable and the pane would refuse for a reason that
 * has nothing to do with the code under test. Hence the serial mode, and hence
 * `refuseIfTheBridgePortIsTaken` — a developer's own running helper is the likely cause and
 * the spec says so rather than timing out.
 *
 * ## Reading the screen
 *
 * xterm 6 renders through its DOM renderer here (no canvas or webgl addon is loaded), so
 * `.xterm-rows` holds one element per visible row and the text is really in the document.
 * Rows are padded with non-breaking spaces, which is the only reason `readScreen` rewrites
 * anything at all.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The banner line every mode prints, and the six characters a human retypes. */
const PAIRING_CODE = /Pairing code ([0-9A-Z]{6})/;

/** Whatever the pane's `data-terminal-pid` is, as the shell itself prints it. */
const PRINTED_PID = /LOOM_(\d+)/;

/** The one answer from the pane that is a shell. Anything else is its refusal, verbatim. */
const OPENED = "a terminal grid";

interface Helper {
  readonly pairingCode: string;
  /** Kills the helper and its process group, and waits for the port to come back. */
  stop(): Promise<void>;
}

/** The helper this test started, so a FAILING test tears it down too (not just a passing one). */
let running: Helper | null = null;

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  const live = running;
  running = null;
  await live?.stop();
});

test("a terminal pane opens a real shell from the local helper (T1263)", async ({ page }) => {
  test.setTimeout(180_000);
  const helper = await startHelper([HELPER_TERMINAL_FLAG]);

  await openApp(page);
  await pairThisTab(page, helper.pairingCode);
  const pid = await openShell(page);

  // The pid the PANE is showing names a process in this operating system. A pane fed by a
  // mock would show a number that names nothing.
  expect(isAlive(pid), `the pane reports pid ${String(pid)}, which is no live process`).toBe(true);

  await typeLine(page, "echo LOOM_$$");

  /*
   * The shell's own answer, compared against the helper's. The poll returns the whole
   * screen when nothing has matched yet, so a failure prints what the terminal actually
   * showed instead of `undefined`.
   */
  await expect
    .poll(
      async () => {
        const screen = await readScreen(page);
        return PRINTED_PID.exec(screen)?.[1] ?? screen;
      },
      {
        message: "the pid the shell printed should be the pid the helper handed the pane",
        timeout: 60_000,
      },
    )
    .toBe(String(pid));

  // T1263's other half of "one pty per pane": all of them die with the helper.
  running = null;
  await helper.stop();
  await expect
    .poll(() => isAlive(pid), { message: `shell ${String(pid)} outlived the helper`, timeout: 15_000 })
    .toBe(false);
});

/*
 * The refusal that must not be a timeout.
 *
 * Started without the flag, the helper pairs exactly as before — the code is right, the tab
 * attaches, the pane is there — and the ONLY thing missing is the door. A spec that could not
 * tell that state from "the terminal is broken" would be worth nothing, so the pane's own
 * sentence is asserted, and it is asserted to name the command that fixes it.
 */
test("a helper started without the terminal flag refuses BY NAME, and the pane says what to run (T1263)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const helper = await startHelper([]);

  await openApp(page);
  await pairThisTab(page, helper.pairingCode);

  await page.getByRole("tab", { name: "terminal", exact: true }).click();
  await page.getByRole("button", { name: "Open shell" }).click();

  // The pane offers the gesture again, which is how a user retries after starting the
  // helper properly — and it is rendered instead of the grid, so there is no shell.
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-terminal-pid]")).toHaveCount(0);
  await expect(page.getByText(DEVICE_HELPER_TERMINAL_COMMAND, { exact: false })).toBeVisible();
});

/* ------------------------------------------------------------------ the helper process */

/**
 * Starts the helper the way a person does, and waits for the code it printed.
 *
 * `detached` so the whole process group can be signalled: the script is `pnpm`, which forks
 * node, and killing only the pnpm process leaves the listener holding the port for the next
 * run — the confusing failure this function's preflight exists to name.
 */
async function startHelper(flags: readonly string[]): Promise<Helper> {
  await refuseIfTheBridgePortIsTaken();

  const child = spawn("pnpm", [HELPER_SCRIPT, ...flags], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  // Both pipes are drained unconditionally: an unread pipe fills and stops the helper dead.
  const collect = (chunk: Buffer): void => {
    said += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  /*
   * A helper that never prints a code is still a helper holding the port, and the failure
   * that follows a leak is never about the leak — it is the NEXT run refusing at the
   * preflight above. So the only path out of this function that leaves a process running is
   * the one that also hands the caller a way to stop it.
   */
  let code: string;
  try {
    code = await waitForPairingCode(child, () => said);
  } catch (error: unknown) {
    await stopHelper(child);
    throw error;
  }
  const helper: Helper = { pairingCode: code, stop: () => stopHelper(child) };
  running = helper;
  return helper;
}

function waitForPairingCode(child: ChildProcess, said: () => string): Promise<string> {
  return new Promise<string>((settle, fail) => {
    const deadline = setTimeout(() => {
      stop();
      fail(new Error(`the helper printed no pairing code within 60s. It said:\n${said()}`));
    }, 60_000);
    const poll = setInterval(() => {
      const code = PAIRING_CODE.exec(said())?.[1];
      if (code === undefined) return;
      stop();
      settle(code);
    }, 100);
    const gone = (): void => {
      stop();
      fail(new Error(`the helper exited before it printed a pairing code. It said:\n${said()}`));
    };
    function stop(): void {
      clearTimeout(deadline);
      clearInterval(poll);
      child.off("exit", gone);
      child.off("error", gone);
    }
    child.on("exit", gone);
    child.on("error", gone);
  });
}

async function stopHelper(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child);
  signalGroup(pid, "SIGTERM");
  await Promise.race([exited, after(10_000)]);
  // A helper that ignored the signal still must not hold the port for the next run.
  signalGroup(pid, "SIGKILL");
  await waitForBridgePortToFree();
}

function once(child: ChildProcess): Promise<void> {
  return new Promise<void>((settle) => {
    child.once("exit", () => {
      settle();
    });
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, or never had a group. Either way there is nothing left to signal.
  }
}

/** Whether `pid` names a process this user can see. Never sends anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------- the port */

async function refuseIfTheBridgePortIsTaken(): Promise<void> {
  if (!(await somethingAnswersOnTheBridgePort())) return;
  throw new Error(
    `${BRIDGE_HOST}:${String(BRIDGE_PORT)} is already taken, so this spec cannot own the helper it tests. ` +
      "The page can only ever talk to that one port, and a second helper finds the bind taken and " +
      "proxies the incumbent instead — with no terminal door of its own. If that is your own " +
      `\`${DEVICE_HELPER_TERMINAL_COMMAND}\`, stop it and run this spec again.`,
  );
}

async function waitForBridgePortToFree(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await somethingAnswersOnTheBridgePort())) return;
    await after(200);
  }
  throw new Error(
    `${BRIDGE_HOST}:${String(BRIDGE_PORT)} was still held 15s after the helper was killed; the next run would proxy it.`,
  );
}

function somethingAnswersOnTheBridgePort(): Promise<boolean> {
  return new Promise<boolean>((settle) => {
    const probe = createConnection({ host: BRIDGE_HOST, port: BRIDGE_PORT });
    const done = (answered: boolean): void => {
      probe.destroy();
      settle(answered);
    };
    probe.setTimeout(2_000);
    probe.once("connect", () => {
      done(true);
    });
    probe.once("timeout", () => {
      done(true);
    });
    probe.once("error", () => {
      done(false);
    });
  });
}

const after = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

/* ----------------------------------------------------------------------------- the UI */

/**
 * The one pairing ceremony the product has: read the code off the helper, type it into the
 * agent panel's Connections row. The terminal client reads the same remembered code, which
 * is why nothing types a second one anywhere.
 */
async function pairThisTab(page: Page, code: string): Promise<void> {
  await page.getByRole("tab", { name: "agent", exact: true }).click();
  const row = page.locator('[data-transport="bridge"]');
  await row.getByTestId("mcp-token-bridge").fill(code);
  await row.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByTestId("mcp-state-bridge")).toHaveText("Connected", { timeout: 30_000 });
}

/**
 * Clicks the pane's own button and returns the pid the helper reported for the shell.
 *
 * The wait races the GRID against the pane's other answers rather than waiting for the grid
 * alone. A helper started without the door refuses in a few milliseconds, and a spec that
 * only watched for `data-terminal-pid` would spend thirty seconds discovering it and then
 * report "element(s) not found" — the failure that cannot tell "no door" from "broken".
 * Every refusal and every exit leaves a button offering the gesture again, so this reads the
 * sentence beside that button and fails WITH it.
 */
async function openShell(page: Page): Promise<number> {
  await page.getByRole("tab", { name: "terminal", exact: true }).click();
  await page.getByRole("button", { name: "Open shell" }).click();
  const surface = page.locator("[data-terminal-pid]");
  const again = page.getByRole("button", { name: /^(Try again|New shell)$/ });
  const answered = async (): Promise<string | null> => {
    if ((await surface.count()) > 0) return OPENED;
    if ((await again.count()) === 0) return null;
    return (await again.locator("xpath=..").innerText()).replace(/\s+/g, " ").trim();
  };
  let answer: string | null = null;
  const deadline = Date.now() + 30_000;
  while (answer === null && Date.now() < deadline) {
    answer = await answered();
    if (answer === null) await after(100);
  }
  expect(answer ?? "nothing within 30s", "what the pane did when asked for a shell").toBe(OPENED);
  const reported = await surface.getAttribute("data-terminal-pid");
  const pid = Number(reported);
  expect(Number.isInteger(pid) && pid > 0, `the pane reported pid "${String(reported)}"`).toBe(true);
  return pid;
}

/**
 * Types a command into the shell, once the shell has stopped talking.
 *
 * The wait is not a settle-for-luck: `$SHELL` is whatever the developer's is, and a login
 * shell's rc files run AFTER the pty exists — keystrokes sent into that window reach a line
 * editor that is not up yet and are simply lost. Two identical screens with something on
 * them is the cheapest honest "the prompt is here".
 */
async function typeLine(page: Page, command: string): Promise<void> {
  let previous = "";
  const deadline = Date.now() + 30_000;
  for (;;) {
    await after(400);
    const screen = await readScreen(page);
    if (screen.trim() !== "" && screen === previous) break;
    if (Date.now() > deadline) {
      throw new Error(`the shell never settled on a prompt. The screen reads:\n${screen}`);
    }
    previous = screen;
  }
  await page.locator("[data-terminal-pid]").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** Every visible row of the terminal, as text. NBSP is xterm's padding, not content. */
function readScreen(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelector(".xterm-rows");
    if (rows === null) return "";
    return [...rows.children]
      .map((row) => (row.textContent ?? "").replace(/\u00A0/g, " ").trimEnd())
      .join("\n");
  });
}
