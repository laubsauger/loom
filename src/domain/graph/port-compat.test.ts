import { describe, expect, it } from "vitest";
import type { PortType } from "../types/ports.ts";
import { arePortsCompatible, describePortType } from "./port-compat.ts";

/**
 * §V13: connection requires an exact PortType match. Every case below is a near miss
 * that a permissive implementation would happily coerce — which is exactly the silent
 * conversion the invariant exists to forbid. If any of these starts passing, someone has
 * added implicit conversion and the graph no longer says what it does.
 */
describe("arePortsCompatible (§V13)", () => {
  const rgba: PortType = { kind: "texture2d", sample: "float", channels: 4 };

  it("accepts an identical type", () => {
    expect(arePortsCompatible(rgba, { kind: "texture2d", sample: "float", channels: 4 })).toBe(true);
  });

  it("rejects a different kind", () => {
    expect(arePortsCompatible(rgba, { kind: "scalar", scalar: "f32" })).toBe(false);
  });

  it("rejects f32 -> i32", () => {
    expect(
      arePortsCompatible({ kind: "scalar", scalar: "f32" }, { kind: "scalar", scalar: "i32" }),
    ).toBe(false);
  });

  it("rejects f32 -> u32 and bool", () => {
    expect(
      arePortsCompatible({ kind: "scalar", scalar: "f32" }, { kind: "scalar", scalar: "u32" }),
    ).toBe(false);
    expect(
      arePortsCompatible({ kind: "scalar", scalar: "bool" }, { kind: "scalar", scalar: "u32" }),
    ).toBe(false);
  });

  it("rejects vec2 -> vec3", () => {
    expect(
      arePortsCompatible(
        { kind: "vector", scalar: "f32", size: 2 },
        { kind: "vector", scalar: "f32", size: 3 },
      ),
    ).toBe(false);
  });

  it("rejects vec3<f32> -> vec3<i32>", () => {
    expect(
      arePortsCompatible(
        { kind: "vector", scalar: "f32", size: 3 },
        { kind: "vector", scalar: "i32", size: 3 },
      ),
    ).toBe(false);
  });

  it("rejects a texture sample-type mismatch", () => {
    expect(arePortsCompatible(rgba, { kind: "texture2d", sample: "depth", channels: 4 })).toBe(false);
    expect(
      arePortsCompatible(rgba, { kind: "texture2d", sample: "unfilterable-float", channels: 4 }),
    ).toBe(false);
  });

  it("rejects a channel-count mismatch", () => {
    expect(arePortsCompatible(rgba, { kind: "texture2d", sample: "float", channels: 1 })).toBe(false);
  });

  it("treats an unspecified channel count as its own declaration, not as a wildcard", () => {
    expect(arePortsCompatible(rgba, { kind: "texture2d", sample: "float" })).toBe(false);
    expect(
      arePortsCompatible({ kind: "texture2d", sample: "float" }, { kind: "texture2d", sample: "float" }),
    ).toBe(true);
  });

  it("rejects buffer element or access mismatches", () => {
    const read: PortType = { kind: "buffer", element: "vec4f", access: "read" };
    expect(arePortsCompatible(read, { kind: "buffer", element: "vec4f", access: "read" })).toBe(true);
    expect(arePortsCompatible(read, { kind: "buffer", element: "vec4f", access: "write" })).toBe(false);
    expect(arePortsCompatible(read, { kind: "buffer", element: "vec2f", access: "read" })).toBe(false);
  });

  it("rejects a matrix shape mismatch", () => {
    expect(
      arePortsCompatible({ kind: "matrix", columns: 4, rows: 4 }, { kind: "matrix", columns: 3, rows: 3 }),
    ).toBe(false);
    expect(
      arePortsCompatible({ kind: "matrix", columns: 4, rows: 3 }, { kind: "matrix", columns: 3, rows: 4 }),
    ).toBe(false);
  });

  it("rejects geometry topology and material model mismatches", () => {
    expect(
      arePortsCompatible(
        { kind: "geometry", topology: "triangle-list" },
        { kind: "geometry", topology: "point-list" },
      ),
    ).toBe(false);
    expect(
      arePortsCompatible({ kind: "material", model: "pbr" }, { kind: "material", model: "unlit" }),
    ).toBe(false);
  });

  it("accepts the payload-free families", () => {
    for (const kind of ["scene", "camera", "light", "transform3d", "event", "audioFeatures"] as const) {
      expect(arePortsCompatible({ kind }, { kind })).toBe(true);
    }
  });

  it("is symmetric: exact match has no direction", () => {
    const a: PortType = { kind: "vector", scalar: "f32", size: 2 };
    const b: PortType = { kind: "vector", scalar: "f32", size: 3 };
    expect(arePortsCompatible(a, b)).toBe(arePortsCompatible(b, a));
  });

  it("describes types distinguishably for diagnostics", () => {
    expect(describePortType(rgba)).toBe("texture2d<float,4>");
    expect(describePortType({ kind: "vector", scalar: "f32", size: 2 })).toBe("vec2<f32>");
    expect(describePortType({ kind: "scalar", scalar: "i32" })).toBe("scalar<i32>");
  });
});
