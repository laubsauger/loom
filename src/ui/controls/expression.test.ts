import { describe, expect, it } from "vitest";
import { evaluateExpression } from "./expression.ts";

/**
 * doc §8.1 — "Text entry supports arithmetic expressions where safe."
 *
 * "Safe" is the requirement being tested. Parameter text arrives from project files and
 * from agents, both untrusted (§V37): the parser must accept ordinary arithmetic,
 * refuse everything else with a reason, and never throw — a bad paste into a number
 * field must not take the editor down.
 */

const value = (input: string): number => {
  const result = evaluateExpression(input);
  if (!result.ok) throw new Error(`expected "${input}" to parse, got: ${result.reason}`);
  return result.value;
};

describe("accepts ordinary numeric entry", () => {
  it("parses plain numbers the same way it parses expressions", () => {
    expect(value("1.5")).toBe(1.5);
    expect(value(" -2 ")).toBe(-2);
    expect(value(".5")).toBe(0.5);
    expect(value("1e3")).toBe(1000);
    expect(value("2e-2")).toBe(0.02);
  });

  it("does the arithmetic a user actually types into a parameter", () => {
    expect(value("1920/2")).toBe(960);
    expect(value("0.5 + 0.25")).toBe(0.75);
    expect(value("3*4")).toBe(12);
    expect(value("10 % 3")).toBe(1);
    expect(value("2^8")).toBe(256);
  });

  it("respects precedence, parentheses and unary signs", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("-(2 + 3)")).toBe(-5);
    expect(value("2^-2")).toBe(0.25);
    // Right-associative, like every calculator and every shading language.
    expect(value("2^3^2")).toBe(512);
  });
});

describe("rejects everything outside the grammar, without throwing", () => {
  const rejected = [
    "",
    "   ",
    "abc",
    "1 + ",
    "(1 + 2",
    "1)",
    "1 2",
    "1 / 0",
    "Math.max(1,2)",
    "alert(1)",
    "process.exit()",
    "globalThis",
    "1;2",
    "${1}",
    "0x10",
    "1 + $",
  ];

  it.each(rejected)("rejects %j", (input) => {
    const result = evaluateExpression(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });

  it("never evaluates identifiers, so there is no path to the host environment", () => {
    // Text entry evaluates with an empty scope: every identifier is unknown by
    // construction — this is not a denylist.
    expect(evaluateExpression("constructor").ok).toBe(false);
    expect(evaluateExpression("this").ok).toBe(false);
  });

  it("refuses a result that is not a finite number", () => {
    expect(evaluateExpression("1/0").ok).toBe(false);
    expect(evaluateExpression("9e999").ok).toBe(false);
  });
});
