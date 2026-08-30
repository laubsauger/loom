import { acceptedFunctionCalls, frameVariableNames } from "@domain/expressions/reference.ts";
import type { ExpressionScope } from "@domain/expressions/index.ts";

/**
 * What to offer while an expression is being typed (T247, §V150).
 *
 * Every candidate comes from something that can answer for itself: variables from the
 * scope the resolver will actually use, functions from PROBING the evaluator, node names
 * from the document. Nothing here is a hand-kept list, which is the whole point — a menu
 * that offers `sin()` while the grammar rejects it teaches a wrong API with the tool's own
 * authority, and the user blames their own syntax rather than the suggestion.
 */

export type CompletionKind = "variable" | "function" | "node";

export interface CompletionCandidate {
  readonly text: string;
  readonly kind: CompletionKind;
  /** Shown beside the name: a variable's current value, or a function's call shape. */
  readonly detail?: string;
}

export interface CompletionState {
  /** The identifier being typed. Empty when the caret sits at a boundary. */
  readonly prefix: string;
  /** Range in the source the accepted text replaces. */
  readonly start: number;
  readonly end: number;
  readonly candidates: readonly CompletionCandidate[];
}

/** The identifier immediately before the caret, if any. */
const IDENTIFIER_BEFORE = /[A-Za-z_][A-Za-z0-9_]*$/;
/** `op('` or `op("` — the caret is naming a NODE, not a variable. */
const OP_REFERENCE_BEFORE = /\bop\(\s*['"][A-Za-z0-9_ -]*$/;

function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Candidates for the caret position, or `null` when there is nothing worth showing.
 *
 * Returns candidates for an EMPTY prefix too. The alternative — waiting for a character —
 * is the behaviour of a menu that only helps people who already know what to type.
 */
export function completionAt(
  source: string,
  caret: number,
  /**
   * A LIVE scope shows each variable's current value beside its name. Omitting it still
   * offers the names — derived from `scopeFromFrame`, never hand-kept — because a menu
   * that waits for wiring is a menu that ships dead. That is not hypothetical: this
   * completion shipped with `scope` optional and unwired, so it could never appear.
   */
  scope?: ExpressionScope,
  nodeNames: readonly string[] = [],
): CompletionState | null {
  const clamped = Math.max(0, Math.min(caret, source.length));
  const before = source.slice(0, clamped);

  // Inside `op('...')` the grammar wants a node name, and offering `time` there would be
  // actively misleading rather than merely unhelpful.
  if (OP_REFERENCE_BEFORE.test(before)) {
    const quoted = /['"]([A-Za-z0-9_ -]*)$/.exec(before);
    const prefix = quoted?.[1] ?? "";
    return finish(
      prefix,
      clamped - prefix.length,
      clamped,
      nodeNames.map((text) => ({ text, kind: "node" as const })),
    );
  }

  const match = IDENTIFIER_BEFORE.exec(before);
  const prefix = match?.[0] ?? "";
  const variables: CompletionCandidate[] =
    scope === undefined
      ? frameVariableNames().map((text) => ({ text, kind: "variable" as const }))
      : Object.entries(scope)
          .filter(([, value]) => typeof value === "number")
          .map(([name, value]) => ({
            text: name,
            kind: "variable" as const,
            detail: formatValue(value as number),
          }));
  const candidates: CompletionCandidate[] = [
    ...variables,
    // The CALL SHAPE, not a bare `()`: the whole cost of a function is knowing how many
    // arguments it takes and in what order, and `clamp(x, low, high)` answers that where
    // `clamp()` sends the user to the help panel to find out (T370, §V150).
    ...acceptedFunctionCalls().map((fn) => ({
      text: fn.name,
      kind: "function" as const,
      detail: fn.signature,
    })),
  ];
  return finish(prefix, clamped - prefix.length, clamped, candidates);
}

function finish(
  prefix: string,
  start: number,
  end: number,
  candidates: readonly CompletionCandidate[],
): CompletionState | null {
  const needle = prefix.toLowerCase();
  const matched = candidates
    .filter((candidate) => candidate.text.toLowerCase().startsWith(needle))
    // A name that IS the prefix is not worth offering — accepting it would change nothing.
    .filter((candidate) => candidate.text !== prefix)
    .sort((a, b) => a.text.localeCompare(b.text));
  if (matched.length === 0) return null;
  return { prefix, start, end, candidates: matched };
}

/** Apply a candidate, returning the new source and where the caret lands. */
export function applyCompletion(
  source: string,
  state: CompletionState,
  candidate: CompletionCandidate,
): { source: string; caret: number } {
  const inserted = candidate.kind === "function" ? `${candidate.text}(` : candidate.text;
  const next = source.slice(0, state.start) + inserted + source.slice(state.end);
  return { source: next, caret: state.start + inserted.length };
}
