import { describe, expect, it } from "vitest";
import { compute, createMockAdapter, frame, init, storage, uniforms } from "vgpu/mock";

import { generateKernelModule } from "../../../points/codegen.ts";
import { attributeBufferBytes, type PointAttributeSchema } from "../../../points/attributes.ts";

/**
 * T117, the half string tests cannot cover: the generated point-kernel module must be
 * REAL WGSL — parseable by vgpu's reflection, with bindings that reflect to the layout
 * the codegen reported, dispatchable through a frame. A typo in the generated text
 * fails here, not in the first point node three tracks later.
 *
 * Lives in the vgpu adapter directory because it must import `vgpu/mock` directly
 * (§V3): the codegen module itself stays pure and headless in `src/points/**`.
 */

const SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let jitter = pointRand(p.id, 7u);
  q.velocity += vec3f(0.0, -9.8 * jitter, 0.0) * ctx.delta;
  q.position += q.velocity * ctx.delta;
  return q;
}`;

describe("generated point WGSL against real reflection (T117)", () => {
  it("reflects, binds and dispatches through vgpu", async () => {
    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: ["position", "velocity", "id"],
      writes: ["position", "velocity"],
      kernel: KERNEL,
    });
    expect(module.ok).toBe(true);
    if (!module.ok) return;

    const gpu = await init({ adapter: createMockAdapter({ features: [] }) });
    try {
      const capacity = 256;
      const kernelFrame = uniforms(gpu, {
        timeSeconds: 0,
        deltaSeconds: 1 / 60,
        frameIndex: 0,
        seed: 7,
        count: capacity,
      });

      const buffers: Record<string, unknown> = { kernelFrame };
      for (const binding of module.buffers) {
        const attribute = SCHEMA.find((entry) => entry.name === binding.attribute);
        if (!attribute) throw new Error(`unknown attribute ${binding.attribute}`);
        buffers[binding.variable] = storage(
          gpu,
          attributeBufferBytes(attribute.type, capacity),
          binding.access === "read" ? "read" : "read-write",
        );
      }

      // compute() runs vgpu's WGSL reflection immediately: a syntax error or a binding
      // the shader does not declare throws here.
      const pipeline = compute(gpu, module.wgsl, { set: buffers });
      frame(gpu, () => {
        pipeline.dispatch(Math.ceil(capacity / module.workgroupSize));
      });
    } finally {
      gpu.dispose();
    }
  });
});
