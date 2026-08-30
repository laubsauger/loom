import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS } from "./defaults.ts";
import { isValidKeys, normalizeKeys } from "./keys.ts";
import { resolveKeymap } from "./resolve.ts";
import { isKnownGuard } from "./when.ts";
import type { KeyBinding } from "./types.ts";

/**
 * The shipped keymap (T77), verified against docs.derivative.ca/Application_Shortcuts.
 *
 * These assertions are the TD parity contract: if someone "tidies" the table, the test
 * says which shortcut they changed and why it mattered.
 */

function find(id: string): KeyBinding {
  const binding = DEFAULT_BINDINGS.find((entry) => entry.id === id);
  if (binding === undefined) throw new Error(`No default binding "${id}".`);
  return binding;
}

describe("keymap integrity", () => {
  it("has unique, stable ids", () => {
    const ids = DEFAULT_BINDINGS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every binding parses, is labelled, and guards on a guard that exists", () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(isValidKeys(binding.keys), `${binding.id}: "${binding.keys}"`).toBe(true);
      expect(binding.label.length, binding.id).toBeGreaterThan(0);
      expect(isKnownGuard(binding.when), `${binding.id}: ${binding.when ?? ""}`).toBe(true);
    }
  });

  it("resolves with no conflicts on either platform", () => {
    for (const platform of ["mac", "other"] as const) {
      const resolved = resolveKeymap({ defaults: DEFAULT_BINDINGS, overrides: {} }, platform);
      expect(resolved.conflicts, platform).toEqual([]);
      expect(resolved.problems, platform).toEqual([]);
    }
  });

  it("keeps bare letters out of the global context", () => {
    // A bare letter that fires anywhere would collide with every pane and with the
    // TD single-key vocabulary. Ours are Space and "." only, deliberately.
    const globalBareLetters = DEFAULT_BINDINGS.filter(
      (binding) => binding.context === "global" && /^[A-Za-z]$/.test(binding.keys),
    );
    expect(globalBareLetters).toEqual([]);
  });

  it("declares every selection-driven binding with a guard", () => {
    // Without the guard, a binding with no selection would send an empty command to
    // the bus instead of doing nothing.
    for (const binding of DEFAULT_BINDINGS) {
      if (binding.inputFrom === undefined) continue;
      expect(binding.when, binding.id).toBeDefined();
    }
  });
});

describe("verified TouchDesigner network-editor bindings", () => {
  it("uses single keys, not modifiers, in the graph", () => {
    for (const id of ["node.toggleBypass", "node.toggleDisplay", "node.toggleRender", "node.openViewer"]) {
      const binding = find(id);
      expect(binding.context).toBe("graph");
      expect(binding.keys).toMatch(/^[a-z]$/);
    }
  });

  it("distinguishes case: uppercase acts on all, lowercase on the selection", () => {
    // The convention survives `h` being unbound (T430): `F`/`f` still carry it, and `H`
    // still reads as the uppercase "acts on everything" member of the pair — it is the
    // LOWERCASE half that has no meaning here, not the convention.
    expect(normalizeKeys(find("view.home").keys)).toBe("shift+h");
    expect(normalizeKeys(find("view.frame").keys)).toBe("shift+f");
    expect(normalizeKeys(find("view.frameSelected").keys)).toBe("f");
    expect(find("view.frameSelected").when).toBe("hasSelection");
  });

  it("binds the verified table", () => {
    // THREE TD keys are deliberately absent from this otherwise TD-verified table, which
    // makes them exactly the kind of thing a future reader would "restore": `mod+f` (no
    // find surface exists), `h` (home-selected has no meaning beside a `H` that is about
    // scale) and `o` (TD's overview is a separate pane this app does not have). The loop
    // at the end of this test is what keeps each one a decision rather than an omission.
    const expected: Record<string, string> = {
      "graph.addOperator": "tab",
      "node.toggleBypass": "b",
      "node.toggleDisplay": "d",
      "node.toggleRender": "r",
      "node.openViewer": "v",
      "graph.diveIn": "i",
      "graph.jumpUp": "u",
      "graph.diveIn.enter": "enter",
      "node.rename": "n",
      "node.colorPalette": "c",
      "node.editExpose": "e",
      "graph.delete": "delete",
      "graph.selectAll": "mod+a",
      "graph.copy": "mod+c",
      "graph.cut": "mod+x",
      "graph.paste": "mod+v",
    };
    for (const [id, keys] of Object.entries(expected)) {
      expect(normalizeKeys(find(id).keys), id).toBe(normalizeKeys(keys));
    }

    // T443/T430: unbound until each has a meaning or a surface, and rebinding one has to
    // be a visible edit to this line rather than a quiet re-add to the table above.
    // `mod+f` — no find surface exists. `h`/`o` — "home selected" has no meaning beside a
    // `H` that is about SCALE, and TD's overview is a separate pane this app lacks.
    for (const command of ["ui.findInGraph", "view.homeSelected", "view.overview"]) {
      expect(
        DEFAULT_BINDINGS.filter((binding) => binding.command === command),
        `${command} is deliberately unbound (T430/T443, §V354)`,
      ).toEqual([]);
    }
  });

  it("does not ship the shortcuts that turned out not to be TouchDesigner's", () => {
    // P pin preview, M mute, mod+g group and 1..8 viewer were guesses; TD covers that
    // ground with d, r and v. They must not come back by accident.
    const keys = DEFAULT_BINDINGS.map((binding) => normalizeKeys(binding.keys));
    for (const dropped of ["shift+p", "shift+m", "mod+g", "1", "2", "8"]) {
      expect(keys, dropped).not.toContain(dropped);
    }
  });
});

describe("our app-level bindings", () => {
  it("binds the shortcuts the spec keeps as ours", () => {
    const expected: Record<string, string> = {
      "graph.undo": "mod+z",
      "graph.redo": "mod+shift+z",
      "project.save": "mod+s",
      "graph.duplicate": "mod+d",
      "ui.commandPalette": "mod+k",
      "ui.settings": "mod+,",
      "transport.playPause": "space",
      "transport.stepFrame": ".",
      "runtime.resetFeedback": "mod+shift+r",
      "ui.cancel": "escape",
    };
    for (const [id, keys] of Object.entries(expected)) {
      expect(normalizeKeys(find(id).keys), id).toBe(normalizeKeys(keys));
    }

    // T443/T430: unbound until each has a meaning or a surface, and rebinding one has to
    // be a visible edit to this line rather than a quiet re-add to the table above.
    // `mod+f` — no find surface exists. `h`/`o` — "home selected" has no meaning beside a
    // `H` that is about SCALE, and TD's overview is a separate pane this app lacks.
    for (const command of ["ui.findInGraph", "view.homeSelected", "view.overview"]) {
      expect(
        DEFAULT_BINDINGS.filter((binding) => binding.command === command),
        `${command} is deliberately unbound (T430/T443, §V354)`,
      ).toEqual([]);
    }
  });

  it("passes static input where the command needs it", () => {
    expect(find("transport.stepFrame").input).toEqual({ frames: 1 });
  });

  it("marks the bindings that could not be confirmed against a real install", () => {
    const unconfirmed = DEFAULT_BINDINGS.filter((binding) => binding.unconfirmed === true).map(
      (binding) => binding.id,
    );
    // L/l layout: §I lists them with the case convention reversed from H/h and F/f.
    expect(unconfirmed).toEqual(["graph.layout", "graph.layoutAll"]);
  });
});
