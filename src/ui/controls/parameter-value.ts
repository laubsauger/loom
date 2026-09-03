import type { ParameterDefinition, ParameterValue } from "@domain/types/parameters.ts";
import { defaultParameterValue } from "@domain/parameters/validate.ts";

/**
 * Reading a stored value through its manifest definition.
 *
 * The document can legitimately disagree with the manifest: an older project, an
 * unknown-node placeholder (§V10), an agent patch mid-flight. The control kit renders
 * what the manifest describes and falls back to the default when the stored value does
 * not fit — it never coerces the document silently. `validateParameters` in the domain
 * layer is what refuses bad values on the way *in*; this is the read side.
 */

/**
 * The manifest default — the domain's one implementation, under the control kit's name.
 *
 * This was a THIRD byte-identical copy of `defaultParameterValue`, beside the domain's
 * and a second in `domain/components/parameter-defaults.ts` whose docblock justified
 * itself against THIS file while not knowing the headless domain copy it was duplicating
 * already existed. Nothing here needs `src/ui` isolation: the function reads a manifest
 * definition and returns a value, both of which are domain types this module already
 * imports. Three copies of a `switch` over a union that grows is how an arm goes missing
 * from one of them.
 */
export { defaultParameterValue as defaultValueFor };

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
    case "code":
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
  if (value === undefined) return defaultParameterValue(definition);
  return matchesDefinition(definition, value) ? value : defaultParameterValue(definition);
}
