import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHARED_UNIFORMS_WGSL } from "../runtime/backend/shared-uniforms.ts";

import {
  ATTRIBUTE_STRIDES,
  attributeBufferBytes,
  pointSetBytes,
  validateAttributes,
  type PointAttributeSchema,
} from "./attributes.ts";
import {
  generateKernelModule,
  generateSpawnHookModule,
  kernelReadsValueSlot,
  POINT_KERNEL_CONTRACT_VERSION,
  POINT_KERNEL_VALUE_SLOTS,
} from "./codegen.ts";

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

/**
 * T367 — the pointer in `PointCtx` (§V182, §V309).
 *
 * Two claims, and the second is the one V309 exists to force. The member must APPEAR for
 * a kernel that names it, with the block member behind it, and it must be ABSENT — text
 * for text, not "roughly the same" — for every kernel that does not. A struct field that
 * appeared unconditionally would move the ctx constructor and the `KernelFrame` block of
 * every point graph ever saved, recompiling all of them once for a value they never read.
 */
describe("the pointer in PointCtx (T367)", () => {
  const request = {
    attributes: SCHEMA,
    reads: ["position", "velocity", "id"],
    writes: ["position", "velocity"],
    kernel: GRAVITY_KERNEL,
  };

  const POINTER_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let target = vec3f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0, 0.0);
  q.velocity += (target - q.position) * ctx.delta;
  q.position += q.velocity * ctx.delta;
  return q;
}`;

  it("declares the member in BOTH structs and passes it, for a kernel that names it", () => {
    const module = generateKernelModule({ ...request, kernel: POINTER_KERNEL });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesPointer).toBe(true);
    // The uniform block carries it LAST: count ends the block at 20 bytes and a vec4f
    // aligns to 32, so nothing that was already there moves.
    expect(module.wgsl).toContain("  count: u32,\n  pointer: vec4f,\n};");
    expect(module.wgsl).toContain("  frameIndex: u32,\n  /* T367");
    expect(module.wgsl).toContain("kernelFrame.frameIndex, kernelFrame.pointer);");
  });

  it("a GROUP predicate over the pointer brings the member in on its own", () => {
    // The predicate is compiled into the same module and reads the same ctx, so the
    // member has to follow the group even when `process` never mentions it.
    const module = generateKernelModule({ ...request, group: "ctx.pointer.z > 0.5" });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesPointer).toBe(true);
    expect(module.wgsl).toContain("pointer: vec4f,");
  });

  it("generates EXACTLY the pre-T367 text for a kernel that does not name it (§V309)", () => {
    const module = generateKernelModule(request);
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesPointer).toBe(false);
    expect(module.wgsl).not.toContain("pointer");
    // The full pre-T367 spelling of both structs and the constructor, verbatim: a
    // "not.toContain" alone would pass while a stray blank line rewrote the text.
    expect(module.wgsl).toContain(`struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,
};`);
    expect(module.wgsl).toContain(`struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,
};`);
    expect(module.wgsl).toContain(
      "  let ctx = PointCtx(index, kernelFrame.count, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex);",
    );
  });
});

/**
 * T472 — `ctx.dim` in `PointCtx` (§V309, §V349, B85).
 *
 * B85 is the case this exists for: E20 hard-coded `64u` twice inside its WGSL while
 * `cols: 64` sat in two node parameters, so the reachable knob LIED — turning it left the
 * kernel computing a different grid than the one it was running over. The dimensions were
 * already travelling on the edge as a topology string (T296/T302); they were only
 * unreachable from inside a kernel.
 *
 * Three claims, and the second is the one §V309 exists to force:
 *  1. a kernel that names it gets the struct, the member and the constructor argument,
 *     with the EDGE's numbers baked in — not a parameter of the kernel node;
 *  2. a kernel that does not name it emits the pre-T472 text, character for character;
 *  3. naming it over a point set with no grid is REFUSED BY NAME, because zeros here
 *     divide by zero and put every point in cell (0, 0) — a picture, and a plausible one.
 */
describe("the grid in PointCtx (T472)", () => {
  const request = {
    attributes: SCHEMA,
    reads: ["position", "velocity", "id"],
    writes: ["position", "velocity"],
    kernel: GRAVITY_KERNEL,
  };

  const DIM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  q.position = vec3f(u, v, 0.0);
  return q;
}`;

  it("bakes the EDGE's cols and rows, and derives the cell, for a kernel that names it", () => {
    const module = generateKernelModule({ ...request, kernel: DIM_KERNEL, dim: { cols: 64, rows: 48 } });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.wgsl).toContain("struct PointDim {");
    expect(module.wgsl).toContain("  dim: PointDim,\n};");
    // The numbers are the TOPOLOGY's, and the cell is computed once in the wrapper so no
    // kernel repeats the modulo — the whole point of B85 is that 64 is written ONCE.
    expect(module.wgsl).toContain("PointDim(64u, 48u, index % 64u, index / 64u));");
    // And nothing was retyped: the kernel body never spells the dimension out.
    expect(DIM_KERNEL).not.toMatch(/\b64\b/);
  });

  it("follows the edge, so a different grid generates a different kernel", () => {
    const wide = generateKernelModule({ ...request, kernel: DIM_KERNEL, dim: { cols: 128, rows: 48 } });
    if (!wide.ok) throw new Error(wide.errors.join("; "));
    expect(wide.wgsl).toContain("PointDim(128u, 48u, index % 128u, index / 128u));");
  });

  it("a GROUP predicate over the grid brings the member in on its own", () => {
    // The predicate compiles into the same module and reads the same ctx, so the member
    // has to follow the group even when `process` never mentions it.
    const module = generateKernelModule({ ...request, group: "ctx.dim.j > 0u", dim: { cols: 8, rows: 8 } });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.wgsl).toContain("dim: PointDim,");
    expect(module.wgsl).toContain("PointDim(8u, 8u, index % 8u, index / 8u));");
  });

  it("REFUSES by name when the point set publishes no grid, rather than handing over zeros", () => {
    const module = generateKernelModule({ ...request, kernel: DIM_KERNEL });
    expect(module.ok).toBe(false);
    if (module.ok) throw new Error("expected a refusal");
    // §V288: the message names what is missing AND the route to having it.
    expect(module.errors.join(" ")).toContain("ctx.dim");
    expect(module.errors.join(" ")).toContain("no grid topology");
    expect(module.errors.join(" ")).toMatch(/Point Grid|Point Topology/);
  });

  it("refuses a group predicate over the grid on a gridless point set too", () => {
    const module = generateKernelModule({ ...request, group: "ctx.dim.i == 0u" });
    expect(module.ok).toBe(false);
  });

  it("generates EXACTLY the pre-T472 text for a kernel that does not name it (§V309)", () => {
    // Supplied WITH a grid: the edge offering one must not be enough to change a byte.
    const module = generateKernelModule({ ...request, dim: { cols: 64, rows: 64 } });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.wgsl).not.toContain("dim");
    expect(module.wgsl).not.toContain("PointDim");
    // The full pre-T472 spelling of the struct and the constructor, verbatim: a
    // "not.toContain" alone would pass while a stray blank line rewrote the text.
    expect(module.wgsl).toContain(`struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,
};`);
    expect(module.wgsl).toContain(
      "  let ctx = PointCtx(index, kernelFrame.count, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex);",
    );
    // And it is the SAME text a caller who never heard of T472 gets.
    const unaware = generateKernelModule(request);
    if (!unaware.ok) throw new Error(unaware.errors.join("; "));
    expect(module.wgsl).toBe(unaware.wgsl);
  });

  it("stacks with the pointer without either member moving the other (§V309)", () => {
    const both = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(ctx.pointer.x, f32(ctx.dim.i), f32(ctx.dim.j));
  return q;
}`;
    const module = generateKernelModule({ ...request, kernel: both, dim: { cols: 16, rows: 4 } });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesPointer).toBe(true);
    // The pointer keeps its place in the uniform block; the grid is not in the block at
    // all (it is compile-time, so there is nothing to mirror and nothing to read zero).
    expect(module.wgsl).toContain("  count: u32,\n  pointer: vec4f,\n};");
    expect(module.wgsl).not.toContain("dim: vec2u");
    expect(module.wgsl).toContain("kernelFrame.frameIndex, kernelFrame.pointer, PointDim(16u, 4u,");
  });
});

/**
 * T479 — the VALUE GRAPH in `PointCtx` (§V309, §V143).
 *
 * The gap: `kernel`, `attributes` and `group` are all `compileTime`, so every point
 * animation's SHAPE lived in WGSL rather than in the graph. An LFO could scale a kernel's
 * uniforms; it could not change what the kernel DID. This is T367's counterpart — the
 * pointer was one absent channel and the value graph was the other.
 *
 * The slots are ORDINALS, not names, and that is the design (see `VALUE_REFERENCE`): the
 * channel name lives in a drivable parameter, where §V128's rename rewrite already reaches
 * it, so no rename can orphan a reference buried in a shader blob (B40's family).
 */
describe("the value graph in PointCtx (T479)", () => {
  const request = {
    attributes: SCHEMA,
    reads: ["position", "velocity", "id"],
    writes: ["position", "velocity"],
    kernel: GRAVITY_KERNEL,
  };

  const VALUE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The SHAPE of the motion is the live value, not a constant compiled into the text. */
  q.velocity += vec3f(0.0, -ctx.value2, 0.0) * ctx.delta;
  q.position += q.velocity * ctx.delta;
  return q;
}`;

  it("declares only the slots the kernel names, in both structs and the constructor", () => {
    const module = generateKernelModule({ ...request, kernel: VALUE_KERNEL });
    if (!module.ok) throw new Error(module.errors.join("; "));
    // PER-SLOT, not all four: a kernel reading one slot carries one f32.
    expect(module.usesValues).toEqual([2]);
    expect(module.wgsl).toContain("  count: u32,\n  value2: f32,\n};");
    expect(module.wgsl).toContain("  value2: f32,\n};");
    expect(module.wgsl).toContain("kernelFrame.frameIndex, kernelFrame.value2);");
    expect(module.wgsl).not.toContain("value1");
    expect(module.wgsl).not.toContain("value3");
  });

  it("collects several slots in ascending order, however the kernel spells them", () => {
    const many = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position += vec3f(ctx.value3, ctx.value1, ctx.value3) * ctx.value4;
  return q;
}`;
    const module = generateKernelModule({ ...request, kernel: many });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesValues).toEqual([1, 3, 4]);
    expect(module.wgsl).toContain("kernelFrame.frameIndex, kernelFrame.value1, kernelFrame.value3, kernelFrame.value4);");
  });

  it("a GROUP predicate over a slot brings it in on its own", () => {
    const module = generateKernelModule({ ...request, group: "p.position.y > ctx.value1" });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesValues).toEqual([1]);
    expect(module.wgsl).toContain("value1: f32,");
  });

  it("REFUSES an ordinal outside the declared slots by name, not by Dawn (§V288)", () => {
    const module = generateKernelModule({
      ...request,
      kernel: VALUE_KERNEL.replace("ctx.value2", "ctx.value9"),
    });
    expect(module.ok).toBe(false);
    if (module.ok) throw new Error("expected a refusal");
    expect(module.errors.join(" ")).toContain("ctx.value9");
    expect(module.errors.join(" ")).toContain(`ctx.value${POINT_KERNEL_VALUE_SLOTS}`);
  });

  it("generates EXACTLY the pre-T479 text for a kernel that names no slot (§V309)", () => {
    const module = generateKernelModule(request);
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesValues).toEqual([]);
    // Not a bare "value" — the RNG helper's own parameter is called that. The claim is
    // that no SLOT member exists.
    expect(module.wgsl).not.toMatch(/\bvalue\d\b/);
    expect(module.wgsl).toContain(`struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,
};`);
    expect(module.wgsl).toContain(
      "  let ctx = PointCtx(index, kernelFrame.count, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex);",
    );
  });

  it("`kernelReadsValueSlot` is the reader the inspector shares, so a knob cannot lie", () => {
    // The applicability rule and the codegen emission MUST agree — an active knob the
    // module never declared writes a uniform nothing reads, and an inactive one hides a
    // slot the kernel is really using (§V220/§V360).
    for (let slot = 1; slot <= POINT_KERNEL_VALUE_SLOTS; slot += 1) {
      const module = generateKernelModule({ ...request, kernel: VALUE_KERNEL });
      if (!module.ok) throw new Error(module.errors.join("; "));
      expect(kernelReadsValueSlot(slot, VALUE_KERNEL, ""), `slot ${slot}`).toBe(
        module.usesValues.includes(slot),
      );
    }
  });

  it("the SPAWN HOOK reaches the same slots — it is a second pass on the same node", () => {
    const hook = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  q.velocity = q.velocity * ctx.value4;
  return q;
}`;
    const module = generateSpawnHookModule({
      attributes: [...SCHEMA, { name: "flags", type: "u32", default: [1] }],
      flagsAttribute: "flags",
      hook,
    });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesValues).toEqual([4]);
    expect(module.wgsl).toContain("value4: f32,");
    expect(module.wgsl).toContain("kernelFrame.frameIndex, kernelFrame.value4);");

    const plain = generateSpawnHookModule({
      attributes: [...SCHEMA, { name: "flags", type: "u32", default: [1] }],
      flagsAttribute: "flags",
      hook: hook.replace("* ctx.value4", "* 2.0"),
    });
    if (!plain.ok) throw new Error(plain.errors.join("; "));
    expect(plain.usesValues).toEqual([]);
    expect(plain.wgsl).not.toMatch(/\bvalue\d\b/);
  });
});

describe("the advection FIELD (T477, §V288/§V309)", () => {
  const fieldKernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position += fieldAt(p.position).xyz * ctx.delta;
  return q;
}`;

  it("a kernel that samples fieldAt with a field wired gets the binding and the helper", () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position", "velocity"],
      kernel: fieldKernel,
      field: true,
    });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesField).toBe(true);
    // The texture takes the slot AFTER every storage binding, and the helper mirrors
    // the bridge's clip→uv mapping verbatim (T262 — one mapping for one idea, §V349).
    const last = module.buffers[module.buffers.length - 1]?.binding ?? 0;
    expect(module.wgsl).toContain(`@group(0) @binding(${last + 1}) var fieldTexture`);
    // T512: y INVERTED — world +y is up, texel row 0 is the picture's top. The old
    // same-sign mapping mirrored every bridge read and survived because both sites
    // agreed with each other; the pin now names the corrected form.
    expect(module.wgsl).toContain("vec2f(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5)");
    expect(module.wgsl).toContain("fn fieldAt(position: vec3f) -> vec4f");
  });

  it("a kernel that samples fieldAt with NOTHING wired is refused by name", () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position", "velocity"],
      kernel: fieldKernel,
    });
    expect(module.ok).toBe(false);
    if (module.ok) return;
    expect(module.errors.join(" ")).toContain("fieldAt");
    expect(module.errors.join(" ")).toContain("field input");
  });

  it("a wired field an incurious kernel never samples costs nothing (§V309)", () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position", "velocity"],
      kernel: GRAVITY_KERNEL,
      field: true,
    });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.usesField).toBe(false);
    expect(module.wgsl).not.toContain("fieldTexture");
  });
});

/**
 * T1070 — `pointAt(slot)`, the neighbour read the module docblock has promised since T117.
 *
 * The gap it closes is structural rather than cosmetic: a point kernel was a PURE PER-POINT
 * FUNCTION, so no coupled system in the shipped set actually couples (E16's flock is a shared
 * flow field, E32's herd talks through a texture). The one property the tests below have to
 * hold on to is WHICH HALF it reads — the pre-frame one, which is what makes a coupled update
 * a Jacobi iteration with an order-independent answer (§V44). A helper reading `out_*` would
 * look more current and would make the result depend on workgroup scheduling.
 */
describe("pointAt — the neighbour read (T1070, §V288/§V309)", () => {
  /** The last line of the generated RNG, i.e. what sits immediately above the author's text. */
  const RNG_TAIL = "  return f32(pointHash(pointId, salt)) * (1.0 / 4294967296.0);\n}";

  const laplacianKernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  var sum = vec3f(0.0);
  for (var j = 0u; j < ctx.count; j += 1u) {
    sum += pointAt(j).position;
  }
  q.position = mix(p.position, sum / f32(ctx.count), 0.1);
  return q;
}`;

  it("hands back the SAME struct p is, loaded from the same pre-frame half", () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position"],
      kernel: laplacianKernel,
    });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.wgsl).toContain("fn pointAt(slot: u32) -> Point {");
    // THE half, not merely A load: `in_*` is where `p` itself comes from, so every reader
    // sees last frame's value whatever order the workgroups ran in. `out_*` here would be
    // Gauss-Seidel with a scheduling-dependent answer.
    expect(module.wgsl).toContain("n.position = in_position[slot];");
    expect(module.wgsl).toContain("n.velocity = in_velocity[slot];");
    expect(module.wgsl).not.toContain("out_position[slot]");
    // One list read twice: the accessor loads exactly what `main` loads into `p`, so the
    // two cannot come to disagree about what a Point is.
    const accessorAttributes = [...module.wgsl.matchAll(/n\.(\w+) = in_/g)].map((m) => m[1]);
    const mainAttributes = [...module.wgsl.matchAll(/ {2}p\.(\w+) = in_/g)].map((m) => m[1]);
    expect(accessorAttributes).toEqual(mainAttributes);
  });

  it("costs no binding and no uniform — it is sugar over storage already bound (§V309)", () => {
    const request = {
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position"],
    };
    const plain = generateKernelModule({ ...request, kernel: GRAVITY_KERNEL });
    const coupled = generateKernelModule({ ...request, kernel: laplacianKernel });
    if (!plain.ok || !coupled.ok) throw new Error("both modules should generate");
    expect(coupled.buffers).toEqual(plain.buffers);
    // The uniform block is what the emitting node must mirror by name; a member it gained
    // here would read zero in silence at every call site that did not learn about it.
    const blockOf = (wgsl: string): string => /struct KernelFrame \{[^}]*\}/.exec(wgsl)?.[0] ?? "";
    expect(blockOf(coupled.wgsl)).toBe(blockOf(plain.wgsl));
  });

  it("a kernel that never names it generates byte-identical WGSL (§V309)", () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position", "velocity"],
      kernel: GRAVITY_KERNEL,
    });
    if (!module.ok) throw new Error(module.errors.join("; "));
    // Pinned against the text this file already asserts elsewhere, so "byte-identical" is
    // the whole module and not just the absence of the word.
    expect(module.wgsl).not.toContain("pointAt");
    expect(module.wgsl).toContain(`${RNG_TAIL}\n\n${GRAVITY_KERNEL}`);
  });

  it("a GROUP predicate that reads a neighbour brings the accessor in on its own", () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity"],
      writes: ["position"],
      kernel: GRAVITY_KERNEL,
      group: "distance(p.position, pointAt(0u).position) < 0.5",
    });
    if (!module.ok) throw new Error(module.errors.join("; "));
    expect(module.wgsl).toContain("fn pointAt(slot: u32) -> Point {");
  });

  it("REFUSES on a lifecycle kernel by name — the flags word could only be invented", () => {
    const module = generateKernelModule({
      attributes: [...SCHEMA, { name: "flags", type: "u32", default: [0] }],
      reads: ["position"],
      writes: ["position", "flags"],
      kernel: laplacianKernel,
      lifecycle: { flagsAttribute: "flags" },
    });
    expect(module.ok).toBe(false);
    if (module.ok) return;
    expect(module.errors.join(" ")).toContain("pointAt");
    expect(module.errors.join(" ")).toContain("write-only");
  });

  it("REFUSES in a SPAWN HOOK by name — the buffers there are mid-update", () => {
    const module = generateSpawnHookModule({
      attributes: [...SCHEMA, { name: "flags", type: "u32", default: [0] }],
      flagsAttribute: "flags",
      hook: `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  q.position = pointAt(0u).position;
  return q;
}`,
    });
    expect(module.ok).toBe(false);
    if (module.ok) return;
    expect(module.errors.join(" ")).toContain("pointAt");
    expect(module.errors.join(" ")).toContain("mid-update");
  });
});

/**
 * T510 — `ctx.firstRun`, the seeding signal the clocks cannot carry. `frameIndex == 0`
 * also fires at a timeline LAP (E9's fountain re-seeded at every loop); `absFrame == 0`
 * never fires again after a seek. One token per meaning: firstRun is 1u exactly when
 * this pass's storage was created or cleared. Use-detected like the pointer (§V309):
 * a kernel that never names it generates byte-identical WGSL.
 */
describe("ctx.firstRun (T510, §V309)", () => {
  const base = {
    attributes: SCHEMA,
    reads: ["position", "velocity", "id"],
    writes: ["position"],
  };

  it("declares the member exactly when the kernel names it", () => {
    const module = generateKernelModule({
      ...base,
      kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  if (ctx.firstRun == 1u) { q.position = vec3f(0.0); }\n  return q;\n}",
    });
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.usesFirstRun).toBe(true);
    expect(module.wgsl).toContain("firstRun: u32");
    expect(module.wgsl).toContain("kernelFrame.firstRun");
  });

  it("a kernel that never names it generates byte-identical WGSL (§V309)", () => {
    const kernel = "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}";
    const module = generateKernelModule({ ...base, kernel });
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.usesFirstRun).toBe(false);
    expect(module.wgsl).not.toContain("firstRun");
  });

  it("the GROUP predicate can declare it when the kernel does not", () => {
    const module = generateKernelModule({
      ...base,
      kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}",
      group: "ctx.firstRun == 0u",
    });
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.usesFirstRun).toBe(true);
  });
});


/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T587 — the TEACHING NOTICE: codegen names the wrapping clock before Dawn has to.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * §V288's move — refuse BY NAME rather than let the device answer — applied at the one
 * severity below a refusal, because `ctx.time` is not an error. It is the right clock for a
 * timeline-anchored kernel (§V436) and the wrong one for everything else, and until now
 * nothing anywhere said which was which. The notice fires on the undeclared kernel and is
 * silent on the declared one; that pair is the whole property, and neither half means
 * anything without the other.
 */
describe("T587 — the wrapping clock is named, not left to bite", () => {
  const base = {
    attributes: SCHEMA,
    reads: ["position", "velocity", "id"],
    writes: ["position"],
  };
  const kernelOf = (body: string) =>
    `fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n${body}\n  return q;\n}`;
  const noticesOf = (request: Parameters<typeof generateKernelModule>[0]) => {
    const module = generateKernelModule(request);
    if (!module.ok) throw new Error(module.errors.join(", "));
    return module.notices;
  };

  it("fires on an UNDECLARED kernel that reads ctx.time, and names the alternative", () => {
    const notices = noticesOf({ ...base, kernel: kernelOf("  q.position.x = sin(ctx.time);") });
    expect(notices).toHaveLength(1);
    const notice = notices[0] as { code: string; message: string; suggestion: string };
    expect(notice.code).toBe("node.points.clock");
    // Both halves of §V338: what it does, and what makes it go away.
    expect(notice.message).toContain("ctx.time");
    expect(notice.message).toContain("ctx.absTime");
    expect(notice.suggestion).toContain("ctx.absTime");
    expect(notice.suggestion).toContain("timeline-anchored");
  });

  it("stays SILENT on a kernel that declares itself timeline-anchored (§V453/§V464)", () => {
    // Same read, same everything, one comment different. If this ever passed for a reason
    // other than the declaration, the test above would be a blanket ban on ctx.time — which
    // would be a lie about the API, since a Timer-shaped kernel is meant to wrap (§V436).
    const declared = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // timeline-anchored: this sweep IS the position in the piece, so it must reset at the lap.
  q.position.x = sin(ctx.time);
  return q;
}`;
    expect(noticesOf({ ...base, kernel: declared })).toEqual([]);
  });

  it("stays silent on a kernel already on the absolute clock, and on one with no clock", () => {
    expect(noticesOf({ ...base, kernel: kernelOf("  q.position.x = sin(ctx.absTime);") })).toEqual([]);
    expect(noticesOf({ ...base, kernel: kernelOf("  q.position += q.velocity * ctx.delta;") })).toEqual([]);
  });

  it("reads CODE, not commentary (§V443) — an explanation naming the other clock is not a read", () => {
    // Every kernel T497 fixed carries a comment saying "ctx.absTime, not ctx.time". A scan
    // that counted those would fire on the fifteen kernels that got this right, which is the
    // fastest possible way to teach people to ignore it.
    const explained = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* FREE-RUNNING (§V436): ctx.absTime, not ctx.time — the wind does not restart. */
  q.position.x = sin(ctx.absTime);
  return q;
}`;
    expect(noticesOf({ ...base, kernel: explained })).toEqual([]);
  });

  it("covers ctx.frameIndex too, and carries B119's type note where it is needed", () => {
    const notices = noticesOf({ ...base, kernel: kernelOf("  q.position.x = f32(ctx.frameIndex) * 0.01;") });
    expect(notices).toHaveLength(1);
    const notice = notices[0] as { message: string; suggestion: string };
    expect(notice.message).toContain("ctx.frameIndex");
    expect(notice.message).toContain("ctx.absFrame");
    // The reader has just been sent to a member whose type differs from the shader's.
    expect(notice.suggestion).toContain("u32");
  });

  it("scans the GROUP predicate, which compiles against the same ctx", () => {
    const notices = noticesOf({
      ...base,
      kernel: kernelOf("  q.position += q.velocity * ctx.delta;"),
      group: "ctx.time > 1.0",
    });
    expect(notices).toHaveLength(1);
  });

  it("scans the SPAWN HOOK, where a phase off the wrapping clock repeats every lap", () => {
    const hook = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  q.position.x = sin(ctx.time);
  return q;
}`;
    const module = generateSpawnHookModule({ attributes: SCHEMA, flagsAttribute: "id", hook });
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.notices).toHaveLength(1);
    expect((module.notices[0] as { message: string }).message).toContain("spawn hook");
  });

  it("a notice is not a refusal — the module still compiles and still generates its pass", () => {
    const module = generateKernelModule({ ...base, kernel: kernelOf("  q.position.x = sin(ctx.time);") });
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.wgsl).toContain("fn main");
    expect(module.notices).toHaveLength(1);
  });

  /**
   * §V309, the notice's half of it: an advisory must not change a byte of the generated
   * text. A kernel that provokes the notice and one that does not differ only in the clock
   * they name, so the block they get is the same block.
   */
  it("emits byte-identical WGSL whether or not it carries a notice (§V309)", () => {
    const noticed = kernelOf("  q.position.x = ctx.time;");
    const declared = kernelOf("  // timeline-anchored: deliberate.\n  q.position.x = ctx.time;");
    const wrapping = generateKernelModule({ ...base, kernel: noticed });
    const anchored = generateKernelModule({ ...base, kernel: declared });
    if (!wrapping.ok || !anchored.ok) throw new Error("both should compile");
    expect(wrapping.notices).toHaveLength(1);
    expect(anchored.notices).toEqual([]);
    // The user's own text is the only difference; every generated byte around it — the
    // KernelFrame block, the ctx construction, the bindings — is the same block.
    expect(wrapping.wgsl.replace(noticed, "<kernel>")).toBe(anchored.wgsl.replace(declared, "<kernel>"));
  });
});

/**
 * B119 — `absFrame` is u32 in a kernel and f32 in a shader, and it STAYS that way.
 *
 * Not unified, and the reason is a measurement rather than a taste: unifying means changing
 * a struct member's TYPE, which breaks every saved project doing integer work on
 * `ctx.absFrame`, and it would then be the member disagreeing with the `frameIndex` beside
 * it. Each side is right about its own neighbours; they are wrong about each other, and
 * Dawn's answer to the mismatch ("no matching overload") names nothing.
 *
 * So the gate is the one a documented asymmetry earns: BOTH types are pinned, so changing
 * either alone reddens here, and BOTH declarations carry the reason where the reader is —
 * for the kernel that is the comment the generated WGSL itself carries.
 */
describe("B119 — the absFrame asymmetry is pinned and stated at both sites", () => {
  const module = generateKernelModule({
    attributes: SCHEMA,
    reads: ["position", "id"],
    writes: ["position"],
    kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position.x = f32(ctx.absFrame);\n  return q;\n}",
  });

  it("a point kernel's ctx.absFrame is u32, matching the frameIndex beside it", () => {
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.wgsl).toContain("absFrame: u32,");
    expect(module.wgsl).toContain("frameIndex: u32,");
  });

  it("a shader's frameU.absFrame is f32, matching the block it lives in", () => {
    expect(SHARED_UNIFORMS_WGSL).toContain("absFrame: f32,");
    expect(SHARED_UNIFORMS_WGSL).toContain("frameIndex: f32,");
    // absTime is the same type on both sides and always was — the report that it "isn't
    // f32" was wrong, and pinning it here stops the wrong repair being made to the wrong
    // member next time someone reads the bug and not the code.
    expect(SHARED_UNIFORMS_WGSL).toContain("absTime: f32,");
    if (!module.ok) throw new Error(module.errors.join(", "));
    expect(module.wgsl).toContain("absTime: f32,");
  });

  it("the generated kernel SAYS so, where the person writing the kernel reads", () => {
    if (!module.ok) throw new Error(module.errors.join(", "));
    // The declaration site the kernel author can actually see. A pinned type with no
    // explanation is the asymmetry preserved and nothing learned.
    expect(module.wgsl).toContain("B119");
    expect(module.wgsl).toContain("no matching overload");
  });

  it("and the shader side says so too, at its own declaration", () => {
    const source = readFileSync(new URL("../runtime/backend/shared-uniforms.ts", import.meta.url), "utf8");
    expect(source).toContain("B119");
    expect(source).toContain("ctx.absFrame");
  });
});
