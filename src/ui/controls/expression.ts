/**
 * Arithmetic text entry for numeric controls (doc §8.1: "Text entry supports
 * arithmetic expressions where safe").
 *
 * "Where safe" is the whole design constraint. This is a hand-written tokeniser plus
 * recursive-descent parser over a closed grammar — numbers, `+ - * / % ^`, unary
 * minus/plus, parentheses. There is deliberately no `eval`, no `new Function`, and no
 * identifier support: parameter text arrives from project files and from agents, and
 * §V37 treats both as untrusted. An expression that is not in the grammar is rejected
 * with a reason; nothing here ever throws.
 */

export type ExpressionResult = { ok: true; value: number } | { ok: false; reason: string };

type Token =
  | { kind: "number"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
  | { kind: "paren"; value: "(" | ")" };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);

function tokenize(input: string): Token[] | string {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char });
      index += 1;
      continue;
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: "op", value: char as "+" | "-" | "*" | "/" | "%" | "^" });
      index += 1;
      continue;
    }

    if ((char >= "0" && char <= "9") || char === ".") {
      const start = index;
      while (index < input.length) {
        const next = input[index] as string;
        const isDigit = next >= "0" && next <= "9";
        const isExponent =
          (next === "e" || next === "E") &&
          index > start &&
          /[0-9.]/.test(input[index - 1] as string);
        const isExponentSign =
          (next === "+" || next === "-") && (input[index - 1] === "e" || input[index - 1] === "E");
        if (!isDigit && next !== "." && !isExponent && !isExponentSign) break;
        index += 1;
      }
      const text = input.slice(start, index);
      const value = Number(text);
      if (!Number.isFinite(value)) return `"${text}" is not a number`;
      tokens.push({ kind: "number", value });
      continue;
    }

    return `unexpected character "${char}"`;
  }

  return tokens;
}

interface Cursor {
  tokens: Token[];
  index: number;
}

function peek(cursor: Cursor): Token | undefined {
  return cursor.tokens[cursor.index];
}

/** Thrown internally only; `evaluateExpression` converts it into a rejection. */
class ParseFailure extends Error {}

function fail(reason: string): never {
  throw new ParseFailure(reason);
}

function parseExpression(cursor: Cursor): number {
  let left = parseTerm(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op") break;
    if (token.value !== "+" && token.value !== "-") break;
    cursor.index += 1;
    const right = parseTerm(cursor);
    left = token.value === "+" ? left + right : left - right;
  }
  return left;
}

function parseTerm(cursor: Cursor): number {
  let left = parseUnary(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op") break;
    if (token.value !== "*" && token.value !== "/" && token.value !== "%") break;
    cursor.index += 1;
    const right = parseUnary(cursor);
    if ((token.value === "/" || token.value === "%") && right === 0) fail("division by zero");
    left = token.value === "*" ? left * right : token.value === "/" ? left / right : left % right;
  }
  return left;
}

function parseUnary(cursor: Cursor): number {
  const token = peek(cursor);
  if (token !== undefined && token.kind === "op" && (token.value === "-" || token.value === "+")) {
    cursor.index += 1;
    const value = parseUnary(cursor);
    return token.value === "-" ? -value : value;
  }
  return parsePower(cursor);
}

function parsePower(cursor: Cursor): number {
  const base = parsePrimary(cursor);
  const token = peek(cursor);
  if (token !== undefined && token.kind === "op" && token.value === "^") {
    cursor.index += 1;
    // Right-associative, and the exponent may itself be signed: 2^-2.
    const exponent = parseUnary(cursor);
    const result = base ** exponent;
    if (!Number.isFinite(result)) fail("result is not a finite number");
    return result;
  }
  return base;
}

function parsePrimary(cursor: Cursor): number {
  const token = peek(cursor);
  if (token === undefined) fail("expression ended early");
  if (token.kind === "number") {
    cursor.index += 1;
    return token.value;
  }
  if (token.kind === "paren" && token.value === "(") {
    cursor.index += 1;
    const value = parseExpression(cursor);
    const closing = peek(cursor);
    if (closing === undefined || closing.kind !== "paren" || closing.value !== ")") {
      fail("missing closing parenthesis");
    }
    cursor.index += 1;
    return value;
  }
  fail(`unexpected "${token.kind === "op" ? token.value : token.value}"`);
}

/**
 * Evaluates typed parameter entry. Plain numbers are the common case and go through
 * the same path, so `"1.5"` and `"1 + 0.5"` cannot disagree.
 */
export function evaluateExpression(input: string): ExpressionResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  const tokens = tokenize(trimmed);
  if (!Array.isArray(tokens)) return { ok: false, reason: tokens };
  if (tokens.length === 0) return { ok: false, reason: "empty" };

  const cursor: Cursor = { tokens, index: 0 };
  try {
    const value = parseExpression(cursor);
    if (cursor.index !== tokens.length) {
      return { ok: false, reason: "trailing input after the expression" };
    }
    if (!Number.isFinite(value)) return { ok: false, reason: "result is not a finite number" };
    return { ok: true, value };
  } catch (thrown) {
    if (thrown instanceof ParseFailure) return { ok: false, reason: thrown.message };
    // A parser bug must degrade to "rejected", never to a crashed editor.
    return { ok: false, reason: "could not parse the expression" };
  }
}
