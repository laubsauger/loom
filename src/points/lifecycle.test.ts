import { describe, expect, it } from "vitest";

import type { PointAttributeSchema } from "./attributes.ts";
import {
  SCAN_WORKGROUP_SIZE,
  blockCount,
  compactReference,
  generateCompactionModule,
  scratchBytes,
} from "./lifecycle.ts";
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

describe("compaction module structure (T119, §V74)", () => {
  it("emits scanLocal, the serial block scan, and chunked scatters", () => {
    const module = generateCompactionModule(SCHEMA, 100_000);
    expect(module.ok).toBe(true);
    if (!module.ok) return;

    expect(module.passes.map((pass) => pass.name)).toEqual([
      "scanLocal",
      "scanBlocks",
      "scatter:position+velocity",
      "scatter:life+id",
    ]);
    // §V24: each scatter chunk stays inside baseline storage-buffer limits.
    for (const pass of module.passes) {
      expect(pass.bindings.length).toBeLessThanOrEqual(7);
    }
    expect(module.scratch).toEqual({ scanned: 100_000, blockSums: blockCount(100_000) });
  });

  it("contains no atomics anywhere — determinism is structural (§V74)", () => {
    const module = generateCompactionModule(SCHEMA, 4096);
    if (!module.ok) throw new Error("expected module");
    for (const pass of module.passes) {
      expect(pass.wgsl, pass.name).not.toContain("atomic<");
      expect(pass.wgsl, pass.name).not.toMatch(/atomic(Add|Sub|Max|Min|And|Or|Xor|Exchange|CompareExchangeWeak|Load|Store)/);
    }
  });

  it("moves whole slots and never reads pointId — identity rides along (§V73)", () => {
    const module = generateCompactionModule(SCHEMA, 4096);
    if (!module.ok) throw new Error("expected module");
    const scatter = module.passes.find((pass) => pass.name.startsWith("scatter:life"));
    expect(scatter?.wgsl).toContain("out_id[destination] = in_id[index];");
  });

  it("rejects a broken schema or capacity", () => {
    expect(generateCompactionModule([], 100).ok).toBe(false);
    expect(generateCompactionModule(SCHEMA, 0).ok).toBe(false);
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
