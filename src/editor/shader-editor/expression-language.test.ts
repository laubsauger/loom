import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { expressionStreamParser } from "./expression-language.ts";

/**
 * T505 — the expression lexer, and the ONE colour decision it exists for.
 *
 * The token classes derive from the evaluator (functionNames(), the exported clock
 * families), so the census here is thin on purpose. What is pinned hard is the clock
 * distinction: `abstime` and `time` MUST tokenize differently, because which clock an
 * expression reads is the mistake this project has made four times (T489's family),
 * and a colour difference at the point of typing is the cheapest guard there is.
 */

function tokenize(source: string): Array<{ type: string | null; text: string }> {
  const stream = new StringStream(source, 2, 2);
  const tokens: Array<{ type: string | null; text: string }> = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const type = expressionStreamParser.token(stream);
    if (stream.pos === stream.start) throw new Error(`zero-length token at ${stream.pos}`);
    tokens.push({ type, text: source.slice(stream.start, stream.pos) });
  }
  return tokens;
}

const typeOf = (source: string, word: string): string | null =>
  tokenize(source).find((token) => token.text === word)?.type ?? null;

describe("expression tokens (T505)", () => {
  it("free-running clocks read as a DIFFERENT class from wrapping ones — the point of the lexer", () => {
    const source = "sin(time) + abstime - absframe * frame + walltime";
    expect(typeOf(source, "time")).toBe("variableName");
    expect(typeOf(source, "frame")).toBe("variableName");
    expect(typeOf(source, "abstime")).toBe("freeRunningClock");
    expect(typeOf(source, "absframe")).toBe("freeRunningClock");
    expect(typeOf(source, "walltime")).toBe("freeRunningClock");
    expect(typeOf(source, "time")).not.toBe(typeOf(source, "abstime"));
  });

  it("functions derive from the evaluator; op() and literals classify", () => {
    const source = "clamp(op('lfo1'), 0.5, mod(x, 2))";
    expect(typeOf(source, "clamp")).toBe("functionName");
    expect(typeOf(source, "mod")).toBe("functionName");
    expect(typeOf(source, "op")).toBe("functionName");
    expect(typeOf(source, "'lfo1'")).toBe("string");
    expect(typeOf(source, "0.5")).toBe("number");
    expect(typeOf(source, "x")).toBe("variableName");
  });
});
