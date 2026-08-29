import { evaluateExpression, scopeFromFrame } from "@domain/expressions/index.ts";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";

/**
 * What an expression may say, ASKED OF THE EVALUATOR (T200, T201, §V105, §V71).
 *
 * §V71 makes `src/domain/expressions` the sole engine, and it exports no manifest of
 * its grammar — the grammar IS the parser. So this module does not describe the
 * evaluator, it INTERROGATES it: every operator and every function name below is run
 * through `evaluateExpression` and only survives into the reference if the real
 * evaluator accepted it.
 *
 * That is the difference that matters. A hand-written list would still say `sin(x)`
 * long after the whitelist changed, and someone would type it and get an error from
 * the help page's own example. Here the list can only ever be a subset of what works:
 * when function calls land, the names the evaluator starts accepting appear on their
 * own; if an operator is ever removed, its row disappears the same day.
 *
 * `CANDIDATE_FUNCTIONS` is a probe set, not a claim. Its only job is to be a superset
 * of what any plausible whitelist would contain; a name in it that the evaluator
 * rejects is simply not shown.
 */

export interface ExpressionVariable {
  readonly name: string;
  /** Its value in the scope this help was opened against. */
  readonly value: number;
}

export interface ExpressionSample {
  /** Source text, verified to parse and evaluate before it is shown. */
  readonly source: string;
  readonly value: number;
}

/** Names a whitelist might plausibly carry. Membership here proves nothing (see above). */
export const CANDIDATE_FUNCTIONS: readonly string[] = [
  "abs",
  "acos",
  "asin",
  "atan",
  "atan2",
  "ceil",
  "clamp",
  "cos",
  "exp",
  "floor",
  "fract",
  "hypot",
  "lerp",
  "log",
  "log2",
  "max",
  "min",
  "mix",
  "mod",
  "pow",
  "round",
  "sign",
  "sin",
  "smoothstep",
  "sqrt",
  "step",
  "tan",
  "trunc",
];

/** Operator forms to probe. Each shows its own arithmetic, so the row carries a value. */
const CANDIDATE_OPERATORS: readonly string[] = [
  "1 + 2",
  "3 - 1",
  "2 * 3",
  "6 / 4",
  "7 % 4",
  "2 ^ 3",
  "-2 + 5",
  "(1 + 2) * 3",
];

/** Variables an expression can read here, with the value each currently has. */
export function expressionVariables(scope: ExpressionScope): readonly ExpressionVariable[] {
  return Object.entries(scope)
    .filter(([, value]) => Number.isFinite(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

/**
 * The scope a parameter expression sees for a frame — `scopeFromFrame` itself, so the
 * names in the help and the names at evaluation time cannot diverge (§V71).
 */
export function frameScope(
  frame: FrameEvaluationInput,
  nodeContext: ExpressionScope = {},
): ExpressionScope {
  return scopeFromFrame(frame, nodeContext);
}

/** Operator forms the evaluator actually accepts, each with the value it produced. */
export function expressionOperators(): readonly ExpressionSample[] {
  const accepted: ExpressionSample[] = [];
  for (const source of CANDIDATE_OPERATORS) {
    const result = evaluateExpression(source);
    if (result.ok) accepted.push({ source, value: result.value });
  }
  return accepted;
}

/**
 * Function names the evaluator accepts TODAY. Empty while the grammar rejects calls,
 * and that emptiness is the honest answer — §V90 would rather show no row than a row
 * for something that does not work.
 */
export function expressionFunctions(): readonly string[] {
  const accepted: string[] = [];
  for (const name of CANDIDATE_FUNCTIONS) {
    // One, two and three arguments: arity is part of what is being asked, and a
    // function that only takes two must not be judged by its one-argument call.
    const calls = [`${name}(1)`, `${name}(1, 1)`, `${name}(1, 1, 1)`];
    if (calls.some((call) => evaluateExpression(call).ok)) accepted.push(name);
  }
  return accepted;
}

/**
 * Starter expressions for the variables that are actually in scope (T201).
 *
 * The owner's question — "how do I drive a noise translate from time?" — is answered by
 * a line of source, not by a paragraph. Each template names the variable it needs, is
 * skipped when that variable is absent, and is evaluated before it is shown, so a
 * suggestion the grammar no longer accepts cannot reach the panel.
 */
const SUGGESTIONS: ReadonlyArray<{ variable: string; source: string }> = [
  { variable: "time", source: "time * 0.25" },
  { variable: "time", source: "(time % 4) / 4" },
  { variable: "time", source: "time * 2 - 1" },
  { variable: "frame", source: "frame * 0.01" },
  { variable: "delta", source: "delta * 60" },
];

export function expressionSuggestions(scope: ExpressionScope): readonly ExpressionSample[] {
  const samples: ExpressionSample[] = [];
  for (const suggestion of SUGGESTIONS) {
    if (!Object.prototype.hasOwnProperty.call(scope, suggestion.variable)) continue;
    const result = evaluateExpression(suggestion.source, scope);
    if (result.ok) samples.push({ source: suggestion.source, value: result.value });
  }
  return samples;
}

export type ExpressionPreview =
  | { readonly state: "empty" }
  | { readonly state: "value"; readonly value: number }
  | { readonly state: "error"; readonly reason: string };

/** Live result of the source being typed, against the scope it will really run in. */
export function previewExpression(source: string, scope: ExpressionScope): ExpressionPreview {
  if (source.trim() === "") return { state: "empty" };
  const result = evaluateExpression(source, scope);
  return result.ok
    ? { state: "value", value: result.value }
    : { state: "error", reason: result.reason };
}
