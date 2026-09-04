import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "@ui/testing/install-dom-stubs.ts";
import {
  DEFAULT_LAYOUT_ID,
  DEFAULT_LAYOUT_STORE,
  DEFAULT_SHELL_LAYOUT,
  LAYOUT_PRESETS,
  LAYOUT_STORAGE_KEY,
  LEGACY_LAYOUT_STORAGE_KEY,
  PANE_IDS,
  allNamedLayouts,
  applyNamedLayout,
  clearLayout,
  clearLegacyLayout,
  deleteNamedLayout,
  dockPane,
  floatPane,
  isLayoutModified,
  movePane,
  readLayout,
  readLayoutStore,
  renameNamedLayout,
  saveLayoutAs,
  selectPane,
  updateNamedLayout,
  writeLayoutStore,
  zoneOf,
} from "./layout-storage.ts";
import type { LayoutStore, PaneId, ShellLayout } from "./layout-storage.ts";

function storeOf(current: ShellLayout): LayoutStore {
  return { current, currentId: null, layouts: [] };
}

/**
 * V18 — the arrangement belongs to the machine, not to the project.
 * These tests exist because a layout that leaked into `.loom.json` would travel
 * to other users and other screens, and because a corrupt entry must degrade to
 * the stock layout instead of an unusable shell.
 */
describe("V18 — shell layout persistence", () => {
  it("round-trips a store through storage", () => {
    const store = storeOf(movePane(DEFAULT_SHELL_LAYOUT, "shader", "center"));
    const storage = createMemoryStorage();

    writeLayoutStore(store, storage);
    expect(readLayoutStore(storage)).toEqual(store);
  });

  it("stores layout under a single localStorage key and nowhere else", () => {
    const storage = createMemoryStorage();
    writeLayoutStore(DEFAULT_LAYOUT_STORE, storage);

    expect(storage.keys()).toEqual([LAYOUT_STORAGE_KEY]);
    // Serialized form carries chrome state only — no project, graph or node data,
    // which is what keeps it out of the document (V18).
    const stored: unknown = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    expect(Object.keys(stored as object).sort()).toEqual([
      "current",
      "currentId",
      "layouts",
      "version",
    ]);
  });

  it("returns defaults when nothing is stored", () => {
    expect(readLayoutStore(createMemoryStorage())).toEqual(DEFAULT_LAYOUT_STORE);
  });

  it("returns defaults when the entry is not JSON", () => {
    const storage = createMemoryStorage({ [LAYOUT_STORAGE_KEY]: "{not json" });
    expect(readLayout(storage)).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it("repairs only the groups that are invalid", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 3,
        currentId: null,
        layouts: [],
        current: {
          ...DEFAULT_SHELL_LAYOUT,
          rows: [60, 40],
          columns: [10, 10], // does not add up
          rightRows: [10, 20, 70], // wrong arity
        },
      }),
    });

    const restored = readLayout(storage);
    expect(restored.rows).toEqual([60, 40]);
    expect(restored.columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
    expect(restored.rightRows).toEqual(DEFAULT_SHELL_LAYOUT.rightRows);
    expect(restored.zones).toEqual(DEFAULT_SHELL_LAYOUT.zones);
  });

  it("survives a store that throws (private mode, blocked embedder)", () => {
    const hostile = {
      getItem: (): string => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
      removeItem: (): void => {
        throw new Error("blocked");
      },
    };

    expect(readLayoutStore(hostile)).toEqual(DEFAULT_LAYOUT_STORE);
    expect(() => writeLayoutStore(DEFAULT_LAYOUT_STORE, hostile)).not.toThrow();
    expect(() => clearLayout(hostile)).not.toThrow();
    expect(() => clearLegacyLayout(hostile)).not.toThrow();
  });

  it("no-ops when there is no store at all", () => {
    expect(readLayout(null)).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(() => writeLayoutStore(DEFAULT_LAYOUT_STORE, null)).not.toThrow();
  });

  it("clears the entry", () => {
    const storage = createMemoryStorage();
    writeLayoutStore(DEFAULT_LAYOUT_STORE, storage);
    clearLayout(storage);
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).toBeNull();
  });
});

/**
 * T426 — the right sidebar is a FULL-HEIGHT column split horizontally.
 *
 * These assertions are about the RECORD, which is where the arrangement lives; that the
 * record actually produces a full-height column on screen is asserted geometrically in
 * `src/tests/e2e/layout.spec.ts`, because no jsdom test can see it (§V339).
 */
describe("T426 — the default arrangement", () => {
  it("puts the viewer above the inspector in two separate right-hand zones", () => {
    expect(DEFAULT_SHELL_LAYOUT.zones.right).toEqual(["viewer"]);
    expect(DEFAULT_SHELL_LAYOUT.zones.rightBottom).toEqual(["inspector"]);
    // Not tabs in one dock any more: the point is seeing both at once.
    expect(DEFAULT_SHELL_LAYOUT.active.right).toBe("viewer");
    expect(DEFAULT_SHELL_LAYOUT.active.rightBottom).toBe("inspector");
  });

  it("gives the sidebar its own top-level column and the bottom dock the rest", () => {
    // Two-value `columns` IS the full-height claim: the sidebar is a sibling of the whole
    // work area, so nothing above the bottom dock can cut it short.
    expect(DEFAULT_SHELL_LAYOUT.columns).toHaveLength(2);
    expect(DEFAULT_SHELL_LAYOUT.mainColumns).toHaveLength(2);
    expect(DEFAULT_SHELL_LAYOUT.rightRows).toHaveLength(2);
    // The shader editor keeps the width it had: left + centre, not centre alone.
    expect(DEFAULT_SHELL_LAYOUT.zones.bottom).toContain("shader");
  });

  it("splits the sidebar so the inspector gets real height, not a third of a column", () => {
    const [top = 0, bottom = 0] = DEFAULT_SHELL_LAYOUT.rightRows;
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeGreaterThan(0);
  });
});

/** Every pane is in exactly one place. The dock's whole model rests on that. */
function placements(layout: ShellLayout): Map<PaneId, string> {
  const seen = new Map<PaneId, string>();
  for (const paneId of PANE_IDS) {
    const where = zoneOf(layout, paneId);
    expect(where, `${paneId} is nowhere`).not.toBeNull();
    seen.set(paneId, where ?? "");
  }
  return seen;
}

/**
 * V95 — every pane relocatable, none hardcoded to a slot.
 */
describe("V95 — the arrangement is data", () => {
  it("moves a pane between every zone, leaving it in exactly one", () => {
    let layout: ShellLayout = DEFAULT_SHELL_LAYOUT;
    for (const zone of ["center", "left", "right", "rightBottom", "bottom"] as const) {
      layout = movePane(layout, "shader", zone);
      expect(zoneOf(layout, "shader")).toBe(zone);
      expect(placements(layout).size).toBe(PANE_IDS.length);
      // Not in any other zone: the move REPLACES a placement, never adds one.
      const elsewhere = (["left", "center", "right", "rightBottom", "bottom"] as const)
        .filter((other) => other !== zone)
        .flatMap((other) => layout.zones[other]);
      expect(elsewhere).not.toContain("shader");
    }
  });

  it("the shader editor is not nailed to the bottom dock — the specific complaint", () => {
    const moved = movePane(DEFAULT_SHELL_LAYOUT, "shader", "center");
    expect(moved.zones.center).toContain("shader");
    expect(moved.zones.bottom).not.toContain("shader");
    // …and it is what you are looking at, because you just put it there.
    expect(moved.active.center).toBe("shader");
  });

  it("keeps the active tab when the move did not touch it, and picks one when it did", () => {
    const layout = movePane(DEFAULT_SHELL_LAYOUT, "performance", "left");
    expect(layout.active.bottom).toBe("examples"); // untouched
    const emptied = (["shader", "problems", "examples", "agent"] as const).reduce<ShellLayout>(
      (next, paneId) => movePane(next, paneId, "left"),
      layout,
    );
    expect(emptied.zones.bottom).toEqual([]);
    expect(emptied.active.bottom).toBeNull();
  });

  it("floats a pane out of every zone and docks it back", () => {
    const floated = floatPane(DEFAULT_SHELL_LAYOUT, "viewer");
    expect(floated.floating).toEqual(["viewer"]);
    expect(zoneOf(floated, "viewer")).toBe("float");
    expect(floated.zones.right).toEqual([]);
    expect(floated.active.right).toBeNull();

    const docked = dockPane(floated, "viewer");
    expect(docked.floating).toEqual([]);
    expect(zoneOf(docked, "viewer")).toBe("right");
  });

  it("sends the inspector home to the sidebar's LOWER section, not the upper one", () => {
    const docked = dockPane(floatPane(DEFAULT_SHELL_LAYOUT, "inspector"), "inspector");
    expect(zoneOf(docked, "inspector")).toBe("rightBottom");
  });

  it("moving a floating pane into a zone takes it out of the window list", () => {
    const layout = movePane(floatPane(DEFAULT_SHELL_LAYOUT, "viewer"), "viewer", "bottom");
    expect(layout.floating).toEqual([]);
    expect(layout.zones.bottom).toContain("viewer");
  });

  it("ignores a select for a pane that is not in that zone", () => {
    expect(selectPane(DEFAULT_SHELL_LAYOUT, "left", "viewer")).toBe(DEFAULT_SHELL_LAYOUT);
  });
});

/**
 * A stored arrangement is a user's furniture. Repair it; do not throw it away because
 * this build knows one more pane than the file does.
 */
describe("V95 — a stored arrangement is repaired, not rejected", () => {
  it("keeps what it can and puts an unmentioned pane in its home zone", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 3,
        currentId: null,
        layouts: [],
        current: {
          rows: [70, 30],
          columns: [75, 25],
          mainColumns: [25, 75],
          rightRows: [50, 50],
          zones: {
            left: ["library", "shader"],
            center: ["graph"],
            right: ["viewer"],
            rightBottom: [],
            bottom: ["problems"],
          },
          active: { left: "shader", center: "graph", right: "viewer", bottom: "problems" },
          floating: ["inspector"],
        },
      }),
    });

    const restored = readLayout(storage);
    // `components` was never mentioned; it lands in its home zone rather than vanishing,
    // which is what makes adding a pane free of migrations.
    expect(restored.zones.left).toEqual(["library", "shader", "components"]);
    expect(restored.active.left).toBe("shader");
    expect(restored.floating).toEqual(["inspector"]);
    expect(restored.zones.bottom).toEqual(["problems", "performance", "examples", "agent"]);
    expect(placements(restored).size).toBe(PANE_IDS.length);
  });

  it("drops unknown ids and duplicates rather than rendering a pane twice", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 3,
        currentId: null,
        layouts: [],
        current: {
          ...DEFAULT_SHELL_LAYOUT,
          zones: {
            left: ["library", "library", "vanished-pane"],
            center: ["graph", "library"],
            right: [],
            rightBottom: [],
            bottom: [],
          },
          floating: ["graph"],
        },
      }),
    });

    const restored = readLayout(storage);
    // "library" once, not three times; "vanished-pane" not at all. Everything the record
    // did not place lands in its home zone.
    expect(restored.zones.left).toEqual(["library", "components"]);
    expect(restored.zones.center).toEqual(["graph"]);
    expect(restored.floating).toEqual([]);
    expect(placements(restored).size).toBe(PANE_IDS.length);
  });
});

// ---- T436 -----------------------------------------------------------------------------

const CUSTOM_V2 = {
  rows: [50, 50],
  columns: [20, 50, 30],
  zones: {
    left: ["library", "components", "examples"],
    center: ["graph"],
    right: ["inspector", "viewer"],
    bottom: ["shader", "problems", "performance", "agent"],
  },
  active: { left: "examples", center: "graph", right: "viewer", bottom: "problems" },
  floating: [] as string[],
};

const STOCK_V2 = {
  rows: [72, 28],
  columns: [17, 57, 26],
  zones: {
    left: ["library", "components"],
    center: ["graph"],
    right: ["inspector", "viewer"],
    bottom: ["shader", "problems", "performance", "examples", "agent"],
  },
  active: { left: "library", center: "graph", right: "inspector", bottom: "shader" },
  floating: [] as string[],
};

/**
 * V311 — migration runs in BOTH directions, and the innocuous case is the dangerous one.
 *
 * The shell WRITES its layout on every mount, so "an entry exists" proves nothing about
 * whether the user ever arranged anything. Treating every v2 entry as furniture would
 * have pinned every existing user to the old arrangement and given them a phantom "Saved
 * layout" row; treating none of them as furniture would have thrown away the arrangement
 * of everyone who did move something. Both directions are asserted here.
 */
describe("V311 — v2 migrates in both directions", () => {
  it("keeps a CUSTOMISED v2 layout as a named layout, UNSELECTED, so nothing is lost", () => {
    const storage = createMemoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify(CUSTOM_V2),
    });

    const store = readLayoutStore(storage);
    expect(store.layouts).toHaveLength(1);
    expect(store.layouts[0]?.name).toBe("Saved layout");
    // SELECTED IS THE NEW DEFAULT. The owner reported twice that they never saw T426,
    // because selecting the migrated layout made the new arrangement unreachable without
    // knowing to look for it — a default nobody is shown is not a default.
    expect(store.currentId).toBe(DEFAULT_LAYOUT_ID);
    expect(store.current.zones.rightBottom).toEqual(["inspector"]);

    // NOTHING IS LOST is still the property this test carries: their furniture survives
    // intact in the saved row, one click away in the layout menu.
    const saved = store.layouts[0]?.layout;
    expect(saved?.zones.left).toEqual(["library", "components", "examples"]);
    expect(saved?.zones.right).toEqual(["inspector", "viewer"]);
    expect(saved?.rows).toEqual([50, 50]);
  });

  it("preserves the three column widths through the reshape, rather than resetting them", () => {
    const storage = createMemoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify(CUSTOM_V2),
    });

    // In the SAVED row — the migrated arrangement is preserved, not selected.
    const saved = readLayoutStore(storage).layouts[0]?.layout;
    // 20 / 50 / 30 becomes a 70-wide work area beside a 30-wide sidebar, and the work
    // area is split 20:50 — the same pixels, expressed in the new geometry.
    expect(saved?.columns).toEqual([70, 30]);
    expect(saved?.mainColumns[0]).toBeCloseTo((20 / 70) * 100, 6);
    expect(saved?.mainColumns[1]).toBeCloseTo((50 / 70) * 100, 6);
  });

  it("leaves the SAVED layout's lower section CLOSED, so restoring it looks unchanged", () => {
    const storage = createMemoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify(CUSTOM_V2),
    });

    // On the saved row, not the selection: restoring their arrangement must give back the
    // undivided sidebar they had, while the app opens on the new default.
    const saved = readLayoutStore(storage).layouts[0]?.layout;
    expect(saved?.zones.rightBottom).toEqual([]);
    expect(saved?.rightRows).toEqual([100, 0]);
  });

  it("does NOT invent a saved layout for a user who only ever opened the app", () => {
    // The false case (§V311). A stock v2 entry is the app's own write, not furniture.
    const storage = createMemoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify(STOCK_V2),
    });

    const store = readLayoutStore(storage);
    expect(store.layouts).toEqual([]);
    expect(store.currentId).toBe(DEFAULT_LAYOUT_ID);
    expect(store.current).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it("prefers a v3 entry and never re-reads v2 over the top of it", () => {
    const saved = storeOf(movePane(DEFAULT_SHELL_LAYOUT, "problems", "left"));
    const storage = createMemoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify(CUSTOM_V2),
    });
    writeLayoutStore(saved, storage);

    expect(readLayoutStore(storage).current.zones.left).toContain("problems");
  });

  it("drops v2's key once v3 has been written, leaving exactly one", () => {
    const storage = createMemoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify(CUSTOM_V2),
    });
    writeLayoutStore(readLayoutStore(storage), storage);
    clearLegacyLayout(storage);

    expect(storage.keys()).toEqual([LAYOUT_STORAGE_KEY]);
  });
});

/**
 * T436 — save, name, update, restore, delete. The distinction that matters is UPDATE vs
 * SAVE AS: only one of them may ever grow the list.
 */
describe("T436 — named layouts", () => {
  it("ships presets alongside user layouts, with T426's arrangement first", () => {
    expect(LAYOUT_PRESETS[0]?.id).toBe(DEFAULT_LAYOUT_ID);
    expect(LAYOUT_PRESETS[0]?.layout).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(allNamedLayouts(DEFAULT_LAYOUT_STORE).map((entry) => entry.id)).toEqual([
      DEFAULT_LAYOUT_ID,
    ]);
  });

  it("T470: a stored selection of a preset that no longer ships falls back to Default, NAMED", () => {
    const storage = { map: new Map<string, string>() } as unknown as {
      map: Map<string, string>;
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
    storage.getItem = (key) => storage.map.get(key) ?? null;
    storage.setItem = (key, value) => void storage.map.set(key, value);
    storage.removeItem = (key) => void storage.map.delete(key);
    storage.map.set(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        current: DEFAULT_SHELL_LAYOUT,
        currentId: "preset:classic",
        layouts: [],
      }),
    );
    const store = readLayoutStore(storage);
    // Not null (a dangling nothing) and not the ghost id: the Default row, selected.
    expect(store.currentId).toBe(DEFAULT_LAYOUT_ID);
    // The arrangement itself is untouched by the fallback.
    expect(store.current).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it("SAVE AS adds an entry and selects it", () => {
    const store = saveLayoutAs(storeOf(DEFAULT_SHELL_LAYOUT), "Shader work");
    expect(store.layouts).toHaveLength(1);
    expect(store.layouts[0]?.name).toBe("Shader work");
    expect(store.currentId).toBe(store.layouts[0]?.id);
  });

  it("UPDATE overwrites the selected entry and NEVER adds a second one", () => {
    const saved = saveLayoutAs(storeOf(DEFAULT_SHELL_LAYOUT), "Shader work");
    const moved: LayoutStore = { ...saved, current: movePane(saved.current, "shader", "center") };

    const updated = updateNamedLayout(moved, saved.currentId ?? "");

    // The whole point of the verb: one entry, carrying the new arrangement.
    expect(updated.layouts).toHaveLength(1);
    expect(updated.layouts[0]?.layout.zones.center).toContain("shader");
    // …and the same id, so anything pointing at it still points at it.
    expect(updated.layouts[0]?.id).toBe(saved.layouts[0]?.id);
  });

  it("SAVE AS with the same name mints a distinct id rather than clobbering the first", () => {
    const once = saveLayoutAs(storeOf(DEFAULT_SHELL_LAYOUT), "Layout");
    const twice = saveLayoutAs(once, "Layout");
    expect(twice.layouts).toHaveLength(2);
    expect(twice.layouts[0]?.id).not.toBe(twice.layouts[1]?.id);
  });

  it("refuses to update or rename or delete a PRESET, which is code and not a row", () => {
    const store: LayoutStore = { ...DEFAULT_LAYOUT_STORE, currentId: DEFAULT_LAYOUT_ID };
    expect(updateNamedLayout(store, DEFAULT_LAYOUT_ID)).toBe(store);
    expect(renameNamedLayout(store, DEFAULT_LAYOUT_ID, "Mine")).toBe(store);
    expect(deleteNamedLayout(store, DEFAULT_LAYOUT_ID)).toBe(store);
    // So a built-in cannot be lost: it is still there to restore from.
    expect(allNamedLayouts(store).some((entry) => entry.id === DEFAULT_LAYOUT_ID)).toBe(true);
  });

  it("RESTORE makes a named layout the live one", () => {
    const saved = saveLayoutAs(storeOf(movePane(DEFAULT_SHELL_LAYOUT, "shader", "left")), "Wide");
    const back = applyNamedLayout(saved, DEFAULT_LAYOUT_ID);

    expect(back.current).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(back.currentId).toBe(DEFAULT_LAYOUT_ID);
    // Restoring did not delete the saved one.
    expect(back.layouts).toHaveLength(1);
  });

  it("RENAME changes the name and nothing else", () => {
    const saved = saveLayoutAs(storeOf(DEFAULT_SHELL_LAYOUT), "Old");
    const id = saved.currentId ?? "";
    const renamed = renameNamedLayout(saved, id, "New");
    expect(renamed.layouts[0]?.name).toBe("New");
    expect(renamed.layouts[0]?.layout).toEqual(saved.layouts[0]?.layout);
    expect(renamed.currentId).toBe(id);
  });

  it("DELETE removes the entry but leaves what is on screen alone", () => {
    const saved = saveLayoutAs(storeOf(DEFAULT_SHELL_LAYOUT), "Temp");
    const deleted = deleteNamedLayout(saved, saved.currentId ?? "");
    expect(deleted.layouts).toEqual([]);
    expect(deleted.currentId).toBeNull();
    // Deleting the bookmark is not rearranging the room.
    expect(deleted.current).toEqual(saved.current);
  });

  it("knows when the live arrangement has drifted from the layout it came from", () => {
    const saved = saveLayoutAs(storeOf(DEFAULT_SHELL_LAYOUT), "Pinned");
    expect(isLayoutModified(saved)).toBe(false);

    const drifted: LayoutStore = { ...saved, current: movePane(saved.current, "shader", "left") };
    expect(isLayoutModified(drifted)).toBe(true);

    // A resize counts too: it is the thing Update exists to capture.
    const resized: LayoutStore = { ...saved, current: { ...saved.current, rows: [50, 50] } };
    expect(isLayoutModified(resized)).toBe(true);
  });

  it("round-trips the whole named set through storage", () => {
    const storage = createMemoryStorage();
    const store = saveLayoutAs(storeOf(movePane(DEFAULT_SHELL_LAYOUT, "agent", "left")), "Mine");
    writeLayoutStore(store, storage);

    const read = readLayoutStore(storage);
    expect(read.layouts.map((entry) => entry.name)).toEqual(["Mine"]);
    expect(read.currentId).toBe(store.currentId);
    expect(read.layouts[0]?.layout.zones.left).toContain("agent");
  });

  it("drops a stored entry that is not a usable named layout", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 3,
        current: DEFAULT_SHELL_LAYOUT,
        currentId: "user:gone",
        layouts: [
          null,
          { id: "", name: "no id", layout: DEFAULT_SHELL_LAYOUT },
          { id: "preset:default", name: "impostor", layout: DEFAULT_SHELL_LAYOUT },
          { id: "user:ok", name: "Ok", layout: DEFAULT_SHELL_LAYOUT },
        ],
      }),
    });

    const store = readLayoutStore(storage);
    expect(store.layouts.map((entry) => entry.id)).toEqual(["user:ok"]);
    // A selection naming nothing is dropped rather than left dangling.
    expect(store.currentId).toBeNull();
  });
});
