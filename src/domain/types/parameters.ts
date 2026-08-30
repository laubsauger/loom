/** Authoring metadata for node parameters (doc §8). WGSL reflection cannot infer these. */

interface ParameterBase {
  label: string;
  group?: string;
  description?: string;
  animatable?: boolean;
  /** Compile-time parameters change shader structure and force targeted recompilation (§V5). */
  compileTime?: boolean;
  /**
   * §V146 — when this parameter CANNOT affect the output, and why (T245, B14).
   *
   * Returns the reason as a sentence, or `null` when the parameter applies. It is a
   * function over the node's OWN effective parameter values, declared here beside the
   * parameter it describes, because the node is the only thing that knows: Noise's
   * `Time Speed` moves the fourth noise dimension, and a 2D type has no fourth
   * dimension, so the shader discards it. The user sets it, presses play, sees a still
   * frame, and goes looking for the fault in their own understanding — which is why a
   * live control that does nothing is worse than one that is not there.
   *
   * It is a PREDICATE, not a table in the inspector: most nodes with a mode enum have
   * parameters that only apply in some modes, and a lookup keyed by node type would have
   * to be edited every time the catalogue grows.
   *
   * Inactive is NOT disabled. The value stays editable — TD lets you type into a greyed
   * parameter, because setting it BEFORE switching the mode that makes it apply is a
   * normal way to work, and read-only would take that away.
   */
  inactiveWhen?: (values: Readonly<Record<string, ParameterValue>>) => string | null;
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

/**
 * A momentary trigger (T214, §V123, §V124, §V125). TouchDesigner's Pulse.
 *
 * It is a parameter TYPE rather than a per-node feature, so the mechanism is written
 * once and any node can declare one — Feedback's Reset, Noise's Reseed, a Timer's Start.
 *
 * ## Why it cannot just be a boolean (§V124)
 *
 * A pulse mutates RUNTIME state, not document state. Three consequences follow, and the
 * middle one is the reason a `boolean` would be wrong:
 *
 *  - it is AUDITED (§V31), like every other command;
 *  - it is NOT UNDOABLE — undo restores a document, and a cleared feedback buffer is not
 *    in the document. A disabled undo that silently does nothing is worse than saying so;
 *  - it is NOT SERIALIZED "on". A pulse saved as fired would re-fire on load and wipe
 *    your work every time you opened the project.
 *
 * The last one is enforced structurally rather than by convention: the only value a
 * pulse accepts is `false`, so a document physically cannot carry an armed one, and a
 * file that does gets a diagnostic instead of a silent reset. `defaultParameters` omits
 * pulses entirely, so a freshly created node stores nothing for them at all.
 *
 * ## Firing (§V125)
 *
 * A pulse names the bus COMMAND it fires. A name, never a handler: a node definition
 * stays headless (§V11) and serializable, the same command is reachable from the menu,
 * the keymap, the palette and an agent (§V29, §V78), and nothing in the catalogue has to
 * know what a GPU is. `"$node"` anywhere in `input` — as a value, or as an element of an
 * array value — is replaced by the id of the node whose pulse fired.
 *
 * A pulse takes every parameter mode like everything else (§V107): an EXPRESSION that
 * becomes non-zero fires it, which is how an automated reset happens — on a beat, on a
 * threshold, on a frame count. A trigger you can only click is not a trigger, it is a
 * button.
 */
export interface PulseParameter extends ParameterBase {
  type: "pulse";
  /** Bus command name this pulse fires. */
  fires: string;
  /** Static input for that command; `"$node"` is substituted with the firing node id. */
  input?: Readonly<Record<string, unknown>>;
}

export type ParameterDefinition =
  | NumberParameter
  | BooleanParameter
  | EnumParameter
  | ColorParameter
  | VectorParameter
  | StringParameter
  | AssetParameter
  | CurveParameter
  | PulseParameter;

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
