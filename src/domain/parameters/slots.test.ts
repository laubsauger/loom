import { describe, expect, it } from "vitest";
import type { ParameterDefinition } from "../types/parameters.ts";
import {
  bindingFromText,
  componentDefinition,
  componentKey,
  componentNamesFor,
  isComponentKeyOf,
  isParameterSlot,
  parseComponentKey,
  payloadText,
  seedBinding,
  slotFromValue,
  storedStaticValue,
} from "./slots.ts";

/**
 * The envelope discrimination rule and component addressing (T202, T207, §V113).
 *
 * The load-bearing claim: a bare `ParameterValue` NEVER parses as a slot. If it ever
 * could, every legacy document would resolve through the wrong path.
 */

describe("isParameterSlot", () => {
  it("accepts the envelope and nothing a ParameterValue can be", () => {
    expect(isParameterSlot({ mode: "static", bindings: {} })).toBe(true);
    expect(
      isParameterSlot({ mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } }),
    ).toBe(true);

    // Every ParameterValue shape:
    expect(isParameterSlot(3)).toBe(false);
    expect(isParameterSlot(true)).toBe(false);
    expect(isParameterSlot("mode")).toBe(false);
    expect(isParameterSlot([1, 2, 3])).toBe(false);
    expect(isParameterSlot([{ x: 0, y: 0 }])).toBe(false);
    expect(isParameterSlot(null)).toBe(false);
    // Near-misses:
    expect(isParameterSlot({ mode: "wat", bindings: {} })).toBe(false);
    expect(isParameterSlot({ mode: "static" })).toBe(false);
    expect(isParameterSlot({ bindings: {} })).toBe(false);
  });
});

describe("storedStaticValue / slotFromValue", () => {
  it("round-trips: the wrapped value is the static view", () => {
    expect(storedStaticValue(slotFromValue(7))).toBe(7);
    expect(storedStaticValue(5)).toBe(5);
    expect(storedStaticValue(undefined)).toBeUndefined();
    expect(storedStaticValue({ mode: "expression", bindings: {} })).toBeUndefined();
  });
});

describe("component addressing (§V113)", () => {
  const color: ParameterDefinition = { type: "color", label: "Tint", default: [1, 0, 0, 1], space: "display" };
  const vec3: ParameterDefinition = { type: "vector", label: "T", size: 3, default: [0, 0, 0], min: -10, max: 10 };
  const gain: ParameterDefinition = { type: "number", label: "Gain", default: 1 };

  it("names components r g b a and x y z(w)", () => {
    expect(componentNamesFor(color)).toEqual(["r", "g", "b", "a"]);
    expect(componentNamesFor(vec3)).toEqual(["x", "y", "z"]);
    expect(componentNamesFor(gain)).toBeNull();
  });

  it("parses component keys and validates them against the schema", () => {
    expect(parseComponentKey(componentKey("color", "r"))).toEqual({ base: "color", component: "r" });
    expect(parseComponentKey("color")).toBeNull();
    const schema = { color, t: vec3, gain };
    expect(isComponentKeyOf(schema, "color.r")).toBe(true);
    expect(isComponentKeyOf(schema, "t.z")).toBe(true);
    expect(isComponentKeyOf(schema, "t.w")).toBe(false); // size 3 has no w
    expect(isComponentKeyOf(schema, "color.q")).toBe(false);
    expect(isComponentKeyOf(schema, "gain.x")).toBe(false); // scalars have no components
    expect(isComponentKeyOf(schema, "missing.x")).toBe(false);
  });

  it("derives the component definition: vector inherits range, colour stays unclamped (HDR)", () => {
    const tz = componentDefinition(vec3, "z", 2);
    expect(tz).toMatchObject({ type: "number", min: -10, max: 10, default: 0 });
    const cr = componentDefinition(color, "r", 0);
    expect(cr.min).toBeUndefined(); // HDR colours are real; no 0..1 clamp
    expect(cr.default).toBe(1);
    expect(() => componentDefinition(gain, "x", 0)).toThrow(/no components/);
  });
});

describe("the map mode's payload text (T286)", () => {
  it("round-trips attribute, channel and port through the editor's text form", () => {
    for (const [text, expected] of [
      ["size", { kind: "map", attribute: "size" }],
      ["velocity:x", { kind: "map", attribute: "velocity", channel: "x" }],
      ["points2/velocity:x", { kind: "map", attribute: "velocity", channel: "x", port: "points2" }],
    ] as const) {
      const binding = bindingFromText("map", text, 0);
      expect(binding).toEqual(expected);
      expect(payloadText(binding)).toBe(text);
    }
  });

  it("seeds nothing — like bind and driven, an empty map is not a payload", () => {
    expect(seedBinding("map", 4)).toBeNull();
  });
});
