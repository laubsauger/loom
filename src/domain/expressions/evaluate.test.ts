import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../types/frame.ts";
import {
  evaluateAst,
  evaluateExpression,
  functionNames,
  functionSignature,
  parseExpression,
  scopeFromFrame,
} from "./evaluate.ts";

/**
 * T108, §V71: the single expression engine — deterministic, sandboxed by construction,
 * variables only from the scope the caller passes (§V44, §V45). Arithmetic coverage
 * lives in `src/ui/controls/expression.test.ts`, which exercises this same engine
 * through the empty-scope text-entry wrapper; this file covers what the domain module
 * adds: variables, parse-once evaluation, and the frame scope.
 */

const frame: FrameEvaluationInput = {
  timeSeconds: 2.5,
  deltaSeconds: 0.016,
  frameIndex: 150,
  mode: "realtime",
  randomSeed: 7,
};

import {
  FREE_RUNNING_CLOCK_NAMES,
  WRAPPING_CLOCK_NAMES,
} from "./evaluate.ts";

/**
 * T505 — the exported clock families ARE the scope's clock keys, in both directions.
 * The highlighter derives from these lists; a clock added to `scopeFromFrame` without
 * joining a family would be invisibly unpainted, and a name in a family that the scope
 * does not supply would paint a variable that evaluates to an error.
 */
describe("clock families match the scope (T505)", () => {
  it("the two lists are disjoint and together are EXACTLY the bare scope's keys", () => {
    const frame = { timeSeconds: 1, deltaSeconds: 1 / 60, frameIndex: 60, mode: "realtime", randomSeed: 0 } as never;
    const keys = Object.keys(scopeFromFrame(frame)).sort();
    const union = [...WRAPPING_CLOCK_NAMES, ...FREE_RUNNING_CLOCK_NAMES].sort();
    expect(union).toEqual(keys);
    for (const name of WRAPPING_CLOCK_NAMES) {
      expect(FREE_RUNNING_CLOCK_NAMES).not.toContain(name);
    }
  });
});

describe("variables resolve only from the provided scope", () => {
  it("evaluates frame-driven expressions", () => {
    const scope = scopeFromFrame(frame);
    expect(evaluateExpression("time * 2", scope)).toEqual({ ok: true, value: 5 });
    expect(evaluateExpression("frame % 60", scope)).toEqual({ ok: true, value: 30 });
    expect(evaluateExpression("delta * 1000", scope)).toEqual({ ok: true, value: 16 });
  });

  it("lets node context extend the frame scope without shadowing it", () => {
    const scope = scopeFromFrame(frame, { width: 1920, time: 999 });
    // Frame values win over a colliding context name: `time` always means frame time.
    expect(evaluateExpression("width / 2", scope)).toEqual({ ok: true, value: 960 });
    expect(evaluateExpression("time", scope)).toEqual({ ok: true, value: 2.5 });
  });

  it("rejects unknown names and lists what is available", () => {
    const result = evaluateExpression("speed", { time: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('"speed"');
    if (!result.ok) expect(result.reason).toContain("time");
  });

  it("rejects a scope value that is not finite rather than propagating NaN", () => {
    expect(evaluateAst({ kind: "variable", name: "x" }, { x: Number.NaN }).ok).toBe(false);
  });
});

describe("parse once, evaluate per frame", () => {
  it("the same AST with different scopes yields different values deterministically", () => {
    const parsed = parseExpression("time * 10 + 1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(evaluateAst(parsed.ast, { time: 0 })).toEqual({ ok: true, value: 1 });
    expect(evaluateAst(parsed.ast, { time: 2 })).toEqual({ ok: true, value: 21 });
    // Same seed, same frame, same value (§V45): re-evaluation is pure.
    expect(evaluateAst(parsed.ast, { time: 2 })).toEqual({ ok: true, value: 21 });
  });

  it("parse errors carry a reason and never throw", () => {
    for (const bad of ["", "1 +", "(2", "time ** 2", "a..b"]) {
      const result = parseExpression(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe("");
    }
  });
});

/**
 * T370 — the function whitelist, and the boundary around it.
 *
 * The set is closed and argued in `FUNCTIONS`: a name is in it because arithmetic cannot
 * say it, or because the arithmetic form is subtly wrong. These tests assert the value a
 * user would see, not merely that a call parses.
 */
describe("the function whitelist", () => {
  const value = (source: string, scope = {}): number => {
    const result = evaluateExpression(source, scope);
    if (!result.ok) throw new Error(`expected "${source}" to evaluate: ${result.reason}`);
    return result.value;
  };

  it("oscillates, which no amount of arithmetic can do", () => {
    expect(value("sin(0)")).toBe(0);
    expect(value("cos(0)")).toBe(1);
    // The reason the set exists: a bounded parameter can now be driven forever without
    // leaving its range, from the parameter itself.
    expect(value("sin(time * 2) * 0.3 + 0.5", { time: 0 })).toBeCloseTo(0.5, 12);
  });

  it("wraps with mod where % would go negative — the difference is the point", () => {
    expect(value("mod(370, 360)")).toBe(10);
    // `%` is a REMAINDER: this is the case that makes `mod` a different function and not
    // a synonym, and it is exactly the case a rewinding timeline produces.
    expect(value("-10 % 360")).toBe(-10);
    expect(value("mod(-10, 360)")).toBe(350);
    expect(value("fract(-0.25)")).toBe(0.75);
  });

  it("clamps explicitly, saying out loud what a bounded parameter does silently", () => {
    expect(value("clamp(5, 0, 1)")).toBe(1);
    expect(value("clamp(-5, 0, 1)")).toBe(0);
    expect(value("clamp(0.5, 0, 1)")).toBe(0.5);
  });

  it("quantises and takes extremes and directions", () => {
    expect(value("floor(2.7)")).toBe(2);
    expect(value("ceil(2.1)")).toBe(3);
    expect(value("round(2.5)")).toBe(3);
    expect(value("abs(-3)")).toBe(3);
    expect(value("min(2, 5)")).toBe(2);
    expect(value("max(2, 5)")).toBe(5);
    expect(value("sign(-4)")).toBe(-1);
  });

  it("composes with the rest of the grammar, including op() and variables", () => {
    expect(value("clamp(time * 7, -360, 360)", { time: 100 })).toBe(360);
    expect(value("floor(time) + fract(time)", { time: 2.25 })).toBeCloseTo(2.25, 12);
  });

  it("names the whole whitelist when a function is not in it (§V288)", () => {
    // The teaching moment. `smoothstep` is a reasonable thing to try, and the answer has
    // to be more useful than "no" — it has to say what the grammar IS.
    const result = parseExpression("smoothstep(0, 1, time)");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"smoothstep"');
    for (const name of ["abs", "clamp", "cos", "fract", "mod", "sin"]) {
      expect(result.reason).toContain(name);
    }
  });

  it("refuses the wrong number of arguments at PARSE time, with the call shape", () => {
    const result = parseExpression("clamp(time)");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("clamp() takes 3 arguments, got 1");
    expect(result.reason).toContain("clamp(x, low, high)");
  });

  it("refuses a hand-built call with the wrong arity rather than reading a missing argument as 0", () => {
    // `evaluateAst` is exported: an AST can arrive from somewhere the parser never saw.
    const result = evaluateAst({ kind: "call", name: "clamp", args: [{ kind: "number", value: 5 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("clamp()");
  });

  it("refuses the degenerate arguments instead of inventing a value", () => {
    expect(evaluateExpression("mod(1, 0)").ok).toBe(false);
    const inverted = evaluateExpression("clamp(1, 5, 0)");
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.reason).toContain("clamp()");
  });

  it("still has no path to the host environment through a call", () => {
    for (const bad of ["Math.max(1, 2)", "alert(1)", "constructor(1)", "eval(1)"]) {
      expect(evaluateExpression(bad).ok, bad).toBe(false);
    }
  });

  it("reports the signature of every name it accepts, and nothing else", () => {
    for (const name of functionNames()) expect(functionSignature(name)).toContain(`${name}(`);
    expect(functionSignature("smoothstep")).toBeNull();
  });
});

describe("comparison operators (T628)", () => {
  const value = (input: string, scope: Record<string, number> = {}) => {
    const result = evaluateExpression(input, scope);
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  };

  it("parses the pulse idiom without parentheses: comparison binds below additive", () => {
    // The reset idiom our own pulse docblock names — previously did not parse at all.
    expect(value("frame % 120 == 0", { frame: 240 })).toBe(1);
    expect(value("frame % 120 == 0", { frame: 241 })).toBe(0);
  });

  it("returns 1/0 so comparisons compose with arithmetic", () => {
    expect(value("(t > 2) * 10", { t: 3 })).toBe(10);
    expect(value("(t > 2) * 10", { t: 1 })).toBe(0);
    expect(value("1 <= 1")).toBe(1);
    expect(value("1 >= 2")).toBe(0);
    expect(value("3 != 3")).toBe(0);
    expect(value("2 < 3")).toBe(1);
  });

  it("refuses the near-miss spellings with the correction in the message", () => {
    const single = evaluateExpression("a = 1", { a: 1 });
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.reason).toContain('"=="');
    const bang = evaluateExpression("!a", { a: 1 });
    expect(bang.ok).toBe(false);
    if (!bang.ok) expect(bang.reason).toContain('"!="');
  });

  it("chains left-associatively — a < b < c is (a < b) < c, stated not surprising", () => {
    // 1 < 5 -> 1; 1 < 3 -> 1. The docblock tells authors to write the conjunction as
    // a product; this pin is what keeps the meaning from silently changing later.
    expect(value("1 < 5 < 3")).toBe(1);
    expect(value("5 < 1 < 3")).toBe(1); // (5<1)=0, 0<3 -> 1
  });
});
