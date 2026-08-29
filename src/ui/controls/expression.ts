/**
 * Arithmetic text entry for numeric controls (doc §8.1: "Text entry supports
 * arithmetic expressions where safe").
 *
 * The engine lives in `src/domain/expressions` (T108) — the single evaluator in the
 * codebase, shared with expression-driven parameters, so `"1.5"` and `"1 + 0.5"` typed
 * here can never disagree with a bound expression about arithmetic. This wrapper
 * evaluates with an EMPTY scope: plain text entry exposes no variables, so every
 * identifier — `constructor`, `globalThis`, anything — is rejected as unknown.
 */

import { evaluateExpression as evaluateInScope, type EvaluateResult } from "../../domain/expressions/index.ts";

export type ExpressionResult = EvaluateResult;

export function evaluateExpression(input: string): ExpressionResult {
  return evaluateInScope(input, {});
}
