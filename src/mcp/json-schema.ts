import type { z } from "zod";

/**
 * zod → JSON Schema, for MCP `tools/list` (T290).
 *
 * Hand-rolled over the handful of constructs the agent schemas actually use, rather
 * than a dependency: the point is to publish an honest picture of what `callTool`
 * accepts, and the surface's zod schema stays the one source of truth (§V39) — this is
 * derivation, never a second declaration. A construct this walker does not recognise
 * degrades to `{}` (accept-anything) instead of throwing, because a tool that cannot
 * be LISTED is worse than one loosely described; zod still validates the real call.
 */

interface ZodDefLike {
  readonly typeName?: string;
  readonly innerType?: z.ZodType<unknown>;
  readonly schema?: z.ZodType<unknown>;
  readonly type?: z.ZodType<unknown>;
  readonly valueType?: z.ZodType<unknown>;
  readonly options?: ReadonlyArray<z.ZodType<unknown>>;
  readonly values?: ReadonlyArray<string>;
  readonly value?: unknown;
  readonly shape?: () => Record<string, z.ZodType<unknown>>;
  readonly checks?: ReadonlyArray<{ kind: string; value?: unknown }>;
  readonly description?: string;
}

const defOf = (schema: z.ZodType<unknown>): ZodDefLike =>
  (schema as unknown as { _def: ZodDefLike })._def;

export function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = defOf(schema);
  const described = (body: Record<string, unknown>): Record<string, unknown> =>
    schema.description === undefined ? body : { ...body, description: schema.description };

  switch (def.typeName) {
    case "ZodString": {
      const out: Record<string, unknown> = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") out["minLength"] = check.value;
        if (check.kind === "max") out["maxLength"] = check.value;
        if (check.kind === "regex") out["pattern"] = String((check.value as RegExp | undefined)?.source ?? "");
      }
      return described(out);
    }
    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") out["minimum"] = check.value;
        if (check.kind === "max") out["maximum"] = check.value;
        if (check.kind === "int") out["type"] = "integer";
      }
      return described(out);
    }
    case "ZodBoolean":
      return described({ type: "boolean" });
    case "ZodNull":
      return described({ type: "null" });
    case "ZodLiteral":
      return described({ const: def.value });
    case "ZodEnum":
      return described({ type: "string", enum: [...(def.values ?? [])] });
    case "ZodArray":
      return described({ type: "array", items: def.type === undefined ? {} : zodToJsonSchema(def.type) });
    case "ZodRecord":
      return described({
        type: "object",
        additionalProperties: def.valueType === undefined ? {} : zodToJsonSchema(def.valueType),
      });
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return described({ anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)) });
    case "ZodOptional":
    case "ZodDefault":
    case "ZodNullable":
      return def.innerType === undefined ? {} : zodToJsonSchema(def.innerType);
    case "ZodEffects":
      return def.schema === undefined ? {} : zodToJsonSchema(def.schema);
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(field);
        const fieldDef = defOf(field);
        if (fieldDef.typeName !== "ZodOptional" && fieldDef.typeName !== "ZodDefault") required.push(key);
      }
      return described({
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      });
    }
    default:
      return described({});
  }
}
