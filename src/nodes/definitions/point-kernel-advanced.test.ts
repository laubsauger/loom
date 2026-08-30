import { describe, expect, it } from "vitest";

import { pointKernelAdvancedNode, liveCountBufferId } from "./point-kernel-advanced.ts";
import { renderPointsNode } from "./points.ts";
import { pointPairId } from "./points.ts";
import { compileContext } from "./test-support.ts";

/**
 * The advanced kernel at the fixture level (T322): pass order, the §V231 inversion,
 * the counted edge, and the indirect consumer. The kills-actually-compact half — on
 * VALUES, not buffer ids — lives in
 * `src/runtime/backend/vgpu/point-kernel-advanced.gpu.test.ts`.
 */

type PassShape = {
  id: string;
  buffers: Array<{ binding: string; resourceId: string; half?: string }>;
};

describe("pointKernelAdvanced — kill and compact (T322)", () => {
  it("emits kernel, tail clear, scan, and scatter — in that order, nothing else", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 1000 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const ids = (result.passes as PassShape[]).map((pass) => pass.id.slice("sim:".length));
    expect(ids[0]).toBe("kernel");
    expect(ids[1]).toBe("clearDeadTail");
    expect(ids[2]).toBe("scanLocal");
    expect(ids[3]).toBe("scanBlocks");
    expect(ids.slice(4).every((id) => id.startsWith("scatter:"))).toBe(true);
  });

  it("scatter reads the write halves and lands in the READ halves (§V231's inversion)", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const scatters = (result.passes as PassShape[]).filter((pass) => pass.id.includes("scatter"));
    expect(scatters.length).toBeGreaterThan(0);
    for (const pass of scatters) {
      for (const binding of pass.buffers) {
        if (binding.binding.startsWith("in_")) expect(binding.half, binding.binding).toBe("write");
        if (binding.binding.startsWith("out_")) expect(binding.half, binding.binding).toBe("read");
      }
    }
    // And the pairs opt out of the compiler's swap: the data is already where next
    // frame reads it.
    for (const entry of result.scratch ?? []) {
      if (entry.kind === "bufferPair") expect(entry.swap, entry.key).toBe(false);
    }
  });

  it("publishes READ halves and the GPU-resident count — the payload, not a convention", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const out = result.pointsets?.["out"];
    expect(out?.count).toEqual({ buffer: liveCountBufferId("sim") });
    expect(out?.capacity).toBe(256);
    for (const [attribute, entry] of Object.entries(out?.pairs ?? {})) {
      expect(entry.half, attribute).toBe("read");
    }
    // The lifecycle flag is internal; the edge does not offer it as an attribute.
    expect(out?.pairs["alive"]).toBeUndefined();
  });

  it("refuses a schema that declares the injected alive flag", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: { attributes: '[{"name":"alive","type":"u32","default":[1]}]' },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.attributes");
  });
});

describe("renderPoints on a counted edge (T322)", () => {
  it("converts the live count to draw arguments and draws indirect", () => {
    const result = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        pointsets: {
          points: {
            pairs: { position: { pair: pointPairId("sim", "position"), half: "read" } },
            capacity: 256,
            topology: "points",
            count: { buffer: liveCountBufferId("sim") },
          },
        },
        parameters: { count: 100 },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const [args, draw] = result.passes as [
      PassShape & { uniforms: Record<string, number> },
      { instances: unknown; buffers: Array<{ binding: string; half?: string }> },
    ];
    expect(args.id).toBe("draw:drawArgs");
    expect(args.uniforms).toEqual({ vertexCount: 6, maxInstances: 100 });
    expect(draw.instances).toEqual({ indirect: pointPairId("draw", "drawArgs") });
    // The payload's half, not the old convention: a compacted producer says "read".
    expect(draw.buffers[0]?.half).toBe("read");
    expect(result.scratch).toEqual([
      { kind: "buffer", key: "drawArgs", stride: 4, capacity: 4, usage: "indirect" },
    ]);
  });
});
