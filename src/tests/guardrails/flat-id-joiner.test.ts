import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * §T1695b (G6) — ONE PLACE JOINS AND SPLITS THE ID OF A NODE INSIDE AN INSTANCE.
 *
 * A node inside a component instance is named `<instance>/<node>` in the flattened document,
 * once per level. The census behind the session rule found eight roads across that boundary
 * and string code of their own in most of them (`docs/component-session-commands-design-
 * 2026-10-06.md` §1.6), and §T1216 had already recorded that `ComponentPath` means two
 * things, for one of which `.join("/")` gives `a/a/b`: a lookup that finds nothing and says
 * nothing. `src/domain/components/addressing.ts` is the one place now, and this is the gate
 * that keeps the next crossing from writing its own.
 *
 * ## How a site is found
 *
 * Every non-test file under the trees that handle documents is read for a line that names
 * `COMPONENT_ID_SEPARATOR`, calls `split`, `join`, `indexOf`, `lastIndexOf`, `includes`,
 * `startsWith` or `endsWith` with the literal `"/"`, or writes `}/${` in a template. Each
 * file with such a line is in exactly one of three lists:
 *
 *  - `THE_JOINER`: the modules whose job it is.
 *  - `OWED`: files that still build or take apart a flattened id by hand, with how many
 *    lines. The count must match, so it can only be brought down, and a file leaves the
 *    list when it reaches the addressing module. A NEW file fails by name.
 *  - `NOT_A_NODE_PATH`: files whose slashes are something else, with what.
 *
 * ## What it cannot see
 *
 * A flattened id built without any of those forms (`[a, b].join(SEP)` under another name,
 * string concatenation with `+`), and a new id join added to a file already listed under
 * `NOT_A_NODE_PATH`. It reads the tree rather than importing what it checks, so no
 * dependency selector finds it: it is on `test:gates` (§V957).
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const TREES = ["src/app", "src/editor", "src/compiler", "src/domain", "src/agent"];
const SITE = /(?:split|join|indexOf|lastIndexOf|includes|startsWith|endsWith)\(\s*"\/"\s*\)|\}\/\$\{|COMPONENT_ID_SEPARATOR/;

const THE_JOINER: Readonly<Record<string, string>> = {
  "src/domain/components/addressing.ts": "the address of a node of an instance, both ways",
  "src/domain/components/internal-resolutions.ts": "the separator itself, `flattenedNodeId`, and the codec of an instance's stored resolution overrides",
  "src/domain/components/internal-channel-masks.ts": "the codec of an instance's stored channel-mask overrides, keyed like the resolutions",
  "src/compiler/flatten.ts": "the flattening, which mints the ids, and `componentPathOf`",
  "src/compiler/index.ts": "a re-export",
};

/** Hand-written joins and splits of a flattened id, by file and line count. It only goes down. */
const OWED: Readonly<Record<string, number>> = {
  // The dived panes' prefix for reads of the plan (§T1019, §T1202): §T1697b.
  "src/app/graph-pane.tsx": 2,
  "src/app/side-panes.tsx": 1,
  "src/app/use-node-previews.ts": 3,
  "src/editor/viewer/preview-orbit-store.ts": 1,
  // The inspector's road to a published value's owner (design doc §1.6, road 6): §T1697b.
  "src/app/use-component-editing.ts": 2,
  // Root-side decoding of a flat id, to move onto the flattening's `ComponentSource`: §T1697b.
  "src/domain/commands/node-output-commands.ts": 3,
  "src/app/use-requirement-diagnostics.ts": 1,
  "src/app/use-file-references.ts": 1,
  "src/compiler/document-findings.ts": 2,
  "src/domain/components/commands.ts": 2,
  "src/editor/agent/describe-operation.ts": 1,
};

const NOT_A_NODE_PATH: Readonly<Record<string, string>> = {
  "src/app/audio-analysis-frame.ts": "two counts in an error message",
  "src/app/audio-analysis.worklet.ts": "two sizes in an error message",
  "src/app/audio-offline-analysis.ts": "two rates in an error message",
  "src/app/use-mesh-sources.ts": "a mesh's sizes, as a memo key",
  "src/app/use-osc-bridge.ts": "an OSC address",
  "src/app/whip-publisher.ts": "a WHIP endpoint's URL",
  "src/domain/audio/analysis/stft.ts": "two sizes in an error message",
  "src/domain/components/instance.ts": "an instance's internal PARAMETER path, `<node>/<key>`",
  "src/domain/components/save-selection.ts": "a node and one of its ports, as a map key",
  "src/domain/media/file-reference.ts": "a retained file's URI",
  "src/domain/media/picture-file.ts": "a file path",
  "src/domain/mesh/glb.ts": "an accessor's types in an error message",
  "src/domain/osc/osc-address.ts": "an OSC address",
  "src/domain/parameters/slots.ts": "a map slot's `port/attribute` text",
  "src/domain/types/ids.ts": "an output: a node and one of its ports",
  "src/editor/component/breadcrumb-trail.tsx": "a React key",
  "src/editor/component/starter-set.ts": "a file path",
  "src/editor/controls/reset-all.tsx": "three counts, as a memo key",
  "src/editor/inspect/pipeline-model.ts": "a row's text",
  "src/editor/inspector/component-section.tsx": "a React key",
  "src/editor/library/example-catalogue.ts": "a file path",
};

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(join(ROOT, directory))) {
      const path = `${directory}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.gpu\.|test-support|testing/.test(path)) found.push(path);
    }
  };
  TREES.forEach(walk);
  return found.sort();
}

/** file → the number of lines that join or split on a slash. Comment lines are not code. */
function sites(): Map<string, number> {
  const counted = new Map<string, number>();
  for (const file of sourceFiles()) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    const hits = lines.filter((line) => SITE.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line)).length;
    if (hits > 0) counted.set(file, hits);
  }
  return counted;
}

describe("§T1695b — one place joins and splits the id of a node inside an instance", () => {
  const found = sites();

  it("reads the tree it claims to", () => {
    // The module itself must be among what was found, or the walk read nothing (§V707).
    expect(found.has("src/domain/components/addressing.ts")).toBe(true);
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it("every file that joins or splits on a slash is the joiner, owed, or something else by name", () => {
    const unknown = [...found.keys()].filter((file) => THE_JOINER[file] === undefined && OWED[file] === undefined && NOT_A_NODE_PATH[file] === undefined);
    expect(unknown, "a new slash join: reach `addressing.ts`, or say in NOT_A_NODE_PATH what the slash is").toEqual([]);
  });

  it("what is owed is owed exactly: a file that got better leaves the list, and none got worse", () => {
    const drifted = Object.entries(OWED)
      .filter(([file, count]) => (found.get(file) ?? 0) !== count)
      .map(([file, count]) => `${file}: listed ${count}, found ${found.get(file) ?? 0}`);
    expect(drifted).toEqual([]);
  });

  it("no list names a file that has no such line any more, or names one twice", () => {
    const listed = [...Object.keys(THE_JOINER), ...Object.keys(OWED), ...Object.keys(NOT_A_NODE_PATH)];
    expect(listed.filter((file) => !found.has(file))).toEqual([]);
    expect(listed.length).toBe(new Set(listed).size);
  });
});
