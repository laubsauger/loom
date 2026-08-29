import type {
  NumberParameter,
  ParameterDefinition,
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

export const PARAMETER_MODES = ["static", "expression", "bind", "driven"] as const;

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
      ...(definition.step === undefined ? {} : { step: definition.step }),
    };
  }
  if (definition.type === "color") {
    return { type: "number", label, default: definition.default[index] ?? 0 };
  }
  // Callers only reach here for compound definitions; a scalar has no components.
  throw new Error(`Parameter "${definition.label}" has no components.`);
}
