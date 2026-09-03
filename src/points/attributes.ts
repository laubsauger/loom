/**
 * Point attribute schemas and their GPU layout (T117, §V72).
 *
 * Storage is structure-of-arrays: every attribute is a contiguous `stride × capacity` run,
 * never an interleaved struct. That kills WGSL struct-layout pain at the source and means
 * adding an attribute never relayouts the others.
 *
 * ⚑ T1076 moved WHERE those runs live. They used to be one storage buffer each, which cost
 * a kernel 2n bindings against WebGPU's baseline of 8 per stage — four attributes, and the
 * fifth failed the pipeline in silence (B33, §V588). They are now REGIONS of one buffer per
 * producer per half: the same bytes in the same order, addressed by offset instead of by
 * binding. `src/points/packing.ts` owns that layout; this file owns the strides it is built
 * from, and both are still what a consumer binds against.
 *
 * The one layout trap worth spelling out: `array<vec3f>` has an element STRIDE of 16
 * bytes (vec3 aligns to 16 in WGSL), so a vec3 attribute costs as much as a vec4. The
 * stride table below is the single source of truth; capacity × stride is the REGION
 * size everywhere.
 */

export const POINT_ATTRIBUTE_TYPES = ["f32", "vec2f", "vec3f", "vec4f", "u32", "vec4u"] as const;

export type PointAttributeType = (typeof POINT_ATTRIBUTE_TYPES)[number];

/** Well-known roles renderers and viewers pick up without magic strings (§V72). */
export const POINT_SEMANTICS = ["position", "color", "size", "id", "life"] as const;

export type PointSemantic = (typeof POINT_SEMANTICS)[number];

/**
 * T287 (§V75): how a TRANSFORM must treat an attribute — Houdini's qualifier model,
 * declared in the schema rather than encoded in magic names ("an attribute named `Cd`
 * is a colour" is index-as-identity all over again).
 *
 *   - `color`: values are a colour; a spatial transform leaves them alone, a
 *     colour-space operation converts them.
 *   - `direction`: a vector IN SPACE with no position — rotates with the points,
 *     never translates (a normal, a velocity treated as a heading).
 *   - `quaternion`: an orientation; composing a rotation MULTIPLIES rather than
 *     rotating componentwise.
 *
 * v1 is the DECLARATION plus its type constraints, made now while the union is cheap
 * to grow. Transform nodes that honour it arrive with the transform family; a
 * consumer that ignores a qualifier today is merely incomplete, but a schema that
 * cannot say it would force the magic-name convention this exists to prevent.
 */
export const ATTRIBUTE_QUALIFIERS = ["color", "direction", "quaternion"] as const;

export type AttributeQualifier = (typeof ATTRIBUTE_QUALIFIERS)[number];

/** The types a qualifier is coherent on: rotating an f32 "direction" means nothing. */
export const QUALIFIER_TYPES: Readonly<Record<AttributeQualifier, ReadonlyArray<PointAttributeType>>> = {
  color: ["vec3f", "vec4f"],
  direction: ["vec3f"],
  quaternion: ["vec4f"],
};

export interface PointAttributeSchema {
  /** WGSL-safe identifier; becomes the `Point` struct field and the buffer names. */
  readonly name: string;
  readonly type: PointAttributeType;
  readonly semantic?: PointSemantic;
  /** T287: transform treatment. Absent = plain data, transformed by nothing. */
  readonly qualifier?: AttributeQualifier;
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

/**
 * Coarse memory estimate for a whole point system (§V24 reporting) — the sum of the
 * regions, EXCLUDING the inter-region alignment padding a packed buffer carries. What is
 * actually allocated is `packAttributes(attributes, capacity).bytes`, per half; this is
 * the payload inside it, which is what a "how much data is this" question wants.
 */
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
    // T287: a qualifier promises transform behaviour, which only certain types can honour.
    if (attribute.qualifier !== undefined) {
      if (!ATTRIBUTE_QUALIFIERS.includes(attribute.qualifier)) {
        errors.push(`attribute "${name}" has unknown qualifier "${String(attribute.qualifier)}"`);
      } else if (!QUALIFIER_TYPES[attribute.qualifier].includes(type)) {
        errors.push(
          `attribute "${name}" is qualified "${attribute.qualifier}", which needs ${QUALIFIER_TYPES[
            attribute.qualifier
          ].join(" or ")}, not "${type}"`,
        );
      }
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
