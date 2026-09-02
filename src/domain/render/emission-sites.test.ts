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

/** Every non-test source module a pump could hide in. */
function sessionSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  // Everything session-side. `src/domain/render` (the surface's own home) and the node
  // definition tree (owned by §T949's egress scan) are the two deliberate exclusions.
  return ["src/app", "src/runtime", "src/editor", "src/mcp", "src/compiler", "src/points"].flatMap(
    (dir) => walk(join(ROOT, dir)),
  );
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
    expect(Object.entries(EMISSION_PUMPS).sort()).toEqual([["oscOut", "src/app/use-osc-bridge.ts"]]);
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
