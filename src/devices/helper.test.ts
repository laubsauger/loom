import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DEVICE_HELPER_ALL_COMMAND,
  DEVICE_HELPER_COMMAND,
  DEVICE_HELPER_DEVICES_ONLY_COMMAND,
  DEVICE_HELPER_PHONE_COMMAND,
  DEVICE_HELPER_TERMINAL_COMMAND,
  HELPER_ALL_BANNER,
  HELPER_ALL_DEVICES_ONLY_REFUSAL,
  HELPER_ALL_FLAG,
  HELPER_DEVICES_ONLY_FLAG,
  HELPER_PHONE_BANNER,
  HELPER_PHONE_FLAG,
  HELPER_SCRIPT,
  HELPER_TERMINAL_FLAG,
  HELPER_DOCS_URL,
  TERMINAL_PANE_RUN,
  TERMINAL_UNPAIRED_REFUSAL,
} from "./helper.ts";
import * as helperModule from "./helper.ts";
import { createDeviceDoors } from "./doors.ts";
import { createDeviceHelper, resolveHelperInvocation } from "../mcp/serve.ts";

/**
 * ONE SPELLING OF THE COMMAND, AND A GATE THAT SAYS SO (T1110, §V39).
 *
 * ## Why this test exists
 *
 * T1103 wrote that `helper.ts` is "THE ONE PLACE THAT NAMES THE COMMAND", and it was not
 * true: `domain/osc/osc-status.ts` spelled it twice and four node descriptions spelled it
 * once each — six user-facing sentences that a rename would have left saying the old name,
 * beside the seven refusals that would have said the new one. A product answering "what do I
 * run?" with two different commands is worse than one that answers with the wrong one.
 *
 * The claim was a paragraph in a docblock, and this repo's own history (§V901's reasoning)
 * says a paragraph decays. So the claim is a gate now. It scans the source the way
 * `copy-guard.test.ts` does, because the fact being defended is about what a HUMAN READS,
 * and no type can see that.
 *
 * ## What it forbids, precisely
 *
 * The literal `pnpm <script>` form inside a STRING OR TEMPLATE LITERAL, in any file under
 * `src/` except this one and the module that owns it — including the retired name, so a
 * stale sentence is caught as loudly as a duplicated fresh one.
 *
 * String literals and not raw text, because the fact being defended is about what the
 * PRODUCT SAYS. A docblock naming the command is documentation that can go stale; a string
 * literal naming it is a second command in the user's face, and only one of those is the
 * failure this gate exists for. Parsed rather than pattern-matched, because "is this inside
 * a comment" is not a question a regex answers — the same reason `copy-guard.test.ts` walks
 * the AST. A template literal that INTERPOLATES the constant carries none of its text and
 * so passes, which is exactly the fix this gate is asking for.
 *
 * A bare `"mcp:serve"` (the alias constant in `client-config.ts`, which exists so a test can
 * assert `package.json` still carries the alias) is not a command a user is told to type,
 * and is deliberately not matched.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The name the script had until T1110. A sentence still saying it is a stale sentence. */
const RETIRED_COMMAND = "pnpm mcp:serve";

/** Owns the fact, or asserts it. Nothing else may spell it. */
const ALLOWED = new Set([join(SRC, "devices/helper.ts"), join(SRC, "devices/helper.test.ts")]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** Every string and template literal in a file, comments and identifiers excluded. */
function literalText(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      // The literal SPANS only. An interpolated `${DEVICE_HELPER_COMMAND}` contributes no
      // text, which is the whole point: reading the constant is the passing answer.
      found.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the helper command has exactly one spelling (T1110)", () => {
  it("is not written into a string anywhere else under src/", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (ALLOWED.has(path)) continue;
      const strings = literalText(path);
      for (const command of [DEVICE_HELPER_COMMAND, RETIRED_COMMAND]) {
        if (strings.some((text) => text.includes(command))) {
          offenders.push(`${relative(SRC, path)} spells "${command}"`);
        }
      }
    }
    expect(
      offenders,
      `Import DEVICE_HELPER_COMMAND from @devices/helper.ts instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("builds both commands from the one script name, so a rename moves both", () => {
    expect(DEVICE_HELPER_COMMAND).toBe(`pnpm ${HELPER_SCRIPT}`);
    expect(DEVICE_HELPER_DEVICES_ONLY_COMMAND).toBe(`${DEVICE_HELPER_COMMAND} ${HELPER_DEVICES_ONLY_FLAG}`);
  });

  /*
   * T1263 — the third spelling, `pnpm helper --terminal`, follows the same rule: built
   * from the one script name here, and the FLAG itself is written nowhere else under
   * src/ either, so the entry point and every refusal that names it move together.
   */
  it("builds the terminal command from the same script name, and hands the pane that command", () => {
    expect(DEVICE_HELPER_TERMINAL_COMMAND).toBe(`${DEVICE_HELPER_COMMAND} ${HELPER_TERMINAL_FLAG}`);
    /*
     * T1284b — the requirement is that the pane NAMES THE COMMAND, built from the one
     * script name here; it was never that the command sit inside a prose sentence. The
     * pane now renders `TERMINAL_PANE_RUN` as a command, so that constant is what has to
     * be the real thing.
     */
    expect(TERMINAL_PANE_RUN).toBe(DEVICE_HELPER_TERMINAL_COMMAND);
    /*
     * The devices-only variant is DELIBERATELY no longer in the pane (T1284b, the owner:
     * "less verbose text, more clear instructions"). One command is what a reader has to
     * type; the second spelling is an option, and options live in the docs the pane links.
     * Asserted as ABSENCE so nobody puts it back by reflex.
     */
    expect(TERMINAL_PANE_RUN).not.toContain(DEVICE_HELPER_DEVICES_ONLY_COMMAND);
    expect(HELPER_DOCS_URL.startsWith("https://")).toBe(true);
  });

  /*
   * B213 — the refusal a reader without a helper gets is the one that most needs the
   * command, and it was the one that lost it: composed from `TERMINAL_PANE_HINT` back
   * when that constant was a whole instruction, it survived T1284b's edit as "…with this
   * tab: Shells come from the local helper..". Both halves of that are asserted, because
   * the sentence broke silently — nothing reads a refusal but a person.
   */
  it("tells a tab with no helper paired what to run, in one sentence per idea (B213)", () => {
    expect(TERMINAL_UNPAIRED_REFUSAL).toContain(TERMINAL_PANE_RUN);
    expect(TERMINAL_UNPAIRED_REFUSAL, "a sentence ended twice").not.toMatch(/\.\./);
  });

  it("the --terminal flag is not spelled into a string anywhere else under src/ (T1263)", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (ALLOWED.has(path)) continue;
      if (literalText(path).some((text) => text.includes(HELPER_TERMINAL_FLAG))) {
        offenders.push(relative(SRC, path));
      }
    }
    expect(offenders, "Import HELPER_TERMINAL_FLAG from @devices/helper.ts instead").toEqual([]);
  });

  /*
   * T1343b — the fourth spelling. `--all` inherits the rule the other two flags carry: one
   * definition, and every sentence that names it interpolates that definition. The banner
   * and the refusal both do, which is why neither appears in the offender list below.
   *
   * Substring matching is deliberate and the same as the `--terminal` scan above: a file
   * that says `--all-outputs` would be flagged, and being asked to justify a near-miss is
   * the cheap side of that trade next to a second spelling of a flag that grants a shell.
   */
  it("the --all flag is not spelled into a string anywhere else under src/ (T1343b)", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (ALLOWED.has(path)) continue;
      if (literalText(path).some((text) => text.includes(HELPER_ALL_FLAG))) {
        offenders.push(relative(SRC, path));
      }
    }
    expect(offenders, "Import HELPER_ALL_FLAG from @devices/helper.ts instead").toEqual([]);
  });

  it("builds the all-inclusive command from the same script name (T1343b)", () => {
    expect(DEVICE_HELPER_ALL_COMMAND).toBe(`${DEVICE_HELPER_COMMAND} ${HELPER_ALL_FLAG}`);
  });

  /*
   * T1396b — the fifth spelling, same rule. The phone door's refusal and the helper's
   * startup line both name `--phone`, and both interpolate it from helper.ts.
   */
  it("the --phone flag is not spelled into a string anywhere else under src/ (T1396b)", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (ALLOWED.has(path)) continue;
      if (literalText(path).some((text) => text.includes(HELPER_PHONE_FLAG))) {
        offenders.push(relative(SRC, path));
      }
    }
    expect(offenders, "Import HELPER_PHONE_FLAG from @devices/helper.ts instead").toEqual([]);
  });

  it("builds the phone command from the same script name (T1396b)", () => {
    expect(DEVICE_HELPER_PHONE_COMMAND).toBe(`${DEVICE_HELPER_COMMAND} ${HELPER_PHONE_FLAG}`);
  });
});

/**
 * T1396b — THE PHONE DOOR IS ITS OWN AFFIRMATIVE ACT, AND `--all` IS NOT ONE.
 *
 * `--all` means every door ON THIS MACHINE; the phone door is the first one that listens on
 * the LAN, and the owner approved it opt-in per session. So the ruling is asserted three
 * ways, each of which can regress on its own: `--all` does not arm it, `--phone` does (in
 * both modes, since the door rides the device role), and the `--all` banner tells the
 * reader it was left out and which flag adds it.
 */
describe("`--phone` arms the phone door, and `--all` does not (T1396b)", () => {
  it("is NOT implied by --all", () => {
    const all = resolveHelperInvocation([HELPER_ALL_FLAG]);
    expect(all.kind === "stdio" && all.phone).toBe(false);
    expect(HELPER_ALL_BANNER).toContain(HELPER_PHONE_FLAG);
  });

  it("is armed by --phone alone, with the agent server or without it", () => {
    const stdio = resolveHelperInvocation([HELPER_PHONE_FLAG]);
    expect(stdio.kind === "stdio" && stdio.phone).toBe(true);
    expect(stdio.kind === "stdio" && stdio.terminal).toBe(false);
    expect(resolveHelperInvocation([HELPER_DEVICES_ONLY_FLAG, HELPER_PHONE_FLAG])).toEqual({
      kind: "devices",
      terminal: false,
      phone: true,
      force: false,
    });
    expect(resolveHelperInvocation([HELPER_ALL_FLAG, HELPER_PHONE_FLAG]).kind === "stdio").toBe(true);
    const bare = resolveHelperInvocation([]);
    expect(bare.kind === "stdio" && bare.phone).toBe(false);
  });

  it("says at startup that the door is armed and NOT open", () => {
    expect(HELPER_PHONE_BANNER).toContain("not open");
    expect(HELPER_PHONE_BANNER).toContain("QR code");
  });
});

/**
 * T1343b — ONE COMMAND TO REMEMBER, AND IT IS STILL AN EXPLICIT GRANT.
 *
 * What these assert is not "the parser parses". It is the RULING: `--all` folds in two
 * SECURITY GRANTS — a shell spawner and a pixel/readback reader — so (a) it must fold them
 * in, (b) a BARE invocation must be untouched by its existence, (c) the process must SAY
 * what it opened, because a grant the user cannot see is a grant they cannot revoke, and
 * (d) the contradiction with `--devices-only` must be refused by name rather than resolved
 * by precedence. Each of those can regress independently and silently.
 */
describe("`--all` opens every door, and only when asked (T1343b)", () => {
  it("folds in the terminal and the export grant, which no other single flag does", () => {
    const all = resolveHelperInvocation([HELPER_ALL_FLAG]);
    expect(all.kind).toBe("stdio");
    if (all.kind !== "stdio") return;
    expect(all.terminal).toBe(true);
    expect(all.grantExport).toBe(true);
  });

  /*
   * THE LOAD-BEARING ONE. Anyone who has ever typed the bare command — or put it in a
   * script — gets the same process they got before `--all` existed. If this goes red, the
   * convenience became a default and every existing invocation silently grew a shell door.
   */
  it("leaves the bare invocation exactly as it was: no shell, no pixels", () => {
    const bare = resolveHelperInvocation([]);
    expect(bare.kind).toBe("stdio");
    if (bare.kind !== "stdio") return;
    expect(bare.terminal).toBe(false);
    expect(bare.grantExport).toBe(false);
    expect(bare.banner).toBeNull();
  });

  it("still honours each flag on its own, so --all is additive and not a replacement", () => {
    const terminalOnly = resolveHelperInvocation([HELPER_TERMINAL_FLAG]);
    expect(terminalOnly.kind === "stdio" && terminalOnly.terminal).toBe(true);
    expect(terminalOnly.kind === "stdio" && terminalOnly.grantExport).toBe(false);
    const exportOnly = resolveHelperInvocation(["--grant-export"]);
    expect(exportOnly.kind === "stdio" && exportOnly.grantExport).toBe(true);
    expect(exportOnly.kind === "stdio" && exportOnly.terminal).toBe(false);
    const devicesTerminal = resolveHelperInvocation([HELPER_DEVICES_ONLY_FLAG, HELPER_TERMINAL_FLAG]);
    expect(devicesTerminal).toEqual({ kind: "devices", terminal: true, phone: false, force: false });
  });

  /*
   * The announcement is the condition the ruling attached to the convenience, so it is
   * asserted by CONTENT and not merely as non-null: a reader who did not enumerate the
   * doors has to find the two grants and the way back out in this one line.
   */
  it("says what it opened, naming both grants and the way to not have them", () => {
    const all = resolveHelperInvocation([HELPER_ALL_FLAG]);
    expect(all.kind === "stdio" && all.banner).toBe(HELPER_ALL_BANNER);
    expect(HELPER_ALL_BANNER).toContain("shells as you");
    expect(HELPER_ALL_BANNER).toContain("readback buffers");
    // The revocation: the bare command, named, as the thing that opens neither.
    expect(HELPER_ALL_BANNER).toContain(DEVICE_HELPER_COMMAND);
  });

  it("refuses --all --devices-only BY NAME and starts nothing, in either argument order", () => {
    for (const args of [
      [HELPER_ALL_FLAG, HELPER_DEVICES_ONLY_FLAG],
      [HELPER_DEVICES_ONLY_FLAG, HELPER_ALL_FLAG],
      [HELPER_DEVICES_ONLY_FLAG, HELPER_ALL_FLAG, HELPER_TERMINAL_FLAG],
    ]) {
      expect(resolveHelperInvocation(args), `precedence decided ${args.join(" ")}`).toEqual({
        kind: "refused",
        reason: HELPER_ALL_DEVICES_ONLY_REFUSAL,
      });
    }
    // BY NAME: both flags, and both of the commands the reader could have meant instead.
    expect(HELPER_ALL_DEVICES_ONLY_REFUSAL).toContain(HELPER_ALL_FLAG);
    expect(HELPER_ALL_DEVICES_ONLY_REFUSAL).toContain(HELPER_DEVICES_ONLY_FLAG);
    expect(HELPER_ALL_DEVICES_ONLY_REFUSAL).toContain(DEVICE_HELPER_ALL_COMMAND);
    expect(HELPER_ALL_DEVICES_ONLY_REFUSAL).toContain(DEVICE_HELPER_DEVICES_ONLY_COMMAND);
  });
});

/**
 * T1344b — THE README IS OUTSIDE `src/`, WHICH IS EXACTLY HOW IT FELL BEHIND.
 *
 * ## The failure this exists for, as it actually happened
 *
 * `--terminal` shipped in §T1263 with its own door, its own opt-in flag and its own copy,
 * and the README never learned about it — the word appeared NOWHERE in 240 lines that
 * documented `pnpm helper`, `--devices-only` and `--grant-export`. The T1110 gate above
 * walks `src/` and cannot see a file one directory up, so the one document a new user reads
 * first is the one document nothing checked.
 *
 * ## Why this gate and not a bigger one
 *
 * §V1003's amendment says a gate nobody runs is worse than none, and this project's CI runs
 * no tests at all. So this is deliberately the cheapest thing that would have caught it: a
 * `readFileSync` and a substring, in a file ALREADY named in `test:gates` — no new script
 * entry, no `gate-list` exemption, nothing anyone has to remember to run. The subjects are
 * DERIVED from the module's own exports rather than listed here, so the fifth command
 * constant somebody adds is red in the README on the day they add it, which is the property
 * a hand-maintained list would not have.
 *
 * ## Blind spot, stated
 *
 * This proves the README SPELLS each command correctly, not that the prose around it is
 * true. A section that describes `--terminal` wrongly still passes. What it removes is the
 * silent case — a command that exists in the product and is absent from, or misspelled in,
 * the document that teaches it.
 */
describe("the README spells every helper command the product builds (T1344b)", () => {
  const readme = readFileSync(resolve(SRC, "..", "README.md"), "utf8");

  /** Every `DEVICE_HELPER_*_COMMAND` export: what a human is told to type. */
  const commands = Object.entries(helperModule)
    .filter(
      (entry): entry is [string, string] =>
        /^DEVICE_HELPER(_[A-Z_]+)?_COMMAND$/.test(entry[0]) && typeof entry[1] === "string",
    )
    .sort(([a], [b]) => a.localeCompare(b));

  it("found the commands to check by reading the module, not a list kept here", () => {
    // The floor, said out loud (§V739): a filter that stopped matching would make the
    // assertion below vacuously green rather than loudly red.
    expect(commands.map(([name]) => name)).toContain("DEVICE_HELPER_ALL_COMMAND");
    expect(commands.length).toBeGreaterThan(1);
  });

  it("spells each one exactly as helper.ts builds it", () => {
    const missing = commands.filter(([, command]) => !readme.includes(command));
    expect(
      missing.map(([name, command]) => `${name} (\`${command}\`)`),
      "README.md is outside src/, so the T1110 scan above cannot reach it. Write these " +
        "commands into README.md, or this document teaches a command the product does not have",
    ).toEqual([]);
  });

  /*
   * The retired name, for the same reason the `src/` scan looks for it. The README may
   * SAY the alias exists (it does, in a sentence explaining that an old config keeps
   * working) but must not hand it out as the command to run, which is what the `pnpm `
   * prefix distinguishes — the same distinction the scan above draws.
   */
  it("hands out the current script name and not the retired one", () => {
    const mentions = readme
      .split("\n")
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => line.includes(RETIRED_COMMAND));
    expect(mentions.map(([line, text]) => `${String(line)}: ${text.trim()}`)).toEqual([]);
  });
});

describe("the devices-only helper never registers the terminal role unless told to (T1263, §T1111)", () => {
  it("refuses `terminalAttach` by name with the door's default construction — the right code kept", async () => {
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-helper-"));
    const helper = createDeviceHelper({
      port: 0,
      handoffDir,
      // The DEFAULT doors, with only the OS's UDP replaced: no `terminal` option at all,
      // which is what `pnpm helper --devices-only` builds without `--terminal`.
      doors: createDeviceDoors({
        udpSocketFactory: () => {
          throw new Error("no UDP in this test");
        },
      }),
    });
    try {
      const deadline = Date.now() + 5_000;
      while (helper.status().port == null) {
        if (Date.now() > deadline) throw new Error("the helper never bound a port");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const socket = new WebSocket(`ws://127.0.0.1:${String(helper.status().port)}`);
      const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "terminalAttach", code: helper.pairingCode }));
        };
        socket.onmessage = (event: MessageEvent) => {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        };
        setTimeout(() => reject(new Error("no answer")), 5_000);
      });
      socket.close();
      expect(answer["type"]).toBe("refused");
      expect(answer["terminalUnavailable"]).toBe(true);
      expect(String(answer["reason"])).toContain(DEVICE_HELPER_TERMINAL_COMMAND);
    } finally {
      helper.dispose();
      rmSync(handoffDir, { recursive: true, force: true });
    }
  });
});
