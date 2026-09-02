import { describe, expect, it } from "vitest";

import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { pointRangeNode } from "./point-range.ts";
import { compileContext } from "./test-support.ts";

/**
 * Range (T983) — the compile contract. The behaviour a consumer actually reads — kept
 * positions byte-identical, dropped ones parked, the inside/outside partition exact —
 * is pinned on Dawn in point-range.gpu.test.ts; this file pins the edge payload and the
 * refusals, which decide what every downstream node sees.
 */
describe("pointRange — attribute-range selection (T983)", () => {
  const edge = (overrides: Partial<{ count: { buffer: string }; topology: string }> = {}) => ({
    points: {
      pairs: {
        position: { pair: "scratch:gen:position", half: "write" as const, type: "vec3f" },
        tint: { pair: "scratch:gen:tint", half: "read" as const, type: "vec4f" },
        depthN: { pair: "scratch:gen:depthN", half: "write" as const, type: "f32" },
      },
      capacity: 4096,
      ...overrides,
    },
  });

  it("owns a fresh position pair and republishes every other attribute BY REFERENCE (§V197)", () => {
    const result = pointRangeNode.compile(
      compileContext({
        nodeId: "zone",
        inputs: ["points"],
        pointsets: edge({ topology: "grid:64x64" }),
        parameters: { attribute: "depthN", from: 0.2, to: 0.6, mode: "inside" },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.pointsets).toEqual({
      out: {
        pairs: {
          position: { pair: "scratch:zone:position", half: "write", type: "vec3f" },
          tint: { pair: "scratch:gen:tint", half: "read", type: "vec4f" },
          depthN: { pair: "scratch:gen:depthN", half: "write", type: "f32" },
        },
        capacity: 4096,
        // Parking never moves a slot, so the upstream lattice claim stays true.
        topology: "grid:64x64",
      },
    });
    // The zone itself is RUNTIME state — from/to/mode ride the uniforms so the slab can
    // be driven without a recompile.
    const pass = result.passes[0] as DispatchPassDescriptor;
    expect(pass.kind).toBe("dispatch");
    expect(pass.uniforms).toMatchObject({ lo: 0.2, hi: 0.6, keepInside: 1 });
    expect(pass.buffers?.map((b) => b.binding)).toEqual(["in_position", "in_attr", "out_position"]);
  });

  it("keep-outside is the SAME program with keepInside 0 — §T979's complement is a parameter, not a variant", () => {
    const compiled = (mode: string) =>
      pointRangeNode.compile(
        compileContext({
          nodeId: "zone",
          inputs: ["points"],
          pointsets: edge(),
          parameters: { attribute: "depthN", mode },
        }),
      ).passes[0] as DispatchPassDescriptor;
    const inside = compiled("inside");
    const outside = compiled("outside");
    expect(inside.id).toBe(outside.id);
    expect(inside.shader).toBe(outside.shader);
    expect(inside.uniforms?.["keepInside"]).toBe(1);
    expect(outside.uniforms?.["keepInside"]).toBe(0);
  });

  it("a position component needs no second binding, and the program id says what varies (§V62b)", () => {
    const result = pointRangeNode.compile(
      compileContext({
        nodeId: "slab",
        inputs: ["points"],
        pointsets: edge(),
        parameters: { attribute: "position", component: "z", from: -1, to: 1 },
      }),
    );
    const pass = result.passes[0] as DispatchPassDescriptor;
    expect(pass.kind).toBe("dispatch");
    expect(pass.buffers?.map((b) => b.binding)).toEqual(["in_position", "out_position"]);
    expect(pass.id).toBe("slab:range:position.z:vec3f");
    expect(pass.shader).toContain("in_position[index].z");
  });

  it("binds the live count of a counted input and does NOT republish it — parked survivors are not contiguous", () => {
    const result = pointRangeNode.compile(
      compileContext({
        nodeId: "zone",
        inputs: ["points"],
        pointsets: edge({ count: { buffer: "scratch:gen:counts" } }),
        parameters: { attribute: "depthN" },
      }),
    );
    const pass = result.passes[0] as DispatchPassDescriptor;
    expect(pass.kind).toBe("dispatch");
    expect(pass.id).toBe("zone:range:depthN:f32:counted");
    expect(pass.buffers?.map((b) => b.binding)).toEqual(["in_position", "in_attr", "in_count", "out_position"]);
    expect(result.pointsets?.["out"]?.count).toBeUndefined();
  });

  it("refuses an attribute the points do not carry, listing what they do (§V288)", () => {
    const result = pointRangeNode.compile(
      compileContext({
        nodeId: "zone",
        inputs: ["points"],
        pointsets: edge(),
        parameters: { attribute: "velocity" },
      }),
    );
    expect(result.passes).toEqual([]);
    const diagnostic = (result.diagnostics ?? [])[0];
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain('"velocity"');
    expect(diagnostic?.suggestion).toBe("It provides: depthN, position, tint.");
  });

  it("refuses a component the attribute does not have", () => {
    const result = pointRangeNode.compile(
      compileContext({
        nodeId: "zone",
        inputs: ["points"],
        pointsets: edge(),
        parameters: { attribute: "position", component: "w" },
      }),
    );
    expect(result.passes).toEqual([]);
    expect((result.diagnostics ?? [])[0]?.message).toContain("3 components");
  });
});
