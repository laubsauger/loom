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
import { nodeReference, nodeReferenceSections, splitLede } from "./node-reference.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
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

/**
 * The authored prose (T1337b, T1338b, §V998).
 *
 * These rows exist because `description` was declared on `NodeReference`, filled from the
 * manifest, and then dropped — and because ports and parameters never carried theirs at
 * all. The claims below are about the DERIVATION reaching the panel's hands intact; that
 * the panel then RENDERS it is asserted in `help-panel.test.tsx`, because those are the
 * two halves §V998 says each look complete from their own side.
 */
describe("the manifests' prose reaches the reference (T1337b, T1338b)", () => {
  it("splits at the author's own sentence end, and never inside a number", () => {
    // The lede is the summary the author already wrote. `9.6` must not end a sentence:
    // the rule needs whitespace after the stop, and a decimal point has none.
    expect(splitLede("Automatic prefers the GPU — 9.6x faster. Ask for CPU to compare.")).toEqual({
      summary: "Automatic prefers the GPU — 9.6x faster.",
      detail: "Ask for CPU to compare.",
    });
    // A signature line is a perfectly good lede, and the period after `Point` is a real
    // sentence end — this is the shape every point-shader parameter opens with.
    expect(splitLede("fn process(p: Point, ctx: PointCtx) -> Point. q.alive = 0u kills.")).toEqual({
      summary: "fn process(p: Point, ctx: PointCtx) -> Point.",
      detail: "q.alive = 0u kills.",
    });
    // One sentence is the majority case: there is nothing behind it, and the panel must
    // be able to tell that from "there is more", so it does not offer an empty disclosure.
    expect(splitLede("Linear-space colour.")).toEqual({
      summary: "Linear-space colour.",
      detail: "",
    });
    // An abbreviation is not a sentence end, or the lede stops at "e.g.".
    expect(splitLede("Accepts a channel name, e.g. level or onset. Wire it or drive it.")).toEqual({
      summary: "Accepts a channel name, e.g. level or onset.",
      detail: "Wire it or drive it.",
    });
  });

  it("LOSES NO BYTE of any shipped description — the split is a container, not an edit", () => {
    // §T1055 measured the population and concluded the long tail is house style, not a
    // defect. So the one thing this split must never do is shorten anything: for all 115
    // shipped node descriptions, summary + detail must reconstitute the author's text.
    const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
    let checked = 0;
    for (const definition of allNodeDefinitions) {
      if (definition.description === undefined) continue;
      const reference = nodeReference(definition);
      expect(squash(`${reference.summary ?? ""} ${reference.detail}`), definition.type).toBe(
        squash(definition.description),
      );
      checked += 1;
    }
    // The loop must have had something to check — 115 descriptions ship today.
    expect(checked).toBeGreaterThan(100);
  });

  it("carries every port and parameter description a manifest authors", () => {
    // Read back from the shipped catalogue, not from a copy: the count is whatever the
    // manifests hold today, and the assertion is that NONE of them stop at the manifest.
    let ports = 0;
    let parameters = 0;
    for (const definition of allNodeDefinitions) {
      const reference = nodeReference(definition);
      const referencePorts = [...reference.inputs, ...reference.outputs];
      for (const port of [...definition.inputs, ...definition.outputs]) {
        if (port.description === undefined) continue;
        expect(
          referencePorts.find((candidate) => candidate.id === port.id)?.description,
          `${definition.type}.${port.id}`,
        ).toBe(port.description);
        ports += 1;
      }
      for (const [key, schema] of Object.entries(definition.parameters)) {
        if (schema.description === undefined) continue;
        expect(
          reference.parameters.find((candidate) => candidate.key === key)?.description,
          `${definition.type}.${key}`,
        ).toBe(schema.description);
        parameters += 1;
      }
    }
    // T1338b's 77 port strings and T1337b's 293 parameter strings, still authored.
    expect(ports).toBeGreaterThan(50);
    expect(parameters).toBeGreaterThan(200);
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
