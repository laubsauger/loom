import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { WGSL_TOKEN_TABLE, wgslStreamParser } from "./wgsl-language.ts";
import type { WgslTokenizerState } from "./wgsl-language.ts";

interface Token {
  readonly text: string;
  readonly type: string | null;
}

/**
 * Drives the tokenizer the way CodeMirror does — one `StringStream` per line, `start`
 * reset before each token, state carried across lines — so what these tests exercise is
 * the real code path and not a convenient reimplementation of it.
 */
function tokenize(source: string): Token[] {
  const start = wgslStreamParser.startState;
  const state: WgslTokenizerState =
    start === undefined ? { blockCommentDepth: 0, pendingDefinition: false } : start(2);
  const tokens: Token[] = [];

  for (const line of source.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    let guard = 0;
    while (!stream.eol()) {
      stream.start = stream.pos;
      const type = wgslStreamParser.token(stream, state);
      // A zero-length token would spin CodeMirror's parser forever; fail loudly here
      // rather than hanging the suite.
      expect(stream.pos).toBeGreaterThan(stream.start);
      tokens.push({ text: line.slice(stream.start, stream.pos), type });
      guard += 1;
      expect(guard).toBeLessThan(1000);
    }
  }
  return tokens;
}

function typeOf(source: string, text: string): string | null | undefined {
  return tokenize(source).find((token) => token.text === text)?.type;
}

function nonSpace(source: string): Token[] {
  return tokenize(source).filter((token) => token.type !== null || token.text.trim() !== "");
}

describe("WGSL tokenizer — the shader contract in §I compiles to sensible tokens", () => {
  const CONTRACT = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
struct Params { time: f32, amount: f32, };
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;

  it("tags attributes as one token including the name", () => {
    expect(typeOf(CONTRACT, "@group")).toBe("attribute");
    expect(typeOf(CONTRACT, "@binding")).toBe("attribute");
    expect(typeOf(CONTRACT, "@fragment")).toBe("attribute");
    expect(typeOf(CONTRACT, "@location")).toBe("attribute");
  });

  it("separates declaration keywords, types, builtins and plain identifiers", () => {
    expect(typeOf(CONTRACT, "var")).toBe("keyword");
    expect(typeOf(CONTRACT, "struct")).toBe("keyword");
    expect(typeOf(CONTRACT, "return")).toBe("keyword");
    expect(typeOf(CONTRACT, "sampler")).toBe("type");
    expect(typeOf(CONTRACT, "texture_2d")).toBe("type");
    expect(typeOf(CONTRACT, "f32")).toBe("type");
    expect(typeOf(CONTRACT, "vec2f")).toBe("type");
    expect(typeOf(CONTRACT, "vec4f")).toBe("type");
    expect(typeOf(CONTRACT, "textureSample")).toBe("builtin");
    expect(typeOf(CONTRACT, "inputTexture")).toBe("variable");
    expect(typeOf(CONTRACT, "uv")).toBe("variable");
  });

  it("marks the name after fn / struct as a definition, not a plain identifier", () => {
    expect(typeOf(CONTRACT, "fs")).toBe("definition");
    expect(typeOf(CONTRACT, "Params")).toBe("definition");
  });

  it("reads address spaces inside var<> as modifiers", () => {
    expect(typeOf(CONTRACT, "uniform")).toBe("modifier");
    expect(typeOf("var<storage, read_write> data: array<f32>;", "storage")).toBe("modifier");
    expect(typeOf("var<storage, read_write> data: array<f32>;", "read_write")).toBe("modifier");
  });
});

describe("WGSL tokenizer — literals", () => {
  it("reads decimal, suffixed, exponent and hex numbers as one number token each", () => {
    for (const literal of ["1", "1.0", "1.", ".5", "1e-3", "2.5f", "3h", "7i", "9u", "0xff", "0xffu"]) {
      const tokens = nonSpace(`let x = ${literal};`);
      const number = tokens.find((token) => token.type === "number");
      expect(number, literal).toBeDefined();
      expect(number?.text, literal).toBe(literal);
    }
  });

  it("does not swallow member access as a number", () => {
    const tokens = nonSpace("let c = color.rgb;");
    expect(tokens.some((token) => token.type === "number")).toBe(false);
    expect(typeOf("let c = color.rgb;", "rgb")).toBe("variable");
  });

  it("tags true and false as atoms, not identifiers", () => {
    expect(typeOf("let a = true;", "true")).toBe("atom");
    expect(typeOf("let a = false;", "false")).toBe("atom");
  });
});

describe("WGSL tokenizer — comments", () => {
  it("reads a line comment to end of line", () => {
    const tokens = tokenize("let x = 1; // not code fn struct");
    const comment = tokens.find((token) => token.type === "comment");
    expect(comment?.text).toBe("// not code fn struct");
  });

  it("keeps a block comment open across lines", () => {
    const tokens = tokenize("/* start\nstill comment fn\n*/ let x = 1;");
    // Everything before the closing delimiter is comment, and code resumes after it.
    expect(tokens.filter((token) => token.type === "comment").length).toBeGreaterThan(2);
    expect(typeOf("/* start\nstill comment fn\n*/ let x = 1;", "let")).toBe("keyword");
  });

  it("nests block comments, which WGSL requires and C does not", () => {
    // The inner `*/` closes only the inner comment; `let` must still be commented out.
    const source = "/* outer /* inner */ let x = 1; */ fn f() {}";
    expect(typeOf(source, "let")).toBeUndefined();
    expect(typeOf(source, "fn")).toBe("keyword");
  });
});

describe("WGSL token vocabulary", () => {
  it("maps every token name the tokenizer can emit to a highlight tag", () => {
    // A name emitted but absent from the table renders unstyled — silently. This is the
    // guard that keeps the tokenizer and the theme from drifting.
    const emitted = new Set(
      tokenize(
        `@fragment fn f(@location(0) uv: vec2f) -> vec4f {\n` +
          `  // c\n  let n = 0xff; var<uniform> p: Params; return vec4f(1.0) + textureSample(t, s, uv);\n}`,
      )
        .map((token) => token.type)
        .filter((type): type is string => type !== null),
    );
    for (const name of emitted) {
      expect(Object.keys(WGSL_TOKEN_TABLE), name).toContain(name);
    }
    expect(emitted.size).toBeGreaterThan(6);
  });
});
