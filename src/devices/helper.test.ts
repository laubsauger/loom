import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DEVICE_HELPER_COMMAND,
  DEVICE_HELPER_DEVICES_ONLY_COMMAND,
  DEVICE_HELPER_TERMINAL_COMMAND,
  HELPER_DEVICES_ONLY_FLAG,
  HELPER_SCRIPT,
  HELPER_TERMINAL_FLAG,
  TERMINAL_PANE_HINT,
} from "./helper.ts";
import { createDeviceDoors } from "./doors.ts";
import { createDeviceHelper } from "../mcp/serve.ts";

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
  it("builds the terminal command from the same script name, and the pane hint from it", () => {
    expect(DEVICE_HELPER_TERMINAL_COMMAND).toBe(`${DEVICE_HELPER_COMMAND} ${HELPER_TERMINAL_FLAG}`);
    expect(TERMINAL_PANE_HINT).toContain(DEVICE_HELPER_TERMINAL_COMMAND);
    expect(TERMINAL_PANE_HINT).toContain(`${DEVICE_HELPER_DEVICES_ONLY_COMMAND} ${HELPER_TERMINAL_FLAG}`);
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
