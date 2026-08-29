import type { PortId } from "./ids.ts";

/**
 * Port families. `geometry`/`scene`/`material`/`camera`/`light`/`transform3d`/`event`/
 * `audioFeatures` are declared now but not implemented in v1 (§C scope).
 */
export type PortType =
  | { kind: "texture2d"; sample: "float" | "unfilterable-float" | "depth"; channels?: 1 | 2 | 4 }
  | { kind: "buffer"; element: string; access: "read" | "write" | "read-write" }
  | { kind: "scalar"; scalar: "f32" | "i32" | "u32" | "bool" }
  | { kind: "vector"; scalar: "f32" | "i32" | "u32"; size: 2 | 3 | 4 }
  | { kind: "matrix"; columns: 3 | 4; rows: 3 | 4 }
  | { kind: "geometry"; topology: "triangle-list" | "triangle-strip" | "line-list" | "point-list" }
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
