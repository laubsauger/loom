import { wallDeltaSecondsOf, wallSecondsOf } from "../types/frame.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";

/**
 * The parameter expression engine (T108, §V71): own closed grammar, jsep-style AST,
 * deterministic and sandboxed by construction.
 *
 * This is THE single evaluator in the codebase — numeric text entry in the inspector
 * delegates here (`src/ui/controls/expression.ts`), and future expression-driven
 * parameters resolve through the same module, so `"1.5"`, `"1 + 0.5"` and a bound
 * `"time * 2"` can never disagree about arithmetic.
 *
 * Safety model: hand-written tokeniser and recursive-descent parser, no `eval`, no
 * `new Function`, no host globals. Expression text arrives from project files and from
 * agents, and §V37 treats both as untrusted; anything outside the grammar is rejected
 * with a reason, and nothing here ever throws. Variables come ONLY from the scope the
 * caller passes (FrameEvaluationInput plus node context), never from ambient state, so
 * the same AST and scope always produce the same value (§V44, §V45).
 *
 * v1 grammar: numbers, `+ - * / % ^`, unary sign, parentheses, scope variables.
 * Function calls are recognised and rejected — the grammar grows by whitelist later.
 */

export type ExpressionAst =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  /**
   * A node reference, `op('noise1').par.gain` (§V127, T221). PARSED now, so it can be
   * stored, validated and rename-rewritten (§V128) today; EVALUATION arrives with the
   * cross-node read path and until then resolves to a named failure, which the
   * parameter resolver turns into the §V108 fallback rather than an error wall.
   */
  | { kind: "opRef"; name: string; path: readonly string[] }
  | { kind: "unary"; operator: "-" | "+"; operand: ExpressionAst }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "%" | "^"; left: ExpressionAst; right: ExpressionAst };

export type ExpressionScope = Readonly<Record<string, number>>;

export type ParseResult = { ok: true; ast: ExpressionAst } | { ok: false; reason: string };
export type EvaluateResult = { ok: true; value: number } | { ok: false; reason: string };

/** Names an expression may read when evaluated against a frame (§I.frame). */
export function scopeFromFrame(
  frame: FrameEvaluationInput,
  nodeContext: ExpressionScope = {},
): ExpressionScope {
  return {
    ...nodeContext,
    // T271/§V172 — `time` is TIMELINE time and `delta` is its step; `walltime` and
    // `walldelta` are the other clock. Never a mix: an expression reading `time` and a
    // simulation reading `delta` must be advancing at the same rate.
    time: frame.timeSeconds,
    delta: frame.deltaSeconds,
    frame: frame.frameIndex,
    walltime: wallSecondsOf(frame),
    walldelta: wallDeltaSecondsOf(frame),
  };
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "dot" }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
  | { kind: "paren"; value: "(" | ")" };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);

const isIdentStart = (char: string): boolean =>
  (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
const isIdentPart = (char: string): boolean => isIdentStart(char) || (char >= "0" && char <= "9");

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

    if (isIdentStart(char)) {
      const start = index;
      while (index < input.length && isIdentPart(input[index] as string)) index += 1;
      tokens.push({ kind: "identifier", value: input.slice(start, index) });
      continue;
    }

    // String literal — only op('name') references use these (§V127).
    if (char === "'" || char === '"') {
      const close = input.indexOf(char, index + 1);
      if (close < 0) return "unterminated string";
      tokens.push({ kind: "string", value: input.slice(index + 1, close) });
      index = close + 1;
      continue;
    }

    // A dot NOT starting a number is member access: op('x').par.gain.
    if (char === "." && !/[0-9]/.test(input[index + 1] ?? "")) {
      tokens.push({ kind: "dot" });
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

const peek = (cursor: Cursor): Token | undefined => cursor.tokens[cursor.index];

/** Thrown internally only; the public functions convert it into a rejection. */
class ParseFailure extends Error {}

function fail(reason: string): never {
  throw new ParseFailure(reason);
}

function parseAdditive(cursor: Cursor): ExpressionAst {
  let left = parseMultiplicative(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op") break;
    if (token.value !== "+" && token.value !== "-") break;
    cursor.index += 1;
    left = { kind: "binary", operator: token.value, left, right: parseMultiplicative(cursor) };
  }
  return left;
}

function parseMultiplicative(cursor: Cursor): ExpressionAst {
  let left = parseUnary(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op") break;
    if (token.value !== "*" && token.value !== "/" && token.value !== "%") break;
    cursor.index += 1;
    left = { kind: "binary", operator: token.value, left, right: parseUnary(cursor) };
  }
  return left;
}

function parseUnary(cursor: Cursor): ExpressionAst {
  const token = peek(cursor);
  if (token !== undefined && token.kind === "op" && (token.value === "-" || token.value === "+")) {
    cursor.index += 1;
    return { kind: "unary", operator: token.value, operand: parseUnary(cursor) };
  }
  return parsePower(cursor);
}

function parsePower(cursor: Cursor): ExpressionAst {
  const base = parsePrimary(cursor);
  const token = peek(cursor);
  if (token !== undefined && token.kind === "op" && token.value === "^") {
    cursor.index += 1;
    // Right-associative, and the exponent may itself be signed: 2^-2.
    return { kind: "binary", operator: "^", left: base, right: parseUnary(cursor) };
  }
  return base;
}

function parsePrimary(cursor: Cursor): ExpressionAst {
  const token = peek(cursor);
  if (token === undefined) fail("expression ended early");
  if (token.kind === "number") {
    cursor.index += 1;
    return { kind: "number", value: token.value };
  }
  if (token.kind === "identifier") {
    cursor.index += 1;
    const next = peek(cursor);
    if (next !== undefined && next.kind === "paren" && next.value === "(") {
      if (token.value === "op") return parseOpReference(cursor);
      fail(`functions are not available yet ("${token.value}")`);
    }
    return { kind: "variable", name: token.value };
  }
  if (token.kind === "paren" && token.value === "(") {
    cursor.index += 1;
    const inner = parseAdditive(cursor);
    const closing = peek(cursor);
    if (closing === undefined || closing.kind !== "paren" || closing.value !== ")") {
      fail("missing closing parenthesis");
    }
    cursor.index += 1;
    return inner;
  }
  fail(`unexpected "${describeToken(token)}"`);
}

const describeToken = (token: Token): string =>
  token.kind === "dot" ? "." : token.kind === "string" ? `'${token.value}'` : String(token.value);

/**
 * `op('name').par.gain` — the cursor stands ON the opening paren (§V127, T221).
 * Recognised so references can be STORED (and rename-rewritten, §V128) before the
 * cross-node read path exists; `evaluateAst` names the gap until then.
 */
function parseOpReference(cursor: Cursor): ExpressionAst {
  cursor.index += 1; // consume "("
  const name = peek(cursor);
  if (name === undefined || name.kind !== "string" || name.value.length === 0) {
    fail("op() takes a quoted node name: op('noise1')");
  }
  cursor.index += 1;
  const closing = peek(cursor);
  if (closing === undefined || closing.kind !== "paren" || closing.value !== ")") {
    fail("op() takes exactly one quoted node name");
  }
  cursor.index += 1;

  const path: string[] = [];
  for (;;) {
    const dot = peek(cursor);
    if (dot === undefined || dot.kind !== "dot") break;
    cursor.index += 1;
    const member = peek(cursor);
    if (member === undefined || member.kind !== "identifier") {
      fail("expected a member name after \".\"");
    }
    cursor.index += 1;
    path.push(member.value);
  }
  if (path.length === 0) fail("an op() reference must read something: op('noise1').par.gain");
  return { kind: "opRef", name: name.value, path };
}

export function parseExpression(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  const tokens = tokenize(trimmed);
  if (!Array.isArray(tokens)) return { ok: false, reason: tokens };
  if (tokens.length === 0) return { ok: false, reason: "empty" };

  const cursor: Cursor = { tokens, index: 0 };
  try {
    const ast = parseAdditive(cursor);
    if (cursor.index !== tokens.length) {
      return { ok: false, reason: "trailing input after the expression" };
    }
    return { ok: true, ast };
  } catch (thrown) {
    if (thrown instanceof ParseFailure) return { ok: false, reason: thrown.message };
    // A parser bug must degrade to "rejected", never to a crashed editor.
    return { ok: false, reason: "could not parse the expression" };
  }
}

/** Parse-once, evaluate-per-frame: bound parameters keep the AST and call this each frame. */
export function evaluateAst(ast: ExpressionAst, scope: ExpressionScope = {}): EvaluateResult {
  try {
    const value = evaluateNode(ast, scope);
    if (!Number.isFinite(value)) return { ok: false, reason: "result is not a finite number" };
    return { ok: true, value };
  } catch (thrown) {
    if (thrown instanceof ParseFailure) return { ok: false, reason: thrown.message };
    return { ok: false, reason: "could not evaluate the expression" };
  }
}

function evaluateNode(ast: ExpressionAst, scope: ExpressionScope): number {
  switch (ast.kind) {
    case "number":
      return ast.value;
    case "variable": {
      const value = scope[ast.name];
      if (value === undefined || !Number.isFinite(value)) {
        const known = Object.keys(scope).sort().join(", ");
        fail(known === "" ? `unknown name "${ast.name}"` : `unknown name "${ast.name}" (available: ${known})`);
      }
      return value;
    }
    case "opRef":
      // Parseable today so it can be stored and rename-rewritten (§V128); readable when
      // the cross-node value path lands. The resolver turns this into the §V108 fallback.
      fail(`node references are not readable yet (op('${ast.name}'))`);
    // eslint-disable-next-line no-fallthrough -- fail() never returns
    case "unary": {
      const operand = evaluateNode(ast.operand, scope);
      return ast.operator === "-" ? -operand : operand;
    }
    case "binary": {
      const left = evaluateNode(ast.left, scope);
      const right = evaluateNode(ast.right, scope);
      switch (ast.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "%":
        case "/":
          if (right === 0) fail("division by zero");
          return ast.operator === "/" ? left / right : left % right;
        case "^":
          return left ** right;
      }
    }
  }
}

/** One-shot convenience for text entry: parse and evaluate in a single call. */
export function evaluateExpression(input: string, scope: ExpressionScope = {}): EvaluateResult {
  const parsed = parseExpression(input);
  if (!parsed.ok) return parsed;
  return evaluateAst(parsed.ast, scope);
}
