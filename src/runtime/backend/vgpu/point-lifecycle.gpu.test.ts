import { describe, expect, it } from "vitest";
import { compute, frame, storage, uniforms } from "vgpu/node";
import { init } from "vgpu/node";

import {
  SCAN_WORKGROUP_SIZE,
  compactReference,
  generateCompactionModule,
  scratchBytes,
} from "../../../points/lifecycle.ts";
import { generateKernelModule } from "../../../points/codegen.ts";
import { pointRandReference } from "../../../points/rng.ts";
import type { PointAttributeSchema } from "../../../points/attributes.ts";
import { probeDawn } from "./node-gpu-host.ts";

/**
 * T119/T120 on a REAL device: the generated lifecycle passes must produce exactly what
 * `compactReference` predicts, and the WGSL RNG must agree with the CPU mirror to the
 * last f32 bit. These are the §V74 claims — deterministic compaction, identity-keyed
 * randomness — executed rather than asserted.
 *
 * Fails LOUDLY when Dawn is unavailable (parity-track precedent): a lifecycle test that
 * silently skips on a GPU-less machine is a green light that proves nothing.
 */

const CAPACITY = 1000; // multi-block on purpose: exercises the serial block scan

const SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

describe("point lifecycle on Dawn (T119/T120, §V73/§V74)", () => {
  it("compacts exactly as the CPU reference predicts, ids riding their points", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const module = generateCompactionModule(SCHEMA, CAPACITY);
    expect(module.ok).toBe(true);
    if (!module.ok) return;

    // Deterministic kill pattern from the reference RNG itself.
    const flags = Array.from({ length: CAPACITY }, (_, index) =>
      pointRandReference(7, index, 0, 0) < 0.7 ? 1 : 0,
    );
    const positions = Array.from({ length: CAPACITY }, (_, index) => [index, index * 2, index * 3]);
    const ids = Array.from({ length: CAPACITY }, (_, index) => index);

    const gpu = await init();
    try {
      const params = uniforms(gpu, { capacity: CAPACITY });
      const scratch = scratchBytes(CAPACITY);

      const flagsBuffer = storage(gpu, CAPACITY * 4, "read");
      flagsBuffer.write(new Uint32Array(flags));
      const scanned = storage(gpu, scratch.scanned, "read-write");
      const blockSums = storage(gpu, scratch.blockSums, "read-write");
      const aliveCount = storage(gpu, scratch.aliveCount, "read-write");

      const positionData = new Float32Array(CAPACITY * 4); // vec3f strides 16 bytes
      positions.forEach((value, index) => positionData.set(value, index * 4));
      const inPosition = storage(gpu, CAPACITY * 16, "read");
      inPosition.write(positionData);
      const outPosition = storage(gpu, CAPACITY * 16, "read-write");
      const inId = storage(gpu, CAPACITY * 4, "read");
      inId.write(new Uint32Array(ids));
      const outId = storage(gpu, CAPACITY * 4, "read-write");

      const bindingsByName: Record<string, unknown> = {
        params,
        flags: flagsBuffer,
        scanned,
        blockSums,
        aliveCount,
        in_position: inPosition,
        out_position: outPosition,
        in_id: inId,
        out_id: outId,
      };

      const pipelines = module.passes.map((pass) => {
        const set: Record<string, unknown> = { params };
        for (const binding of pass.bindings) set[binding.name] = bindingsByName[binding.name];
        return { pass, pipeline: compute(gpu, pass.wgsl, { set }) };
      });

      frame(gpu, () => {
        for (const { pass, pipeline } of pipelines) {
          pipeline.dispatch(pass.dispatch === "single" ? 1 : Math.ceil(CAPACITY / SCAN_WORKGROUP_SIZE));
        }
      });

      const expectedIds = compactReference(flags, ids);
      const expectedPositions = compactReference(flags, positions);

      const gotCount = new Uint32Array(await aliveCount.read())[0] ?? 0;
      expect(gotCount).toBe(expectedIds.aliveCount);

      const gotIds = [...new Uint32Array(await outId.read())].slice(0, gotCount);
      expect(gotIds).toEqual(expectedIds.compacted);

      const gotPositionsRaw = new Float32Array(await outPosition.read());
      const gotPositions = Array.from({ length: gotCount }, (_, index) => [
        gotPositionsRaw[index * 4],
        gotPositionsRaw[index * 4 + 1],
        gotPositionsRaw[index * 4 + 2],
      ]);
      expect(gotPositions).toEqual(expectedPositions.compacted);
    } finally {
      gpu.dispose();
    }
  });

  it("the WGSL RNG agrees with the CPU mirror bit for bit (§V74)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const schema: ReadonlyArray<PointAttributeSchema> = [
      { name: "id", type: "u32", semantic: "id", default: [0] },
      { name: "sample", type: "f32", default: [0] },
    ];
    const module = generateKernelModule({
      attributes: schema,
      reads: ["id"],
      writes: ["sample"],
      kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.sample = pointRand(p.id, 3u);
  return q;
}`,
    });
    expect(module.ok).toBe(true);
    if (!module.ok) return;

    const count = 512;
    const seed = 7;
    const frameIndex = 42;

    const gpu = await init();
    try {
      const kernelFrame = uniforms(gpu, {
        timeSeconds: 0,
        deltaSeconds: 1 / 60,
        frameIndex,
        seed,
        count,
      });
      const ids = Array.from({ length: count }, (_, index) => index * 17 + 3);
      const inId = storage(gpu, count * 4, "read");
      inId.write(new Uint32Array(ids));
      const inSample = storage(gpu, count * 4, "read");
      const outSample = storage(gpu, count * 4, "read-write");

      const set: Record<string, unknown> = { kernelFrame, in_id: inId, in_sample: inSample, out_sample: outSample };
      const pipeline = compute(gpu, module.wgsl, { set });
      frame(gpu, () => pipeline.dispatch(Math.ceil(count / module.workgroupSize)));

      const got = new Float32Array(await outSample.read());
      for (let index = 0; index < count; index += 1) {
        expect(got[index], `point ${index}`).toBe(pointRandReference(seed, ids[index] ?? 0, frameIndex, 3));
      }
    } finally {
      gpu.dispose();
    }
  });
});
