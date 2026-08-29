import { describe, expect, it } from "vitest";
import { createHarness } from "../../domain/commands/test-support.ts";
import { DEFAULT_BINDINGS } from "../keymap/defaults.ts";
import { resolveKeymap } from "../keymap/resolve.ts";
import { buildPaletteEntries, humanizeCommand } from "./entries.ts";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.ts";

/** What the palette lists and how it ranks (T79, §V55). */

const resolved = resolveKeymap({ defaults: DEFAULT_BINDINGS, overrides: {} }, "mac");

describe("palette entries", () => {
  it("lists every command registered on the bus", () => {
    const { bus } = createHarness();
    const entries = buildPaletteEntries({ bus, resolved });
    const commands = entries.map((entry) => entry.command);
    for (const registered of bus.listCommands()) {
      expect(commands, registered).toContain(registered);
    }
  });

  it("shows the current shortcut next to the command (§V55)", () => {
    const { bus } = createHarness();
    const entries = buildPaletteEntries({ bus, resolved });
    const undo = entries.find((entry) => entry.command === "graph.undo");
    expect(undo?.display).toBe("⌘Z");
    expect(undo?.label).toBe("Undo");
    expect(undo?.available).toBe(true);
  });

  it("follows a rebind rather than caching a key", () => {
    const { bus } = createHarness();
    const rebound = resolveKeymap({ defaults: DEFAULT_BINDINGS, overrides: { "graph.undo": "mod+u" } }, "mac");
    const undo = buildPaletteEntries({ bus, resolved: rebound }).find(
      (entry) => entry.command === "graph.undo",
    );
    expect(undo?.display).toBe("⌘U");
  });

  it("lists a bound-but-unregistered command as unavailable instead of hiding or faking it", () => {
    const { bus } = createHarness();
    const entries = buildPaletteEntries({ bus, resolved });
    const play = entries.find((entry) => entry.command === "transport.togglePlay");
    expect(play).toBeDefined();
    expect(play?.available).toBe(false);
    expect(play?.display).toBe("Space");
    // The bus was not given a stub to make the entry look real.
    expect(bus.hasCommand("transport.togglePlay")).toBe(false);
  });

  it("sorts available commands above unavailable ones", () => {
    const { bus } = createHarness();
    const entries = buildPaletteEntries({ bus, resolved });
    const firstUnavailable = entries.findIndex((entry) => !entry.available);
    const lastAvailable = entries.map((entry) => entry.available).lastIndexOf(true);
    expect(firstUnavailable).toBeGreaterThan(lastAvailable);
  });

  it("humanises a command that no binding names", () => {
    expect(humanizeCommand("graph.applyPatch")).toBe("Graph: Apply patch");
    expect(humanizeCommand("node.setResolution")).toBe("Node: Set resolution");
    expect(humanizeCommand("standalone")).toBe("Standalone");
  });
});

describe("fuzzy ranking", () => {
  it("matches a subsequence and rejects a non-match", () => {
    expect(fuzzyScore("und", "Undo")).not.toBeNull();
    expect(fuzzyScore("udn", "Undo")).toBeNull();
  });

  it("puts the tighter match first", () => {
    const items = ["Redo", "Reset feedback history", "Undo"];
    const ranked = fuzzyFilter("red", items, (item) => [item]).map((result) => result.item);
    expect(ranked[0]).toBe("Redo");
  });

  it("finds an entry by its command name as well as its label", () => {
    const { bus } = createHarness();
    const entries = buildPaletteEntries({ bus, resolved });
    const ranked = fuzzyFilter("graph.redo", entries, (entry) => [entry.label, entry.command]);
    expect(ranked[0]?.item.command).toBe("graph.redo");
  });

  it("keeps the incoming order for equal scores, so ranking is stable", () => {
    const items = ["alpha", "alpha"];
    const ranked = fuzzyFilter("a", items, (item) => [item]);
    expect(ranked.length).toBe(2);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("returns everything for an empty query", () => {
    const items = ["one", "two"];
    expect(fuzzyFilter("", items, (item) => [item]).length).toBe(2);
  });
});
