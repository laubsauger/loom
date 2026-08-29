import type { ColorSpace, PortType } from "../types/ports.ts";

/**
 * Port compatibility (§V13, T11).
 *
 * Connection requires an EXACT `PortType` match. There is no implicit conversion of
 * colour space, texture format, scalar type, vector size or resolution — every
 * conversion is a visible node in the graph, so what the user sees is what runs.
 *
 * Optional discriminant fields (`texture2d.channels`) compare exactly too: an
 * unspecified channel count is a distinct declaration from `channels: 4`, and
 * silently equating them would be exactly the implicit coercion §V13 forbids.
 */
export function arePortsCompatible(source: PortType, target: PortType): boolean {
  if (source.kind !== target.kind) return false;

  switch (source.kind) {
    case "texture2d": {
      const b = target as Extract<PortType, { kind: "texture2d" }>;
      // Absence normalises to "linear" (the project working space), so an unannotated
      // port and an explicitly-linear one are the SAME declaration. `channels` above is
      // deliberately not treated this way — see the note on PortType.
      return (
        source.sample === b.sample &&
        source.channels === b.channels &&
        colorSpaceOf(source) === colorSpaceOf(b)
      );
    }
    case "buffer": {
      const b = target as Extract<PortType, { kind: "buffer" }>;
      return source.element === b.element && source.access === b.access;
    }
    case "scalar": {
      const b = target as Extract<PortType, { kind: "scalar" }>;
      return source.scalar === b.scalar;
    }
    case "vector": {
      const b = target as Extract<PortType, { kind: "vector" }>;
      return source.scalar === b.scalar && source.size === b.size;
    }
    case "matrix": {
      const b = target as Extract<PortType, { kind: "matrix" }>;
      return source.columns === b.columns && source.rows === b.rows;
    }
    case "pointset": {
      const b = target as Extract<PortType, { kind: "pointset" }>;
      // Attribute-requirement compatibility, in the spirit of V13: the CONSUMER states
      // what it needs and the producer must satisfy every entry by name AND type. A
      // producer carrying extra attributes is fine — that is a superset, not a mismatch,
      // and refusing it would make every operator declare the whole schema. A missing or
      // mistyped attribute is refused outright rather than silently defaulted, because a
      // zero-filled "vel" that should have existed is a bug you debug in the render.
      if (source.topology !== b.topology) return false;
      const available = new Map(source.requires.map((attribute) => [attribute.name, attribute.type]));
      return b.requires.every((needed) => available.get(needed.name) === needed.type);
    }
    case "material": {
      const b = target as Extract<PortType, { kind: "material" }>;
      return source.model === b.model;
    }
    case "scene":
    case "camera":
    case "light":
    case "transform3d":
    case "event":
    case "audioFeatures":
      return true;
    default: {
      // Exhaustiveness guard: a new PortType member must be handled explicitly rather
      // than defaulting to "compatible".
      const never: never = source;
      void never;
      return false;
    }
  }
}

/**
 * The space a texture port EXPLICITLY declares, or undefined when it declares none.
 *
 * Use this where absence means "no claim, derive it" — colour-space propagation, where a
 * node's output space is computed from its inputs unless the port pins it.
 */
export function declaredColorSpace(
  type: Extract<PortType, { kind: "texture2d" }>,
): ColorSpace | undefined {
  return type.space;
}

/**
 * The space a texture port EFFECTIVELY carries; absent resolves to the project working
 * space (§V56).
 *
 * Use this for compatibility comparison (§V13), where absence means the ordinary claim —
 * an unannotated port and an explicitly-linear one are the same declaration.
 *
 * The two accessors exist because the same absent field answers two different questions:
 * "what does this port accept?" (linear) and "what does this output carry?" (unknown yet).
 * Reading the field raw at one site and through an accessor at the other hid that.
 */
export function colorSpaceOf(type: Extract<PortType, { kind: "texture2d" }>): ColorSpace {
  return declaredColorSpace(type) ?? "linear";
}

/** Stable, human-readable label for diagnostics and for port-family lookup. */
export function describePortType(type: PortType): string {
  switch (type.kind) {
    case "texture2d":
      return `texture2d<${type.sample}${type.channels === undefined ? "" : `,${type.channels}`},${colorSpaceOf(type)}>`;
    case "buffer":
      return `buffer<${type.element},${type.access}>`;
    case "scalar":
      return `scalar<${type.scalar}>`;
    case "vector":
      return `vec${type.size}<${type.scalar}>`;
    case "matrix":
      return `mat${type.columns}x${type.rows}`;
    case "pointset": {
      const attributes = type.requires.map((a) => `${a.name}:${a.type}`).join(",");
      return `pointset<${type.topology ?? "points"}${attributes === "" ? "" : ` ${attributes}`}>`;
    }
    case "material":
      return `material<${type.model}>`;
    default:
      return type.kind;
  }
}
