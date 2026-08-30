import { evaluateExpression } from "./evaluate.ts";

/**
 * What the expression grammar ACCEPTS, discovered by asking it (§V150, §V105).
 *
 * This lives in the domain rather than beside a panel because it is a property of the
 * evaluator, not of any one surface. Two things read it — the help panel's reference and
 * the completion menu at the parameter — and V150 requires them to agree: a completion
 * that offers `sin()` while the grammar rejects it teaches a wrong API with the tool's own
 * authority, and the user blames their syntax rather than the suggestion.
 *
 * The candidate list below proves NOTHING on its own. It is a list of names worth ASKING
 * about; only the ones that actually parse survive. That is what keeps this honest as the
 * whitelist grows: nobody has to remember to update a second list, because there is no
 * second list to update.
 */
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
];

/**
 * Function names the evaluator accepts TODAY. Empty while the grammar rejects calls, and
 * that emptiness is the honest answer — better no row than a row for something that does
 * not work.
 */
export function acceptedFunctions(): readonly string[] {
  const accepted: string[] = [];
  for (const name of CANDIDATE_FUNCTIONS) {
    // One, two and three arguments: arity is part of what is being asked, and a function
    // that only takes two must not be judged by its one-argument call.
    const calls = [`${name}(1)`, `${name}(1, 1)`, `${name}(1, 1, 1)`];
    if (calls.some((call) => evaluateExpression(call).ok)) accepted.push(name);
  }
  return accepted;
}
