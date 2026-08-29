/** Authoring metadata for node parameters (doc §8). WGSL reflection cannot infer these. */

interface ParameterBase {
  label: string;
  group?: string;
  description?: string;
  animatable?: boolean;
  /** Compile-time parameters change shader structure and force targeted recompilation (§V5). */
  compileTime?: boolean;
}

export interface NumberParameter extends ParameterBase {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  scale?: "linear" | "log";
  unit?: "px" | "percent" | "degrees" | "radians" | "seconds" | "hz";
  precision?: number;
}

export interface BooleanParameter extends ParameterBase {
  type: "boolean";
  default: boolean;
}

export interface EnumParameter extends ParameterBase {
  type: "enum";
  default: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export interface ColorParameter extends ParameterBase {
  type: "color";
  default: readonly [number, number, number, number];
  /** Data colors bypass color conversion; display colors are decoded to linear (doc §16.2). */
  space: "linear" | "display";
}

export interface VectorParameter extends ParameterBase {
  type: "vector";
  size: 2 | 3 | 4;
  default: readonly number[];
  min?: number;
  max?: number;
  step?: number;
}

export interface StringParameter extends ParameterBase {
  type: "string";
  default: string;
  multiline?: boolean;
}

export interface AssetParameter extends ParameterBase {
  type: "asset";
  kind: "image" | "video" | "audio" | "gltf" | "binary";
}

export interface CurveParameter extends ParameterBase {
  type: "curve";
  default: ReadonlyArray<{ x: number; y: number }>;
}

export type ParameterDefinition =
  | NumberParameter
  | BooleanParameter
  | EnumParameter
  | ColorParameter
  | VectorParameter
  | StringParameter
  | AssetParameter
  | CurveParameter;

export type ParameterSchema = Record<string, ParameterDefinition>;

export type ParameterValue =
  | number
  | boolean
  | string
  | readonly number[]
  | ReadonlyArray<{ x: number; y: number }>
  | null;
