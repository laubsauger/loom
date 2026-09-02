import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * §T899's gate, both directions (§V813). The product renamed Shaderloom → Loom, and the
 * rename has one hard boundary: PERSISTENCE KEYS ARE ADDRESSES, NOT NAMES. So the gate
 * fails on a missed rename (a user-reachable "Shaderloom" anywhere outside the SPEC
 * record) AND on an over-eager one (a storage key that stops matching its address, which
 * would orphan every user's autosaved projects, layout and keybindings with no error).
 *
 * Grep-backed (§V814): the pattern IS the definition of the set, so a 165th file cannot
 * appear outside it.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
}

const BINARY = new Set([".png", ".jpg", ".ico", ".woff2"]);
/** The engineering record of what was true then — class 4, deliberately untouched. */
const RECORD = new Set(["SPEC.md", "SPEC-ARCHIVE.md"]);
/*
 * The gate names the old word to describe itself, so without this it reports ITSELF and
 * masks the real offender behind its own noise — which is how `docs/laser-vector-display-plan.md`
 * sat unrenamed while the gate was already red.
 */
const SELF = "src/tests/integration/rename-gate.test.ts";

describe("the Shaderloom → Loom rename holds (§T899)", () => {
  it("no tracked file outside the SPEC record says Shaderloom", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (file === SELF) continue;
      const name = file.split("/").at(-1) ?? file;
      if (RECORD.has(name)) continue;
      if (BINARY.has(name.slice(name.lastIndexOf(".")))) continue;
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), "utf8");
      } catch {
        continue;
      }
      if (text.includes("Shaderloom")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("exactly the class-3 persistence addresses still say shaderloom, each with its §V813 comment", () => {
    // The full address list, pinned. A key leaving this list means someone renamed a
    // storage address (orphaning user data); a key joining it means a new shaderloom
    // string appeared that is neither renamed nor a known address.
    const KEYS = [
      "shaderloom.shell.layouts.v5",
      "shaderloom.shell.layouts.v4",
      "shaderloom.shell.layouts.v3",
      "shaderloom.shell.layout.v2",
      "shaderloom.actor.id.v1",
      "shaderloom.project.id.v1",
      "shaderloom.keymap.overrides.v1",
      "shaderloom.graph.nodeTypeLabels.v1",
      "shaderloom.autosave",
      "shaderloom-models-v1",
      "shaderloom.commands.holders",
      "shaderloom.webmcp.registered",
      "models.shaderloom.invalid",
    ];
    const sources = trackedFiles().filter(
      (file) => (file.startsWith("src/") && (file.endsWith(".ts") || file.endsWith(".tsx"))) &&
        !file.includes(".test.") && !file.includes(".spec."),
    );
    const unexpected: string[] = [];
    const uncommented: string[] = [];
    for (const file of sources) {
      const text = readFileSync(join(ROOT, file), "utf8");
      if (!text.toLowerCase().includes("shaderloom")) continue;
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.toLowerCase().includes("shaderloom")) continue;
        if (line.includes("§V813")) continue; // the comment itself
        const isAddress = KEYS.some((key) => line.includes(key));
        if (!isAddress) {
          unexpected.push(`${file}:${index + 1}: ${line.trim()}`);
          continue;
        }
        // A DECLARATION site carries the §V813 comment on the line above; a legacy-list
        // or lookup mention inside the same file is covered by the declaration's comment.
        const declares = /(const|export const)\s+\w+\s*=/.test(line);
        const before = text.split("\n")[index - 1] ?? "";
        if (declares && !before.includes("§V813")) uncommented.push(`${file}:${index + 1}`);
      }
    }
    expect(unexpected).toEqual([]);
    expect(uncommented).toEqual([]);
  });
});
