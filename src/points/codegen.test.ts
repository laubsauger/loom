import { describe, expect, it } from "vitest";

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

