import { describe, expect, it } from "vitest";

import type { ParameterSchema } from "../types/parameters.ts";
import { defaultParameters, validateParameterValue, validateParameters } from "./validate.ts";

/**
 * Parameter values reaching the document come from agents, files and inspector drags —
 * all untrusted (§V37). They are checked against the manifest, never coerced.
 */

const schema: ParameterSchema = {
  amount: { type: "number", label: "Amount", default: 0.5, min: 0, max: 1 },
  enabled: { type: "boolean", label: "Enabled", default: true },
  mode: {
    type: "enum",
    label: "Mode",
    default: "over",
    options: [
      { value: "over", label: "Over" },
      { value: "add", label: "Add" },
    ],
  },
  tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
  offset: { type: "vector", label: "Offset", size: 2, default: [0, 0] },
  note: { type: "string", label: "Note", default: "" },
  texture: { type: "asset", label: "Texture", kind: "image" },
  curve: { type: "curve", label: "Curve", default: [{ x: 0, y: 0 }] },
};

describe("validateParameters", () => {
  it("accepts values matching the schema", () => {
    expect(
      validateParameters(schema, {
        amount: 0.25,
        enabled: false,
        mode: "add",
        tint: [0, 0, 0, 1],
        offset: [1, 2],
        note: "hi",
        texture: null,
        curve: [{ x: 0, y: 1 }],
      }),
    ).toEqual([]);
  });

  it("rejects an unknown parameter name", () => {
    const diagnostics = validateParameters(schema, { nope: 1 });
    expect(diagnostics[0]?.code).toBe("parameter.unknown");
    expect(diagnostics[0]?.suggestion).toContain("amount");
  });

  it("rejects wrong types without coercing", () => {
    expect(validateParameters(schema, { amount: "0.25" })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { enabled: 1 })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { note: 5 })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { amount: Number.NaN })[0]?.code).toBe("parameter.type");
  });

  it("rejects out-of-range numbers instead of clamping them silently", () => {
    expect(validateParameters(schema, { amount: 2 })[0]?.code).toBe("parameter.range");
    expect(validateParameters(schema, { amount: -1 })[0]?.code).toBe("parameter.range");
  });

  it("rejects an enum value outside its options", () => {
    const diagnostic = validateParameters(schema, { mode: "screen" })[0];
    expect(diagnostic?.code).toBe("parameter.enum");
    expect(diagnostic?.message).toContain("over, add");
  });

  it("rejects a vector or color of the wrong length", () => {
    expect(validateParameters(schema, { offset: [1, 2, 3] })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { tint: [1, 1, 1] })[0]?.code).toBe("parameter.type");
  });

  it("accepts an asset id or null, nothing else", () => {
    expect(validateParameters(schema, { texture: "asset-1" })).toEqual([]);
    expect(validateParameters(schema, { texture: null })).toEqual([]);
    expect(validateParameters(schema, { texture: 7 })[0]?.code).toBe("parameter.type");
  });

  it("reports every bad key, not only the first", () => {
    expect(validateParameters(schema, { amount: 9, mode: "screen" })).toHaveLength(2);
  });

  it("attaches the node id so the diagnostic can be shown on the node badge", () => {
    expect(validateParameters(schema, { amount: 9 }, "node-1")[0]?.nodeId).toBe("node-1");
  });
});

describe("defaultParameters", () => {
  it("materialises manifest defaults, with null for unbound assets", () => {
    expect(defaultParameters(schema)).toEqual({
      amount: 0.5,
      enabled: true,
      mode: "over",
      tint: [1, 1, 1, 1],
      offset: [0, 0],
      note: "",
      texture: null,
      curve: [{ x: 0, y: 0 }],
    });
  });

  it("copies array and curve defaults so two nodes never share one array", () => {
    const first = defaultParameters(schema);
    const second = defaultParameters(schema);
    expect(first["tint"]).not.toBe(second["tint"]);
    expect(first["curve"]).not.toBe(second["curve"]);
  });

  it("produces defaults that validate against their own schema", () => {
    expect(validateParameters(schema, defaultParameters(schema))).toEqual([]);
  });
});

describe("validateParameterValue", () => {
  it("returns null for a valid value and a diagnostic otherwise", () => {
    const definition = schema["amount"];
    if (definition === undefined) throw new Error("fixture");
    expect(validateParameterValue("amount", definition, 0.5)).toBeNull();
    expect(validateParameterValue("amount", definition, 5)?.code).toBe("parameter.range");
  });
});
