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

  it("rejects pointset topology and material model mismatches", () => {
    expect(
      arePortsCompatible(
        { kind: "pointset", requires: [], topology: "triangles" },
        { kind: "pointset", requires: [], topology: "points" },
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
    expect(describePortType(rgba)).toBe("texture2d<float,4,linear>");
    expect(describePortType({ kind: "vector", scalar: "f32", size: 2 })).toBe("vec2<f32>");
    expect(describePortType({ kind: "scalar", scalar: "i32" })).toBe("scalar<i32>");
  });
});

/**
 * Pointset compatibility (§V13 spirit, §I.pointset): the CONSUMER declares what it needs.
 */
describe("pointset attribute requirements", () => {
  const P = { name: "P", type: "vec3f" } as const;
  const vel = { name: "vel", type: "vec3f" } as const;
  const age = { name: "age", type: "f32" } as const;
  const set = (requires: ReadonlyArray<{ name: string; type: "vec3f" | "f32" }>) =>
    ({ kind: "pointset", requires }) as const;

  it("accepts a producer carrying exactly what the consumer needs", () => {
    expect(arePortsCompatible(set([P, vel]), set([P, vel]))).toBe(true);
  });

  /** A superset is fine — otherwise every operator would have to declare the whole schema. */
  it("accepts a producer carrying MORE attributes than required", () => {
    expect(arePortsCompatible(set([P, vel, age]), set([P]))).toBe(true);
  });

  it("rejects a missing attribute rather than defaulting it", () => {
    expect(arePortsCompatible(set([P]), set([P, vel]))).toBe(false);
  });

  /** A zero-filled "vel" that should have existed is a bug you debug in the render. */
  it("rejects a name match with the wrong type", () => {
    expect(arePortsCompatible(set([P, { name: "vel", type: "f32" }]), set([P, vel]))).toBe(false);
  });

  it("treats absent topology (particles) as distinct from a mesh topology", () => {
    expect(
      arePortsCompatible({ kind: "pointset", requires: [P] }, { kind: "pointset", requires: [P], topology: "triangles" }),
    ).toBe(false);
  });

  it("accepts a DECLARED topology into a consumer that asks for none", () => {
    // The reverse of the case above, and the one that was broken: strict inequality made
    // `undefined` a value, so a producer honest enough to declare `topology: "points"`
    // failed to connect to every consumer that had simply never mentioned topology —
    // `renderPoints` among them. Invisible until now because nothing declares it, so both
    // sides were `undefined` and compared equal. A consumer that states no topology has
    // stated no requirement.
    expect(
      arePortsCompatible(
        { kind: "pointset", requires: [P], topology: "points" },
        { kind: "pointset", requires: [P] },
      ),
    ).toBe(true);
    expect(
      arePortsCompatible(
        { kind: "pointset", requires: [P], topology: "triangles" },
        { kind: "pointset", requires: [P] },
      ),
    ).toBe(true);
  });

  it("accepts two topology-free pointsets", () => {
    expect(arePortsCompatible({ kind: "pointset", requires: [P] }, { kind: "pointset", requires: [P] })).toBe(true);
  });
});

/**
 * Colour space on a texture port (§V56/§V57, T83). It is a PORT-level fact rather than
 * something inferred from the pixel format: a gamma curve applied to a displacement field
 * silently moves geometry, and no format tells you that field is not colour.
 */
describe("texture2d colour space", () => {
  const tex = (space?: "linear" | "encoded" | "data") =>
    ({ kind: "texture2d", sample: "float", ...(space === undefined ? {} : { space }) }) as const;

  /** Absence IS linear — the project working space — not an unknown. */
  it("treats an unannotated port and an explicitly linear one as the same declaration", () => {
    expect(arePortsCompatible(tex(), tex("linear"))).toBe(true);
    expect(arePortsCompatible(tex("linear"), tex())).toBe(true);
  });

  it("refuses to feed encoded pixels into a linear input", () => {
    expect(arePortsCompatible(tex("encoded"), tex("linear"))).toBe(false);
    expect(arePortsCompatible(tex("encoded"), tex())).toBe(false);
  });

  /** The case the invariant exists for: data must never be colour-converted. */
  it("refuses to feed a data texture into a colour input, and vice versa", () => {
    expect(arePortsCompatible(tex("data"), tex("linear"))).toBe(false);
    expect(arePortsCompatible(tex("linear"), tex("data"))).toBe(false);
  });

  it("accepts data into data", () => {
    expect(arePortsCompatible(tex("data"), tex("data"))).toBe(true);
  });

  it("names the space in the description, so a diagnostic says which mismatched", () => {
    expect(describePortType(tex("data"))).toContain("data");
    expect(describePortType(tex())).toContain("linear");
  });
});
