import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../types/frame.ts";
import { evaluateAst, evaluateExpression, parseExpression, scopeFromFrame } from "./evaluate.ts";

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

describe("the grammar has no function calls yet", () => {
  it("recognises call syntax and rejects it with a clear reason", () => {
    const result = parseExpression("sin(1)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("functions are not available yet");
  });
});
