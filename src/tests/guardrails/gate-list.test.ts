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
 * THE DOCUMENT SET IS DERIVED TOO (T1274). A document-set gate (`layout.test.ts` reads every
 * shipped document, `doc-claims.test.ts` every shipped `.md`) reaches its subjects through an
 * ordinary import, and T1273 left that half as a hand-named set rather than guess at it from
 * the file's contents. The set was 5 of the 36 files that import a document-set ENUMERATOR,
 * and four gates of this class went red unseen in one night (§V957, B207, B214, T1303b). The
 * detector here reads no contents: importing an enumerator is a fact about the file. So every
 * such test is either on the script or exempted BY NAME with what makes it fine to leave off —
 * and a test that looks up one example through the enumerator pays one line for it, once.
 *
 * THE BUDGET IS PART OF THE CONTRACT. `test:gates` is the run every session makes before
 * every commit, so it has to stay in seconds — the whole point is that it is cheaper than
 * knowing which gates your change could reach. Measured when this landed: the fourteen
 * files added here cost 3.3 s together, against ~10 s for the thirteen that were already
 * on it. T1274's seventeen document-set readers took the whole script from 4.6 s to 7.4 s
 * wall, the dearest being app-parity (1.0 s) and frame-compile (0.7 s); the three that would
 * have cost 6–37 s each are exempted by name instead. A candidate that is NOT cheap does
 * not belong in this script — say so and give it
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

/**
 * T1274: the names that hand a test the WHOLE shipped set — every example file, every
 * starter component, every example document, or the directory they live in.
 *
 * `*.gpu.test.ts` files are outside the detector: they need Dawn, cost seconds each, and so
 * can never be on a script that runs before every commit — one rule stated once rather than
 * thirty exemptions saying the same thing. `examples.gpu.test.ts` is the one GPU file that
 * sweeps the whole set, and it runs in the full suite.
 */
const DOCUMENT_SET_ENUMERATORS: ReadonlySet<string> = new Set([
  "listExamples",
  "listStarterComponentFiles",
  "EXAMPLE_DOCUMENTS",
  "EXAMPLE_COMPONENT_IDS",
  "EXAMPLES_DIR",
  "STARTER_COMPONENTS_DIR",
  "buildExampleFiles",
]);

/**
 * Tests that import an enumerator and are NOT on `test:gates`, each with what makes that
 * file fine to leave off. Checked in both directions, like the walker exemptions above.
 */
const NOT_A_CHEAP_DOCUMENT_SET_GATE: Readonly<Record<string, string>> = {
  "src/examples/liveness.test.ts":
    "renders every shipped document over a frame window — 37 s measured at T1274, ten times the whole gate script; it runs in the full suite",
  "src/tests/headless/cook-oracle.test.ts":
    "renders every example twice for 80 frames under two cook policies — 37 s measured at T1274; it runs in the full suite",
  "src/examples/runner.test.ts":
    "runs every example through the runner, 601 cases in 6.6 s measured at T1274 — more than the whole gate script; it runs in the full suite",
  "src/examples/vesper-claims.test.ts":
    "reads only E56-Vesper, found by file name; 6 s of rendering claims about that one example",
  "src/examples/concepts/e47-hologram.test.ts": "reads only E47-Hologram, found by file name",
  "src/examples/concepts/e52-presence.test.ts": "reads only E52-Presence, found by file name",
  "src/examples/concepts/e53-two-cuts.test.ts": "reads only E53-Two-Cuts, found by file name",
  "src/app/starter-document.test.ts": "reads only the one example the app opens on first run, found by file name",
  "src/app/use-model-inference.test.tsx": "reads only the E44 Sounding document, found by name",
  "src/nodes/definitions/annotate.test.ts": "reads only E24, found by file name, to test the Annotate node on it",
  "src/examples/relay-circuit.test.ts": "reads only the E64 Relay document, found by project id",
  "src/tests/headless/audio-replay.test.ts": "reads only the E24 document, found by name, as an audio replay fixture",
  "src/tests/headless/audio-offline-scrub.test.ts":
    "reads only the E24 document, found by name, as an offline-scrub fixture",
  "src/tests/headless/audio-track-replay.test.ts":
    "reads only the E24 document, found by name, as a track-replay fixture",
  "src/tests/integration/camera-gizmo-corruption.test.ts":
    "reads only E69-Burnish, found by file name — the one catalogue camera with no bare `eye` at all",
};

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

/** Named, non-type imports only: `import type` carries no set, and prose is stripped first. */
function importsAnEnumerator(source: string): boolean {
  for (const clause of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    if (clause[1] !== undefined) continue;
    for (const specifier of (clause[2] ?? "").split(",")) {
      const name = specifier.trim();
      if (name.startsWith("type ")) continue;
      if (DOCUMENT_SET_ENUMERATORS.has(name.split(/\s+as\s+/)[0] ?? "")) return true;
    }
  }
  return false;
}

const setReaders = testFiles(SOURCE)
  .filter((path) => !path.endsWith(".gpu.test.ts"))
  .filter((path) => importsAnEnumerator(withoutComments(readFileSync(path, "utf8"))))
  .map((path) => relative(ROOT, path))
  .sort();

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

  it("names every test that imports the whole shipped set (T1274)", () => {
    // These reach their subjects through an ordinary import, so a scoped PATH run of the
    // document you edited never reaches them — which is how §V389, B207 and T1303b sat red.
    const missing = setReaders.filter(
      (path) => !listed.includes(path) && NOT_A_CHEAP_DOCUMENT_SET_GATE[path] === undefined,
    );
    expect(
      missing,
      "These tests import a document-set enumerator (DOCUMENT_SET_ENUMERATORS), so a change to " +
        "any shipped example can break them and no scoped run of that example's files will say " +
        "so. Add each to the `test:gates` script — or, if it reads one example only or is not " +
        "cheap, add it to NOT_A_CHEAP_DOCUMENT_SET_GATE here with what makes it fine to leave off.",
    ).toEqual([]);
  });

  it("keeps every document-set exemption honest: the file must still import an enumerator", () => {
    for (const [path, reason] of Object.entries(NOT_A_CHEAP_DOCUMENT_SET_GATE)) {
      expect(reason.length, `${path}'s exemption has no reason`).toBeGreaterThan(20);
      expect(
        setReaders,
        `${path} is exempted as a document-set reader but no longer imports an enumerator — delete the exemption`,
      ).toContain(path);
      expect(listed, `${path} is exempted AND on the script — pick one`).not.toContain(path);
    }
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
