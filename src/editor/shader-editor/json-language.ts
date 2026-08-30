import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * JSON highlighting for code-valued parameters (T492) — the attribute schemas a point
 * kernel declares. A hand-written stream lexer like `wgsl-language.ts`, and for the
 * same reason: no new dependency for a grammar this small, and a simple correct
 * tokenizer beats an ambitious broken one. A string followed by a colon is a property
 * name; everything else is literals and punctuation, which IS the whole language.
 */

interface JsonState {
  /** True when the next string is a property NAME — right after `{` or `,` in an object. */
  expectKey: boolean;
  /** Object-nesting trail, so `expectKey` survives nested arrays and objects. */
  stack: Array<"object" | "array">;
}

function readString(stream: StringStream): void {
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === "\\") stream.next();
    else if (ch === '"') return;
  }
}

const parser = {
  name: "json",
  startState(): JsonState {
    return { expectKey: false, stack: [] };
  },
  token(stream: StringStream, state: JsonState): string | null {
    if (stream.eatSpace()) return null;
    const ch = stream.next();
    if (ch === undefined || ch === null) return null;
    if (ch === '"') {
      readString(stream);
      if (state.expectKey && state.stack.at(-1) === "object") {
        return "propertyName";
      }
      return "string";
    }
    if (ch === "{") {
      state.stack.push("object");
      state.expectKey = true;
      return "brace";
    }
    if (ch === "[") {
      state.stack.push("array");
      state.expectKey = false;
      return "squareBracket";
    }
    if (ch === "}" || ch === "]") {
      state.stack.pop();
      state.expectKey = false;
      return ch === "}" ? "brace" : "squareBracket";
    }
    if (ch === ":") {
      state.expectKey = false;
      return "punctuation";
    }
    if (ch === ",") {
      state.expectKey = state.stack.at(-1) === "object";
      return "punctuation";
    }
    if (/[-0-9]/.test(ch)) {
      stream.eatWhile(/[0-9eE+.-]/);
      return "number";
    }
    if (/[a-z]/.test(ch)) {
      stream.eatWhile(/[a-z]/);
      return "keyword"; // true / false / null — nothing else is legal here
    }
    return null;
  },
  tokenTable: {
    propertyName: tags.propertyName,
    string: tags.string,
    number: tags.number,
    keyword: tags.keyword,
    brace: tags.brace,
    squareBracket: tags.squareBracket,
    punctuation: tags.punctuation,
  },
};

export function json(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}
