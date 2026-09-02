import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * T933, in the shape §V814 asks for: not a list of the readers I happened to find, but a
 * pattern that IS the definition of the set.
 *
 * `projectFps()` was written so the project's rate has ONE answer and the default is
 * applied once. It had two callers when it was written and three readers in the tree:
 * the settings pane, the clock, and the render loop — and the render loop, the one
 * nobody counted, read the raw field. An absent `fps` therefore meant 60 to everything
 * that asked properly and "unpaced" to the thing that actually drew, which is the state
 * every shipped document was in.
 *
 * So the closure is enforced rather than remembered. The set this scans is "source that
 * reads the rate field off something named settings", and the pattern is that sentence:
 * a member read, or a destructure, of `fps` from a `settings`-shaped identifier.
 *
 * TWO SCOPE DECISIONS, both deliberate and both stated rather than silent:
 *
 *  - COMMENTS ARE STRIPPED FIRST. Prose that names the field by its real name is how the
 *    docblocks explain the rule; a gate that forbade writing it down would be paid for in
 *    worse documentation.
 *  - TESTS ARE NOT SCANNED. A test asserting `runtime.settings.fps === 30` is checking
 *    what was WRITTEN to the document, which is a different question from "what rate is
 *    this project" — the one this closure is about.
 *
 * §T926's lesson is honoured structurally: the forbidden spellings are assembled from
 * pieces here, so this file cannot contain the text it forbids and can always pass.
 */

const FIELD = "fps";
/** `settings.<field>`, `registration.settings.<field>`, `ProjectSettings.<field>`, … */
const MEMBER_READ = new RegExp(String.raw`\b[\w$.]*[Ss]ettings\.` + FIELD + String.raw`\b`);
/** `const { <field>, … } = settings` and its relatives. */
const DESTRUCTURED = new RegExp(
  String.raw`\{[^}\n]*\b` + FIELD + String.raw`\b[^}\n]*\}\s*=\s*[\w$.]*[Ss]ettings\b`,
);

/** Where the default is allowed to be applied — `projectFps`'s own body. */
const DEFINITION_SITE = "src/domain/types/graph.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Comments carry the explanation, never the read. Blanked rather than deleted, so the
 * line number in a failure is the line number in the file — a gate that names the wrong
 * line sends its reader to the wrong place, which is most of what a gate is for.
 */
function code(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/.*)$/gm, (_all, before: string, comment: string) => before + blank(comment));
}

describe("every reader of the project rate goes through projectFps (T933, §V814)", () => {
  it("no source outside projectFps reads the rate field off a settings object", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const relative = file.slice(ROOT.length).replace(/^\//, "");
      if (relative === DEFINITION_SITE) continue;
      const body = code(readFileSync(file, "utf8"));
      for (const [index, line] of body.split("\n").entries()) {
        if (MEMBER_READ.test(line) || DESTRUCTURED.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    // Named, not counted: a new one has to be read and decided on, not diffed away.
    expect(offenders).toEqual([]);
  });

  it("the patterns catch what they claim to — a gate that matches nothing is not a gate", () => {
    const member = ["const target = registration.settings.", FIELD, ";"].join("");
    const destructure = ["const {", FIELD, ", frameRange } = project.settings;"].join("");
    expect(MEMBER_READ.test(member)).toBe(true);
    expect(DESTRUCTURED.test(destructure)).toBe(true);
    // And they do not fire on the readers that are asking a different question.
    expect(MEMBER_READ.test("const rate = request.fps ?? projectFps(settings);")).toBe(false);
    expect(MEMBER_READ.test('readonly settings: Pick<ProjectSettings, "fps">;')).toBe(false);
    expect(MEMBER_READ.test("const step = 1 / options.fps;")).toBe(false);
  });

  it("the definition site is real — the scan would fail without its exemption", () => {
    const body = code(readFileSync(join(ROOT, DEFINITION_SITE), "utf8"));
    expect(body.split("\n").some((line) => MEMBER_READ.test(line))).toBe(true);
  });
});
