import { describe, expect, it, vi } from "vitest";

import { createHarness } from "./test-support.ts";
import type { ShaderloomBus } from "./bus.ts";

/**
 * §T719 — EVERY command module survives its own module being re-executed.
 *
 * ## Why this is one table and not twenty-one copies of a test
 *
 * The conversion is mechanical; the GATE is what stops number twenty-two. Each module was
 * holding its surface in a module-level `WeakMap`, so re-executing the module — which is
 * what Vite HMR does on every save — minted a second, empty holder while the handler
 * already registered on the bus kept reading the first. The surface wrote itself into the
 * new one, the command read `null` from the old one, and refused. Silently: no throw, no
 * log, the menu row still enabled. Measured end to end for `ui.openNodeSearch` in a real
 * browser (T709): open before the update, dead after it, recoverable only by a hard reload.
 *
 * Twenty-one modules, one bug, one table. A new `ui.open*` command that forgets to use
 * `sharedForBus` fails HERE, by name, rather than in a report three weeks later that the
 * owner's help panel stopped opening some time on Tuesday.
 *
 * ## The trap the third test exists for
 *
 * The store is keyed by bus AND key. Keyed by the bus alone — which is the obvious
 * simplification, and the one a hurried conversion would reach for — every `ui.open*`
 * command would share ONE holder, and the last surface to mount would answer for all of
 * them. That is strictly worse than the bug being fixed: silent AND wrong, rather than
 * silent and absent. So the collision check compares the actual OBJECTS every module hands
 * back, not the key strings, because comparing the strings is a review and comparing the
 * objects is a measurement.
 */

/**
 * Every shared holder in the app, and how to reach it.
 *
 * `load` is a thunk with a LITERAL import so the bundler can resolve it; calling it twice
 * across a `vi.resetModules()` is what produces two genuine module instances.
 */
interface HolderEntry {
  readonly label: string;
  /** Repeated as data because a dynamic import needs a literal and completeness needs a value. */
  readonly path: string;
  readonly load: () => Promise<Record<string, unknown>>;
  readonly accessor: string;
}

const MODULES: readonly HolderEntry[] = [
  { label: "ui.showNodeInfo", path: "src/editor/inspect/command.ts", load: () => import("@editor/inspect/command.ts"), accessor: "nodeInfoHolderFor" },
  { label: "ui.openSettings", path: "src/editor/inspect/settings-command.ts", load: () => import("@editor/inspect/settings-command.ts"), accessor: "projectSettingsHolderFor" },
  { label: "ui.openNodeSearch", path: "src/editor/library/node-search-command.ts", load: () => import("@editor/library/node-search-command.ts"), accessor: "nodeSearchHolderFor" },
  { label: "ui.setPreviewView#target", path: "src/editor/viewer/preview-view-command.ts", load: () => import("@editor/viewer/preview-view-command.ts"), accessor: "previewViewTargetFor" },
  { label: "ui.openCommandPalette", path: "src/editor/palette/palette-commands.ts", load: () => import("@editor/palette/palette-commands.ts"), accessor: "paletteHolderFor" },
  { label: "ui.openHelp", path: "src/editor/help/command.ts", load: () => import("@editor/help/command.ts"), accessor: "helpHolderFor" },
  { label: "export.renderRange", path: "src/app/render-range.ts", load: () => import("@/app/render-range.ts"), accessor: "renderRangeHolderFor" },
  { label: "project.compile", path: "src/app/compile-command.ts", load: () => import("@/app/compile-command.ts"), accessor: "compileHolderFor" },
  { label: "graph.selectAll", path: "src/app/selection-commands.ts", load: () => import("@/app/selection-commands.ts"), accessor: "selectionHolderFor" },
  { label: "audio.toggleTrackRecording", path: "src/app/audio-track-commands.ts", load: () => import("@/app/audio-track-commands.ts"), accessor: "audioTrackHolderFor" },
  { label: "node.openViewer", path: "src/app/viewer-commands.ts", load: () => import("@/app/viewer-commands.ts"), accessor: "viewerHolderFor" },
  { label: "ui.openLayouts", path: "src/app/layout-commands.ts", load: () => import("@/app/layout-commands.ts"), accessor: "layoutCommandHolderFor" },
  { label: "view.frameAll", path: "src/app/view-commands.ts", load: () => import("@/app/view-commands.ts"), accessor: "viewHolderFor" },
  { label: "view.toggleFullscreen", path: "src/app/fullscreen-commands.ts", load: () => import("@/app/fullscreen-commands.ts"), accessor: "fullscreenHolderFor" },
  { label: "transport.togglePlay", path: "src/app/transport-commands.ts", load: () => import("@/app/transport-commands.ts"), accessor: "transportHolderFor" },
  { label: "project.save", path: "src/app/project-commands.ts", load: () => import("@/app/project-commands.ts"), accessor: "projectHolderFor" },
  /*
   * Its holder accessor is module-private and it backs QUERIES rather than one command,
   * so the entry point is the exported reader — which hands back the shared `sources`
   * object itself. Same identity question, reached through the door this module offers.
   */
  { label: "domain/state-queries", path: "src/domain/commands/state-queries.ts", load: () => import("./state-queries.ts"), accessor: "stateSourcesFor" },
];

type Accessor = (bus: ShaderloomBus) => object;

async function accessorFrom(entry: HolderEntry): Promise<Accessor> {
  const module = await entry.load();
  const found = module[entry.accessor];
  if (typeof found !== "function") {
    throw new Error(`${entry.label}: ${entry.accessor} is not exported`);
  }
  return found as Accessor;
}

describe("§T719 — a re-executed command module keeps its surface", () => {
  it.each(MODULES.map((entry) => [entry.label, entry] as const))(
    "%s hands a SECOND module instance the same holder",
    async (_label, entry) => {
      const { bus } = createHarness();

      vi.resetModules();
      const first = await accessorFrom(entry);
      vi.resetModules();
      const second = await accessorFrom(entry);

      /*
       * The precondition, asserted rather than assumed. Without it a change to how Vitest
       * caches modules would quietly make this a test of ONE instance against itself —
       * green forever, and blind to the only thing it is here for.
       */
      expect(first).not.toBe(second);

      // The property: the holder the surface writes into IS the holder the command reads.
      expect(second(bus)).toBe(first(bus));
    },
  );

  it("gives every module its OWN holder on one bus", async () => {
    /*
     * The keying trap, measured on the objects.
     *
     * Keyed by bus alone, all sixteen of these would be the same object and the last
     * surface to mount would answer for every command in the app. Comparing identities is
     * what makes that impossible to introduce; comparing the key strings would only prove
     * that someone typed sixteen different things.
     */
    const { bus } = createHarness();
    const holders = await Promise.all(
      MODULES.map(async (entry) => ({ label: entry.label, holder: (await accessorFrom(entry))(bus) })),
    );

    const byHolder = new Map<object, string[]>();
    for (const { label, holder } of holders) {
      byHolder.set(holder, [...(byHolder.get(holder) ?? []), label]);
    }
    const shared = [...byHolder.values()].filter((labels) => labels.length > 1);
    // The failure message names the colliding pair rather than reporting a count.
    expect(shared).toEqual([]);
    expect(byHolder.size).toBe(MODULES.length);
  });

  it("does not leak a holder between two buses", async () => {
    // Two app instances in one page — a floated pane's window, or two harnesses in one
    // test file — must not write into each other's surfaces.
    const one = createHarness().bus;
    const other = createHarness().bus;
    for (const entry of MODULES) {
      const holderFor = await accessorFrom(entry);
      expect(holderFor(one), entry.label).not.toBe(holderFor(other));
    }
  });

  it("covers every module that holds a surface per bus — BOTH directions", async () => {
    /*
     * The gate on the gate. A table is worth exactly its completeness, and there are two
     * ways to lose it, so both are checked against the SOURCE rather than against memory.
     *
     * (a) A module still on the old module-level `WeakMap` — the unconverted case. The
     *     four that remain are wave 2's STORES, named here so the list cannot quietly grow:
     *     "does a store survive the swap WITH ITS STATE" is a different question from "does
     *     a handler holder survive", which is why they are deliberately not converted yet.
     *
     * (b) A module that DOES use the shared store but is missing from `MODULES` — the case
     *     the first check cannot see, because such a module looks perfectly converted. It
     *     would be fixed and ungated, which is the state this whole row exists to end.
     */
    const { readFileSync, globSync } = await import("node:fs");
    const sources = globSync("src/{app,editor,domain}/**/*.ts", { cwd: process.cwd() })
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => ({ file, text: readFileSync(file, "utf8") }));

    const unconverted = sources
      .filter(({ text }) => /new WeakMap<object,/.test(text))
      .map(({ file }) => file)
      .sort();
    expect(unconverted).toEqual([
      "src/app/component-navigation.ts",
      "src/editor/edges/reference-lines-command.ts",
      "src/editor/nodes/rename-session.ts",
      "src/editor/viewer/preview-view-store.ts",
    ]);

    const usesSharedStore = sources
      .filter(({ file }) => file !== "src/domain/commands/command-holder.ts")
      .filter(({ text }) => /\b(commandHolder|sharedForBus)</.test(text))
      .map(({ file }) => file)
      .sort();
    const covered = [...new Set(MODULES.map((entry) => entry.path))].sort();
    // Named difference, not a count: a failure says WHICH module is holding a surface
    // without a row in this table.
    expect(usesSharedStore.filter((file) => !covered.includes(file))).toEqual([]);
    expect(usesSharedStore).toEqual(covered);
  });
});
