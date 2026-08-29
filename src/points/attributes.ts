/**
 * Point attribute schemas and their GPU layout (T117, §V72).
 *
 * Storage is structure-of-arrays: ONE storage buffer per attribute, never one
 * interleaved struct buffer. That kills WGSL struct-layout pain at the source (each
 * buffer is a plain `array<T>`), lets an operator bind only the attributes it touches,
 * and means adding an attribute never relayouts the others.
 *
 * The one layout trap worth spelling out: `array<vec3f>` has an element STRIDE of 16
 * bytes (vec3 aligns to 16 in WGSL), so a vec3 attribute costs as much as a vec4. The
 * stride table below is the single source of truth; capacity × stride is the buffer
 * size everywhere.
 */

export const POINT_ATTRIBUTE_TYPES = ["f32", "vec2f", "vec3f", "vec4f", "u32", "vec4u"] as const;

export type PointAttributeType = (typeof POINT_ATTRIBUTE_TYPES)[number];

/** Well-known roles renderers and viewers pick up without magic strings (§V72). */
export const POINT_SEMANTICS = ["position", "color", "size", "id", "life"] as const;

export type PointSemantic = (typeof POINT_SEMANTICS)[number];

export interface PointAttributeSchema {
  /** WGSL-safe identifier; becomes the `Point` struct field and the buffer names. */
  readonly name: string;
  readonly type: PointAttributeType;
  readonly semantic?: PointSemantic;
  /** Value for newly emitted points, component count matching the type. */
  readonly default: ReadonlyArray<number>;
}

/** Element stride in bytes inside `array<T>` — vec3f is 16, not 12 (WGSL alignment). */
export const ATTRIBUTE_STRIDES: Readonly<Record<PointAttributeType, number>> = {
  f32: 4,
  vec2f: 8,
  vec3f: 16,
  vec4f: 16,
  u32: 4,
  vec4u: 16,
};

export const COMPONENT_COUNTS: Readonly<Record<PointAttributeType, number>> = {
  f32: 1,
  vec2f: 2,
  vec3f: 3,
  vec4f: 4,
  u32: 1,
  vec4u: 4,
};

export function attributeBufferBytes(type: PointAttributeType, capacity: number): number {
  return ATTRIBUTE_STRIDES[type] * capacity;
}

/** Coarse memory estimate for a whole point system (§V24 reporting). */
export function pointSetBytes(attributes: ReadonlyArray<PointAttributeSchema>, capacity: number): number {
  return attributes.reduce((total, attribute) => total + attributeBufferBytes(attribute.type, capacity), 0);
}

/**
 * WGSL reserved words a field name must dodge. Not the full spec list — the subset a
 * plausible attribute name could actually collide with; the identifier rule below
 * screens the rest of the syntax.
 */
const WGSL_RESERVED = new Set([
  "array", "bool", "break", "case", "const", "continue", "default", "discard", "else",
  "enable", "false", "fn", "for", "if", "let", "loop", "return", "struct", "switch",
  "true", "type", "var", "while", "override", "sampler", "texture", "uniform", "storage",
  "read", "write", "function", "private", "workgroup", "vertex", "fragment", "compute",
]);

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface AttributeValidation {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
}

export function validateAttributes(attributes: ReadonlyArray<PointAttributeSchema>): AttributeValidation {
  const errors: string[] = [];
  const seen = new Set<string>();

  if (attributes.length === 0) errors.push("a point schema needs at least one attribute");

  for (const attribute of attributes) {
    const { name, type } = attribute;
    if (!IDENTIFIER.test(name)) {
      errors.push(`attribute name "${name}" is not a valid WGSL identifier`);
    } else if (WGSL_RESERVED.has(name)) {
      errors.push(`attribute name "${name}" is a WGSL reserved word`);
    }
    if (seen.has(name)) errors.push(`duplicate attribute name "${name}"`);
    seen.add(name);

    if (!POINT_ATTRIBUTE_TYPES.includes(type)) {
      errors.push(`attribute "${name}" has unknown type "${String(type)}"`);
      continue;
    }
    if (attribute.default.length !== COMPONENT_COUNTS[type]) {
      errors.push(
        `attribute "${name}" default has ${attribute.default.length} component(s); "${type}" needs ${COMPONENT_COUNTS[type]}`,
      );
    }
    // §V73: point identity is the id attribute's VALUE, never a slot index — slots move
    // under compaction. An id that is not u32 cannot be that identity.
    if (attribute.semantic === "id" && type !== "u32") {
      errors.push(`attribute "${name}" carries semantic "id" and must be u32, not "${type}"`);
    }
  }

  const ids = attributes.filter((attribute) => attribute.semantic === "id");
  if (ids.length > 1) errors.push("at most one attribute may carry semantic \"id\"");

  return { ok: errors.length === 0, errors };
}

/** The identity attribute, when the schema declares one (§V73). */
export function idAttribute(attributes: ReadonlyArray<PointAttributeSchema>): PointAttributeSchema | undefined {
  return attributes.find((attribute) => attribute.semantic === "id");
}
