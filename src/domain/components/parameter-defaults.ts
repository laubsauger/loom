import type { ParameterDefinition, ParameterValue } from "../types/parameters.ts";

/**
 * The default value a parameter definition declares.
 *
 * `src/ui/controls/parameter-value.ts` has the same function for the control kit, but
 * `src/domain/components/**` must stay headless and importable from Node and from the
 * compiler (§V11) — reaching into `src/ui` from the domain layer to save nine lines
 * would be the wrong trade.
 */
export function defaultValueOf(definition: ParameterDefinition): ParameterValue {
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
    default:
      return definition.default;
  }
}
