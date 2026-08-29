import type { PortType } from "../types/ports.ts";

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
      return source.sample === b.sample && source.channels === b.channels;
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
    case "geometry": {
      const b = target as Extract<PortType, { kind: "geometry" }>;
      return source.topology === b.topology;
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

/** Stable, human-readable label for diagnostics and for port-family lookup. */
export function describePortType(type: PortType): string {
  switch (type.kind) {
    case "texture2d":
      return `texture2d<${type.sample}${type.channels === undefined ? "" : `,${type.channels}`}>`;
    case "buffer":
      return `buffer<${type.element},${type.access}>`;
    case "scalar":
      return `scalar<${type.scalar}>`;
    case "vector":
      return `vec${type.size}<${type.scalar}>`;
    case "matrix":
      return `mat${type.columns}x${type.rows}`;
    case "geometry":
      return `geometry<${type.topology}>`;
    case "material":
      return `material<${type.model}>`;
    default:
      return type.kind;
  }
}
