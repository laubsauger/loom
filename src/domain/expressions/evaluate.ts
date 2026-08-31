import {
  absFrameIndexOf,
  absTimeSecondsOf,
  wallDeltaSecondsOf,
  wallSecondsOf,
} from "../types/frame.ts";
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
 * Grammar: numbers, `+ - * / % ^`, unary sign, parentheses, scope variables, `op()`
 * references, and the closed function whitelist in `FUNCTIONS` below (T370).
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
  /** A whitelisted function call (T370). Arity is checked at PARSE time; see `FUNCTIONS`. */
  | { kind: "call"; name: string; args: readonly ExpressionAst[] }
  | { kind: "unary"; operator: "-" | "+"; operand: ExpressionAst }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | "<=" | ">" | ">=";
      left: ExpressionAst;
      right: ExpressionAst;
    };

export type ExpressionScope = Readonly<Record<string, number>>;

/**
 * How `op('name').par.key` is READ (T316, §V148, §V61).
 *
 * A callback rather than a lookup table, because resolving another node's parameter is a
 * recursive resolve — the referenced parameter may itself be an expression, a bind or a
 * driven channel — and it is the caller that owns the graph, the schema and the cycle
 * guard. This module stays what §V71 says it is: a grammar and an evaluator over numbers,
 * with no idea what a node is.
 *
 * Returns a RESULT, not a bare number, so a failure arrives with a reason a human can act
 * on. "That node does not exist", "that parameter is not a number" and "this reference is
 * a cycle" are three different problems and a silent `undefined` is none of them (§V148
 * wants a cross-node reference that fails to fail LOUDLY, with the name in the message).
 */
export type NodeReferenceResult = { ok: true; value: number } | { ok: false; reason: string };

export type NodeReferenceReader = (
  name: string,
  path: readonly string[],
) => NodeReferenceResult;

/**
 * The function whitelist (T370) — closed, small, and argued name by name.
 *
 * ## What the grammar is FOR
 *
 * An expression is a value written WHERE IT IS READ: no node, no wire, no channel. That
 * is locality, and locality was already worth having with arithmetic alone. What
 * arithmetic alone could not do was say anything PERIODIC or BOUNDED, which is most of
 * what a parameter on a moving image wants to say — so `time * 7` on a ±360 rotate was
 * the only ramp available, and it hits the manifest's limit and stops (T368). Every name
 * below earns its place by one of two tests:
 *
 *  - the arithmetic grammar CANNOT express it (`sin`, `cos`, `min`, `max`, `floor`,
 *    `ceil`, `round`, `sign` — no series here; comparisons joined the GRAMMAR in T628); or
 *  - it is the CORRECT form of something the arithmetic form gets subtly wrong
 *    (`clamp` is what a bounded parameter does to you silently, said out loud; `mod` is a
 *    true modulo where `%` is a remainder that goes negative below zero; `fract` is the
 *    0..1 phase `x % 1` only appears to be).
 *
 * Names that fail both tests stay out, and the rejection message lists what is in, so
 * typing one teaches the boundary instead of just failing. `sqrt` is `x ^ 0.5`; `mix` is
 * `a + (b - a) * t`; `hypot` and `pow` are the same story. `tan`, `log`, `asin` and
 * friends are excluded for a second reason as well: each has inputs where it returns a
 * non-finite number, and this evaluator's contract is a finite one.
 *
 * ## Cost
 *
 * This runs on the CPU for every expression-mode parameter, every frame (§V163). A call
 * costs one `Map`-free object lookup plus the `Math` builtin; ARITY is checked when the
 * source is PARSED, so the per-frame path never re-validates a shape that cannot have
 * changed. Parse once, evaluate per frame, exactly as before.
 */
interface FunctionSpec {
  /** Argument names, in order. Length IS the arity, and the call shape shown in help. */
  readonly params: readonly string[];
  readonly apply: (args: readonly number[]) => number;
}

/** Fails loud rather than defaulting: `undefined` here would mean the arity check missed. */
function nth(args: readonly number[], index: number): number {
  const value = args[index];
  if (value === undefined) fail(`argument ${index + 1} is missing`);
  return value;
}

const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  abs: { params: ["x"], apply: (a) => Math.abs(nth(a, 0)) },
  ceil: { params: ["x"], apply: (a) => Math.ceil(nth(a, 0)) },
  clamp: {
    params: ["x", "low", "high"],
    apply: (a) => {
      const [x, low, high] = [nth(a, 0), nth(a, 1), nth(a, 2)];
      // An inverted range is a typo, not a value: silently returning `high` would pin the
      // parameter at a number the author never asked for and never sees a reason for.
      if (low > high) fail(`clamp(): the low bound ${low} is above the high bound ${high}`);
      return Math.min(Math.max(x, low), high);
    },
  },
  cos: { params: ["x"], apply: (a) => Math.cos(nth(a, 0)) },
  floor: { params: ["x"], apply: (a) => Math.floor(nth(a, 0)) },
  /** The 0..1 phase. `x % 1` is negative for negative x; this never is. */
  fract: { params: ["x"], apply: (a) => nth(a, 0) - Math.floor(nth(a, 0)) },
  max: { params: ["a", "b"], apply: (a) => Math.max(nth(a, 0), nth(a, 1)) },
  min: { params: ["a", "b"], apply: (a) => Math.min(nth(a, 0), nth(a, 1)) },
  /** TRUE modulo: `mod(-10, 360)` is 350, where `-10 % 360` is -10. */
  mod: {
    params: ["x", "period"],
    apply: (a) => {
      const period = nth(a, 1);
      if (period === 0) fail("mod(): the period is zero");
      return nth(a, 0) - Math.floor(nth(a, 0) / period) * period;
    },
  },
  round: { params: ["x"], apply: (a) => Math.round(nth(a, 0)) },
  sign: { params: ["x"], apply: (a) => Math.sign(nth(a, 0)) },
  sin: { params: ["x"], apply: (a) => Math.sin(nth(a, 0)) },
};

/** Every function name the grammar accepts, sorted. The evaluator's own statement (§V150). */
export function functionNames(): readonly string[] {
  return Object.keys(FUNCTIONS).sort();
}

/** `clamp(x, low, high)` — the call shape, for help and completion. Null if unknown. */
export function functionSignature(name: string): string | null {
  const spec = FUNCTIONS[name];
  return spec === undefined ? null : `${name}(${spec.params.join(", ")})`;
}

export type ParseResult = { ok: true; ast: ExpressionAst } | { ok: false; reason: string };
export type EvaluateResult = { ok: true; value: number } | { ok: false; reason: string };

/** Names an expression may read when evaluated against a frame (§I.frame). */
/**
 * T505: the two clock families, EXPORTED so the expression highlighter derives from the
 * evaluator rather than remembering names (§V150). The distinction is the one that has
 * bitten this project four times: `time`/`frame`/`delta` WRAP with the timeline once it
 * is bounded; the free-running names keep counting through a loop. A test pins both
 * lists against `scopeFromFrame`'s actual keys, in both directions.
 */
export const WRAPPING_CLOCK_NAMES = ["time", "delta", "frame"] as const;
export const FREE_RUNNING_CLOCK_NAMES = ["walltime", "walldelta", "abstime", "absframe"] as const;

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
    // T461 — the clocks that do NOT reset. `time` and `frame` wrap with the timeline once
    // it is bounded (T455); these keep counting, so a continuous rotation has something to
    // read that does not snap back at the out point. Still deterministic: a frame COUNT,
    // never the wall clock, so a graph reading `abstime` renders offline exactly as it
    // played (§V44).
    abstime: absTimeSecondsOf(frame),
    absframe: absFrameIndexOf(frame),
  };
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "dot" }
  | { kind: "comma" }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | "<=" | ">" | ">=" }
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

    if (char === ",") {
      tokens.push({ kind: "comma" });
      index += 1;
      continue;
    }

    /*
     * T628: comparisons. Two-character forms first, so `<=` never reads as `<` `=`.
     * A bare `=` or `!` is refused with the spelling the author meant — the reset
     * idiom this exists for is `frame % 120 == 0`, and "unexpected =" teaches nothing.
     */
    if (char === "=" || char === "!" || char === "<" || char === ">") {
      const two = input.slice(index, index + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ kind: "op", value: two });
        index += 2;
        continue;
      }
      if (char === "<" || char === ">") {
        tokens.push({ kind: "op", value: char });
        index += 1;
        continue;
      }
      return char === "=" ? 'single "=" — comparison is written "=="' : 'single "!" — negation is written "!="';
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

const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);

/**
 * T628: comparisons, one precedence level BELOW additive — `frame % 120 == 0` parses
 * as `(frame % 120) == 0` with no parentheses, which is the pulse idiom this grammar
 * existed without. The result is 1 or 0 (the evaluator's contract is finite numbers;
 * there is no boolean type), so comparisons compose with arithmetic: `(t > 2) * gain`.
 * Left-associative like everything here; `a < b < c` therefore means `(a < b) < c` —
 * write the conjunction as a product instead: `(a < b) * (b < c)`.
 */
function parseComparison(cursor: Cursor): ExpressionAst {
  let left = parseAdditive(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op" || !COMPARISONS.has(token.value)) break;
    cursor.index += 1;
    left = { kind: "binary", operator: token.value, left, right: parseAdditive(cursor) };
  }
  return left;
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
      return parseCall(cursor, token.value);
    }
    return { kind: "variable", name: token.value };
  }
  if (token.kind === "paren" && token.value === "(") {
    cursor.index += 1;
    const inner = parseComparison(cursor);
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
  token.kind === "dot"
    ? "."
    : token.kind === "comma"
      ? ","
      : token.kind === "string"
        ? `'${token.value}'`
        : String(token.value);

/**
 * A whitelisted call — the cursor stands ON the opening paren (T370).
 *
 * Both refusals here NAME the problem and what would fix it (§V288). An unknown name
 * lists the whole whitelist rather than saying "not available": `sin(time)` is the first
 * thing anyone types into an expression field, and a user who types `smoothstep` deserves
 * to learn where the boundary is from the tool rather than from trial and error. Arity is
 * checked HERE, once per parse, so the per-frame evaluation never re-validates it.
 */
function parseCall(cursor: Cursor, name: string): ExpressionAst {
  const spec = FUNCTIONS[name];
  if (spec === undefined) {
    fail(`unknown function "${name}" (available: ${functionNames().join(", ")})`);
  }
  cursor.index += 1; // consume "("
  const args: ExpressionAst[] = [];
  const empty = peek(cursor);
  if (empty !== undefined && empty.kind === "paren" && empty.value === ")") {
    cursor.index += 1;
  } else {
    for (;;) {
      args.push(parseComparison(cursor));
      const next = peek(cursor);
      if (next !== undefined && next.kind === "comma") {
        cursor.index += 1;
        continue;
      }
      if (next !== undefined && next.kind === "paren" && next.value === ")") {
        cursor.index += 1;
        break;
      }
      fail(`missing closing parenthesis in ${functionSignature(name) ?? name}`);
    }
  }
  if (args.length !== spec.params.length) {
    fail(
      `${name}() takes ${spec.params.length} argument${spec.params.length === 1 ? "" : "s"}` +
        `, got ${args.length}: ${functionSignature(name) ?? name}`,
    );
  }
  return { kind: "call", name, args };
}

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
    const ast = parseComparison(cursor);
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
export function evaluateAst(
  ast: ExpressionAst,
  scope: ExpressionScope = {},
  readNode?: NodeReferenceReader,
): EvaluateResult {
  try {
    const value = evaluateNode(ast, scope, readNode);
    if (!Number.isFinite(value)) return { ok: false, reason: "result is not a finite number" };
    return { ok: true, value };
  } catch (thrown) {
    if (thrown instanceof ParseFailure) return { ok: false, reason: thrown.message };
    return { ok: false, reason: "could not evaluate the expression" };
  }
}

function evaluateNode(
  ast: ExpressionAst,
  scope: ExpressionScope,
  readNode: NodeReferenceReader | undefined,
): number {
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
    case "opRef": {
      /**
       * T316 — the cross-node read, completing §V148's round trip.
       *
       * A caller with no reader is one that cannot resolve a graph: a bare
       * `evaluateExpression` in a test, the completion probe, a preview of an expression
       * typed into a field before it is attached to anything. That case keeps saying so
       * rather than inventing a value, because the alternative — resolving to 0 — is a
       * number that looks like an answer.
       */
      if (readNode === undefined) {
        fail(`node references need a graph to read (op('${ast.name}'))`);
      }
      const read = readNode(ast.name, ast.path);
      if (!read.ok) fail(read.reason);
      return read.value;
    }
    case "call": {
      const spec = FUNCTIONS[ast.name];
      // Unreachable through `parseExpression`, which refuses both cases. Reachable
      // through a hand-built AST, and a wrong-arity call must fail loud rather than read
      // a missing argument as zero.
      if (spec === undefined) fail(`unknown function "${ast.name}"`);
      if (ast.args.length !== spec.params.length) {
        fail(`${ast.name}() takes ${spec.params.length} arguments, got ${ast.args.length}`);
      }
      return spec.apply(ast.args.map((arg) => evaluateNode(arg, scope, readNode)));
    }
    case "unary": {
      const operand = evaluateNode(ast.operand, scope, readNode);
      return ast.operator === "-" ? -operand : operand;
    }
    case "binary": {
      const left = evaluateNode(ast.left, scope, readNode);
      const right = evaluateNode(ast.right, scope, readNode);
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
        // T628: 1/0, never a boolean — the contract is finite numbers, and 1/0 is
        // what lets a comparison drive an amount: `(frame % 120 == 0) * kick`.
        case "==":
          return left === right ? 1 : 0;
        case "!=":
          return left === right ? 0 : 1;
        case "<":
          return left < right ? 1 : 0;
        case "<=":
          return left <= right ? 1 : 0;
        case ">":
          return left > right ? 1 : 0;
        case ">=":
          return left >= right ? 1 : 0;
      }
    }
  }
}

/** One-shot convenience for text entry: parse and evaluate in a single call. */
export function evaluateExpression(
  input: string,
  scope: ExpressionScope = {},
  readNode?: NodeReferenceReader,
): EvaluateResult {
  const parsed = parseExpression(input);
  if (!parsed.ok) return parsed;
  return evaluateAst(parsed.ast, scope, readNode);
}
