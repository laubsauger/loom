import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { listExamples, listStarterComponentFiles } from "./catalogue.ts";
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
 * Nothing here writes into `examples/`: the selection is the predicate, the no-match case
 * is exercised through the real script (which throws BEFORE the first `writeFileSync`),
 * and the runs that DO write go to a temp `--out` directory.
 *
 * T1221 is the second half of the same complaint, and it is NOT in the predicate: the
 * script skipped the component half outright under `--only`, so the only shipped route to
 * regenerate a starter component was the unscoped run the contention rule forbids. A
 * predicate test cannot see that, so those cases spawn the real script and assert the set
 * of files it actually wrote.
 *
 * Which is also why this file is named in `test:gates` (§V957, T1273): the script it now
 * checks WRITES ON IMPORT, so nothing imports it, so no module-graph selector reaches this
 * file from an edit to `build-examples.ts` — the one file whose regressions cost other
 * sessions their in-flight work.
 */

const shippedNames = listExamples().map((file) => file.fileName);
const shippedComponentNames = listStarterComponentFiles().map((file) => file.fileName);
const selectedBy = (only: string): readonly string[] =>
  shippedNames.filter((fileName) => matchesOnlyFlag(fileName, only));

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/* A directory the run never reached counts as "wrote nothing there", so a run that wrote
   the wrong half fails as a file-list diff rather than as an ENOENT from the test itself. */
const looms = (directory: string): readonly string[] =>
  existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".loom.json"))
        .sort()
    : [];

/** Every shipped path the regenerator could overwrite, with the mtime it has right now. */
const shippedMtimes = (): Record<string, number> =>
  Object.fromEntries([
    ...shippedNames.map((name) => [`examples/${name}`, statSync(`${REPO_ROOT}examples/${name}`).mtimeMs] as const),
    ...shippedComponentNames.map(
      (name) =>
        [`components/${name}`, statSync(`${REPO_ROOT}examples/components/${name}`).mtimeMs] as const,
    ),
  ]);

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

/** Runs the real regenerator into a fresh temp directory and returns what it wrote. */
function regenerateInto(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly out: string;
  readonly examples: readonly string[];
  readonly components: readonly string[];
} {
  const out = mkdtempSync(join(tmpdir(), "loom-only-"));
  temporaryDirectories.push(out);
  const before = shippedMtimes();

  const run = spawnSync(
    process.execPath,
    ["--import", "./src/tooling/alias-hooks.ts", "src/examples/build-examples.ts", ...args, "--out", out],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  /* The point of `--out` is that a gate for the regenerator never regenerates: if this
     ever fails, the test itself has become the sweep it is guarding against. */
  expect(shippedMtimes()).toEqual(before);
  return {
    status: run.status,
    stdout: `${run.stdout}${run.stderr}`,
    out,
    examples: looms(out),
    components: looms(join(out, "components")),
  };
}

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
    const before = shippedMtimes();

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
    expect(run.stderr).toContain("--only NoSuchExample matched no example or component");
    /* The throw is ahead of BOTH write loops, so a mistyped scope cannot half-regenerate —
       and T1221 added a second half it has to stay ahead of. */
    expect(shippedMtimes()).toEqual(before);
  });
});

/**
 * T1221: the flag has to be able to scope the COMPONENT half too, because the alternative
 * it left behind was the unscoped run — the one the project's contention rule forbids for
 * exactly the reason B197 demonstrated. So these assert the file set the script writes,
 * not the predicate: the bug was `only !== undefined ? [] : await buildStarterComponentFiles()`
 * in the script, and a predicate is blind to it.
 */
describe("--only scopes a component regen (T1221, B197, T1267)", () => {
  /* A component addressed by the name it ships under. Derived, not hardcoded, and chosen
     to match NO example so "wrote no example" means the scope held rather than that the
     argument happened to be unpopular — `--only Bloom` legitimately takes two examples
     and a component, which is the substring branch working as designed. */
  const componentStem = shippedComponentNames
    .map((fileName) => fileName.replace(/\.loom\.json$/, ""))
    .find((stem) => shippedNames.every((name) => !matchesOnlyFlag(name, stem)));

  it("--only <component> writes that component and nothing else", () => {
    expect(componentStem).toBeDefined();
    // Non-vacuity: there are peers it could have swept, and it did not.
    expect(shippedComponentNames.length).toBeGreaterThan(1);

    const run = regenerateInto(["--only", componentStem as string]);

    expect(run.status).toBe(0);
    expect(run.components).toEqual([`${componentStem}.loom.json`]);
    expect(run.examples).toEqual([]);
    expect(run.stdout).toContain(`writing 1 component: ${componentStem}.loom.json`);
    expect(run.stdout).toContain("writing 0 examples");
    /* And the scoped route has to produce the bytes the unscoped route would, or it is a
       route to a DIFFERENT file and sessions would be right to distrust it. */
    expect(readFileSync(join(run.out, "components", `${componentStem}.loom.json`), "utf8")).toBe(
      readFileSync(`${REPO_ROOT}examples/components/${componentStem}.loom.json`, "utf8"),
    );
  });

  it("--only E2 still writes that one example and no component (T1267 must not regress)", () => {
    const run = regenerateInto(["--only", "E2"]);

    expect(run.status).toBe(0);
    expect(run.examples).toEqual(["E2-Reaction-Diffusion.loom.json"]);
    // An E-number can only ever name an example: no component file is `E` + digits.
    expect(run.components).toEqual([]);
  });

  it("the unscoped run still writes every example and every component", () => {
    // The release regen. Giving --only a component half must not have narrowed it.
    const run = regenerateInto([]);

    expect(run.status).toBe(0);
    expect(run.examples).toEqual([...shippedNames].sort());
    expect(run.components).toEqual([...shippedComponentNames].sort());
  });
});
