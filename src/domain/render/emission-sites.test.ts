import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EMISSION_PUMPS, emittingNodeTypes } from "./emission-pumps.ts";
import { NODE_SIDE_EFFECTS } from "./side-effects.ts";

/**
 * T1005 — EVERY EMISSION SITE IS REGISTERED, AND EVERY REGISTERED SITE REFUSES.
 *
 * §T949 left one gap, named rather than papered over: the structural scan stops a send
 * inside a node definition, the policy check stops the one pump that exists, and
 * NOTHING forces a second pump to call `emissionRefusal` — and the second pump's author
 * is writing `laserOut`. These gates close it in both directions, the way §T949's
 * ledger closes node classification:
 *
 *   - every `emits` node has a pump row, and no row exists without an `emits` node;
 *   - every pump file exists and its comments-stripped CODE calls `emissionRefusal`;
 *   - any module that touches the emission surface at all — the ledger, the helpers,
 *     the refusal, or an emitting type's literal name — IS a pump and must be a row.
 *
 * Non-vacuity is asserted, not assumed (§T985's lesson, restated by §T949's own file):
 * the pump set is pinned by name, and the scan has a floor under the file count, so a
 * walk that finds nothing cannot hold this green.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Comments stripped: what the CODE does, not what it explains about itself (§T949). */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * The surface's own home and the node definition tree (owned by §T949's egress scan) are
 * the two deliberate exclusions. They are ENUMERATED while the scanned tree is DERIVED,
 * and that asymmetry is the point (§T1129, §V906): a forgotten exclusion is a loud red a
 * reviewer resolves, a forgotten inclusion is a gate that silently sees nothing. §T1103
 * moved every device pump to `src/devices/` — a directory no hand-list had — and the
 * scan's old root list went blind without failing. A walk of `src` cannot go blind again.
 */
const NOT_A_PUMP_SITE = [
  "src/domain/render",
  "src/nodes/definitions",
  /*
   * T1193 — EXAMPLE DOCUMENTS NAME NODE TYPES AS DATA, and E64 Relay is the first one to
   * place an emitting node (`oscOut`, wired to its own `oscIn` over the loopback).
   *
   * These modules export a `ProjectDocument` and nothing else; they are the SOURCE the
   * `.loom.json` files are generated from, `sync.test.ts` holds the bytes to them, and
   * nothing in a running session imports one. A node type spelled here is a type string in
   * a document, exactly as it is in the shipped JSON — which this scan does not read and
   * never should. A pump cannot hide in a document, and the alternative on offer was worse:
   * writing `oscOutNode.type` instead of `"oscOut"` in the example, which is a file made
   * less readable to slip past a gate.
   */
  "src/examples/documents",
  // Command-authored desktop test documents name Syphon Out as graph data.
  // This fixture creates/serializes documents only; the real app pump remains gated.
  "src/desktop/testing/output-fixture.ts",
  /*
   * T1162 — THE EXAMPLE CARD'S CAPABILITY VOCABULARY NAMES NODE TYPES AS DATA, and the
   * `device` tag is the row that has to name `oscOut` and `laserOut`: the tag means "this
   * example plans or drives hardware over the local bridge", and a row that left the two
   * EMITTERS out would be a tag that goes quiet on exactly the file that talks to a laser.
   *
   * THE FILE, not the directory, so a real pump landing anywhere else under
   * `src/examples/` is still caught. What it exports is `tagsOf`/`categoryOf` — pure
   * predicates over a set of type STRINGS parsed out of a `.loom.json`, with no registry,
   * no definition and no transport in reach. It is the read side of §T1193's exclusion one
   * surface over: that one is the document that SPELLS `oscOut`, this one is the list that
   * reads the same string back out of the shipped bytes and puts a badge on it.
   *
   * The alternative was dropping the emitters from the vocabulary, which is a gate quietly
   * shaping a product decision — the thing §T1193 refused when it declined to write
   * `oscOutNode.type` to slip past this scan.
   *
   * T1211 moved the table out of `src/editor/library/example-catalogue.ts`, which is now a
   * glob and a re-export and names no node type: the MCP server derives the same tags in
   * Node and cannot import a Vite transform, so one table serves both readers.
   */
  "src/examples/capabilities.ts",
  // Read-only file requirements: loads/expands an isolated document to classify
  // helper/desktop dependencies. Names emitting operators as metadata, never
  // installs an app pump, requests permission or opens a device/native transport.
  "src/examples/runtime-requirements.ts",
  // Pure node-type/transport-name tables shared by the inspector and existing
  // native pumps. No bridge access, publication or device ownership in this file.
  "src/devices/native-video.ts",
];

/** Every non-test source module a pump could hide in: all of `src`, minus the exclusions. */
function sessionSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  return walk(join(ROOT, "src")).filter((file) => {
    const path = relative(ROOT, file).replaceAll("\\", "/");
    return !NOT_A_PUMP_SITE.some((dir) => path === dir || path.startsWith(`${dir}/`));
  });
}

describe("T1005 — the pump ledger, held to the side-effect ledger", () => {
  it("gives every emitting node exactly one pump, and no pump a phantom node", () => {
    expect(Object.keys(EMISSION_PUMPS).sort()).toEqual([...emittingNodeTypes()]);
    // And the deriver itself derives from the real ledger — the set is not restatable
    // here without restating it there.
    expect(emittingNodeTypes()).toEqual(
      Object.entries(NODE_SIDE_EFFECTS)
        .filter(([, effect]) => effect === "emits")
        .map(([type]) => type)
        .sort(),
    );
  });

  it("pins today's pump set by name — one arriving is a decision, one vanishing is red", () => {
    expect(Object.entries(EMISSION_PUMPS).sort()).toEqual([
      // T950: registered in the same commit that declared laserOut "emits" — the gate
      // forcing exactly what it was built to force, before any transport exists.
      ["laserOut", "src/app/use-laser-bridge.ts"],
      ["ndiOut", "src/app/use-native-outputs.ts"],
      ["oscOut", "src/app/use-osc-bridge.ts"],
      ["spoutOut", "src/app/use-native-outputs.ts"],
      ["syphonOut", "src/app/use-native-outputs.ts"],
    ]);
  });

  it("every pump file exists and its CODE calls emissionRefusal", () => {
    for (const [nodeType, path] of Object.entries(EMISSION_PUMPS)) {
      const file = join(ROOT, path);
      expect(existsSync(file), `${nodeType}'s pump "${path}" does not exist (§V421 rot)`).toBe(true);
      expect(
        /\bemissionRefusal\s*\(/.test(code(file)),
        `${nodeType}'s pump "${path}" never calls emissionRefusal — a take, a headless export ` +
          `and every gate would emit through it. The refusal is the pump's admission ticket (T1005).`,
      ).toBe(true);
    }
  });
});

describe("T1005 — an UNREGISTERED pump cannot hide", () => {
  it("any module touching the emission surface is a registered pump", () => {
    /*
     * The tell: a pump must know WHICH nodes emit, and every legitimate way to know is
     * a token this scan sees — the ledger, the helpers, the refusal itself, or an
     * emitting type's literal name. A module carrying one of those tokens either IS a
     * pump (register it, and the gate above then demands its refusal call) or is doing
     * something with the emission surface that deserves exactly this review.
     *
     * Verified against reality before it was written: today precisely ONE module
     * outside `src/domain/render` carries any of these tokens, and it is the OSC pump.
     */
    const emitting = emittingNodeTypes();
    const surface = new RegExp(
      [
        "\\bNODE_SIDE_EFFECTS\\b",
        "\\bactsOnWorld\\b",
        "\\bemissionRefusal\\b",
        "\\bemittingNodeTypes\\b",
        "\\bEMISSION_PUMPS\\b",
        ...emitting.map((type) => `\\b${type}\\b`),
      ].join("|"),
    );
    const registered = new Set(Object.values(EMISSION_PUMPS));
    const sources = sessionSources();
    // The floor: a walk that finds nothing would assert over the empty set (§T985).
    expect(sources.length).toBeGreaterThan(100);
    const unregistered = sources
      .filter((file) => surface.test(code(file)))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
      .filter((path) => !registered.has(path));
    expect(
      unregistered,
      "These modules touch the emission surface (the side-effect ledger, its helpers, or an " +
        "emitting node's name) without being registered in EMISSION_PUMPS. If one is a new " +
        "pump: add its row, and make it call emissionRefusal — that pairing is what keeps a " +
        "take, a headless export and every gate from reaching hardware (T1005). If it is " +
        "not a pump, it has no business on this surface.",
    ).toEqual([]);
  });
});
