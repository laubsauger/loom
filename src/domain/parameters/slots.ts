import type {
  NumberParameter,
  ParameterBinding,
  ParameterDefinition,
  ParameterMode,
  ParameterSchema,
  ParameterSlot,
  ParameterValue,
  StoredParameter,
} from "../types/parameters.ts";

/**
 * The stored-parameter envelope and compound-component addressing (T202, T207, §V107,
 * §V108, §V113).
 *
 * Storage speaks two shapes: a bare `ParameterValue` (static, the common case, and the
 * only shape older documents contain) and a `ParameterSlot` carrying a mode plus every
 * mode's retained payload. Everything that needs to tell them apart does it through
 * `isParameterSlot`, so the discrimination rule lives in exactly one place: a slot is a
 * plain object, and a `ParameterValue` never is (numbers, booleans, strings, arrays,
 * null — no objects).
 *
 * Compound addressing (§V113): the MANIFEST keeps one declaration (`color`, `t`) but a
 * slot may be stored per component under `"<key>.<component>"` (`color.r`, `t.x`) so
 * each channel carries its own mode — one channel driven by an expression while its
 * siblings stay constant, which is the TD model and the whole point. The resolver
 * reassembles components into the compound value evaluation wants; component keys are a
 * STORAGE and BINDING concern and never appear in `ResolvedParameters.values`.
 */

/**
 * Every mode, pinned to the union in BOTH directions (§V316, B45): the Record forces a
 * key per `ParameterMode`, so adding a sixth binding kind breaks this line at compile
 * time instead of leaving every list derived from it — the mode panel, the parameter
 * menu, `isParameterSlot` — silently one short, which is exactly how `map` went missing
 * from the menu. Key order is the display order.
 */
const MODE_ENUMERATION: Readonly<Record<ParameterMode, true>> = {
  static: true,
  expression: true,
  bind: true,
  driven: true,
  map: true,
};

export const PARAMETER_MODES = Object.keys(MODE_ENUMERATION) as readonly ParameterMode[];

/**
 * §T897: the modes a user can SET. `driven` is retired — a channel read is an expression
 * term (`op('name').chan.low`) — but it stays in `ParameterMode` and the schema forever,
 * because documents in the wild hold it and the load-time upgrade needs to parse it.
 * Authoring surfaces (the mode buttons, `parameter.setMode`) offer only these.
 */
export const AUTHORABLE_PARAMETER_MODES: readonly ParameterMode[] = PARAMETER_MODES.filter(
  (mode) => mode !== "driven",
);

const MODE_SET: ReadonlySet<string> = new Set(PARAMETER_MODES);

export function isParameterSlot(value: unknown): value is ParameterSlot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { mode?: unknown; bindings?: unknown };
  return (
    typeof candidate.mode === "string" &&
    MODE_SET.has(candidate.mode) &&
    typeof candidate.bindings === "object" &&
    candidate.bindings !== null &&
    !Array.isArray(candidate.bindings)
  );
}

/** The slot's retained static value, if it has one. */
export function staticBindingValue(slot: ParameterSlot): ParameterValue | undefined {
  const binding = slot.bindings.static;
  return binding?.kind === "static" ? binding.value : undefined;
}

/**
 * The document-static view of a stored parameter: the bare value, or a slot's retained
 * static payload. What an edit writes back to, and what a caller that must not evaluate
 * (serialization diffing, "is this the default" checks) reads.
 */
export function storedStaticValue(stored: StoredParameter | undefined): ParameterValue | undefined {
  if (stored === undefined) return undefined;
  if (isParameterSlot(stored)) return staticBindingValue(stored);
  return stored;
}

/** Wraps a bare value as the slot it means: static mode, static binding, nothing else. */
export function slotFromValue(value: ParameterValue): ParameterSlot {
  return { mode: "static", bindings: { static: { kind: "static", value } } };
}

const VECTOR_COMPONENTS = ["x", "y", "z", "w"] as const;
const COLOR_COMPONENTS = ["r", "g", "b", "a"] as const;

/**
 * The component names of a compound parameter, or null for a scalar one (§V113).
 * `color` → r g b a; `vector` → x y z (w at size 4). Names, not indices, because they
 * are what the user types into a bind ref and what the UI labels the rows with.
 */
export function componentNamesFor(definition: ParameterDefinition): readonly string[] | null {
  switch (definition.type) {
    case "color":
      return COLOR_COMPONENTS;
    case "vector":
      return VECTOR_COMPONENTS.slice(0, definition.size);
    default:
      return null;
  }
}

export function componentKey(base: string, component: string): string {
  return `${base}.${component}`;
}

/** `"color.r"` → `{ base: "color", component: "r" }`; null when the key has no dot. */
export function parseComponentKey(key: string): { base: string; component: string } | null {
  const dot = key.lastIndexOf(".");
  if (dot <= 0 || dot === key.length - 1) return null;
  return { base: key.slice(0, dot), component: key.slice(dot + 1) };
}

/**
 * True when `key` addresses a component of a compound parameter the schema declares —
 * the test that keeps `color.r` from tripping "carries a parameter this type does not
 * declare" while still catching `color.q` and `blur.r`.
 */
export function isComponentKeyOf(schema: ParameterSchema, key: string): boolean {
  const parsed = parseComponentKey(key);
  if (parsed === null) return false;
  const definition = schema[parsed.base];
  if (definition === undefined) return false;
  const names = componentNamesFor(definition);
  return names !== null && names.includes(parsed.component);
}

/**
 * The scalar definition one component of a compound resolves against. Derived, never
 * declared: the manifest keeps ONE declaration (§V113) and the swatch grouping with it.
 * A vector component inherits the compound's min/max/step; a colour component is a bare
 * finite number — deliberately unclamped, because HDR colours are real.
 */
export function componentDefinition(
  definition: ParameterDefinition,
  component: string,
  index: number,
): NumberParameter {
  const label = `${definition.label}.${component}`;
  if (definition.type === "vector") {
    return {
      type: "number",
      label,
      default: definition.default[index] ?? 0,
      ...(definition.min === undefined ? {} : { min: definition.min }),
      ...(definition.max === undefined ? {} : { max: definition.max }),
      // §B111: a component inherits WHICH ENDS CLAMP along with the numbers. Dropping it
      // here would clamp `rotate.y` on an instancer while `rotate` itself kept going.
      ...(definition.range === undefined ? {} : { range: definition.range }),
      ...(definition.step === undefined ? {} : { step: definition.step }),
    };
  }
  if (definition.type === "color") {
    return { type: "number", label, default: definition.default[index] ?? 0 };
  }
  // Callers only reach here for compound definitions; a scalar has no components.
  throw new Error(`Parameter "${definition.label}" has no components.`);
}

/**
 * T1008 — the definition a COMPONENT-ADDRESSED key resolves against, or undefined when
 * the key is not one. §V113 declares compound parameters component-addressable and the
 * STORE honours it (`color.r` carries its own slot and mode) — but both doors into the
 * store looked keys up as `schema[key]`, which holds only base keys, so the command
 * path refused `parameter.copy`/`paste`/`setMode` on `color.r` with `parameter.unknown`
 * and the publish path could not target `repeat.y` at all. ONE resolution here, used by
 * both, so "what can address a component" cannot answer differently per door.
 */
export function componentAddressedDefinition(
  schema: ParameterSchema,
  key: string,
): NumberParameter | undefined {
  const parsed = parseComponentKey(key);
  if (parsed === null) return undefined;
  // A literal dotted key the schema declares outright wins; this is only the fallback.
  if (schema[key] !== undefined) return undefined;
  const base = schema[parsed.base];
  if (base === undefined) return undefined;
  const names = componentNamesFor(base);
  if (names === null) return undefined;
  const index = names.indexOf(parsed.component);
  if (index < 0) return undefined;
  return componentDefinition(base, parsed.component, index);
}

/* ------------------------------------------------------------------------------------
 * The WRITE half: building the next slot (T204, T246, §V107, §V108)
 *
 * These lived in `src/ui/controls/parameter-slot.ts` while the mode buttons were their
 * only caller. The parameter context menu switches modes too (T246), and a menu item is
 * a bus COMMAND (§V78) — which runs in the domain, where `src/ui` is unreachable. Two
 * copies of "what does switching to Expression do" is exactly the drift §V109 forbids,
 * so the rule moved down to the layer that owns the slot model and the UI re-exports it.
 *
 * The rule itself, in one line: **a mode switch is never destructive** (§V108). Every
 * function here returns a slot whose `bindings` is a superset of the one it was given.
 * That is not a nicety — it is what the corner mark on an inactive button promises, and
 * the reason flipping to Constant to read a number is safe with an expression half
 * written.
 * ---------------------------------------------------------------------------------- */

/** Reads a binding's payload as the string its editor edits. Static has no string form. */
export function payloadText(binding: ParameterBinding | undefined): string {
  if (binding === undefined) return "";
  switch (binding.kind) {
    case "expression":
      return binding.source;
    case "bind":
      return binding.ref;
    case "driven":
      return binding.channel;
    case "map":
      // The text form an editor edits: "size", "velocity:x", "points2/velocity:x".
      return `${binding.port === undefined ? "" : `${binding.port}/`}${binding.attribute}${
        binding.channel === undefined ? "" : `:${binding.channel}`
      }`;
    case "static":
      return "";
  }
}

/**
 * A `ParameterValue` as the number an expression would produce for it (§V107's coercion,
 * read backwards). Seeds a fresh expression with the value the user is looking at, so
 * switching to Expression starts where Constant left off instead of at zero.
 */
export function numericLiteralFor(value: ParameterValue): string {
  const scalar = ((): number => {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      return typeof first === "number" && Number.isFinite(first) ? first : 0;
    }
    return 0;
  })();
  return String(Number.isFinite(scalar) ? scalar : 0);
}

/**
 * The payload a mode gets when it is activated for the first time.
 *
 * It has to be one the WRITE validator accepts, or the button is inert: an empty
 * expression does not parse and an empty bind ref is refused, so seeding those would
 * make the patch bounce and the mode switch would silently do nothing. Expression seeds
 * a literal of the current value; `bind` and `driven` have no meaningful empty form at
 * all, so they seed nothing and the panel holds the choice until a payload is typed.
 */
export function seedBinding(mode: ParameterMode, value: ParameterValue): ParameterBinding | null {
  switch (mode) {
    case "static":
      return { kind: "static", value };
    case "expression":
      return { kind: "expression", source: numericLiteralFor(value) };
    case "bind":
    case "driven":
    case "map":
      return null;
  }
}

/** Builds a binding of `mode` carrying `text` — the inverse of `payloadText`. */
export function bindingFromText(
  mode: ParameterMode,
  text: string,
  value: ParameterValue,
): ParameterBinding {
  switch (mode) {
    case "static":
      return { kind: "static", value };
    case "expression":
      return { kind: "expression", source: text };
    case "bind":
      return { kind: "bind", ref: text };
    case "driven":
      return { kind: "driven", channel: text };
    case "map": {
      // Inverse of payloadText: optional "port/" prefix, optional ":channel" suffix.
      const [head, channel] = text.split(":");
      const slash = (head ?? "").indexOf("/");
      const port = slash > 0 ? (head as string).slice(0, slash) : undefined;
      const attribute = slash > 0 ? (head as string).slice(slash + 1) : (head ?? "");
      return {
        kind: "map",
        attribute,
        ...(channel === undefined || channel === "" ? {} : { channel }),
        ...(port === undefined ? {} : { port }),
      };
    }
  }
}

/**
 * Switches the active mode, KEEPING every other mode's payload (§V108).
 *
 * The mode being left keeps what it held; the mode being entered keeps what it held
 * last time, or is seeded empty. `value` is the parameter's effective value and is used
 * only to seed a missing static payload, so that switching to Constant on a parameter
 * that has only ever been an expression lands on the number the user was just looking
 * at rather than on the manifest default.
 */
export function withMode(
  slot: ParameterSlot,
  mode: ParameterMode,
  value: ParameterValue,
): ParameterSlot | null {
  const existing = slot.bindings[mode];
  const retained = existing !== undefined && existing.kind === mode ? existing : null;
  const binding = retained ?? seedBinding(mode, value);
  // Null = this mode has no payload yet and no sensible empty one. The caller keeps the
  // choice in the UI and writes once the user has authored something.
  if (binding === null) return null;
  return { mode, bindings: { ...slot.bindings, [mode]: binding } };
}

/**
 * Replaces one mode's payload without changing which mode is active.
 *
 * Editing the expression while the parameter sits in Constant is a real thing to do —
 * it is half of why the retained payload exists — so writing a payload must not flip
 * the mode behind the user's back.
 */
export function withBinding(slot: ParameterSlot, binding: ParameterBinding): ParameterSlot {
  return { mode: slot.mode, bindings: { ...slot.bindings, [binding.kind]: binding } };
}

/** The static payload a slot should carry once the control below it writes `value`. */
export function withStaticValue(slot: ParameterSlot, value: ParameterValue): ParameterSlot {
  return withBinding(slot, { kind: "static", value });
}

/**
 * §V108's corner mark, as a predicate: does this INACTIVE mode hold something?
 *
 * Active modes never mark — the button is already lit — and an empty payload does not
 * count. A mark on "Expression" that means "there is an empty string in there" would
 * teach the user the mark means nothing.
 */
export function holdsRetainedValue(slot: ParameterSlot, mode: ParameterMode): boolean {
  if (slot.mode === mode) return false;
  const binding = slot.bindings[mode];
  if (binding === undefined || binding.kind !== mode) return false;
  if (binding.kind === "static") return true;
  return payloadText(binding).trim() !== "";
}


/**
 * §T897 — `driven` mode is retired (owner's ruling; TD's model). A channel read is an
 * EXPRESSION term now: `op('name').chan.value` (a node's bare/single channel) or
 * `op('name').chan.low` (a named one), resolving through the SAME channels resolver the
 * driven mode used, so the migration is value-identical by construction. This is the ONE
 * mapping — the load-time upgrade below and the example builders both call it, so the two
 * spellings can never drift.
 */
export function channelExpression(channel: string): string {
  const colon = channel.indexOf(":");
  const name = colon < 0 ? channel : channel.slice(0, colon);
  const key = colon < 0 ? "value" : channel.slice(colon + 1);
  return `op('${name}').chan.${key}`;
}

/**
 * The §T897 load-time upgrade: parse `driven` forever, emit it never. A slot whose ACTIVE
 * mode is `driven` becomes an expression slot carrying the channel read (the expression
 * payload is its translation — the driven binding WAS the active intent). An INACTIVE
 * driven payload is translated into the expression slot only when that slot is empty
 * (§V108: never overwrite a retained payload the user authored). The driven payload itself
 * is dropped once translated; a shadowed one beside an authored expression stays, harmless,
 * for the schema still parses it.
 */
export function upgradeDrivenSlot(slot: ParameterSlot): { slot: ParameterSlot; changed: boolean } {
  const driven = slot.bindings.driven;
  if (driven === undefined || driven.kind !== "driven") return { slot, changed: false };
  const translated = { kind: "expression" as const, source: channelExpression(driven.channel) };
  if (slot.mode === "driven") {
    const { driven: _dropped, ...rest } = slot.bindings;
    return {
      slot: { mode: "expression", bindings: { ...rest, expression: translated } },
      changed: true,
    };
  }
  if (slot.bindings.expression === undefined) {
    const { driven: _dropped, ...rest } = slot.bindings;
    return { slot: { mode: slot.mode, bindings: { ...rest, expression: translated } }, changed: true };
  }
  return { slot, changed: false };
}
