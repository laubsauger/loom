import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { StreamParser, StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Tag } from "@lezer/highlight";

/**
 * WGSL syntax highlighting (T20).
 *
 * There is no official Lezer grammar for WGSL, so this is a hand-written stream
 * tokenizer. It is deliberately a *lexer*, not a parser: it classifies words and
 * punctuation and tracks exactly two pieces of state — block-comment nesting depth and
 * "the next identifier names the thing just declared". A correct simple tokenizer beats
 * an ambitious broken one, and a highlighter that mis-colours is worse than one that
 * under-colours, so anything it cannot decide from the current token alone is left as a
 * plain identifier.
 *
 * Known gaps, all deliberate:
 *  - No scope tracking. A local named `mix` highlights as the builtin `mix`.
 *  - `read` / `write` / `uniform` / `storage` are highlighted as address-space modifiers
 *    wherever they appear, including as a user identifier.
 *  - Struct member names, function call sites and template arguments are plain
 *    identifiers — telling them apart needs a parser.
 *  - `enable` / `requires` / `diagnostic` directive payloads are plain identifiers.
 *  - Semantic errors are not this file's job; those arrive from the GPU as compilation
 *    messages (§V27) and are rendered by the lint layer.
 */

/** Declaration and control-flow keywords (WGSL spec §keyword summary). */
const KEYWORDS = new Set([
  "alias",
  "break",
  "case",
  "const",
  "const_assert",
  "continue",
  "continuing",
  "default",
  "diagnostic",
  "discard",
  "else",
  "enable",
  "fn",
  "for",
  "if",
  "let",
  "loop",
  "override",
  "requires",
  "return",
  "struct",
  "switch",
  "var",
  "while",
]);

/** Keywords after which the next identifier is the name being declared. */
const DECLARATION_KEYWORDS = new Set(["fn", "struct", "alias"]);

/** Address spaces and access modes — `var<storage, read_write>`. */
const MODIFIERS = new Set([
  "function",
  "private",
  "workgroup",
  "uniform",
  "storage",
  "push_constant",
  "read",
  "write",
  "read_write",
]);

const ATOMS = new Set(["true", "false"]);

/** Predeclared types, including the `vec2f` / `mat3x3f` shorthand aliases. */
const TYPES = new Set([
  "array",
  "atomic",
  "bool",
  "f16",
  "f32",
  "i32",
  "u32",
  "ptr",
  "ref",
  "sampler",
  "sampler_comparison",
  "texture_1d",
  "texture_2d",
  "texture_2d_array",
  "texture_3d",
  "texture_cube",
  "texture_cube_array",
  "texture_multisampled_2d",
  "texture_depth_2d",
  "texture_depth_2d_array",
  "texture_depth_cube",
  "texture_depth_cube_array",
  "texture_depth_multisampled_2d",
  "texture_storage_1d",
  "texture_storage_2d",
  "texture_storage_2d_array",
  "texture_storage_3d",
  "texture_external",
  "binding_array",
  ...["2", "3", "4"].flatMap((size) => [
    `vec${size}`,
    ...["f", "h", "i", "u"].map((scalar) => `vec${size}${scalar}`),
  ]),
  ...["2", "3", "4"].flatMap((columns) =>
    ["2", "3", "4"].flatMap((rows) => [
      `mat${columns}x${rows}`,
      ...["f", "h"].map((scalar) => `mat${columns}x${rows}${scalar}`),
    ]),
  ),
]);

/**
 * Built-in functions. Not exhaustive — the WGSL builtin list is long and grows — but it
 * covers the numeric, texture, derivative, atomic, barrier and packing families a
 * compositor shader actually reaches for. An unlisted builtin degrades to a plain
 * identifier, which is the safe direction.
 */
const BUILTINS = new Set([
  // numeric
  "abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "ceil", "clamp",
  "cos", "cosh", "countLeadingZeros", "countOneBits", "countTrailingZeros", "cross",
  "degrees", "determinant", "distance", "dot", "dot4U8Packed", "dot4I8Packed", "exp",
  "exp2", "extractBits", "faceForward", "firstLeadingBit", "firstTrailingBit", "floor",
  "fma", "fract", "frexp", "insertBits", "inverseSqrt", "ldexp", "length", "log", "log2",
  "max", "min", "mix", "modf", "normalize", "pow", "quantizeToF16", "radians", "reflect",
  "refract", "reverseBits", "round", "saturate", "sign", "sin", "sinh", "smoothstep",
  "sqrt", "step", "tan", "tanh", "transpose", "trunc",
  // logical / data
  "all", "any", "select", "arrayLength", "bitcast",
  // derivatives
  "dpdx", "dpdxCoarse", "dpdxFine", "dpdy", "dpdyCoarse", "dpdyFine", "fwidth",
  "fwidthCoarse", "fwidthFine",
  // texture
  "textureDimensions", "textureGather", "textureGatherCompare", "textureLoad",
  "textureNumLayers", "textureNumLevels", "textureNumSamples", "textureSample",
  "textureSampleBias", "textureSampleCompare", "textureSampleCompareLevel",
  "textureSampleGrad", "textureSampleLevel", "textureSampleBaseClampToEdge",
  "textureStore",
  // synchronization
  "storageBarrier", "textureBarrier", "workgroupBarrier", "workgroupUniformLoad",
  // atomics
  "atomicLoad", "atomicStore", "atomicAdd", "atomicSub", "atomicMax", "atomicMin",
  "atomicAnd", "atomicOr", "atomicXor", "atomicExchange", "atomicCompareExchangeWeak",
  // packing
  "pack4x8snorm", "pack4x8unorm", "pack4xI8", "pack4xU8", "pack4xI8Clamp",
  "pack4xU8Clamp", "pack2x16snorm", "pack2x16unorm", "pack2x16float",
  "unpack4x8snorm", "unpack4x8unorm", "unpack4xI8", "unpack4xU8", "unpack2x16snorm",
  "unpack2x16unorm", "unpack2x16float",
]);

/**
 * Token names this tokenizer emits. They are mapped to highlight tags by
 * `WGSL_TOKEN_TABLE` rather than relying on CodeMirror's legacy-mode name table, so the
 * vocabulary here and the theme's vocabulary cannot drift apart silently.
 */
export type WgslTokenName =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "modifier"
  | "type"
  | "builtin"
  | "atom"
  | "attribute"
  | "definition"
  | "variable"
  | "operator"
  | "punctuation"
  | "bracket";

export const WGSL_TOKEN_TABLE: Record<WgslTokenName, Tag> = {
  comment: tags.comment,
  string: tags.string,
  number: tags.number,
  keyword: tags.keyword,
  modifier: tags.modifier,
  type: tags.typeName,
  builtin: tags.function(tags.standard(tags.variableName)),
  atom: tags.atom,
  attribute: tags.annotation,
  definition: tags.definition(tags.variableName),
  variable: tags.variableName,
  operator: tags.operator,
  punctuation: tags.punctuation,
  bracket: tags.bracket,
};

export interface WgslTokenizerState {
  /** WGSL block comments nest, so a depth counter is required, not a boolean. */
  blockCommentDepth: number;
  /** Set by `fn` / `struct` / `alias`: the next identifier is a declaration name. */
  pendingDefinition: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
const ATTRIBUTE = /^@[A-Za-z_][A-Za-z0-9_]*/;
/** `0x1.8p3`, `0xffu`, `0x7F` — hex integers and hex floats, with optional suffix. */
const HEX_NUMBER = /^0[xX][0-9a-fA-F]*(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?[0-9]+)?[hfiu]?/;
/** `1`, `1.`, `.5`, `1.0e-3`, with the `f` / `h` / `i` / `u` suffixes WGSL allows. */
const DEC_NUMBER = /^(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?[hfiu]?/;
const OPERATOR_CHARS = /[+\-*/%<>=!&|^~]/;

function readBlockComment(stream: StringStream, state: WgslTokenizerState): WgslTokenName {
  while (!stream.eol()) {
    if (stream.match("*/")) {
      state.blockCommentDepth -= 1;
      if (state.blockCommentDepth <= 0) {
        state.blockCommentDepth = 0;
        return "comment";
      }
      continue;
    }
    if (stream.match("/*")) {
      state.blockCommentDepth += 1;
      continue;
    }
    stream.next();
  }
  return "comment";
}

export const wgslStreamParser: StreamParser<WgslTokenizerState> = {
  name: "wgsl",
  startState: () => ({ blockCommentDepth: 0, pendingDefinition: false }),
  copyState: (state) => ({ ...state }),
  tokenTable: WGSL_TOKEN_TABLE,
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },

  token(stream, state): string | null {
    // Guard first: every branch below must consume at least one character, and a
    // zero-length token would spin the parser.
    if (stream.eol()) return null;

    if (state.blockCommentDepth > 0) return readBlockComment(stream, state);
    if (stream.eatSpace()) return null;

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.blockCommentDepth = 1;
      return readBlockComment(stream, state);
    }

    // `@group(0) @binding(1) @fragment` — the attribute name is part of the token.
    if (stream.match(ATTRIBUTE)) {
      state.pendingDefinition = false;
      return "attribute";
    }

    // WGSL has no string literals. Consuming a quoted run anyway keeps one stray quote
    // from re-colouring the rest of the line.
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.pendingDefinition = false;
      return "string";
    }

    if (stream.match(HEX_NUMBER) || stream.match(DEC_NUMBER)) {
      state.pendingDefinition = false;
      return "number";
    }

    if (stream.match(IDENTIFIER)) {
      const word = stream.current();
      if (state.pendingDefinition) {
        state.pendingDefinition = false;
        return "definition";
      }
      if (KEYWORDS.has(word)) {
        state.pendingDefinition = DECLARATION_KEYWORDS.has(word);
        return "keyword";
      }
      if (ATOMS.has(word)) return "atom";
      if (MODIFIERS.has(word)) return "modifier";
      if (TYPES.has(word)) return "type";
      if (BUILTINS.has(word)) return "builtin";
      return "variable";
    }

    const char = stream.next();
    state.pendingDefinition = false;
    if (char === undefined) return null;
    if ("()[]{}".includes(char)) return "bracket";
    if (",;:".includes(char)) return "punctuation";
    if (OPERATOR_CHARS.test(char)) {
      stream.eatWhile(OPERATOR_CHARS);
      return "operator";
    }
    if (char === ".") return "operator";
    return null;
  },
};

export const wgslLanguage = StreamLanguage.define(wgslStreamParser);

/** CodeMirror extension: WGSL highlighting plus its comment/indent language data. */
export function wgsl(): LanguageSupport {
  return new LanguageSupport(wgslLanguage);
}
