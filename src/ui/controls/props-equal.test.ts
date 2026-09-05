import { describe, expect, it } from "vitest";
import { sameProps, sameRenderedValue } from "./props-equal.ts";

/**
 * T1177 — the comparator behind the control kit's `React.memo` boundaries.
 *
 * Every test here is about the ONE direction that can hurt: a `true` this function is not
 * entitled to. A wrong `false` costs a render nobody notices; a wrong `true` is a panel
 * that stops telling the truth and says nothing about it (§B181's shape). So the cases
 * below are mostly "things that must NOT read as equal", and the few equality claims are
 * the shapes the resolver mints fresh on every read — without those the boundary would be
 * correct and worthless.
 */

describe("sameRenderedValue — proven equal, or false", () => {
  it("answers true for identical primitives, including NaN and both nullish forms", () => {
    expect(sameRenderedValue(1, 1)).toBe(true);
    expect(sameRenderedValue("a", "a")).toBe(true);
    expect(sameRenderedValue(false, false)).toBe(true);
    expect(sameRenderedValue(null, null)).toBe(true);
    expect(sameRenderedValue(undefined, undefined)).toBe(true);
    // A value that fell out of a numeric expression. `===` would say these differ and cost
    // an unnecessary render forever; `Object.is` is right and is what the walk starts with.
    expect(sameRenderedValue(Number.NaN, Number.NaN)).toBe(true);
  });

  it("never confuses a nullish prop with a present one", () => {
    expect(sameRenderedValue(null, undefined)).toBe(false);
    expect(sameRenderedValue(undefined, 0)).toBe(false);
    expect(sameRenderedValue(null, 0)).toBe(false);
    expect(sameRenderedValue(null, {})).toBe(false);
    expect(sameRenderedValue("", 0)).toBe(false);
    // A number that arrives as its own string is a DIFFERENT rendered value.
    expect(sameRenderedValue(1, "1")).toBe(false);
  });

  it("walks a fresh array of numbers — the shape a compound's value takes every read", () => {
    expect(sameRenderedValue([0.1, 0.2, 0.3, 1], [0.1, 0.2, 0.3, 1])).toBe(true);
    expect(sameRenderedValue([0.1, 0.2, 0.3, 1], [0.1, 0.2, 0.3, 0.999])).toBe(false);
    expect(sameRenderedValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameRenderedValue([1, 2], [2, 1])).toBe(false);
    // An array is never a record, whatever their contents look like.
    expect(sameRenderedValue([], {})).toBe(false);
  });

  it("walks a fresh diagnostic, and sees a difference in ANY of its fields", () => {
    const diagnostic = {
      severity: "warning",
      code: "parameter.expression",
      message: "op('lfo1').chan.value: there is no node named \"lfo1\"",
      nodeId: "n1",
    };
    expect(sameRenderedValue(diagnostic, { ...diagnostic })).toBe(true);
    expect(sameRenderedValue(diagnostic, { ...diagnostic, message: "something else" })).toBe(false);
    expect(sameRenderedValue(diagnostic, { ...diagnostic, severity: "error" })).toBe(false);
    expect(sameRenderedValue(diagnostic, { ...diagnostic, nodeId: "n2" })).toBe(false);
    // A field that APPEARS. The key counts are compared, so a diagnostic that grows a
    // `suggestion` is not the diagnostic that had none.
    expect(sameRenderedValue(diagnostic, { ...diagnostic, suggestion: "rename it" })).toBe(false);
    // …and one that LOSES a field, which a one-sided key walk would miss.
    const { nodeId: _dropped, ...withoutNode } = diagnostic;
    expect(sameRenderedValue(diagnostic, withoutNode)).toBe(false);
  });

  it("walks an array of records — a compound's per-channel resolutions (§V113)", () => {
    const components = [
      { name: "r", mode: "static", value: 1, slot: undefined, diagnostic: null },
      { name: "g", mode: "expression", value: 0.5, slot: undefined, diagnostic: null },
    ];
    expect(sameRenderedValue(components, structuredClone(components))).toBe(true);
    const moved = structuredClone(components);
    moved[1]!.value = 0.5001;
    expect(sameRenderedValue(components, moved)).toBe(false);
    const remoded = structuredClone(components);
    remoded[1]!.mode = "static";
    expect(sameRenderedValue(components, remoded)).toBe(false);
  });

  it("refuses to claim equality for anything it cannot walk", () => {
    // Two functions that do the same thing are not the same handler: one of them may be
    // closed over a node the panel has moved off, which is the stale-WRITE bug.
    expect(sameRenderedValue(() => 1, () => 1)).toBe(false);
    expect(sameRenderedValue(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false);
    expect(sameRenderedValue(new Set([1]), new Set([1]))).toBe(false);
    expect(sameRenderedValue(new Date(0), new Date(0))).toBe(false);
    class Holder {
      value: number;
      constructor(value: number) {
        this.value = value;
      }
    }
    expect(sameRenderedValue(new Holder(1), new Holder(1))).toBe(false);
    // A prototype-less record is not a plain record either — it is not a shape this kit
    // passes, so the honest answer is "I do not know".
    expect(sameRenderedValue(Object.assign(Object.create(null), { a: 1 }), { a: 1 })).toBe(false);
  });

  it("gives up rather than guessing past its depth cap", () => {
    const deep = (depth: number): unknown =>
      depth === 0 ? 1 : { next: deep(depth - 1) };
    // Four levels is what the kit's props need and is walked.
    expect(sameRenderedValue(deep(3), deep(3))).toBe(true);
    // Past it the answer is a re-render, never a wrong equality.
    expect(sameRenderedValue(deep(6), deep(6))).toBe(false);
  });

  it("is not fooled by a shared prefix or by extra keys", () => {
    expect(sameRenderedValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameRenderedValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    // Same key COUNT, different keys.
    expect(sameRenderedValue({ a: 1 }, { b: 1 })).toBe(false);
  });
});

describe("sameProps — the union of both sides' keys", () => {
  it("sees a prop that APPEARS, which a prev-keyed walk cannot", () => {
    // The case that motivated the union: `liveValue` starts arriving on a row that had
    // none, or a `diagnostic` shows up. Iterating `previous`'s keys alone reads both of
    // those as unchanged and freezes the row on its pre-driven number — §B181 exactly.
    expect(sameProps({ value: 1 }, { value: 1, liveValue: 2 } as never)).toBe(false);
    expect(sameProps({ value: 1, diagnostic: null }, { value: 1, diagnostic: { code: "x" } } as never)).toBe(false);
  });

  it("sees a prop that DISAPPEARS", () => {
    expect(sameProps({ value: 1, liveValue: 2 } as never, { value: 1 } as never)).toBe(false);
  });

  it("bails out only when every key is proven equal", () => {
    const handler = () => undefined;
    const references = { names: [], membersOf: () => [] };
    const previous = { value: 0.5, driven: true, onChange: handler, references, diagnostic: null };
    expect(sameProps(previous, { ...previous })).toBe(true);
    expect(sameProps(previous, { ...previous, value: 0.6 })).toBe(false);
    expect(sameProps(previous, { ...previous, driven: false })).toBe(false);
    // A NEW closure for the same behaviour is a different handler and must re-render:
    // this is the trap that makes freezing callbacks behind a ref unsafe.
    expect(sameProps(previous, { ...previous, onChange: () => undefined })).toBe(false);
  });
});
