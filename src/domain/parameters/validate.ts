import type { NodeId } from "../types/ids.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type {
  ParameterDefinition,
  ParameterSchema,
  ParameterValue,
} from "../types/parameters.ts";

/**
 * Parameter validation against a node manifest's `ParameterSchema`.
 *
 * Values arriving from an agent patch, a file load, or an inspector edit are all
 * untrusted (§V37) and are checked here before they reach the document. Failing loud
 * beats coercing: a wrong-typed parameter is a rejected command, not a silent default.
 */

function error(code: string, message: string, nodeId?: NodeId, suggestion?: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function isNumberArray(value: ParameterValue, size?: number): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  if (size !== undefined && value.length !== size) return false;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** Validates one value. Returns null when the value is acceptable for the definition. */
export function validateParameterValue(
  key: string,
  definition: ParameterDefinition,
  value: ParameterValue,
  nodeId?: NodeId,
): RuntimeDiagnostic | null {
  const wrongType = (expected: string): RuntimeDiagnostic =>
    error(
      "parameter.type",
      `Parameter "${key}" expects ${expected}, received ${describeValue(value)}.`,
      nodeId,
    );

  switch (definition.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return wrongType("a finite number");
      if (definition.min !== undefined && value < definition.min) {
        return error(
          "parameter.range",
          `Parameter "${key}" is ${value}, below its minimum ${definition.min}.`,
          nodeId,
          `Use a value >= ${definition.min}.`,
        );
      }
      if (definition.max !== undefined && value > definition.max) {
        return error(
          "parameter.range",
          `Parameter "${key}" is ${value}, above its maximum ${definition.max}.`,
          nodeId,
          `Use a value <= ${definition.max}.`,
        );
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : wrongType("a boolean");
    case "enum": {
      if (typeof value !== "string") return wrongType("an enum option string");
      const allowed = definition.options.map((option) => option.value);
      if (!allowed.includes(value)) {
        return error(
          "parameter.enum",
          `Parameter "${key}" got "${value}", which is not one of: ${allowed.join(", ")}.`,
          nodeId,
        );
      }
      return null;
    }
    case "color":
      return isNumberArray(value, 4) ? null : wrongType("4 finite numbers (rgba)");
    case "vector":
      return isNumberArray(value, definition.size)
        ? null
        : wrongType(`${definition.size} finite numbers`);
    case "string":
      return typeof value === "string" ? null : wrongType("a string");
    case "asset":
      // null is the legitimate "no asset bound yet" state (§C relink flow).
      return value === null || typeof value === "string" ? null : wrongType("an asset id or null");
    case "curve": {
      if (!Array.isArray(value)) return wrongType("an array of {x, y} points");
      const ok = value.every(
        (point) =>
          typeof point === "object" &&
          point !== null &&
          typeof (point as { x?: unknown }).x === "number" &&
          typeof (point as { y?: unknown }).y === "number",
      );
      return ok ? null : wrongType("an array of {x, y} points");
    }
    default: {
      const never: never = definition;
      void never;
      return null;
    }
  }
}

function describeValue(value: ParameterValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  return typeof value;
}

/**
 * Validates a partial or complete parameter bag against a schema.
 * Unknown keys are errors: they usually mean a stale agent patch or a renamed
 * parameter, and accepting them would let dead values accumulate in the document.
 */
export function validateParameters(
  schema: ParameterSchema,
  values: Readonly<Record<string, ParameterValue>>,
  nodeId?: NodeId,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const key of Object.keys(values).sort()) {
    const definition = schema[key];
    if (definition === undefined) {
      const known = Object.keys(schema).sort().join(", ");
      diagnostics.push(
        error(
          "parameter.unknown",
          `Unknown parameter "${key}".`,
          nodeId,
          known.length > 0 ? `Known parameters: ${known}.` : undefined,
        ),
      );
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      diagnostics.push(error("parameter.undefined", `Parameter "${key}" was set to undefined.`, nodeId));
      continue;
    }
    const diagnostic = validateParameterValue(key, definition, value, nodeId);
    if (diagnostic !== null) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** The manifest defaults for a schema — the starting parameter bag of a new node. */
export function defaultParameters(schema: ParameterSchema): Record<string, ParameterValue> {
  const result: Record<string, ParameterValue> = {};
  for (const [key, definition] of Object.entries(schema)) {
    switch (definition.type) {
      case "asset":
        result[key] = null;
        break;
      case "color":
      case "vector":
        result[key] = [...definition.default];
        break;
      case "curve":
        result[key] = definition.default.map((point) => ({ x: point.x, y: point.y }));
        break;
      default:
        result[key] = definition.default;
        break;
    }
  }
  return result;
}
