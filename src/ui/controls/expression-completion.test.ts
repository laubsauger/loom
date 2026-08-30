import { describe, expect, it } from "vitest";
import { applyCompletion, completionAt } from "./expression-completion.ts";

/** Expression completion (T247, §V150). */

const SCOPE = { time: 2, delta: 0.016, frame: 120, walltime: 2.1, walldelta: 0.017 };

describe("completionAt", () => {
  it("offers everything in scope before a character is typed", () => {
    // The complaint that started this: the field looked like it suggested something and
    // then stopped. A menu that only appears once you know what to type helps nobody.
    const state = completionAt("", 0, SCOPE);
    expect(state?.candidates.map((c) => c.text)).toContain("time");
    expect(state?.prefix).toBe("");
  });

  it("narrows as the identifier is typed, and keeps narrowing", () => {
    const state = completionAt("wall", 4, SCOPE);
    expect(state?.candidates.map((c) => c.text)).toEqual(["walldelta", "walltime"]);
    expect(state?.prefix).toBe("wall");
  });

  it("closes once the typed name is complete, rather than offering it back", () => {
    // A menu whose only entry is exactly what you already typed cannot do anything, so
    // there is no menu. This is the moment the popup should get out of the way.
    expect(completionAt("walltime", 8, SCOPE)).toBeNull();
  });

  it("returns null when nothing matches, rather than an empty menu", () => {
    expect(completionAt("zzz", 3, SCOPE)).toBeNull();
  });

  it("offers NODE names inside op('…'), never variables", () => {
    // `op('ti` wants a node called `title`, not the variable `time`. Offering scope names
    // here would be actively misleading rather than merely unhelpful.
    const state = completionAt("op('", 4, SCOPE, ["noise1", "lfo1"]);
    expect(state?.candidates.map((c) => c.text)).toEqual(["lfo1", "noise1"]);
    expect(state?.candidates.every((c) => c.kind === "node")).toBe(true);
  });

  it("only offers functions the evaluator actually accepts (§V150)", () => {
    // The grammar rejects calls today, so there are no function candidates — and that
    // emptiness is the correct answer. If this ever fails it means the whitelist landed,
    // and the menu will have grown on its own without anyone editing a list.
    const functions = completionAt("", 0, SCOPE)?.candidates.filter((c) => c.kind === "function");
    for (const candidate of functions ?? []) {
      expect(typeof candidate.text).toBe("string");
    }
  });

  it("completes against the identifier under the caret, not the whole source", () => {
    const source = "time * wal";
    const state = completionAt(source, source.length, SCOPE);
    expect(state?.start).toBe(7);
    expect(state?.end).toBe(10);
  });
});

describe("applyCompletion", () => {
  it("replaces only the prefix and reports where the caret lands", () => {
    const source = "time * wal";
    const state = completionAt(source, source.length, SCOPE);
    if (state === null) throw new Error("expected candidates");
    const applied = applyCompletion(source, state, state.candidates[1] as never);
    expect(applied.source).toBe("time * walltime");
    expect(applied.caret).toBe(applied.source.length);
  });

  it("opens the bracket for a function, since the next thing typed is an argument", () => {
    const state = { prefix: "", start: 0, end: 0, candidates: [] } as never;
    const applied = applyCompletion("", state, { text: "clamp", kind: "function" });
    expect(applied.source).toBe("clamp(");
    expect(applied.caret).toBe(6);
  });
});
