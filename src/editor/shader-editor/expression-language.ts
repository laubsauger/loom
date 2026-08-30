import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  FREE_RUNNING_CLOCK_NAMES,
  WRAPPING_CLOCK_NAMES,
  functionNames,
} from "@domain/expressions/index.ts";

/**
 * Expression highlighting (T505) — the parameter expression grammar, beside the WGSL
 * and JSON lexers and for the same reasons: hand-written, tiny, no dependency.
 *
 * Every word class DERIVES from the evaluator (§V150): the function set is
 * `functionNames()`, and the clock names come from the exported families rather than a
 * remembered list. The one deliberate colour decision: FREE-RUNNING clocks (`abstime`,
 * `absframe`, `walltime`, `walldelta`) highlight as ATOM while the WRAPPING ones
 * (`time`, `frame`, `delta`) stay plain variables — which clock an expression reads is
 * the distinction that has bitten this project four times (T489's whole family), and a
 * colour difference at the point of typing is worth more than generic keyword paint.
 */

const FUNCTION_SET = new Set(functionNames());
const FREE_RUNNING = new Set<string>(FREE_RUNNING_CLOCK_NAMES);
const WRAPPING = new Set<string>(WRAPPING_CLOCK_NAMES);

export const expressionStreamParser = {
  name: "shaderloom-expression",
  token(stream: StringStream): string | null {
    if (stream.eatSpace()) return null;
    const ch = stream.next();
    if (ch === undefined || ch === null) return null;
    if (ch === "'" || ch === '"') {
      while (!stream.eol()) {
        const next = stream.next();
        if (next === ch) break;
      }
      return "string";
    }
    if (/[0-9.]/.test(ch)) {
      stream.eatWhile(/[0-9.eE]/);
      return "number";
    }
    if (/[a-zA-Z_]/.test(ch)) {
      stream.eatWhile(/[a-zA-Z0-9_]/);
      const word = stream.current();
      if (FUNCTION_SET.has(word) || word === "op") return "functionName";
      if (FREE_RUNNING.has(word)) return "freeRunningClock";
      if (WRAPPING.has(word)) return "variableName";
      return "variableName";
    }
    if ("+-*/%^".includes(ch)) return "operator";
    if ("(),.".includes(ch)) return "punctuation";
    return null;
  },
  tokenTable: {
    string: tags.string,
    number: tags.number,
    functionName: tags.function(tags.variableName),
    // ATOM on purpose: the free-running clocks must LOOK different from the wrapping
    // ones while being typed — see the module note.
    freeRunningClock: tags.atom,
    variableName: tags.variableName,
    operator: tags.operator,
    punctuation: tags.punctuation,
  },
};

export function expression(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(expressionStreamParser));
}
