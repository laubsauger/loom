import type { ParameterDefinition, ParameterValue } from "../../domain/types/parameters.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";

/**
 * `struct Params` reflection — ONE reflector, shared by every node whose controls are its
 * own shader's uniform struct (T880 built it for `customWgsl`; T900 brought the point
 * kernels onto it rather than forking it).
 *
 * WHY IT LIVES HERE AND NOT IN `custom-wgsl.ts`. Nothing below knows what kind of node it
 * is reading for: it takes WGSL text and returns fields, controls and uniform values. The
 * moment a second node needed the same behaviour, keeping it inside the first node's file
 * would have meant copying it — and a copied reflector is two answers to "what does
 * `lightColor: vec4f` mean?" that drift the first time one of them learns a new type
 * (§V349). `customWgsl` re-exports `declaresUniformBlock` and `reflectParamsStruct` so its
 * own tests still read them off the node they document.
 *
 * WHAT IS *NOT* HERE: the compile-time/uniform SPLIT. This module answers "what fields did
 * the author declare and what control does each become"; whether a given key rebuilds a
 * pipeline or writes a uniform is the node manifest's business, because the two node
 * families answer it differently (a customWgsl's `source` and a kernel's `kernel` are
 * `compileTime`; every control reflected out of them is not — §V5).
 */

/** One field of a shader's `struct Params`: its name, its WGSL type, and what it is FOR. */
export interface ReflectedField {
  readonly name: string;
  readonly wgsl: string;
  /**
   * T1053 — THE AUTHOR'S OWN SENTENCE ABOUT THE KNOB, taken from the trailing `//` comment on
   * the field's line.
   *
   * A name reflects into a label (`sweepRate` → *Sweep Rate*), and a label says WHAT a control
   * is called and nothing about what turning it does. Promoting a shader's magic numbers into
   * `Params` is only half the owner's ask — *"we should at least expose artistic direction as
   * params"* — if every one of them arrives documented as "reaches the kernel as
   * `ctx.params.sweepRate`", which the user could already see by reading the struct.
   *
   * The comment is where the explanation ALREADY IS in every shader anybody writes, so this
   * reads what is there rather than inventing a second place to put it: no annotation syntax,
   * no key that has to agree with the field name, nothing to keep in step. It is strictly
   * opt-in — a field with no trailing comment reflects exactly as it did before — and it costs
   * the generated module nothing, because `extractParamsStruct` already hoists the author's
   * own bytes, comments included.
   *
   * §V852 applies: this becomes the parameter's description, so it is ONE SENTENCE.
   */
  readonly note?: string;
}

/**
 * Comments blanked to SPACES OF THE SAME LENGTH, so a mention of `params` in prose is not a
 * declaration and index arithmetic on the masked text still addresses the original (which is
 * what lets `extractParamsStruct` slice a declaration back out of the author's own bytes).
 *
 * A block comment loses its newlines exactly as the collapse-to-one-space version it replaces
 * did — a struct body interrupted by a multi-line `/* … *\/` parses identically before and
 * after this change. A line comment never contained its own newline to begin with.
 */
function maskComments(source: string): string {
  return maskBlockComments(source).replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

/**
 * T1053 — BLOCK comments alone, blanked the same way: the copy a `//` is looked for in.
 *
 * `maskComments` blanks both kinds, so it cannot be used to FIND a line comment. The raw
 * source cannot either: `/* holds // slashes *\/` contains a slash pair that was never a
 * comment, and reading it as one turns the tail of somebody's prose into a control's
 * description. Blanking only the block form leaves exactly the real line comments visible,
 * at their original indices.
 */
function maskBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
}

/**
 * True when the source really declares `var<uniform> <name>`. Exported for the nodes' own
 * tests: the claim "the default source declares nothing that is not bound" is only worth
 * making if it is checked with the same reader the compile path uses.
 */
export function declaresUniformBlock(source: string, name: string): boolean {
  return new RegExp(`var\\s*<\\s*uniform\\s*>\\s*${name}\\s*:`).test(maskComments(source));
}

const PARAMS_STRUCT = /struct\s+Params\s*\{([^}]*)\}/;

/**
 * The fields a `struct Params { … }` declares (T880, code-first reflection). A deterministic
 * scan, not a WGSL parser — enough to turn a shader's own uniform struct into node controls,
 * so a node's parameters ARE its shader's parameters (the owner's ask; §V805). A shader with
 * no `Params` block, or one listing only `amount` (E43/E45, whose §V147 identity depends on
 * it), reflects to exactly that and no more.
 */
export function reflectParamsStruct(source: string): readonly ReflectedField[] {
  const masked = maskComments(source);
  const match = PARAMS_STRUCT.exec(masked);
  if (match === null) return [];
  const body = match[1] ?? "";
  /*
   * Where the body starts in the ORIGINAL bytes. The mask is character-for-character the same
   * length as the source (that is the whole reason it blanks rather than deletes), so an index
   * into one is an index into the other — which is what lets the field be FOUND in the masked
   * text, where a `//` cannot lie about a declaration, and its note READ from the original,
   * where the comment still exists. `match[0]` is `struct Params {` + body + `}`, so the body
   * ends exactly one character before the match does.
   */
  const bodyStart = match.index + match[0].length - 1 - body.length;
  const visible = maskBlockComments(source);
  const fields: ReflectedField[] = [];
  let offset = 0;
  for (const line of body.split(/[,;\n]/)) {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_]+)/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) {
      // The note is looked for after the DECLARATION ENDS, not from the segment's start: the
      // masked split puts a preceding block comment inside this segment, and a note is by
      // definition something written after the `name: type` it is about.
      const note = noteAt(source, visible, bodyStart + offset + field[0].length, bodyStart + body.length);
      fields.push({ name: field[1], wgsl: field[2], ...(note === undefined ? {} : { note }) });
    }
    // Every delimiter this splits on is one character wide, so the running offset stays exact.
    offset += line.length + 1;
  }
  return fields;
}

/**
 * The trailing `//` note on the PHYSICAL line a field was declared on, or nothing.
 *
 * `from` is where the DECLARATION ENDED, and the scan runs to the next newline in the
 * ORIGINAL — so a block comment that opens after a field and runs on to the next line ENDS
 * that field's line, and whatever note follows the comment belongs to what is declared after
 * it rather than to this one. The `//` is then located in the BLOCK-MASKED copy, where a
 * `/* holds // slashes *\/` no longer offers a slash pair that was never a comment. Both
 * copies are exactly as long as the source, so one index addresses all three.
 *
 * Two fields written on one line share that line's note, which is the honest reading of one
 * comment about two things — write one field a line to say two things.
 */
function noteAt(source: string, visible: string, from: number, bodyEnd: number): string | undefined {
  const newline = source.indexOf("\n", from);
  const end = newline < 0 ? bodyEnd : Math.min(newline, bodyEnd);
  const comment = visible.slice(from, end).indexOf("//");
  if (comment < 0) return undefined;
  const note = source.slice(from + comment + 2, end).trim();
  return note === "" ? undefined : note;
}

/**
 * The author's `struct Params { … }` lifted OUT of their text, verbatim, plus what is left.
 *
 * A `customWgsl` never needs this: its shader is one module and the struct is already in the
 * right place. A point KERNEL is a fragment pasted into a generated module, and WGSL requires
 * declaration before use — the generated `PointCtx` carries a `params: Params` member, so
 * `Params` has to be declared ABOVE it, which is above where the kernel text is pasted.
 * Hoisting the author's own bytes (rather than re-emitting the struct from the reflected
 * fields) is deliberate: their comments and field order survive, and there is exactly one
 * declaration in the module instead of a generated one racing a pasted duplicate.
 *
 * The slice indices come from the MASKED text, whose length matches the original character
 * for character, so a `struct Params` written inside a comment is neither reflected nor cut.
 */
export function extractParamsStruct(source: string): { declaration: string; rest: string } {
  const match = PARAMS_STRUCT.exec(maskComments(source));
  if (match === null) return { declaration: "", rest: source };
  const start = match.index;
  const end = start + match[0].length;
  return {
    declaration: source.slice(start, end),
    rest: `${source.slice(0, start)}${source.slice(end)}`,
  };
}

/** A field whose NAME reads as colour intent gets an RGBA picker; every other vector stays one. */
function looksLikeColour(name: string): boolean {
  return /colou?r|tint|rgb|albedo|emissi/i.test(name);
}

/** A readable label from a camelCase / snake_case field name. */
function labelOf(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** WGSL types this reflector can turn into a control AND into a uniform value. */
export const REFLECTABLE_WGSL_TYPES = ["f32", "i32", "u32", "vec2f", "vec3f", "vec4f"] as const;

/**
 * The node control a struct field maps to (T880). f32 → a number; vec2/3/4 → a vector, or an
 * RGBA picker when the NAME reads as a colour (the vec3f/vec4f fork the orchestrator flagged —
 * resolved by the author's own naming, never a guess from the bare type). Matrices, arrays and
 * textures are not v1 controls and reflect to nothing.
 */
export function paramForField(field: ReflectedField, description?: string): ParameterDefinition | undefined {
  const label = labelOf(field.name);
  /*
   * T1053: the AUTHOR'S sentence wins over the caller's generic one. The caller's text says
   * where the value lands and how it invalidates — true for every field, and therefore worth
   * nothing to somebody who wants to know what this particular knob does.
   */
  const help = field.note ?? description ?? `Reaches the kernel as \`params.${field.name}\` (${field.wgsl}).`;
  // `amount` keeps its historical 0..1 slider so E43/E45 read exactly as they always have.
  if (field.name === "amount" && field.wgsl === "f32") {
    return { type: "number", label: "Amount", default: 1, min: 0, max: 1, range: "bounded", description: "Reaches the kernel as `params.amount`. Whatever your shader makes of it." };
  }
  switch (field.wgsl) {
    case "f32":
      return { type: "number", label, default: 0, description: help };
    case "i32":
    case "u32":
      return { type: "number", label, default: 0, step: 1, description: help };
    case "vec2f":
      return { type: "vector", size: 2, label, default: [0, 0], description: help };
    case "vec3f":
      return looksLikeColour(field.name)
        ? { type: "color", label, default: [1, 1, 1, 1], space: "display", description: help }
        : { type: "vector", size: 3, label, default: [0, 0, 0], description: help };
    case "vec4f":
      return looksLikeColour(field.name)
        ? { type: "color", label, default: [1, 1, 1, 1], space: "display", description: help }
        : { type: "vector", size: 4, label, default: [0, 0, 0, 0], description: help };
    default:
      return undefined;
  }
}

/**
 * The uniform mirror of the reflected controls, shaped to each field's declared WGSL type.
 *
 * Shared for the reason the schema is: vgpu writes uniform members BY NAME into the reflected
 * layout, so a value shaped differently from its control is a silent zero or a silent drop
 * (§V288). One function means the schema above and the values here cannot come to disagree
 * about what a `vec3f` colour is (rgb, not rgba). `prefix` exists because a point kernel folds
 * these into the ONE uniform block it is allowed (`kernelFrame`), where a bare field name could
 * collide with a member the generator owns; a `customWgsl` passes no prefix and binds by the
 * author's own names.
 */
export function reflectedUniforms(
  fields: readonly ReflectedField[],
  parameters: Readonly<Record<string, ParameterValue>>,
  prefix = "",
): Record<string, number | readonly number[]> {
  const uniforms: Record<string, number | readonly number[]> = {};
  for (const field of fields) {
    const param = paramForField(field);
    if (param === undefined) continue;
    const key = `${prefix}${field.name}`;
    if (param.type === "number") {
      uniforms[key] = readNumber(parameters, field.name, typeof param.default === "number" ? param.default : 0);
    } else if (param.type === "color") {
      const rgba = readColor(parameters, field.name, [1, 1, 1, 1]);
      // vec3f colour takes rgb; vec4f takes rgba — matched to the declared type.
      uniforms[key] = field.wgsl === "vec3f" ? [rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0] : rgba;
    } else if (param.type === "vector") {
      const size = field.wgsl === "vec2f" ? 2 : field.wgsl === "vec3f" ? 3 : 4;
      uniforms[key] = readVector(parameters, field.name, new Array<number>(size).fill(0));
    }
  }
  return uniforms;
}
