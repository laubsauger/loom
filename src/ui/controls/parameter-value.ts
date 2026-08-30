import type { ParameterDefinition, ParameterValue } from "@domain/types/parameters.ts";

/**
 * Reading a stored value through its manifest definition.
 *
 * The document can legitimately disagree with the manifest: an older project, an
 * unknown-node placeholder (§V10), an agent patch mid-flight. The control kit renders
 * what the manifest describes and falls back to the default when the stored value does
 * not fit — it never coerces the document silently. `validateParameters` in the domain
 * layer is what refuses bad values on the way *in*; this is the read side.
 */

export function defaultValueFor(definition: ParameterDefinition): ParameterValue {
  switch (definition.type) {
    case "asset":
      return null;
    /** §V124: a pulse is never armed by default and never stored. */
    case "pulse":
      return false;
    case "color":
    case "vector":
      return [...definition.default];
    case "curve":
      return definition.default.map((point) => ({ x: point.x, y: point.y }));
    case "stops":
      return definition.default.map((stop) => ({
        position: stop.position,
        color: [...stop.color] as [number, number, number, number],
      }));
    default:
      return definition.default;
  }
}

function isFiniteNumberArray(value: unknown, size: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === size &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/** True when `value` is a legal value for `definition` — the same rules the domain enforces. */
export function matchesDefinition(definition: ParameterDefinition, value: unknown): boolean {
  switch (definition.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return (
        typeof value === "string" && definition.options.some((option) => option.value === value)
      );
    case "color":
      return isFiniteNumberArray(value, 4);
    case "vector":
      return isFiniteNumberArray(value, definition.size);
    case "string":
      return typeof value === "string";
    case "asset":
      return value === null || typeof value === "string";
    // Armed or not. §V124's "never stored armed" is a WRITE rule and lives in
    // `validateStoredParameter`; this is the read side, and an expression-driven pulse
    // legitimately resolves to `true` on the frame it fires.
    case "pulse":
      return typeof value === "boolean";
    case "stops":
      return (
        Array.isArray(value) &&
        (definition.maxStops === undefined || value.length <= definition.maxStops) &&
        value.every(
          (stop) =>
            typeof stop === "object" &&
            stop !== null &&
            typeof (stop as { position?: unknown }).position === "number" &&
            isFiniteNumberArray((stop as { color?: unknown }).color, 4),
        )
      );
    case "curve":
      return (
        Array.isArray(value) &&
        value.every(
          (point) =>
            typeof point === "object" &&
            point !== null &&
            typeof (point as { x?: unknown }).x === "number" &&
            typeof (point as { y?: unknown }).y === "number",
        )
      );
    default: {
      const never: never = definition;
      void never;
      return false;
    }
  }
}

/** The value a control should display: the stored one when it fits, the default otherwise. */
export function valueForDefinition(
  definition: ParameterDefinition,
  value: ParameterValue | undefined,
): ParameterValue {
  if (value === undefined) return defaultValueFor(definition);
  return matchesDefinition(definition, value) ? value : defaultValueFor(definition);
}
