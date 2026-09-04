import { describe, expect, it, vi } from "vitest";

import { createHarness } from "./test-support.ts";
import type { LoomBus } from "./bus.ts";

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
  /* T1010/T1013 — the two debug views. Both landed committed and green in their own
     suites while this gate stayed red, because a coverage table is the one kind of test
     a new module cannot fail into: it fails the TABLE, in a file its author never opened. */
  { label: "ui.toggleEdgeFlow", path: "src/editor/edges/edge-flow-command.ts", load: () => import("@editor/edges/edge-flow-command.ts"), accessor: "edgeFlowStoreFor" },
  { label: "ui.toggleTimingOverlay", path: "src/editor/nodes/timing-overlay-command.ts", load: () => import("@editor/nodes/timing-overlay-command.ts"), accessor: "timingOverlayStoreFor" },
  { label: "graph.selectAll", path: "src/app/selection-commands.ts", load: () => import("@/app/selection-commands.ts"), accessor: "selectionHolderFor" },
  { label: "graph.selectNodes", path: "src/editor/selection/select-created.ts", load: () => import("@editor/selection/select-created.ts"), accessor: "selectNodesHolderFor" },
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
  // Wave 2. The two in `component-navigation.ts` are HOLDERS despite sitting beside the
  // stores: the navigation state lives inside `current`, which the canvas owns.
  { label: "graph.diveIn", path: "src/app/component-navigation.ts", load: () => import("@/app/component-navigation.ts"), accessor: "navigationHolderFor" },
  { label: "ui.createComponent", path: "src/app/component-navigation.ts", load: () => import("@/app/component-navigation.ts"), accessor: "componentCreationHolderFor" },
  { label: "ui.beginRename", path: "src/editor/nodes/rename-session.ts", load: () => import("@editor/nodes/rename-session.ts"), accessor: "renameSessionStoreFor" },
  { label: "ui.setPreviewView#store", path: "src/editor/viewer/preview-view-store.ts", load: () => import("@editor/viewer/preview-view-store.ts"), accessor: "previewViewStoreFor" },
  { label: "graph.toggleReferenceLines", path: "src/editor/edges/reference-lines-command.ts", load: () => import("@editor/edges/reference-lines-command.ts"), accessor: "referenceLinesStoreFor" },
];

type Accessor = (bus: LoomBus) => object;

/**
 * Takes the minimal structural shape rather than `HolderEntry`, because the wave-2 store
 * probes share the "how do I reach it" half without carrying a `path` — the completeness
 * check keys on paths and the stores are already covered there through `MODULES`.
 */
async function accessorFrom(entry: Pick<HolderEntry, "label" | "load" | "accessor">): Promise<Accessor> {
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
    // Wave 2 emptied this. It stays an assertion rather than being deleted: the list is
    // how a NEW module-level `WeakMap<object, …>` announces itself, and an empty expected
    // value is the strongest form of that check, not the absence of one.
    expect(unconverted).toEqual([]);

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

/**
 * §T719 wave 2 — THE STORES, where identity is not the property.
 *
 * A holder is a slot: if the object survives, the surface that wrote itself into it is
 * reachable, and that is the whole claim. A STORE is different, and this is the question
 * wave 1's gate cannot answer:
 *
 *   A STORE CAN BE THE SAME OBJECT AND STILL HAVE LOST ITS SUBSCRIBERS.
 *
 * So the assertion is the one that names the damage: a subscriber registered through
 * module instance A still fires for a notify issued through instance B. A store that came
 * back fresh would leave every `useSyncExternalStore` in the app subscribed to an object
 * nothing writes to any more — the title editor that stops repainting, the reference lines
 * that toggle without redrawing, the preview badge that never updates. Each of those looks
 * like a rendering bug and is not, which is precisely why it would cost a day.
 *
 * The state each store holds is named in its own docblock, because "does the state
 * survive" is unanswerable until the state has a name.
 */
interface StoreProbe {
  readonly label: string;
  readonly load: () => Promise<Record<string, unknown>>;
  readonly accessor: string;
  /** Subscribe through one instance. Returns the unsubscribe. */
  readonly subscribe: (store: object, listener: () => void) => () => void;
  /**
   * Change the state through the OTHER instance. `step` MUST produce a genuinely
   * different state each time: the first draft called `begin(PROBE_NODE)` twice, and the
   * second call was an idempotent no-op, so the unsubscribe assertion below held whether
   * or not unsubscribe worked. The no-op-unsubscribe mutation caught nothing — which is a
   * hole, not a safe area (§V707).
   */
  readonly mutate: (store: object, step: number) => void;
  /** A reading of the state, so the VALUE is proven shared and not merely the object. */
  readonly read: (store: object) => unknown;
}

const PROBE_NODE = "nd_t719probe";

const STORES: readonly StoreProbe[] = [
  {
    label: "rename-session (which title is being edited)",
    load: () => import("@editor/nodes/rename-session.ts"),
    accessor: "renameSessionStoreFor",
    subscribe: (store, listener) =>
      (store as { subscribe(l: () => void): () => void }).subscribe(listener),
    // A DIFFERENT node each step, because `begin` returns early on the one it is already
    // editing — the guard that made the first draft of this probe vacuous.
    mutate: (store, step) =>
      (store as { begin(id: string): void }).begin(`${PROBE_NODE}${step}`),
    read: (store) => (store as { get(): unknown }).get(),
  },
  {
    label: "reference-lines (whether the lines are drawn)",
    load: () => import("@editor/edges/reference-lines-command.ts"),
    accessor: "referenceLinesStoreFor",
    subscribe: (store, listener) =>
      (store as { subscribe(l: () => void): () => void }).subscribe(listener),
    mutate: (store) => {
      (store as { toggle(): boolean }).toggle();
    },
    read: (store) => (store as { get(): unknown }).get(),
  },
  {
    label: "preview-view (per-node lenses, with a listener bucket per node)",
    load: () => import("@editor/viewer/preview-view-store.ts"),
    accessor: "previewViewStoreFor",
    // Per-NODE subscription — a different signature from the other two, which is why this
    // table carries adapters rather than assuming one store shape.
    subscribe: (store, listener) =>
      (store as { subscribe(id: string, l: () => void): () => void }).subscribe(PROBE_NODE, listener),
    mutate: (store, step) => {
      // `exposureStops`, the store's real field name. The first draft of this probe said
      // `exposure`, which is not a lens field: the patch changed nothing, the store
      // correctly declined to notify, and the gate went red. A probe that does not
      // actually mutate proves nothing about a store that does not actually notify
      // (§V655) — and it was the GATE that caught the mistake, not review.
      (store as { set(id: string, patch: object): unknown }).set(PROBE_NODE, {
        exposureStops: step + 1,
      });
    },
    read: (store) => (store as { isDefault(id: string): unknown }).isDefault(PROBE_NODE),
  },
];

describe("§T719 wave 2 — a re-executed module keeps its store's SUBSCRIBERS", () => {
  it.each(STORES.map((probe) => [probe.label, probe] as const))(
    "%s: a subscriber from instance A fires for a notify from instance B",
    async (_label, probe) => {
      const { bus } = createHarness();

      vi.resetModules();
      const first = await accessorFrom(probe);
      vi.resetModules();
      const second = await accessorFrom(probe);
      expect(first).not.toBe(second);

      const a = first(bus);
      const b = second(bus);

      let fired = 0;
      const unsubscribe = probe.subscribe(a, () => {
        fired += 1;
      });

      // The notify comes through the OTHER instance — the surface that mounted after the
      // hot update — while the subscriber belongs to the one that mounted before it.
      probe.mutate(b, 0);

      expect(fired).toBe(1);
      // And the VALUE is shared, not just the notification: a store that forwarded events
      // but kept two copies of the state would pass the assertion above and still be wrong.
      expect(probe.read(a)).toEqual(probe.read(b));

      // Unsubscribing through A really detaches, so the fix cannot be "never remove a
      // listener" — that would leak a listener per hot update for the life of the session.
      unsubscribe();
      probe.mutate(b, 1);
      expect(fired).toBe(1);
    },
  );
});
