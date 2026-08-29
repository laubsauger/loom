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

/**
 * One way a parameter (or one COMPONENT of a compound parameter, §V113) gets its value
 * (T202, §V107).
 *
 * TouchDesigner's four parameter modes, as data. `static` is the plain stored value;
 * `expression` is a source string in OUR grammar (§V71, never Python); `bind` names
 * another value to read — a sibling parameter (`radius`, `color.r`) or a component
 * scope value (`parent.blur`, §V81); `driven` names an external channel (audio, MIDI,
 * LFO — the TD Export analog) and is declared-but-reserved until Phase 2 consumers
 * exist. Every kind carries its own payload so a future kind can carry a richer one
 * without disturbing these (§V69).
 */
export type ParameterBinding =
  | { kind: "static"; value: ParameterValue }
  | { kind: "expression"; source: string }
  | { kind: "bind"; ref: string }
  | { kind: "driven"; channel: string };

export type ParameterMode = ParameterBinding["kind"];

/**
 * The stored envelope for a parameter that uses modes (T202, §V108).
 *
 * `mode` says which binding is IN EFFECT; `bindings` keeps every mode's last payload.
 * That split is the TD corner-square model: switching a parameter from Expression back
 * to Constant must not destroy the expression, or mode-switching becomes unsafe to
 * experiment with. Nothing ever deletes an inactive binding on a mode switch.
 *
 * For a compound parameter (color, vector) the slot is stored PER COMPONENT under
 * `"<key>.<component>"` (`color.r`, `t.x`, §V113) — that is what lets one channel run
 * an expression while its siblings stay constant. A slot at the bare compound key is
 * also legal and supplies the whole tuple.
 */
export interface ParameterSlot {
  mode: ParameterMode;
  /** EVERY mode's last payload, kept. Mode switch is never destructive (§V108). */
  bindings: Partial<Record<ParameterMode, ParameterBinding>>;
}

/**
 * What `GraphNode.parameters` actually holds: a bare value (the common case, meaning
 * static) or a mode envelope. Bare values stay legal forever — the envelope is opt-in
 * per parameter, so existing documents and patches need no migration.
 */
export type StoredParameter = ParameterValue | ParameterSlot;
