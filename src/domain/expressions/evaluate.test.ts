import { describe, expect, it, vi } from "vitest";

import type { FrameEvaluationInput } from "../types/frame.ts";
import {
  evaluateAst,
  evaluateExpression,
  functionNames,
  functionSignature,
  parseExpression,
  rewriteOf,
  scopeFromFrame,
} from "./evaluate.ts";
import type { ExpressionAst } from "./evaluate.ts";
import { acceptedFunctionCalls, CANDIDATE_FUNCTIONS } from "./reference.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { liveClock } from "../transport/live-clock.ts";
import { DEFAULT_PROJECT_FPS } from "../types/graph.ts";

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
  FRAME_RATE_NAMES,
  TEMPO_NAMES,
  WRAPPING_CLOCK_NAMES,
} from "./evaluate.ts";

/**
 * T505 — the exported clock families ARE the scope's clock keys, in both directions.
 * The highlighter derives from these lists; a clock added to `scopeFromFrame` without
 * joining a family would be invisibly unpainted, and a name in a family that the scope
 * does not supply would paint a variable that evaluates to an error.
 */
describe("clock families match the scope (T505)", () => {
  it("the two lists and the rates are disjoint and together are EXACTLY the bare scope's keys", () => {
    const frame = { timeSeconds: 1, deltaSeconds: 1 / 60, frameIndex: 60, mode: "realtime", randomSeed: 0 } as never;
    const keys = Object.keys(scopeFromFrame(frame)).sort();
    // T1785b: and the project tempo's names, a fourth family.
    const union = [...WRAPPING_CLOCK_NAMES, ...FREE_RUNNING_CLOCK_NAMES, ...FRAME_RATE_NAMES, ...TEMPO_NAMES].sort();
    expect(union).toEqual(keys);
    for (const name of FRAME_RATE_NAMES) {
      expect([...WRAPPING_CLOCK_NAMES, ...FREE_RUNNING_CLOCK_NAMES]).not.toContain(name);
    }
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
    // The teaching moment. `saturate` is a reasonable thing to try (it is WGSL), and the
    // answer has to be more useful than "no" — it has to say what the grammar IS.
    // (`smoothstep` was this example until T1420b let it in.)
    const result = parseExpression("saturate(time)");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"saturate"');
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
    expect(functionSignature("saturate")).toBeNull();
  });
});

/**
 * T1420b — `smoothstep`, `exp` and `atan2`, each asserted at values whose answer is exact in
 * binary floating point, so a wrong formula cannot hide inside a tolerance.
 */
describe("smoothstep, exp and atan2 (T1420b)", () => {
  const value = (source: string, scope: Record<string, number> = {}): number => {
    const result = evaluateExpression(source, scope);
    if (!result.ok) throw new Error(`expected "${source}" to evaluate: ${result.reason}`);
    return result.value;
  };

  it("smoothstep is WGSL's Hermite ramp: 0 below, 1 above, t²(3 − 2t) between", () => {
    expect(value("smoothstep(0, 1, -3)")).toBe(0);
    expect(value("smoothstep(0, 1, 7)")).toBe(1);
    expect(value("smoothstep(0, 1, 0.5)")).toBe(0.5);
    // t = 0.25 → 0.0625 × 2.5. A LINEAR ramp would say 0.25, and that is the difference
    // the name exists for.
    expect(value("smoothstep(0, 1, 0.25)")).toBe(0.15625);
    // The edges scale the input, not the output: a quarter of the way from 2 to 6.
    expect(value("smoothstep(2, 6, 3)")).toBe(0.15625);
    // Driven by the clock, as it is used: halfway through a 2 s → 4 s ease.
    expect(value("smoothstep(2, 4, time)", { time: 3 })).toBe(0.5);
  });

  it("smoothstep with low above high is the falling ramp, the fade-out idiom WGSL authors write", () => {
    // t = (0.25 − 1) / (0 − 1) = 0.75 → 0.5625 × 1.5.
    expect(value("smoothstep(1, 0, 0.25)")).toBe(0.84375);
    expect(value("smoothstep(1, 0, 2)")).toBe(0);
  });

  it("smoothstep refuses a ramp of no width instead of guessing a side of the step", () => {
    const result = evaluateExpression("smoothstep(1, 1, time)", { time: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("smoothstep(): the edges are equal (1)");
  });

  it("exp is e to the x, and refuses by name the overflow that would otherwise be Infinity", () => {
    expect(value("exp(0)")).toBe(1);
    expect(value("exp(1)")).toBe(Math.E);
    // The decay idiom: halve per unit of time is exp(-ln2 · t); here the exact case e^-x·e^x.
    expect(value("exp(-2) * exp(2)")).toBe(1);
    expect(value("exp(709)")).toBe(Math.exp(709));
    const overflow = evaluateExpression("exp(710)");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toBe("exp(): exp(710) overflows");
  });

  it("atan2 keeps the quadrant that y / x throws away", () => {
    expect(value("atan2(1, 1)")).toBe(Math.PI / 4);
    // Same ratio, opposite quadrant — atan(y / x) would answer π/4 for both.
    expect(value("atan2(-1, -1)")).toBe((-3 * Math.PI) / 4);
    expect(value("atan2(0, -1)")).toBe(Math.PI);
    expect(value("atan2(-1, 0)")).toBe(-Math.PI / 2);
    // The origin has no angle, and still gets a finite answer rather than NaN.
    expect(value("atan2(0, 0)")).toBe(0);
  });

  it("checks their arity at PARSE time, with the call shape", () => {
    const short = parseExpression("smoothstep(0, time)");
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toContain("smoothstep(low, high, x)");
    expect(functionSignature("exp")).toBe("exp(x)");
    expect(functionSignature("atan2")).toBe("atan2(y, x)");
  });

  it("are offered by the reference and completion menus, which ASK the evaluator (§V150)", () => {
    const accepted = acceptedFunctionCalls().map((entry) => entry.signature);
    expect(accepted).toContain("smoothstep(low, high, x)");
    expect(accepted).toContain("exp(x)");
    expect(accepted).toContain("atan2(y, x)");
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1172 — THE PARSE MEMO CACHES THE TREE, NEVER THE VALUE
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `parseExpression` is memoised on its own source text because the per-frame path
 * (`resolveStored` → `evaluateExpression`) parsed every expression in an animated
 * document sixty times a second, and §T1172 measured parse at 82% of the cost of
 * evaluating one. The docblock on `evaluateAst` has promised "parse once, evaluate per
 * frame" since T202; this is where the promise is finally kept for every caller.
 *
 * ⚠ There is exactly one way for this to be a bug: caching a VALUE instead of a TREE. An
 * AST is a pure function of the characters; a value is a function of the AST and a SCOPE,
 * and the scope carries the clock. §B181 is what that failure looks like from outside —
 * a parameter frozen on one number while every static assertion stays green — so the
 * gates below evaluate one memoised tree against many scopes and assert it MOVES.
 */
describe("T1172 — the expression parse memo", () => {
  const value = (source: string, scope: Record<string, number> = {}): number => {
    const result = evaluateExpression(source, scope);
    if (!result.ok) throw new Error(`expected "${source}" to evaluate: ${result.reason}`);
    return result.value;
  };

  it("hands back one tree for one source — the memo, stated as identity", () => {
    // The one mechanism claim, and it earns its place: nothing else here fails if the
    // memo is deleted, so without it a regression that restores the per-frame parse
    // lands green.
    const first = parseExpression("time * 2 + 1");
    const second = parseExpression("time * 2 + 1");
    expect(first.ok).toBe(true);
    expect(first).toBe(second);
  });

  it("parses each source's OWN text, however they are interleaved", () => {
    // A one-slot memo answers the second question with the first question's tree.
    expect(value("a * 2", { a: 3 })).toBe(6);
    expect(value("a * 10", { a: 3 })).toBe(30);
    expect(value("a * 2", { a: 3 })).toBe(6);
    expect(value("a * 10", { a: 3 })).toBe(30);
  });

  it("evaluates ONE memoised tree against MANY scopes (§B181)", () => {
    // The whole risk of this memo in one claim: the tree is remembered, the number is
    // not. Sixty evaluations of the same source, sixty different answers.
    for (let frame = 0; frame < 60; frame += 1) {
      expect(value("time * 2", { time: frame })).toBe(frame * 2);
    }
    // And still, after all of that, against a scope it has never seen.
    expect(value("time * 2", { time: 1000 })).toBe(2000);
  });

  it("remembers a REFUSAL as its own reason, not as the last refusal it saw", () => {
    // Failures are cached too — a document holding a typo re-parses it every frame
    // exactly like a working one. The reason must still belong to the text.
    const missing = parseExpression("2 +");
    const unknown = parseExpression("a = 1");
    expect(missing.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    const missingAgain = parseExpression("2 +");
    expect(missingAgain.ok).toBe(false);
    if (!missing.ok && !missingAgain.ok) expect(missingAgain.reason).toBe(missing.reason);
    if (!unknown.ok && !missingAgain.ok) expect(missingAgain.reason).not.toBe(unknown.reason);
  });

  it("keeps answering correctly once the cache is filled past its cap", () => {
    // FIFO eviction. The hazard is not eviction but an entry surviving under the wrong
    // key, so an evicted source and a fresh one must both still parse as themselves.
    expect(value("a + 1", { a: 1 })).toBe(2);
    for (let index = 0; index < 5000; index += 1) {
      expect(value(`a + ${index}`, { a: 0 })).toBe(index);
    }
    expect(value("a + 1", { a: 1 })).toBe(2);
    expect(value("a * 7", { a: 6 })).toBe(42);
  });

  it("T1767b — a document of 1000 distinct expressions is parsed once, not once a frame", () => {
    // The cache exists so a frame does not parse. Under FIFO a working set larger than
    // the cap evicts what the same frame needs, and every statement is parsed again every
    // frame: silk-medusa (646 distinct expressions) lost about 1.8 ms a frame to a cap of
    // 512. The second frame's result must be the FIRST frame's object, not an equal one.
    const sources = Array.from({ length: 1000 }, (_, index) => `t1767b + ${index} * 2`);
    const firstFrame = sources.map((source) => parseExpression(source));
    const secondFrame = sources.map((source) => parseExpression(source));
    for (let index = 0; index < sources.length; index += 1) {
      expect(secondFrame[index]).toBe(firstFrame[index]);
    }
  });
});

describe("T1176 — a rejection is CONTROL FLOW, and must not cost an Error stack", () => {
  /**
   * The rejection path is the app's hot path, not an exceptional one.
   *
   * §V108 makes an unresolvable expression fall back to its retained static, and the
   * frameless STRUCTURAL compile — the one a knob turn runs at frame rate — has no
   * `time` and no `frame` in scope, so every clock-reading expression in a document is
   * *expected* to be rejected on every commit. Capturing a stack trace for each was
   * 21.2% of E55's whole compile.
   *
   * This guards the CAUSE — `new Error` on the rejection path — rather than the
   * observable, which is CPU time and would make a flaky test. The global constructor is
   * swapped BEFORE the module is loaded, because `class X extends Error` resolves the
   * binding at module-evaluation time: a later swap would see nothing.
   */
  it("constructs no Error while rejecting, and still reports the same reasons", async () => {
    const RealError = globalThis.Error;
    let constructed = 0;
    class Counting extends RealError {
      constructor(message?: string) {
        super(message);
        constructed += 1;
      }
    }
    globalThis.Error = Counting as unknown as ErrorConstructor;
    try {
      vi.resetModules();
      const fresh = (await import("./evaluate.ts")) as typeof import("./evaluate.ts");

      // A malformed source, rejected by the PARSER.
      const parsed = fresh.parseExpression("1 +");
      expect(parsed.ok).toBe(false);

      // A well-formed source rejected by the EVALUATOR: `time` is not in scope, which is
      // exactly what a frameless compile hands it.
      const evaluated = fresh.evaluateExpression("time * 2", {});
      expect(evaluated).toEqual({ ok: false, kind: "name", reason: 'unknown name "time"', subject: "time" });

      // And a legitimate expression still evaluates — the guard must not be satisfied by
      // a module that rejects everything.
      expect(fresh.evaluateExpression("time * 2", { time: 3 })).toEqual({ ok: true, value: 6 });

      expect(constructed).toBe(0);
    } finally {
      globalThis.Error = RealError;
      vi.resetModules();
    }
  });
});

/**
 * T1426b / T1435b — the RATES an expression reads: `fps`, the project's frame rate, and
 * `subframes`, the offline sub-frames accumulated into each output frame. Asserted through
 * the transports that state them, at values exact in binary floating point.
 */
describe("fps and subframes (T1426b, T1435b)", () => {
  const value = (source: string, input: FrameEvaluationInput): number => {
    const result = evaluateExpression(source, scopeFromFrame(input));
    if (!result.ok) throw new Error(`expected "${source}" to evaluate: ${result.reason}`);
    return result.value;
  };

  it("an offline render at 8 sub-frames of a 24 fps film reads fps 24 and subframes 8, while delta is a sub-frame", () => {
    const transport = offlineTransport({ fps: 24 * 8, subframes: 8 });
    transport.next();
    const second = transport.next();
    expect(value("fps", second)).toBe(24);
    expect(value("subframes", second)).toBe(8);
    // Three FILM frames back is 3/24 s whatever the transport steps at; delta is 1/192.
    expect(value("3 / fps", second)).toBe(0.125);
    expect(value("delta * fps * subframes", second)).toBe(1);
    // The idiom T1435b exists for: a shot's own shutter blur stands down under accumulation.
    expect(value("(subframes == 1) * 0.5", second)).toBe(0);
    expect(value("(subframes == 1) * 0.5", offlineTransport({ fps: 24 }).next())).toBe(0.5);
  });

  it("the live clock states the PROJECT rate and no accumulation", () => {
    const clock = liveClock({ fps: () => 30, now: () => 0 });
    const first = clock.next();
    expect(value("fps", first)).toBe(30);
    expect(value("subframes", first)).toBe(1);
  });

  it("a frame that states no rate reads the default project rate and 1; a nonsense one is ignored", () => {
    expect(value("fps", frame)).toBe(DEFAULT_PROJECT_FPS);
    expect(value("subframes", frame)).toBe(1);
    expect(value("fps", { ...frame, fps: 0 })).toBe(DEFAULT_PROJECT_FPS);
    expect(value("subframes", { ...frame, subframes: 0.5 })).toBe(1);
  });
});

/**
 * §T1641b — A FAILURE CARRIES ITS KIND, and a refused function carries what to write instead.
 *
 * Every failure was a reason string, so the resolver that turns one into a diagnostic could
 * not tell an expression that can never evaluate (`pow(x, 2)`, §B262) from one that cannot
 * evaluate at this frame, and reported both as one warning. The kind is what it reads now.
 */
describe("why an expression failed (T1641b)", () => {
  const kindOf = (source: string, scope = {}, reader?: Parameters<typeof evaluateExpression>[2]): string => {
    const result = evaluateExpression(source, scope, reader);
    return result.ok ? "ok" : result.kind;
  };

  it("calls everything the parser refuses syntax, whichever site refused it", () => {
    for (const bad of ["", "1 +", "(2", "a = 1", "pow(2, 2)", "clamp(1)", "op()", "op('a')", "1 2"]) {
      expect(kindOf(bad), bad).toBe("syntax");
    }
  });

  it("calls a bare name nothing supplies name, and says which", () => {
    expect(evaluateExpression("flicker * 2", { time: 1 })).toMatchObject({ ok: false, kind: "name", subject: "flicker" });
    // Nor does Object.prototype supply one.
    expect(kindOf("constructor + 1", { time: 1 })).toBe("name");
  });

  it("calls arithmetic with no finite answer for these inputs value", () => {
    for (const bad of ["1 / 0", "1 % 0", "mod(1, 0)", "clamp(1, 5, 0)", "smoothstep(1, 1, 0)", "exp(710)", "(0 - 1) ^ 0.5"]) {
      expect(kindOf(bad), bad).toBe("value");
    }
    // A name the scope HAS, holding no finite number, is this frame's fault and not the text's.
    expect(kindOf("x + 1", { x: Number.NaN })).toBe("value");
  });

  it("passes a reader's kind through, and says when there is no reader at all", () => {
    expect(kindOf("op('a').par.gain")).toBe("reference.noGraph");
    const reader = () => ({ ok: false as const, kind: "channel" as const, reason: "nothing yet" });
    expect(kindOf("op('a').chan.value * 2", {}, reader)).toBe("reference.channel");
    // A hand-built reader that refuses without saying when it would read is taken at its word.
    expect(kindOf("op('a').chan.value", {}, () => ({ ok: false, reason: "no" }))).toBe("reference.unreadable");
  });

  const remedy = (source: string): string | undefined => {
    const parsed = parseExpression(source);
    return parsed.ok ? "it parsed" : parsed.suggestion;
  };

  it("writes a refused function out in the author's own operands", () => {
    expect(remedy("pow(x, 2)")).toBe("Write x ^ 2.");
    // More than one term is parenthesised where it becomes an operand…
    expect(remedy("pow(time + 1, 2)")).toBe("Write (time + 1) ^ 2.");
    expect(remedy("pow(-x, 0.5)")).toBe("Write (-x) ^ 0.5.");
    // …and a call, a group and an op() reference already are one.
    expect(remedy("sqrt(abs(time))")).toBe("Write abs(time) ^ 0.5.");
    expect(remedy("sqrt((a + b))")).toBe("Write (a + b) ^ 0.5.");
    expect(remedy("pow(op('slider_lamp').par.value, 2)")).toBe("Write op('slider_lamp').par.value ^ 2.");
    expect(remedy("mix(0, 10, time)")).toBe("Write 0 + (10 - 0) * time.");
    expect(remedy("lerp(a, b + 1, t)")).toBe("Write a + ((b + 1) - a) * t.");
    expect(remedy("hypot(x, y)")).toBe("Write (x ^ 2 + y ^ 2) ^ 0.5.");
    expect(remedy("step(0.5, time)")).toBe("Write (time >= 0.5).");
    expect(remedy("tan(time * 2)")).toBe("Write sin(time * 2) / cos(time * 2).");
    expect(remedy("atan(y / x)")).toBe("Write atan2(y / x, 1).");
    expect(remedy("saturate(time)")).toBe("Write clamp(time, 0, 1).");
  });

  it("says something else when the operands cannot be placed, or there is nothing to write", () => {
    // The wrong number of arguments: the general form.
    expect(remedy("pow(x)")).toBe("pow(a, b) is written a ^ b.");
    // A name left out on purpose says why.
    expect(remedy("log(time)")).toBe("The grammar has no log(): its result is not finite for every input.");
    // A misspelling names the function it most likely meant, with its call shape.
    expect(remedy("smothstep(0, 1, time)")).toBe("Nearest: smoothstep(low, high, x).");
    expect(remedy("Sin(time)")).toBe("Nearest: sin(x).");
    // Two neighbours swapped is one slip, not two.
    expect(remedy("clmap(time, 0, 1)")).toBe("Nearest: clamp(x, low, high).");
    // A name near nothing gets the list alone, which the reason carries.
    expect(remedy("alert(1)")).toBeUndefined();
    const refused = parseExpression("alert(1)");
    expect(refused.ok ? "" : refused.reason).toContain("available: abs, atan2");
  });

  it("writes rewrites the grammar itself evaluates, to the value the function has", () => {
    // A remedy is one only if it parses and means the same number. `pow(-2, 2)` is the case
    // the parentheses exist for: `-2 ^ 2` is -4.
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["pow(3, 2)", 9],
      ["pow(-2, 2)", 4],
      ["pow(1 + 2, 1 + 1)", 9],
      ["sqrt(16)", 4],
      ["mix(2, 10, 0.25)", 4],
      ["hypot(3, 4)", 5],
      ["step(0.5, 0.75)", 1],
      ["step(0.5, 0.25)", 0],
      ["tan(0)", 0],
      ["atan(1)", Math.PI / 4],
      ["saturate(1.5)", 1],
    ];
    for (const [source, expected] of cases) {
      const written = (remedy(source) ?? "").replace(/^Write /, "").replace(/\.$/, "");
      const result = evaluateExpression(written);
      expect(result.ok ? result.value : result.reason, `${source}, written ${written}`).toBeCloseTo(expected, 12);
    }
  });

  it("has a row for every function an author reaches for and the grammar refuses, and none for one it has", () => {
    const accepted = new Set(functionNames());
    for (const name of CANDIDATE_FUNCTIONS) {
      if (accepted.has(name)) continue;
      expect(rewriteOf(name), `${name}() is refused with nothing to write instead: add a row to REWRITES in evaluate.ts`).not.toBeNull();
    }
    for (const name of accepted) expect(rewriteOf(name), `${name}() is in the grammar: its row would never be said`).toBeNull();
  });
});

describe("T1720b — one object per subtree structure", () => {
  const astOf = (source: string): ExpressionAst => {
    const parsed = parseExpression(source);
    if (!parsed.ok) throw new Error(`${source} does not parse`);
    return parsed.ast;
  };

  it("shares a subtree that two different texts carry, by identity", () => {
    const one = astOf("sin(time * 3) * 2 + 1");
    const two = astOf("4 - sin(time * 3) * 2");
    expect(one.kind === "binary" && two.kind === "binary").toBe(true);
    if (one.kind !== "binary" || two.kind !== "binary") return;
    expect(one.left).toBe(two.right);
  });

  it("keeps structures that differ in any field apart", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["time * 2", "time * 3"],
      ["time * 2", "time / 2"],
      ["time * 2", "frame * 2"],
      ["op('a').par.gain", "op('a').chan.gain"],
      ["op('a').par.gain", "op('b').par.gain"],
      ["sin(time)", "cos(time)"],
      ["-time", "+time"],
      ["1 - 2 - 3", "1 - (2 - 3)"],
    ];
    for (const [a, b] of pairs) expect(astOf(a), `${a} | ${b}`).not.toBe(astOf(b));
  });

  it("evaluates a shared tree to what each text says", () => {
    const scope = { time: 0.5, frame: 30 };
    expect(evaluateExpression("sin(time * 3) * 2 + 1", scope)).toEqual({ ok: true, value: Math.sin(1.5) * 2 + 1 });
    expect(evaluateExpression("4 - sin(time * 3) * 2", scope)).toEqual({ ok: true, value: 4 - Math.sin(1.5) * 2 });
  });
});
