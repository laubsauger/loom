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
      if (source.sample !== b.sample || source.channels !== b.channels) return false;
      /*
       * §V57c (T768) — an INPUT declared `data` accepts ANY source space, because
       * reading bytes as data is not a conversion: a Mask's mask input takes any
       * channel as coverage, a Displace reads any field as offsets. §V13's refusal is
       * about implicit CONVERSION, and a data input converts nothing. The compiler's
       * space propagation has carried exactly this rule since T83/B5; this clause is
       * the connect gate agreeing with it rather than a loosening.
       *
       * The refusal that STAYS is the asymmetric one, and it is the actual protection:
       * a `data` OUTPUT into a colour input still refuses below, because the consumer
       * would display-decode a depth map (T722's retreat, correctly refused).
       */
      if (declaredColorSpace(b) === "data") return true;
      // Absence normalises to "linear" (the project working space), so an unannotated
      // port and an explicitly-linear one are the SAME declaration. `channels` above is
      // deliberately not treated this way — see the note on PortType.
      return colorSpaceOf(source) === colorSpaceOf(b);
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
      // ABSENCE IS NOT A CLAIM, the same rule colour space follows below. A consumer that
      // states no topology accepts any — `renderPoints` does not care whether its input
      // came from a scatter or a grid. Strict inequality made `undefined` a VALUE, so the
      // first producer honest enough to declare `topology: "points"` would have failed to
      // connect to every consumer that had simply never mentioned topology. Nothing
      // declares it today, so both sides are `undefined`, they compare equal, and the bug
      // is invisible until the moment someone does the right thing.
      if (b.topology !== undefined && source.topology !== b.topology) return false;
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
    case "projector":
    case "transform3d":
    case "event":
    case "audioFeatures":
    case "value":
      // A value wire carries a channel bag; which channels is runtime data (T273), so
      // kind equality is the whole static claim — and a value output can never reach a
      // texture input, which is the split doing its real work.
      //
      // The comment sits INSIDE the shared body rather than between the labels: a case
      // containing only a comment reads as a fallthrough to `no-fallthrough`, so the
      // explanation has to live where the statements are.
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
