import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "@ui/testing/install-dom-stubs.ts";
import {
  DEFAULT_SHELL_LAYOUT,
  LAYOUT_STORAGE_KEY,
  clearLayout,
  readLayout,
  writeLayout,
} from "./layout-storage.ts";

/**
 * V18 — pane sizes belong to the machine, not to the project.
 * These tests exist because a layout that leaked into `.loom.json` would travel
 * to other users and other screens, and because a corrupt entry must degrade to
 * the stock layout instead of an unusable shell.
 */
describe("V18 — shell layout persistence", () => {
  it("round-trips a layout through the store", () => {
    const storage = createMemoryStorage();
    const layout = {
      rows: [60, 40],
      columns: [20, 50, 30],
      rightRows: [30, 70],
      dockTab: "problems" as const,
    };

    writeLayout(layout, storage);
    expect(readLayout(storage)).toEqual(layout);
  });

  it("stores layout under a single localStorage key and nowhere else", () => {
    const storage = createMemoryStorage();
    writeLayout(DEFAULT_SHELL_LAYOUT, storage);

    expect(storage.keys()).toEqual([LAYOUT_STORAGE_KEY]);
    // Serialized form carries pane sizes only — no project, graph or node data,
    // which is what keeps it out of the document (V18).
    const stored: unknown = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    expect(Object.keys(stored as object).sort()).toEqual([
      "columns",
      "dockTab",
      "rightRows",
      "rows",
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
        rows: [60, 40],
        columns: [10, 10], // wrong arity
        rightRows: ["a", "b"], // wrong element type
        dockTab: "nope", // not a tab
      }),
    });

    expect(readLayout(storage)).toEqual({
      rows: [60, 40],
      columns: DEFAULT_SHELL_LAYOUT.columns,
      rightRows: DEFAULT_SHELL_LAYOUT.rightRows,
      dockTab: DEFAULT_SHELL_LAYOUT.dockTab,
    });
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
