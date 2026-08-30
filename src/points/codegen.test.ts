import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_STRIDES,
  attributeBufferBytes,
  pointSetBytes,
  validateAttributes,
  type PointAttributeSchema,
} from "./attributes.ts";
import { generateKernelModule, POINT_KERNEL_CONTRACT_VERSION } from "./codegen.ts";

/**
 * T117 — the attribute→WGSL codegen module, tested as the separate unit the spec made
 * it: layout math (including the vec3 stride trap), schema validation (§V72/§V73),
 * generated-module structure, and the deterministic-RNG contract (§V74).
 */

const SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "life", type: "f32", semantic: "life", default: [1] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

const GRAVITY_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.velocity += vec3f(0.0, -9.8, 0.0) * ctx.delta;
  q.position += q.velocity * ctx.delta;
  return q;
}`;

describe("attribute layout (§V72)", () => {
  it("vec3f strides 16 bytes, not 12 — the classic WGSL array-alignment trap", () => {
    expect(ATTRIBUTE_STRIDES["vec3f"]).toBe(16);
    expect(attributeBufferBytes("vec3f", 1000)).toBe(16_000);
  });

  it("sums a system's memory across its per-attribute buffers", () => {
    // 16 + 16 + 4 + 4 bytes per point.
    expect(pointSetBytes(SCHEMA, 100_000)).toBe(4_000_000);
  });
});

describe("schema validation (§V72, §V73)", () => {
  it("accepts the reference schema", () => {
    expect(validateAttributes(SCHEMA)).toEqual({ ok: true, errors: [] });
  });

  it("rejects bad identifiers, duplicates, reserved words and default-arity mismatches", () => {
    const result = validateAttributes([
      { name: "3bad", type: "f32", default: [0] },
      { name: "struct", type: "f32", default: [0] },
      { name: "x", type: "vec2f", default: [0] },
      { name: "x", type: "f32", default: [0] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('"3bad"'))).toBe(true);
    expect(result.errors.some((error) => error.includes("reserved"))).toBe(true);
    expect(result.errors.some((error) => error.includes("component"))).toBe(true);
    expect(result.errors.some((error) => error.includes("duplicate"))).toBe(true);
  });

  it("§V73: the id semantic demands u32 — identity is a value, never a slot", () => {
    const result = validateAttributes([{ name: "id", type: "f32", semantic: "id", default: [0] }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("u32");
  });
});

describe("generated kernel module", () => {
  const build = () =>
    generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position", "velocity"],
      kernel: GRAVITY_KERNEL,
    });

  it("assembles struct, bindings, guard and load/store from the schema", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Written attributes bind an in/out pair; untouched ones ("life", "id") bind nothing.
    expect(result.buffers.map((binding) => binding.variable)).toEqual([
      "in_position",
      "in_velocity",
      "out_position",
      "out_velocity",
    ]);
    expect(result.buffers.map((binding) => binding.binding)).toEqual([1, 2, 3, 4]);

    expect(result.wgsl).toContain("struct Point {\n  position: vec3f,\n  velocity: vec3f,\n};");
    expect(result.wgsl).toContain("if (index >= kernelFrame.count)");
    expect(result.wgsl).toContain("p.position = in_position[index];");
    expect(result.wgsl).toContain("out_velocity[index] = q.velocity;");
    expect(result.wgsl).not.toContain("in_life");
    expect(result.contractVersion).toBe(POINT_KERNEL_CONTRACT_VERSION);
  });

  it("is deterministic: the same request generates byte-identical WGSL", () => {
    const first = build();
    const second = generateKernelModule({
      attributes: SCHEMA,
      // Different declaration order in reads/writes must not change the output.
      reads: ["velocity", "position"],
      writes: ["velocity", "position"],
      kernel: GRAVITY_KERNEL,
    });
    if (!first.ok || !second.ok) throw new Error("expected both to build");
    expect(second.wgsl).toBe(first.wgsl);
  });

  it("§V74: the RNG is hash(seed, pointId, frameIndex, salt) with fixed constants", () => {
    const result = build();
    if (!result.ok) throw new Error("expected build");
    expect(result.wgsl).toContain("fn pointRand(pointId: u32, salt: u32) -> f32");
    expect(result.wgsl).toContain("kernelFrame.seed ^ pointId");
    expect(result.wgsl).toContain("kernelFrame.frameIndex");
    // No atomics anywhere in the generated module: scheduling independence is the point.
    expect(result.wgsl).not.toContain("atomic");
  });

  it("a written attribute is loaded too, so kernels can accumulate", () => {
    const result = generateKernelModule({
      attributes: SCHEMA,
      reads: [],
      writes: ["life"],
      kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.life -= ctx.delta;
  return q;
}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wgsl).toContain("p.life = in_life[index];");
    expect(result.wgsl).toContain("out_life[index] = q.life;");
  });

  it("rejects unknown attributes, missing writes, a bad signature and a bad workgroup size", () => {
    const missingAttribute = generateKernelModule({
      attributes: SCHEMA,
      reads: ["nope"],
      writes: ["position"],
      kernel: GRAVITY_KERNEL,
    });
    expect(missingAttribute.ok).toBe(false);

    const writesNothing = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position"],
      writes: [],
      kernel: GRAVITY_KERNEL,
    });
    expect(writesNothing.ok).toBe(false);

    const badSignature = generateKernelModule({
      attributes: SCHEMA,
      reads: [],
      writes: ["position"],
      kernel: "fn process(p: Point) -> Point { return p; }",
    });
    expect(badSignature.ok).toBe(false);
    if (!badSignature.ok) {
      expect(badSignature.errors[0]).toContain("fn process(p: Point, ctx: PointCtx) -> Point");
    }

    const badWorkgroup = generateKernelModule({
      attributes: SCHEMA,
      reads: [],
      writes: ["position"],
      kernel: GRAVITY_KERNEL,
      workgroupSize: 0,
    });
    expect(badWorkgroup.ok).toBe(false);
  });
});

describe("group predicate (T300)", () => {
  const request = {
    attributes: SCHEMA,
    reads: ["position", "velocity", "id"],
    writes: ["position", "velocity"],
    kernel: GRAVITY_KERNEL,
  };

  it("gates process behind the predicate; non-members pass through byte-identical", () => {
    const module = generateKernelModule({ ...request, group: "p.position.y > 0.0" });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.wgsl).toContain("fn groupMatch(p: Point, ctx: PointCtx) -> bool {\n  return (p.position.y > 0.0);");
    expect(module.wgsl).toContain("if (groupMatch(p, ctx)) {");
    // q starts as p, so a non-member's stores write the loaded values back untouched.
    expect(module.wgsl).toContain("var q = p;");
  });

  it("generates EXACTLY the v1 text with no group — existing pass signatures stand", () => {
    const bare = generateKernelModule(request);
    const empty = generateKernelModule({ ...request, group: "   " });
    if (!bare.ok || !empty.ok) throw new Error("generation failed");
    expect(empty.wgsl).toBe(bare.wgsl);
    expect(bare.wgsl).toContain("let q = process(p, ctx);");
    expect(bare.wgsl).not.toContain("groupMatch");
  });
});

describe("attribute qualifiers (T287, §V75)", () => {
  const base = { name: "aim", default: [0, 0, 0] } as const;

  it("accepts a coherent qualifier and carries it on the schema", () => {
    const result = validateAttributes([
      { ...base, type: "vec3f", qualifier: "direction" },
      { name: "tint", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
      { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("refuses a qualifier its type cannot honour — rotating an f32 means nothing", () => {
    const direction = validateAttributes([{ name: "aim", type: "f32", qualifier: "direction", default: [0] }]);
    expect(direction.errors.join(" ")).toContain('"direction", which needs vec3f');
    const quaternion = validateAttributes([{ ...base, type: "vec3f", qualifier: "quaternion" }]);
    expect(quaternion.errors.join(" ")).toContain("vec4f");
    const unknown = validateAttributes([
      { ...base, type: "vec3f", qualifier: "sideways" as unknown as "color" },
    ]);
    expect(unknown.errors.join(" ")).toContain('unknown qualifier "sideways"');
  });
});
