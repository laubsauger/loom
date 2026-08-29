import type { PortId } from "./ids.ts";

/**
 * One data model for meshes and particles: a mesh is points plus topology, particles are
 * points without it. There is no SOP/POP split — an operator that moves points does not
 * care which it is looking at.
 *
 * Attributes are arbitrary and named from day one; the WGSL `Point` struct is generated
 * from the schema (§V76) rather than hand-written, and storage is one buffer per
 * attribute (§V75) so an operator binds only what it touches.
 */
/** Working space of a texture's values. Linear is the project working space (§V56). */
export type ColorSpace = "linear" | "encoded" | "data";

export type PointAttributeType =
  | "f32"
  | "vec2f"
  | "vec3f"
  | "vec4f"
  | "i32"
  | "u32"
  | "mat3x3f"
  | "mat4x4f";

export interface PointAttributeSpec {
  /** Arbitrary name: "P", "vel", "age", "Cd". Identity is the name, not a slot. */
  name: string;
  type: PointAttributeType;
}

/** Absent topology = a particle system: points with no connectivity. */
export type PointTopology = "points" | "lines" | "triangles";

/**
 * Port families. `geometry`/`scene`/`material`/`camera`/`light`/`transform3d`/`event`/
 * `audioFeatures` are declared now but not implemented in v1 (§C scope).
 */
export type PortType =
  | {
      kind: "texture2d";
      sample: "float" | "unfilterable-float" | "depth";
      channels?: 1 | 2 | 4;
      /**
       * Colour space this texture carries (§V56, §V57).
       *
       * Absent means `"linear"`, because linear IS the project working space — so an
       * unannotated port is making the ordinary claim, not an unknown one. This is
       * deliberately UNLIKE `channels`, where absence is a distinct declaration rather
       * than a default: a 1-channel and a 4-channel texture are genuinely different
       * things, whereas every texture has a colour space whether or not anyone said so.
       *
       * `data` marks a texture whose values are not colour at all — a displacement field,
       * a mask, an SDF — and must bypass every colour conversion. A gamma curve applied
       * to a displacement field silently moves geometry, which is why this is a port-level
       * fact and not something inferred from the pixel format.
       */
      space?: ColorSpace;
    }
  | { kind: "buffer"; element: string; access: "read" | "write" | "read-write" }
  | { kind: "scalar"; scalar: "f32" | "i32" | "u32" | "bool" }
  | { kind: "vector"; scalar: "f32" | "i32" | "u32"; size: 2 | 3 | 4 }
  | { kind: "matrix"; columns: 3 | 4; rows: 3 | 4 }
  | { kind: "pointset"; requires: ReadonlyArray<PointAttributeSpec>; topology?: PointTopology }
  | { kind: "scene" }
  | { kind: "material"; model: "unlit" | "pbr" | "custom" }
  | { kind: "camera" }
  | { kind: "light" }
  | { kind: "transform3d" }
  | { kind: "event" }
  | { kind: "audioFeatures" };

export type PortKind = PortType["kind"];

export interface PortDefinition {
  id: PortId;
  label: string;
  type: PortType;
  /** Only variadic input ports accept more than one incoming edge (§V14). */
  variadic?: boolean;
  optional?: boolean;
  description?: string;
}
