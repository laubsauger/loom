import { describe, expect, it } from "vitest";

import type { ParameterSchema } from "../types/parameters.ts";
import {
  defaultParameters,
  validateParameterValue,
  validateParameters,
  validateStoredParameter,
} from "./validate.ts";

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

describe("validateStoredParameter — the slot write gate (T202, §V108)", () => {
  const amount = schema["amount"];
  const tint = schema["tint"];
  if (amount === undefined || tint === undefined) throw new Error("fixture");

  it("checks EVERY retained payload, not only the active mode", () => {
    // Static payload is out of range while expression mode is active: still refused —
    // a retained payload the resolver cannot trust is not a fallback (§V108).
    const bad = {
      mode: "expression" as const,
      bindings: {
        expression: { kind: "expression" as const, source: "time" },
        static: { kind: "static" as const, value: 42 },
      },
    };
    expect(validateStoredParameter("amount", amount, bad)?.code).toBe("parameter.range");
  });

  it("refuses an expression that does not parse, at write time (§V110 spirit)", () => {
    const bad = {
      mode: "expression" as const,
      bindings: { expression: { kind: "expression" as const, source: "time +" } },
    };
    expect(validateStoredParameter("amount", amount, bad)?.code).toBe("parameter.expression.syntax");
  });

  it("refuses a slot whose active mode has no payload", () => {
    const empty = { mode: "bind" as const, bindings: {} };
    expect(validateStoredParameter("amount", amount, empty)?.code).toBe("parameter.slot.empty");
  });

  it("validates a component key against its derived definition, not as unknown", () => {
    const diagnostics = validateParameters(schema, { "tint.g": 0.5, "offset.y": 3 });
    expect(diagnostics).toEqual([]);
    expect(validateParameters(schema, { "tint.q": 1 })[0]?.code).toBe("parameter.unknown");
    expect(validateParameters(schema, { "amount.x": 1 })[0]?.code).toBe("parameter.unknown");
  });

  it("still accepts every bare value the old gate accepted", () => {
    expect(validateStoredParameter("amount", amount, 0.5)).toBeNull();
    expect(validateStoredParameter("tint", tint, [0, 0, 0, 1])).toBeNull();
  });
});
