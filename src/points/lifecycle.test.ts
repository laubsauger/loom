import { describe, expect, it } from "vitest";

import type { PointAttributeSchema } from "./attributes.ts";
import {
  SCAN_WORKGROUP_SIZE,
  blockCount,
  compactReference,
  generateCompactionModule,
  scratchBytes,
} from "./lifecycle.ts";
import { packAttributes, type PackedLayout } from "./packing.ts";
import { pointHashReference, pointRandReference } from "./rng.ts";

/**
 * T119/T120 — structure-level tests. The GPU-execution half (generated passes running
 * on Dawn against `compactReference`, and the WGSL RNG against the CPU mirror) lives in
 * `src/runtime/backend/vgpu/point-lifecycle.gpu.test.ts`, gated on a real device.
 */

const SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "life", type: "f32", semantic: "life", default: [1] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

/** T1076: the packed layout the node allocates and the scatter addresses. */
function layoutOf(attributes: ReadonlyArray<PointAttributeSchema>, capacity: number): PackedLayout {
  const layout = packAttributes(attributes, capacity);
  if (!layout.ok) throw new Error(layout.errors.join("; "));
  return layout;
}

describe("compaction module structure (T119, §V74)", () => {
  it("emits scanLocal, the serial block scan, and ONE scatter for the whole schema", () => {
    const module = generateCompactionModule(SCHEMA, 100_000, layoutOf(SCHEMA, 100_000));
    expect(module.ok).toBe(true);
    if (!module.ok) return;

    /* T1076: ONE scatter. It was CHUNKED at two attributes a pass — `scatter:position+
       velocity` then `scatter:life+id`, ⌈n/2⌉ dispatches every frame — purely because a
       chunk's in/out pair had to fit the 8-storage-buffer budget beside flags, scanned
       and blockSums. Packing removed the reason, so the dispatches went with it. */
    expect(module.passes.map((pass) => pass.name)).toEqual(["scanLocal", "scanBlocks", "scatter"]);
    // §V24: 5 bindings whatever n is — flags, scanned, blockSums, in, out.
    for (const pass of module.passes) {
      expect(pass.bindings.length).toBeLessThanOrEqual(5);
    }
    expect(module.scratch).toEqual({ scanned: 100_000, blockSums: blockCount(100_000) });
  });

  it("scatter cost stops growing with the schema — the T1076 win, in dispatches", () => {
    const scatters = (attributes: ReadonlyArray<PointAttributeSchema>) => {
      const module = generateCompactionModule(attributes, 4096, layoutOf(attributes, 4096));
      if (!module.ok) throw new Error(module.errors.join("; "));
      return module.passes.filter((pass) => pass.name.startsWith("scatter")).length;
    };
    const wide = [
      ...SCHEMA,
      { name: "age", type: "f32" as const, default: [0] },
      { name: "tint", type: "vec4f" as const, default: [0, 0, 0, 0] },
      { name: "size", type: "f32" as const, default: [1] },
      { name: "flags", type: "u32" as const, default: [1] },
    ];
    // Four attributes cost two dispatches before, eight cost four; both cost one now.
    expect(scatters(SCHEMA)).toBe(1);
    expect(scatters(wide)).toBe(1);
  });

  it("contains no atomics anywhere — determinism is structural (§V74)", () => {
    const module = generateCompactionModule(SCHEMA, 4096, layoutOf(SCHEMA, 4096));
    if (!module.ok) throw new Error("expected module");
    for (const pass of module.passes) {
      expect(pass.wgsl, pass.name).not.toContain("atomic<");
      expect(pass.wgsl, pass.name).not.toMatch(/atomic(Add|Sub|Max|Min|And|Or|Xor|Exchange|CompareExchangeWeak|Load|Store)/);
    }
  });

  it("moves whole slots and never reads pointId — identity rides along (§V73)", () => {
    const layout = layoutOf(SCHEMA, 4096);
    const module = generateCompactionModule(SCHEMA, 4096, layout);
    if (!module.ok) throw new Error("expected module");
    const scatter = module.passes.find((pass) => pass.name === "scatter");
    /* T1076: the copy is word-wise inside the packed halves, at the id region's own base
       — position 16 B + velocity 16 B + life 4 B per point over 4096 points is byte
       147456, word 36864 — and both sides use the SAME layout, so a survivor's id lands
       in the slot its position does. */
    expect(layout.byName.get("id")?.offset).toBe(147456);
    expect(scatter?.wgsl).toContain(
      "out_points[36864u + destination * 1u] = in_points[36864u + index * 1u];",
    );
  });

  it("rejects a broken schema or capacity", () => {
    expect(generateCompactionModule([], 100, layoutOf(SCHEMA, 100)).ok).toBe(false);
    expect(generateCompactionModule(SCHEMA, 0, layoutOf(SCHEMA, 100)).ok).toBe(false);
  });

  it("sizes scratch buffers from the capacity", () => {
    expect(scratchBytes(SCAN_WORKGROUP_SIZE * 3 + 1)).toEqual({
      scanned: (SCAN_WORKGROUP_SIZE * 3 + 1) * 4,
      blockSums: 4 * 4,
      aliveCount: 4,
    });
  });
});

describe("CPU compaction reference", () => {
  it("keeps survivors in slot order and counts them", () => {
    const { compacted, aliveCount } = compactReference([1, 0, 1, 1, 0], ["a", "b", "c", "d", "e"]);
    expect(compacted).toEqual(["a", "c", "d"]);
    expect(aliveCount).toBe(3);
  });
});

describe("RNG reference (T120, §V74)", () => {
  it("is deterministic and sensitive to every key component", () => {
    const base = pointHashReference(7, 42, 100, 0);
    expect(pointHashReference(7, 42, 100, 0)).toBe(base);
    expect(pointHashReference(8, 42, 100, 0)).not.toBe(base);
    expect(pointHashReference(7, 43, 100, 0)).not.toBe(base);
    expect(pointHashReference(7, 42, 101, 0)).not.toBe(base);
    expect(pointHashReference(7, 42, 100, 1)).not.toBe(base);
  });

  it("stays in [0, 1) and spreads reasonably", () => {
    let sum = 0;
    for (let pointId = 0; pointId < 1000; pointId += 1) {
      const value = pointRandReference(7, pointId, 0, 0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      sum += value;
    }
    expect(sum / 1000).toBeGreaterThan(0.4);
    expect(sum / 1000).toBeLessThan(0.6);
  });
});
