import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "@ui/testing/install-dom-stubs.ts";
import {
  DEFAULT_SHELL_LAYOUT,
  LAYOUT_STORAGE_KEY,
  PANE_IDS,
  clearLayout,
  dockPane,
  floatPane,
  movePane,
  readLayout,
  selectPane,
  writeLayout,
  zoneOf,
} from "./layout-storage.ts";
import type { PaneId, ShellLayout } from "./layout-storage.ts";

/**
 * V18 — the arrangement belongs to the machine, not to the project.
 * These tests exist because a layout that leaked into `.loom.json` would travel
 * to other users and other screens, and because a corrupt entry must degrade to
 * the stock layout instead of an unusable shell.
 */
describe("V18 — shell layout persistence", () => {
  it("round-trips a layout through the store", () => {
    const layout = movePane(DEFAULT_SHELL_LAYOUT, "shader", "center");
    const storage = createMemoryStorage();

    writeLayout(layout, storage);
    expect(readLayout(storage)).toEqual(layout);
  });

  it("stores layout under a single localStorage key and nowhere else", () => {
    const storage = createMemoryStorage();
    writeLayout(DEFAULT_SHELL_LAYOUT, storage);

    expect(storage.keys()).toEqual([LAYOUT_STORAGE_KEY]);
    // Serialized form carries chrome state only — no project, graph or node data,
    // which is what keeps it out of the document (V18).
    const stored: unknown = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    expect(Object.keys(stored as object).sort()).toEqual([
      "active",
      "columns",
      "floating",
      "rows",
      "zones",
    ]);
  });

  it("returns defaults when nothing is stored", () => {
    expect(readLayout(createMemoryStorage())).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it("returns defaults when the entry is not JSON", () => {
    const storage = createMemoryStorage({ [LAYOUT_STORAGE_KEY]: "{not json" });
    expect(readLayout(storage)).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it("repairs only the groups that are invalid", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_SHELL_LAYOUT,
        rows: [60, 40],
        columns: [10, 10], // wrong arity
      }),
    });

    const restored = readLayout(storage);
    expect(restored.rows).toEqual([60, 40]);
    expect(restored.columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
    expect(restored.zones).toEqual(DEFAULT_SHELL_LAYOUT.zones);
  });

  it("rejects percentages that do not add up to a full group", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_SHELL_LAYOUT, rows: [10, 10] }),
    });
    expect(readLayout(storage).rows).toEqual(DEFAULT_SHELL_LAYOUT.rows);
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

    expect(readLayout(hostile)).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(() => writeLayout(DEFAULT_SHELL_LAYOUT, hostile)).not.toThrow();
    expect(() => clearLayout(hostile)).not.toThrow();
  });

  it("no-ops when there is no store at all", () => {
    expect(readLayout(null)).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(() => writeLayout(DEFAULT_SHELL_LAYOUT, null)).not.toThrow();
  });

  it("clears the entry", () => {
    const storage = createMemoryStorage();
    writeLayout(DEFAULT_SHELL_LAYOUT, storage);
    clearLayout(storage);
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).toBeNull();
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
    for (const zone of ["center", "left", "right", "bottom"] as const) {
      layout = movePane(layout, "shader", zone);
      expect(zoneOf(layout, "shader")).toBe(zone);
      expect(placements(layout).size).toBe(PANE_IDS.length);
      // Not in any other zone: the move REPLACES a placement, never adds one.
      const elsewhere = (["left", "center", "right", "bottom"] as const)
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
    expect(layout.active.bottom).toBe("shader"); // untouched
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
    expect(floated.zones.right).not.toContain("viewer");
    expect(floated.active.right).toBe("inspector");

    const docked = dockPane(floated, "viewer");
    expect(docked.floating).toEqual([]);
    expect(zoneOf(docked, "viewer")).toBe("right");
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
        rows: [70, 30],
        columns: [20, 55, 25],
        zones: {
          left: ["library", "shader"],
          center: ["graph"],
          right: ["inspector"],
          bottom: ["problems"],
        },
        active: { left: "shader", center: "graph", right: "inspector", bottom: "problems" },
        floating: ["viewer"],
      }),
    });

    const restored = readLayout(storage);
    // `components` was never mentioned; it lands in its home zone rather than vanishing,
    // which is what makes adding a pane free of migrations.
    expect(restored.zones.left).toEqual(["library", "shader", "components"]);
    expect(restored.active.left).toBe("shader");
    expect(restored.floating).toEqual(["viewer"]);
    expect(restored.zones.bottom).toEqual(["problems", "performance", "examples", "agent"]);
    expect(placements(restored).size).toBe(PANE_IDS.length);
  });

  it("drops unknown ids and duplicates rather than rendering a pane twice", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_SHELL_LAYOUT,
        zones: {
          left: ["library", "library", "vanished-pane"],
          center: ["graph", "library"],
          right: [],
          bottom: [],
        },
        floating: ["graph"],
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
