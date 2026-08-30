import { describe, expect, it } from "vitest";
import { evaluateExpression, scopeFromFrame } from "@domain/expressions/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { createKeymapStore } from "@editor/keymap/store.ts";
import {
  CANDIDATE_FUNCTIONS,
  expressionFunctions,
  expressionOperators,
  expressionSuggestions,
  expressionVariables,
  previewExpression,
} from "./expression-reference.ts";
import { nodeReferenceSections } from "./node-reference.ts";
import { shortcutSections } from "./shortcut-reference.ts";

/**
 * The anti-drift suite for the help panel (T200, §V105).
 *
 * §V105's claim is not "help exists" — it is that help CANNOT be wrong, because it holds
 * no copy of anything. Each test below breaks the live source and asserts the reference
 * moved with it. A hand-written table would pass none of them.
 */



const FRAME: FrameEvaluationInput = {
  timeSeconds: 2,
  deltaSeconds: 1 / 60,
  frameIndex: 120,
  mode: "fixed-step",
  randomSeed: 7,
};

function entryFor(sections: ReturnType<typeof shortcutSections>, id: string) {
  for (const section of sections) {
    const found = section.entries.find((entry) => entry.id === id);
    if (found !== undefined) return found;
  }
  throw new Error(`no shortcut entry "${id}"`);
}

describe("shortcut reference ← the keymap (§V105, §V55)", () => {
  it("shows the shipped binding", () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    expect(entryFor(shortcutSections(store.getSnapshot()), "graph.undo").display).toBe("⌘Z");
  });

  it("MOVES when the user rebinds — the whole reason it is derived", () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    expect(store.setOverride("graph.undo", "mod+u").status).toBe("ok");

    // Same lookup, after the override layer. A copy would still say ⌘Z, and someone
    // would trust it.
    expect(entryFor(shortcutSections(store.getSnapshot()), "graph.undo").display).toBe("⌘U");
  });

  it("says UNBOUND rather than dropping a command the user unbound (§V54)", () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    store.setOverride("graph.undo", null);
    const entry = entryFor(shortcutSections(store.getSnapshot()), "graph.undo");
    expect(entry.display).toBeNull();
    // "Exists and has no key" is a different fact from "does not exist".
    expect(entry.label).toBe("Undo");
  });

  it("carries every shipped binding, so nothing is quietly undocumented", () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" });
    const listed = shortcutSections(store.getSnapshot()).flatMap((section) =>
      section.entries.map((entry) => entry.id),
    );
    expect(new Set(listed)).toEqual(new Set(DEFAULT_BINDINGS.map((binding) => binding.id)));
  });

  it("names help itself, so the panel can be found by the key that opens it", () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    expect(entryFor(shortcutSections(store.getSnapshot()), "ui.help").command).toBe("ui.openHelp");
  });
});

describe("node reference ← the manifests (§V105)", () => {
  it("describes exactly what the registry holds, ports and parameters included", () => {
    const registry = createTestRegistry();
    const definitions = registry.list();
    const sections = nodeReferenceSections(definitions);

    const listed = sections.flatMap((section) => section.nodes.map((node) => node.type));
    expect(new Set(listed)).toEqual(new Set(definitions.map((definition) => definition.type)));

    const blur = sections.flatMap((section) => section.nodes).find((node) => node.type === "test.blur");
    const manifest = registry.require("test.blur");
    expect(blur?.title).toBe(manifest.title);
    // Parameter labels are READ from the schema; renaming one renames it here.
    expect(blur?.parameters.map((parameter) => parameter.key).sort()).toEqual(
      Object.keys(manifest.parameters).sort(),
    );
  });
});

describe("expression reference ← the evaluator (§V105, §V71)", () => {
  it("lists the names `scopeFromFrame` actually provides", () => {
    const variables = expressionVariables(scopeFromFrame(FRAME));
    // T271: `time`/`delta` are the TIMELINE pair, `walltime`/`walldelta` the wall one.
    // T461: `abstime`/`absframe` are the THIRD clock — the one that does not reset when a
    // bounded timeline laps, and the only one an unbroken rotation can be driven from.
    expect(variables.map((variable) => variable.name)).toEqual([
      "absframe",
      "abstime",
      "delta",
      "frame",
      "time",
      "walldelta",
      "walltime",
    ]);
    // Values, not placeholders: this is the scope the resolver will use.
    expect(variables.find((variable) => variable.name === "time")?.value).toBe(2);
  });

  it("carries node context alongside the frame names", () => {
    const variables = expressionVariables(scopeFromFrame(FRAME, { gain: 0.5 }));
    expect(variables.map((variable) => variable.name)).toContain("gain");
  });

  it("lists the evaluator's ACTUAL whitelist, never a copy of one", () => {
    const listed = new Set(expressionFunctions());
    // The assertion that makes this a derivation: for every name the reference could
    // have offered, being listed and being accepted are the same thing. A hand-written
    // list would say "sin" today, and the evaluator would reject it today.
    for (const name of CANDIDATE_FUNCTIONS) {
      const accepted =
        evaluateExpression(`${name}(1)`).ok ||
        evaluateExpression(`${name}(1, 1)`).ok ||
        evaluateExpression(`${name}(1, 1, 1)`).ok;
      expect(listed.has(name), name).toBe(accepted);
    }
  });

  it("shows only operators the grammar accepts, each with its real result", () => {
    for (const sample of expressionOperators()) {
      const result = evaluateExpression(sample.source);
      expect(result.ok, sample.source).toBe(true);
      expect(result.ok ? result.value : NaN).toBe(sample.value);
    }
    // The v1 grammar has arithmetic, so the section is not empty for the wrong reason.
    expect(expressionOperators().length).toBeGreaterThan(0);
  });

  it("only suggests starters that parse and evaluate in the scope shown", () => {
    const scope = scopeFromFrame(FRAME);
    const suggestions = expressionSuggestions(scope);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const sample of suggestions) {
      const result = evaluateExpression(sample.source, scope);
      expect(result.ok, sample.source).toBe(true);
      expect(result.ok ? result.value : NaN).toBe(sample.value);
    }
  });

  it("suggests nothing that needs a variable the scope does not have", () => {
    expect(expressionSuggestions({})).toEqual([]);
  });

  it("previews live, and reports the evaluator's own reason on a bad source", () => {
    const scope = scopeFromFrame(FRAME);
    expect(previewExpression("time * 2", scope)).toEqual({ state: "value", value: 4 });
    expect(previewExpression("  ", scope)).toEqual({ state: "empty" });

    const bad = previewExpression("time * ", scope);
    expect(bad.state).toBe("error");
    const reason = evaluateExpression("time * ", scope);
    expect(bad.state === "error" ? bad.reason : "").toBe(reason.ok ? "" : reason.reason);
  });
});
