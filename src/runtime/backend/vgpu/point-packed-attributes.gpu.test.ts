import { describe, expect, it } from "vitest";

import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";
import { compileGraph } from "../../../compiler/compile.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { pointStorageId } from "../../../nodes/definitions/point-storage.ts";
import { readPointAttribute } from "../../../nodes/definitions/test-support.ts";
import { packAttributes } from "../../../points/packing.ts";
import type { PointAttributeSchema } from "../../../points/attributes.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1076 — EIGHT ATTRIBUTES, ON A REAL DEVICE, THROUGH THE REAL BACKEND.
 *
 * This graph could not be built before this ticket. Point storage was one buffer per
 * attribute, a kernel spent 2n storage bindings for n attributes, and WebGPU's baseline is
 * 8 per stage — so five attributes was a refusal and (before the refusal existed, B33) a
 * silently dead pipeline. Packing made the count independent of n; the ceiling is now the
 * bytes one binding may carry.
 *
 * What is asserted is what a CONSUMER reads back, at three different seams, because a
 * region offset can be wrong in three different ways and each renders plausibly:
 *
 *  1. every attribute's own VALUES, exact, out of its own region — an offset one region
 *     off hands back the neighbouring attribute, which is real data of the right shape;
 *  2. the drawn PICTURE, from a vec4f attribute five regions into the packed buffer,
 *     bound to a vertex-stage `array<vec4f>` whose WGSL never changed — the seam that
 *     lets a renderer read a slice of a packed buffer at all;
 *  3. the binding COUNT, which is the ticket: two, for eight attributes.
 *
 * Every value is an integer or a half-representable fraction, so the equalities are EXACT
 * (§V147) rather than a tolerance band.
 */

const COUNT = 4;

/**
 * Every type in the attribute union, in one schema. `vec3f` (stride 16) beside `f32` and
 * `u32` (stride 4) and `vec2f` (stride 8) is the case that decided the packed element type:
 * a uniform vec4 stride would cost the three scalars four times their own width.
 */
const SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "life", type: "f32", semantic: "life", default: [1] },
  { name: "span", type: "vec2f", default: [0, 0] },
  { name: "tint", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "age", type: "f32", default: [0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
  { name: "tag", type: "vec4u", default: [0, 0, 0, 0] },
];

/**
 * Writes an analytically derived value into every attribute, keyed off the slot.
 *
 * Point 0 goes to the LEFT half of the frame carrying a red tint, point 1 to the RIGHT
 * carrying green; points 2 and 3 are parked far off-screen so the picture has exactly two
 * subjects. The tints are the load-bearing half of claim (2): red and green have an EXACT
 * zero in the other's channel, so a draw that bound the wrong region would have to produce
 * that zero by accident.
 */
const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = f32(ctx.index);
  let left = ctx.index == 0u;
  let right = ctx.index == 1u;
  q.position = select(vec3f(40.0, 40.0, 0.0), select(vec3f(0.5, 0.0, 0.0), vec3f(-0.5, 0.0, 0.0), left), left || right);
  q.velocity = vec3f(i, i * 2.0, i * 4.0);
  q.life = i * 0.25;
  q.span = vec2f(i + 8.0, i + 16.0);
  q.tint = select(vec4f(0.0, 0.0, 0.0, 1.0), select(vec4f(0.0, 1.0, 0.0, 1.0), vec4f(1.0, 0.0, 0.0, 1.0), left), left || right);
  q.age = i * 0.5 + 1.0;
  q.id = ctx.index * 7u + 3u;
  q.tag = vec4u(ctx.index, ctx.index + 10u, ctx.index + 20u, ctx.index + 30u);
  return q;
}`;

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never as BackendCapabilities;

const graph = {
  revision: 1,
  nodes: {
    sim: {
      id: "sim",
      type: "pointKernel",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: { capacity: COUNT, seed: 7, kernel: KERNEL, attributes: JSON.stringify(SCHEMA) },
    },
    draw: {
      id: "draw",
      type: "renderPoints",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {
        count: COUNT,
        sizePixels: 8,
        blend: "additive",
        // T364: the colour comes from the `tint` ATTRIBUTE — the fifth region of the
        // packed buffer, bound to a vertex-stage `array<vec4f>` at its own byte offset.
        color: { mode: "map", bindings: { map: { kind: "map", attribute: "tint" } } },
      },
    },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
  },
  edges: {
    e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
    e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  },
  groups: {},
} as never as GraphDocument;

describe("T1076 — eight point attributes on Dawn, which two bindings used to cost eight", () => {
  it("renders, and every attribute reads back EXACTLY out of its own region", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    /* CLAIM 3, before anything runs: the kernel spends TWO storage buffers for eight
       attributes — its own packed read half and its own write half. Sixteen, before. */
    const kernel = plan.passes.find((pass) => (pass as { nodeId?: string }).nodeId === "sim") as {
      buffers?: ReadonlyArray<{ resourceId: string; half?: string }>;
    };
    expect(kernel.buffers?.map((binding) => `${binding.resourceId}:${binding.half}`)).toEqual([
      `${pointStorageId("sim")}:read`,
      `${pointStorageId("sim")}:write`,
    ]);

    /* …and the draw binds ONE REGION of that same buffer for the colour, at the offset
       the layout puts `tint` at — five regions in, not zero. */
    const layout = packAttributes(SCHEMA, COUNT);
    if (!layout.ok) throw new Error(layout.errors.join("; "));
    const tintRegion = layout.byName.get("tint");
    /* Hand-checkable: at four points the widest region is 64 bytes, so the 256-byte
       alignment every region base must satisfy dominates and each attribute starts one
       step after the last. `tint` is the fifth, at 4 × 256. */
    expect(layout.regions.map((region) => region.offset)).toEqual([0, 256, 512, 768, 1024, 1280, 1536, 1792]);
    expect(tintRegion?.offset).toBe(1024);
    const drawPass = plan.passes.find((pass) => pass.kind === "draw") as {
      buffers?: ReadonlyArray<{ binding: string; resourceId: string; offset?: number; bytes?: number }>;
    };
    const colors = drawPass.buffers?.find((binding) => binding.binding === "mapColors");
    expect(colors?.resourceId).toBe(pointStorageId("sim"));
    expect(colors?.offset).toBe(tintRegion?.offset);
    expect(colors?.bytes).toBe(16 * COUNT);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      /* CLAIM 1: every attribute, out of its OWN region, exact. An offset one region off
         would hand back the neighbour — real numbers of the right shape, and wrong. */
      const read = (name: string) => readPointAttribute(backend.readBuffer, "sim", SCHEMA, COUNT, name);

      const position = (await read("position")).floats;
      expect([...position.slice(0, 8)]).toEqual([-0.5, 0, 0, 0, 0.5, 0, 0, 0]);

      const velocity = (await read("velocity")).floats;
      // Slot i: (i, 2i, 4i) — every value distinct from position's, so the two cannot
      // be confused for one another by a reader that landed on the wrong region.
      expect([0, 1, 2, 3].map((slot) => [...velocity.slice(slot * 4, slot * 4 + 3)])).toEqual([
        [0, 0, 0],
        [1, 2, 4],
        [2, 4, 8],
        [3, 6, 12],
      ]);

      // The scalars, at their natural 4-byte stride — the case that decided `array<u32>`.
      expect([...(await read("life")).floats.slice(0, COUNT)]).toEqual([0, 0.25, 0.5, 0.75]);
      expect([...(await read("age")).floats.slice(0, COUNT)]).toEqual([1, 1.5, 2, 2.5]);

      // vec2f at stride 8 — the only attribute whose stride divides neither 4 nor 16.
      expect([...(await read("span")).floats.slice(0, COUNT * 2)]).toEqual([8, 16, 9, 17, 10, 18, 11, 19]);

      const tint = (await read("tint")).floats;
      expect([...tint.slice(0, 8)]).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);

      // The unsigned regions, read as u32 rather than reinterpreted floats (§V73's id).
      expect([...(await read("id")).words.slice(0, COUNT)]).toEqual([3, 10, 17, 24]);
      expect([...(await read("tag")).words.slice(0, 8)]).toEqual([0, 10, 20, 30, 1, 11, 21, 31]);

      /* CLAIM 2: the PICTURE. The colour came off a vertex-stage `array<vec4f>` bound to
         the `tint` region — WGSL unchanged since before packing existed. Point 0 sits at
         clip x = −0.5 wearing pure red, point 1 at +0.5 wearing pure green, and additive
         blending onto black keeps the other channel at EXACTLY zero. A draw that bound
         the buffer at byte 0 would be colouring by `position`, whose components are
         −0.5/0/0 and 0.5/0/0 — nothing like these two. */
      const image = await backend.readOutput(plan.outputs.find((output) => output.nodeId === "draw")?.resourceId ?? "");
      const bytes = image.bytes;
      let redLeft = 0;
      let greenRight = 0;
      let wrongSide = 0;
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          const at = (y * 64 + x) * 4;
          const r = bytes[at] ?? 0;
          const g = bytes[at + 1] ?? 0;
          if (r === 0 && g === 0) continue;
          if (x < 32) {
            expect(g, `left pixel ${x},${y} green`).toBe(0);
            if (r > 0) redLeft += 1;
            else wrongSide += 1;
          } else {
            expect(r, `right pixel ${x},${y} red`).toBe(0);
            if (g > 0) greenRight += 1;
            else wrongSide += 1;
          }
        }
      }
      // Both subjects drawn, both on their own side. An 8 px sprite covers 64 pixels;
      // asserting "some, and fewer than the frame" keeps the claim about WHERE and WHAT
      // rather than about the rasterizer's exact coverage.
      expect(redLeft).toBeGreaterThan(0);
      expect(greenRight).toBeGreaterThan(0);
      expect(wrongSide).toBe(0);
      expect(redLeft + greenRight).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });
});
