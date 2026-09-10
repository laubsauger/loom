import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listExamples } from "./catalogue.ts";
import { matchesOnlyFlag } from "./only-flag.ts";

/**
 * `--only` is the ONE scoping guard every session is told to use before regenerating an
 * example (T698, §V345), and B197 found it was not a guard: `fileName.includes(only)` made
 * `--only E2` regenerate `E2-Reaction-Diffusion` AND `E20`, `E24`-`E29`, sweeping seven
 * other sessions' in-flight documents into the shipped bytes.
 *
 * So the property under test is the one a caller reads back — WHICH FILES A GIVEN ARGUMENT
 * SELECTS — measured against the real shipped corpus rather than an invented list, because
 * the bug was about the names that actually exist next to each other. The E2x files must
 * be present in that corpus for the E-number case to prove anything at all, so their
 * presence is asserted first (§V910: a checker that condemned everything would pass a
 * vacuous version of this).
 *
 * Nothing here writes: the selection is the predicate, and the no-match case is exercised
 * through the real script, which now throws BEFORE the first `writeFileSync`.
 */

const shippedNames = listExamples().map((file) => file.fileName);
const selectedBy = (only: string): readonly string[] =>
  shippedNames.filter((fileName) => matchesOnlyFlag(fileName, only));

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("--only matches an example, not a substring (T1267, B197)", () => {
  it("--only E2 selects E2-Reaction-Diffusion and leaves E20-E29 alone", () => {
    /* Non-vacuity: these are the seven files B197 actually swept, and every one of them
       CONTAINS the string "E2" — so the old substring rule took them and a guard that
       merely failed to find them would prove nothing. */
    const twentiesInCorpus = shippedNames.filter((name) => /^E2\d-/.test(name));
    expect(twentiesInCorpus.length).toBeGreaterThan(1);
    expect(twentiesInCorpus.every((name) => name.includes("E2"))).toBe(true);

    expect(selectedBy("E2")).toEqual(["E2-Reaction-Diffusion.loom.json"]);
  });

  it("--only E2-Reaction still selects E2-Reaction-Diffusion", () => {
    // A named argument is not the E-number form, so it keeps substring matching — this is
    // the workaround B197 told sessions to use and it must not have been broken by the fix.
    expect(selectedBy("E2-Reaction")).toEqual(["E2-Reaction-Diffusion.loom.json"]);
  });

  it("--only Reaction still selects by substring, across both files that carry the word", () => {
    expect(selectedBy("Reaction")).toEqual([
      "E2-Reaction-Diffusion.loom.json",
      "E24-Audio-Reaction-Diffusion.loom.json",
    ]);
  });

  it("--only <no match> throws through the real script without writing a byte", () => {
    const before = shippedNames.map((name) => statSync(`${REPO_ROOT}examples/${name}`).mtimeMs);

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "./src/tooling/alias-hooks.ts",
        "src/examples/build-examples.ts",
        "--only",
        "NoSuchExample",
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--only NoSuchExample matched no example");
    // The throw moved ahead of the write loop, so a mistyped scope cannot half-regenerate.
    expect(shippedNames.map((name) => statSync(`${REPO_ROOT}examples/${name}`).mtimeMs)).toEqual(before);
  });
});
