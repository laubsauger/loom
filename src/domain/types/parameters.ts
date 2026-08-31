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

/**
 * §B111/T537 — WHICH ENDS OF `min`/`max` ARE A LIMIT, and which are only a slider.
 *
 * ## The two ideas that were one pair of numbers
 *
 * `min`/`max` were doing two unrelated jobs at once: they described how far the slider
 * travels AND they hard-pinned every resolved value. Conflated, they produced B111 —
 * `transform.r` is declared ±360 because one turn either way is a sensible span to drag
 * through, and an author who binds `abstime * 7` to it gets a rotation that climbs for
 * fifty-one seconds and then sits at 360 forever. Nothing about a rotation says 360 is a
 * maximum. 725° is a perfectly good rotation.
 *
 * TouchDesigner separates them, and this is a port of that model rather than an
 * invention: a TD parameter carries `normMin`/`normMax` (the slider's travel), `min`/`max`
 * (absolute limits) and `clampMin`/`clampMax` — two independent, OPT-IN booleans, off by
 * default, that decide whether those limits actually bite. That is why you can multiply
 * time into a TD rotation and watch it keep going while the slider still shows one turn.
 *
 * We keep ONE pair of numbers — a second pair would need a value for every parameter in
 * the catalogue and would mostly repeat the first — and declare instead WHICH ENDS OF IT
 * CLAMP. `min`/`max` are always the slider's travel; this field says how much more than
 * that is true.
 *
 * ## Why this is declared and cannot be inferred
 *
 * The obvious shortcut is `unit === "degrees"`. It is wrong in the catalogue we already
 * have: `camera.fov` is in degrees and is genuinely bounded — the projection matrix is
 * singular at 0 and at 180, so an FOV of 725 is not a wide shot, it is a broken frame.
 * Meanwhile `noise.r` is a rotation that declares no range at all and is therefore already
 * unbounded, so the catalogue is inconsistent today in a way nobody decided. This is §V458
 * exactly — code-ness had to be a declared KIND because `multiline` was a plausible-looking
 * inference that lied — and §V437's rule that the classification be DERIVED from the
 * registry so parameter N+1 fails the gate until its author decides.
 *
 * ## Why not wrap
 *
 * T368 considered letting cyclic parameters WRAP and rejected it, correctly: a wrap needs
 * a PERIOD and the manifest declares a RANGE, and for ±360 the range is two periods wide,
 * so 370 could honestly become 10 or -350. That argument still holds and this is not a
 * wrap. `cyclic` does not fold 725 into anything — it stores 725, because the trigonometry
 * downstream is already periodic and does not need the help. What T368 never weighed was
 * the third option: neither clamp nor wrap. That is what TD does.
 *
 * ## The members
 *
 *  - `bounded` — BOTH ends clamp. The value is meaningless or destructive outside the
 *    range and something downstream depends on that: an opacity, a probability, a
 *    normalized amount, a buffer length, an FOV. Overshooting still reports the
 *    `parameter.expression.clamped` diagnostic (T368), because on these it is true.
 *  - `cyclic` — NEITHER end clamps, and the quantity is PERIODIC: a rotation, an angle,
 *    a hue, a unit phase. The range is one period of slider travel. Never diagnoses,
 *    because nothing was pinned.
 *  - `floor` — the MINIMUM clamps, the maximum is slider travel. The largest half of the
 *    catalogue: a radius, a blur size, a light intensity, a lag in seconds. Negative is
 *    meaningless or breaks the shader; large is merely unusual. TD's `clampMin` alone.
 *  - `soft` — NEITHER end clamps and the quantity is NOT periodic. A translate, a scale,
 *    a black level. Any finite value is legal; the range is a suggestion about where the
 *    interesting part is, which is the whole reason a slider needs one.
 *
 * There is deliberately no `ceiling` (max clamps, min does not). No parameter in the
 * catalogue wants one today, and a member with no members is a guess. The gate below
 * enumerates from the registry, so the first parameter that needs one will arrive with an
 * author who has to add it here.
 *
 * DEFAULT: absent means `bounded`, which is what every parameter did before this existed,
 * so nothing changes by omission. `parameter-range-census.test.ts` then forbids omission
 * anywhere a `min` or `max` is declared, so the default is unreachable in the catalogue
 * and stays only as the honest answer for the ad-hoc `NumericSpec`s the UI builds.
 */
export type NumericRangeKind = "bounded" | "cyclic" | "floor" | "soft";

export interface NumberParameter extends ParameterBase {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  /** Which ends of `min`/`max` are a LIMIT rather than slider travel (§B111). */
  range?: NumericRangeKind;
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
  /** Which ends of `min`/`max` are a LIMIT rather than slider travel (§B111). */
  range?: NumericRangeKind;
  step?: number;
}

export interface StringParameter extends ParameterBase {
  type: "string";
  default: string;
  multiline?: boolean;
}

/**
 * T492: a parameter whose VALUE IS CODE — a WGSL kernel, a JSON attribute schema.
 *
 * A KIND, never an inference (§V437): "any other parameter that is this kind of stuff"
 * is a property, and we have shipped properties as site lists four times. Declaring
 * code-ness here is what lets every editing surface — the inspector control, the code
 * pane, enlarge and pop-out — follow from the manifest by construction, so parameter
 * N+1 gets the real editor without touching a UI file. `language` picks the
 * highlighting per kind; WGSL and JSON are different languages and one global mode
 * would mis-colour both. `media.text` stays a multiline STRING on purpose: prose is
 * not code, and the counter-example is what proves the kind must be declared rather
 * than inferred from `multiline`.
 */
export interface CodeParameter extends ParameterBase {
  type: "code";
  language: "wgsl" | "json";
  default: string;
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

/** One entry of a `stops` parameter: where it sits, and what colour it is (T270). */
export interface ColorStop {
  /** Position along the gradient, 0..1. */
  position: number;
  color: readonly [number, number, number, number];
}

/**
 * A list of positioned colours (T270, §V195, §V196). Ramp's key list, TD-style.
 *
 * Two colours is the DEGENERATE CASE of this, and every gradient anyone actually wants
 * needs more than two, so the list is the parameter — not something assembled out of
 * two-colour ramps and a Lookup.
 *
 * §V195 — this is a CONTAINER parameter and it is STATIC AS A WHOLE. An expression
 * returns a number and there is no meaning to a list-valued one; the moded things are its
 * LEAVES (`stops[2].position`), once the key grammar carries an index. `curve` already
 * lives under this rule, and writing it down here is what stops `stops` inventing a
 * second answer. Nothing in this change invents an indexed key grammar.
 *
 * §V196 — it declares `space` exactly as `color` does, and the resolver decodes PER
 * ENTRY. Decoding at the container level, or not at all, reproduces B8 — the inspector
 * shows one colour and the GPU renders another — and a list makes that N times harder to
 * notice, because the eye checks one swatch and assumes the rest.
 */
export interface StopsParameter extends ParameterBase {
  type: "stops";
  default: readonly ColorStop[];
  /** Data stops bypass colour conversion; display stops are decoded to linear per entry. */
  space: "linear" | "display";
  /**
   * How many stops the consumer can carry. The compiler packs a capped uniform table and
   * REPORTS the ones beyond it rather than dropping them quietly.
   */
  maxStops?: number;
}

export type ParameterDefinition =
  | NumberParameter
  | BooleanParameter
  | EnumParameter
  | ColorParameter
  | VectorParameter
  | StringParameter
  | CodeParameter
  | AssetParameter
  | CurveParameter
  | PulseParameter
  | StopsParameter;

/**
 * §V195: a CONTAINER parameter is static as a whole — its modes live on its leaves, so
 * the mode panel is not offered for it. One predicate, so `curve` and `stops` cannot
 * drift into two answers about the same rule.
 */
export function isContainerParameter(definition: ParameterDefinition): boolean {
  return definition.type === "curve" || definition.type === "stops";
}

export type ParameterSchema = Record<string, ParameterDefinition>;

export type ParameterValue =
  | number
  | boolean
  | string
  | readonly number[]
  | ReadonlyArray<{ x: number; y: number }>
  | readonly ColorStop[]
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
  | { kind: "driven"; channel: string }
  /**
   * T286 (§V195 as amended): a PER-POINT attribute supplies the value — the POP Map
   * page. Unlike its four siblings this has no CPU value at all: it changes what the
   * CONSUMER compiles (the shader reads `attribute[index]` instead of a uniform), so
   * the resolver hands evaluation the retained static (§V108) and reports the mapping
   * as DATA beside it. Because a map returns a TYPED per-point value rather than a
   * number, it may address a compound HEAD under type-match (vec4f attribute → color)
   * — the leaf-only rule stays for the scalar-returning kinds, whose rationale it is.
   * `channel` picks one component of a vector attribute for a scalar leaf; `port`
   * names the pointset input when a node declares more than one (§V306: optional
   * here, REQUIRED by validation the moment it is ambiguous).
   */
  // `| undefined` on both: the zod boundary's `.optional()` writes exactly that under
  // exactOptionalPropertyTypes, every builder spread-omits the absent case, and every
  // reader treats absent and undefined identically (T487).
  | { kind: "map"; attribute: string; channel?: string | undefined; port?: string | undefined };

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
