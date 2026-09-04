import { describe, expect, it } from "vitest";

import { buildProjectFile, loadProject } from "../../domain/project/index.ts";
import { createComponentSystem } from "../../domain/components/registry.ts";
import { componentNodeType } from "../../domain/components/component-type.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { document, graph, node, settings } from "./builders.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHAT `node()` STAMPS, AND WHAT THE LOADER THEN DOES WITH IT (§T1068)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `node()` wrote `definitionVersion: 1` for every type it was ever handed, so authoring a
 * CURRENT-schema node shipped a file the loader immediately migrated. §T1037 found it on
 * Ramp, whose schema had moved to 2: without `definitionVersion: 2` passed by hand in
 * `extra`, the loader REWROTE the stops on open, and the only thing that noticed was
 * `runner.test.ts`'s `changed: false` — a whole pipeline stage away from the call site
 * that lied. All 36 Ramp placements across the shipped examples carry that hand-written 2
 * today, which is the same registry number copied out 36 times; that is why closing T1068
 * changes no shipped byte (`sync.test.ts` stays green) and only removes the trap for the
 * next node whose version advances.
 *
 * So these do not assert the FIELD. They assert what the row is actually about: a document
 * built with these builders goes through the real save path and the real loader, and the
 * loader changes nothing and says nothing. A gate on `definitionVersion === 2` would have
 * been satisfied by the hand-written pins that were already there.
 *
 * §V316/§V908 — NOT ONE TYPE BY NAME. The version-bearing type is taken off the registry,
 * so this keeps testing the thing it exists to test after Ramp settles and something else
 * moves. `ramp` is not written down below; if it were, this file would go quietly vacuous
 * the day Ramp's version stops being the interesting one.
 */

/** The catalogue, and the types in it whose schema has actually advanced. */
const VERSIONED = allNodeDefinitions.filter((definition) => definition.version > 1);

function loaderFor() {
  return createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
}

/** Save with the app's own serializer, then open with the app's own loader (§V88). */
function roundTrip(built: ReturnType<typeof document>) {
  const file = buildProjectFile({ document: built, now: () => built.updatedAt });
  const { components, nodes } = loaderFor();
  return loadProject(file.text, { nodes, components });
}

describe("the example builders stamp the version the loader agrees with (§T1068)", () => {
  it("has a node type whose version has advanced, or every claim below is vacuous", () => {
    /*
     * The whole defect only exists for a type at version > 1: at version 1 the old hard-coded
     * default was accidentally right, and a round trip would pass against the bug. If the
     * catalogue ever has no such type, this fails loudly rather than reporting green on a
     * question it can no longer ask.
     */
    expect(
      VERSIONED.map((definition) => `${definition.type}@${definition.version}`),
      "no registered node type is past version 1, so nothing here can distinguish the T1068 bug from its fix",
    ).not.toEqual([]);
  });

  it.each(VERSIONED.map((definition) => definition.type))(
    "opens a saved %s with nothing migrated and nothing to say",
    (type) => {
      const definition = allNodeDefinitions.find((entry) => entry.type === type)!;
      const built = document(
        "t1068",
        "T1068",
        settings(),
        graph([node("subject", type, [0, 0]), node("out", "output", [240, 0])], []),
      );

      const loaded = roundTrip(built);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      /*
       * `changed` is the consumer-visible fact: it is what marks a freshly opened project
       * dirty, and it is true exactly when the loader migrated or clamped something. Under
       * the bug this was TRUE for a Ramp — the file said 1, the build said 2, and the stops
       * the author wrote were replaced by the v1->v2 migration's own two.
       */
      expect(loaded.changed).toBe(false);
      expect(loaded.diagnostics.map((entry) => entry.message)).toEqual([]);
      expect(loaded.document.graph.nodes["subject"]?.definitionVersion).toBe(definition.version);
      // And the parameters came back untouched, which is what a migration would not leave alone.
      expect(loaded.document.graph.nodes["subject"]?.parameters).toEqual({});
      /*
       * The field the builder wrote, asserted LAST on purpose. Red-verifying T1068 showed
       * this line placed first short-circuits the `it` before the loader ever runs, so the
       * consumer-visible claims above would have been reported red without being reached —
       * a gate that looks like it covers the loader while only covering the helper.
       */
      expect(built.graph.nodes["subject"]?.definitionVersion).toBe(definition.version);
    },
  );

  it("still lets an author pin an OLD version, because a migration fixture wants one", () => {
    const definition = VERSIONED[0]!;
    const pinned = node("old", definition.type, [0, 0], {}, { definitionVersion: 1 });
    expect(pinned.definitionVersion).toBe(1);
    // Deliberately old means the loader DOES migrate it — the other half of the same claim,
    // and the proof that `changed: false` above is a fact about the version and not a fact
    // about this round trip being incapable of noticing.
    const loaded = roundTrip(
      document("t1068-old", "T1068 old", settings(), graph([pinned, node("out", "output", [240, 0])], [])),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.changed).toBe(true);
  });

  it("reads a component instance's version off its own type (§V79/§V84)", () => {
    // A component pins its version IN the type and mirrors it in `definitionVersion` — the
    // pair `saveAsComponent` writes. There is no built-in definition to ask, so the type is
    // the source, and a v2 instance must not be stamped 1 the way the old default did.
    expect(node("c", componentNodeType("fan", 2), [0, 0]).definitionVersion).toBe(2);
    expect(node("c", componentNodeType("fan", 1), [0, 0]).definitionVersion).toBe(1);
  });

  it("refuses a node type the registry does not have, at the call site", () => {
    // §V883's shape, caught early: an unregistered type compiles to a severed graph with a
    // diagnostic an author reads a pipeline stage later, if at all. The builder is where the
    // name was typed, so it is where the name is checked.
    expect(() => node("oops", "gaussianBlurr", [0, 0])).toThrow(/gaussianBlurr/);
  });
});
