import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * §V957 / T1273 — THE LIST OF GATES NOTHING ELSE CAN FIND CANNOT ITSELF BE HAND-MAINTAINED.
 *
 * `test:gates` exists because a gate that discovers its subjects by walking the SOURCE TREE
 * has no import edge from the file you edited: `vitest related`, a scoped path run and the
 * module graph all miss it by construction, not by accident. The remedy was a list in
 * `package.json` — and a hand-maintained list of the things nothing can find is one edit
 * away from being wrong. It already was: `layout.test.ts` walks the document set, was never
 * on it, and §V389 sat red on two freshly-landed rows (E35 an hour old, E24 three commits
 * back) while every scoped run passed. §T1272 found that by accident, running a different
 * sweep. That is the whole argument for this file.
 *
 * So the list is derived from here down: any test that calls `readdirSync` or
 * `import.meta.glob` to find its subjects must be NAMED in the script, or exempted BY NAME
 * with a reason. Both directions are checked — an exemption that no longer describes a
 * walker is as much a lie as a missing entry.
 *
 * WHAT THIS CANNOT DERIVE, and why it is a list rather than a rule. A DOCUMENT-SET gate
 * (`layout.test.ts` reads every shipped document; `doc-drift.test.ts` reads every shipped
 * `.md`) reaches its subjects through an ordinary import, so it is indistinguishable by
 * static shape from the sixty-odd example tests that import the same barrel to make a claim
 * about ONE example. Those stay a named set below, and the honest statement is that this
 * gate mechanises the class it can see and records the rest where a reader will find it.
 *
 * THE BUDGET IS PART OF THE CONTRACT. `test:gates` is the run every session makes before
 * every commit, so it has to stay in seconds — the whole point is that it is cheaper than
 * knowing which gates your change could reach. Measured when this landed: the fourteen
 * files added here cost 3.3 s together, against ~10 s for the thirteen that were already
 * on it. A candidate that is NOT cheap does not belong in this script — say so and give it
 * its own, rather than making the thing sessions run every time slow enough to skip.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const SOURCE = join(ROOT, "src");

/**
 * Walkers that are NOT gates of this class, each with the reason it looks like one.
 *
 * An exemption is a claim about a file, so it is checked in both directions: if the file
 * stops matching the detector the entry is stale and this gate says so.
 */
const NOT_A_TREE_WALKING_GATE: Readonly<Record<string, string>> = {
  "src/devices/device-bridge.test.ts":
    "the readdirSync reads a temp handoff directory this test itself created — its subjects are its own fixtures, and it imports the bridge it checks",
};

/** Files whose subjects are the DOCUMENT SET rather than the tree (see the docblock). */
const DOCUMENT_SET_GATES: readonly string[] = [
  "src/examples/layout.test.ts",
  "src/examples/doc-drift.test.ts",
  // B207: it walks the SHIPPED COMPONENT SET through `catalogue.ts`, so adding a component
  // (T1276, Antialias) left its roster stale and no scoped run of the component's own files
  // could reach it.
  "src/examples/component-port-names.test.ts",
  // T1303b: it reads every shipped concept doc against its graph (B83, §V332). 9f1a23b
  // removed E24's last valueLimit and a HYPOTHETICAL sentence naming one went stale — a
  // change that never touched the sentence's subject, found only by a session running it
  // for another reason.
  "src/examples/doc-claims.test.ts",
];

function testFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...testFiles(path));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Comments are stripped before the detector runs, and that is not tidiness: one file
 * (`agent-library-port.test.tsx`) DESCRIBES the corpus glob in prose while importing what
 * it checks, and a detector that reads prose would have demanded it join a list it does not
 * belong on. A gate that cries wolf gets an exemption written for it, which is how a
 * derived list quietly becomes a hand-maintained one again.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const DISCOVERS_BY_WALKING = /\breaddirSync\s*\(|import\.meta\.glob\s*\(/;

const walkers = testFiles(SOURCE)
  .filter((path) => DISCOVERS_BY_WALKING.test(withoutComments(readFileSync(path, "utf8"))))
  .map((path) => relative(ROOT, path))
  .sort();

const script = (() => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const line = manifest.scripts?.["test:gates"];
  if (line === undefined) throw new Error("package.json has no `test:gates` script");
  return line;
})();

const listed = script
  .split(/\s+/)
  .filter((token) => /^src\/.*\.test\.tsx?$/.test(token))
  .sort();

describe("§V957 — the `test:gates` list is derived, not remembered (T1273)", () => {
  it("names every test that discovers its subjects by walking the source tree", () => {
    const missing = walkers.filter(
      (path) => !listed.includes(path) && NOT_A_TREE_WALKING_GATE[path] === undefined,
    );
    expect(
      missing,
      "These tests walk the source tree, so no dependency-graph selector can reach them " +
        "(§V957) and only `pnpm test:gates` will ever run them. Add each to the `test:gates` " +
        "script in package.json — or, if it is not a gate of this class, add it to " +
        "NOT_A_TREE_WALKING_GATE here with the reason it looks like one. If it is a gate but " +
        "NOT cheap, give it its own script instead: this one runs before every commit.",
    ).toEqual([]);
  });

  it("names the document-set gates, which no static rule can tell from an example's own test", () => {
    // These reach their subjects through an ordinary import, so `vitest related` finds them
    // but a scoped PATH run does not — which is how §V389 stayed red through two landings.
    const missing = DOCUMENT_SET_GATES.filter((path) => !listed.includes(path));
    expect(missing, "a document-set gate named here is missing from the `test:gates` script").toEqual([]);
  });

  it("keeps every exemption honest: an exempted file must exist and still look like a walker", () => {
    for (const [path, reason] of Object.entries(NOT_A_TREE_WALKING_GATE)) {
      expect(reason.length, `${path}'s exemption has no reason`).toBeGreaterThan(20);
      expect(
        walkers,
        `${path} is exempted from the walker rule but no longer matches it — delete the exemption`,
      ).toContain(path);
    }
  });

  it("does not name a test that has been moved or deleted", () => {
    const gone = listed.filter((path) => !existsUnderRoot(path));
    // A renamed gate drops silently out of a string-typed script: the command still exits 0
    // with one fewer file in it, which is the failure mode this whole row is about.
    expect(gone, "the `test:gates` script names files that do not exist").toEqual([]);
  });
});

function existsUnderRoot(path: string): boolean {
  try {
    readFileSync(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
}
