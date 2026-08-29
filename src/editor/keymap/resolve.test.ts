import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../ui/testing/install-dom-stubs.ts";
import { DEFAULT_BINDINGS } from "./defaults.ts";
import { KEYMAP_STORAGE_KEY, readOverrides, writeOverrides } from "./storage.ts";
import { displayForCommand, resolveKeymap } from "./resolve.ts";
import { createKeymapStore } from "./store.ts";
import type { KeyBinding } from "./types.ts";

/** Layering, conflicts, persistence and reset (T78, §V54). */

function binding(overrides: Partial<KeyBinding> & Pick<KeyBinding, "id" | "keys">): KeyBinding {
  return { context: "global", command: "graph.undo", label: overrides.id, ...overrides };
}

const base: KeyBinding[] = [
  binding({ id: "undo", keys: "mod+z", label: "Undo" }),
  binding({ id: "redo", keys: "mod+shift+z", command: "graph.redo", label: "Redo" }),
  binding({ id: "bypass", keys: "b", context: "graph", command: "node.setFormat", label: "Bypass" }),
];

describe("override layering (§V54)", () => {
  it("an override replaces the default and remembers where it came from", () => {
    const resolved = resolveKeymap({ defaults: base, overrides: { undo: "mod+u" } }, "other");
    const undo = resolved.byId.get("undo");
    expect(undo?.effectiveKeys).toBe("mod+u");
    expect(undo?.display).toBe("Ctrl+U");
    expect(undo?.source).toBe("override");
    expect(undo?.defaultKeys).toBe("mod+z");
  });

  it("null unbinds without losing the binding from the list", () => {
    const resolved = resolveKeymap({ defaults: base, overrides: { bypass: null } }, "other");
    const bypass = resolved.byId.get("bypass");
    expect(bypass?.effectiveKeys).toBeNull();
    expect(bypass?.display).toBeNull();
    expect(bypass?.isBound).toBe(false);
    expect(resolved.active.some((entry) => entry.id === "bypass")).toBe(false);
    // Still listed, so the settings pane can offer a reset.
    expect(resolved.bindings.some((entry) => entry.id === "bypass")).toBe(true);
  });

  it("keeps the default and reports the problem when an override is unparseable", () => {
    const resolved = resolveKeymap({ defaults: base, overrides: { undo: "mod+" + "shift" } }, "other");
    expect(resolved.byId.get("undo")?.effectiveKeys).toBe("mod+z");
    expect(resolved.problems.map((problem) => problem.code)).toContain("invalid-keys");
  });

  it("reports an override for a binding that no longer exists", () => {
    const resolved = resolveKeymap({ defaults: base, overrides: { "gone.away": "mod+j" } }, "other");
    expect(resolved.problems.map((problem) => problem.code)).toContain("unknown-binding");
  });

  it("reports a binding whose `when` guard is not a real guard", () => {
    const resolved = resolveKeymap(
      { defaults: [binding({ id: "x", keys: "x", when: "whenTheStarsAlign" })], overrides: {} },
      "other",
    );
    expect(resolved.problems.map((problem) => problem.code)).toContain("unknown-guard");
  });
});

describe("conflict detection (§V54)", () => {
  it("reports BOTH bindings when two commands share a key in one context", () => {
    const resolved = resolveKeymap(
      { defaults: base, overrides: { redo: "mod+z" } },
      "other",
    );
    const conflict = resolved.conflicts.find((entry) => entry.kind === "duplicate");
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe("error");
    expect(conflict?.bindings.map((entry) => entry.id).sort()).toEqual(["redo", "undo"]);
    expect(resolved.conflictingIds.has("undo")).toBe(true);
    expect(resolved.conflictingIds.has("redo")).toBe(true);
    expect(conflict?.message).toContain("Ctrl+Z");
  });

  it("warns rather than errors when a pane binding shadows a global one", () => {
    // Deterministic (narrowest wins) but still worth surfacing — §V54 forbids a
    // silent shadow, not a resolvable one.
    const resolved = resolveKeymap({ defaults: base, overrides: { bypass: "mod+z" } }, "other");
    const conflict = resolved.conflicts.find((entry) => entry.kind === "duplicate");
    expect(conflict?.severity).toBe("warning");
    expect(conflict?.bindings.map((entry) => entry.id).sort()).toEqual(["bypass", "undo"]);
  });

  it("does not report two panes that are never active together", () => {
    const resolved = resolveKeymap(
      {
        defaults: [
          binding({ id: "a", keys: "k", context: "graph" }),
          binding({ id: "b", keys: "k", context: "inspector" }),
        ],
        overrides: {},
      },
      "other",
    );
    expect(resolved.conflicts).toEqual([]);
  });

  it("reports a chord that can never complete because its prefix is bound", () => {
    const resolved = resolveKeymap(
      {
        defaults: [
          binding({ id: "single", keys: "g" }),
          binding({ id: "chord", keys: "g d" }),
        ],
        overrides: {},
      },
      "other",
    );
    const conflict = resolved.conflicts.find((entry) => entry.kind === "prefix");
    expect(conflict?.bindings.map((entry) => entry.id)).toEqual(["single", "chord"]);
  });

  it("the shipped defaults have no conflicts and no problems", () => {
    const resolved = resolveKeymap({ defaults: DEFAULT_BINDINGS, overrides: {} }, "mac");
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.problems).toEqual([]);
  });
});

describe("lookup for menus and tooltips (§V55)", () => {
  it("answers with a display string per command", () => {
    const resolved = resolveKeymap({ defaults: base, overrides: {} }, "mac");
    expect(displayForCommand(resolved, "graph.undo")).toBe("⌘Z");
    expect(displayForCommand(resolved, "graph.redo")).toBe("⇧⌘Z");
    expect(displayForCommand(resolved, "nobody.registered.this")).toBeNull();
  });

  it("follows a rebind, so a menu never goes stale", () => {
    const resolved = resolveKeymap({ defaults: base, overrides: { undo: "mod+u" } }, "mac");
    expect(displayForCommand(resolved, "graph.undo")).toBe("⌘U");
  });
});

describe("persistence (§V54 — localStorage, never the project document)", () => {
  it("round-trips overrides through storage", () => {
    const storage = createMemoryStorage();
    const store = createKeymapStore({ defaults: base, storage, platform: "other" });
    store.setOverride("undo", "mod+u");

    const reloaded = createKeymapStore({ defaults: base, storage, platform: "other" });
    expect(reloaded.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+u");
    expect(storage.keys()).toEqual([KEYMAP_STORAGE_KEY]);
  });

  it("survives a corrupt entry by dropping only that entry", () => {
    const storage = createMemoryStorage({
      [KEYMAP_STORAGE_KEY]: JSON.stringify({ undo: "mod+u", redo: "&&&", bypass: null }),
    });
    const overrides = readOverrides(storage);
    expect(overrides).toEqual({ undo: "mod+u", bypass: null });
  });

  it("survives unparseable JSON without throwing", () => {
    const storage = createMemoryStorage({ [KEYMAP_STORAGE_KEY]: "{not json" });
    expect(readOverrides(storage)).toEqual({});
  });

  it("removes the entry rather than storing an empty map", () => {
    const storage = createMemoryStorage();
    writeOverrides({ undo: "mod+u" }, storage);
    expect(storage.size).toBe(1);
    writeOverrides({}, storage);
    expect(storage.size).toBe(0);
  });
});

describe("reset (§V54)", () => {
  it("resets one binding and leaves the others alone", () => {
    const storage = createMemoryStorage();
    const store = createKeymapStore({ defaults: base, storage, platform: "other" });
    store.setOverride("undo", "mod+u");
    store.setOverride("redo", "mod+y");

    store.resetBinding("undo");
    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+z");
    expect(store.getSnapshot().byId.get("redo")?.effectiveKeys).toBe("mod+y");
    expect(store.hasOverride("undo")).toBe(false);
  });

  it("resets the whole map", () => {
    const storage = createMemoryStorage();
    const store = createKeymapStore({ defaults: base, storage, platform: "other" });
    store.setOverride("undo", "mod+u");
    store.setOverride("bypass", null);

    store.resetAll();
    expect(store.getOverrides()).toEqual({});
    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+z");
    expect(store.getSnapshot().byId.get("bypass")?.effectiveKeys).toBe("b");
    expect(storage.size).toBe(0);
  });

  it("rebinding back to the default drops the override rather than storing a no-op", () => {
    const store = createKeymapStore({ defaults: base, storage: null, platform: "other" });
    store.setOverride("undo", "mod+u");
    store.setOverride("undo", "mod+z");
    expect(store.hasOverride("undo")).toBe(false);
    expect(store.getSnapshot().byId.get("undo")?.source).toBe("default");
  });

  it("refuses an invalid rebind and says why, instead of silently doing nothing", () => {
    const store = createKeymapStore({ defaults: base, storage: null, platform: "other" });
    expect(store.setOverride("undo", "mod+shift")).toEqual({
      status: "invalid",
      message: '"mod+shift" is not a valid key sequence.',
    });
    expect(store.setOverride("nope", "mod+j").status).toBe("unknown-binding");
    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+z");
  });

  it("notifies subscribers so the UI and the live engine stay in step", () => {
    const store = createKeymapStore({ defaults: base, storage: null, platform: "other" });
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    const before = store.getSnapshot();
    store.setOverride("undo", "mod+u");
    expect(notified).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    unsubscribe();
    store.setOverride("undo", "mod+i");
    expect(notified).toBe(1);
  });
});
