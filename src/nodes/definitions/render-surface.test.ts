import { describe, expect, it } from "vitest";

import { renderSurfaceNode } from "./render-surface.ts";
import { compileContext } from "./test-support.ts";

/**
 * RenderSurface at the fixture level (T301): the analytic-topology contract. The
 * pixels-on-Dawn half lives in `src/runtime/backend/vgpu/render-surface.gpu.test.ts`.
 */

type DrawShape = {
  kind: string;
  instances: number;
  vertexCount: number;
  buffers: Array<{ binding: string; resourceId: string; half: string }>;
  uniforms: Record<string, number | readonly number[]>;
};

const gridEdge = (cols: number, rows: number, capacity = cols * rows) => ({
  points: {
    pairs: { position: { pair: "scratch:gen:position", half: "write" as const } },
    capacity,
    topology: `grid:${cols}x${rows}`,
  },
});

describe("renderSurface — the topology contract (T301)", () => {
  it("derives its vertex count from the edge's grid — six vertices per cell", () => {
    const result = renderSurfaceNode.compile(
      compileContext({ nodeId: "surf", inputs: ["points"], pointsets: gridEdge(48, 24) }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as DrawShape;
    expect(pass.kind).toBe("draw");
    expect(pass.instances).toBe(1);
    expect(pass.vertexCount).toBe(47 * 23 * 6);
    expect(pass.uniforms["cols"]).toBe(48);
    expect(pass.uniforms["rows"]).toBe(24);
    expect(pass.buffers).toEqual([
      { binding: "positions", resourceId: "scratch:gen:position", half: "write" },
    ]);
    expect(renderSurfaceNode.depthOutputs).toEqual(["out"]);
  });

  it("closes wrapped seams: a wrapped axis contributes its seam cell (T302)", () => {
    const result = renderSurfaceNode.compile(
      compileContext({
        nodeId: "surf",
        inputs: ["points"],
        pointsets: {
          points: {
            pairs: { position: { pair: "scratch:gen:position", half: "write" as const } },
            capacity: 48 * 24,
            topology: "grid:48x24:wrapUV",
          },
        },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as DrawShape;
    expect(pass.vertexCount).toBe(48 * 24 * 6);
    expect(pass.uniforms["wrapU"]).toBe(1);
    expect(pass.uniforms["wrapV"]).toBe(1);
  });

  it("REFUSES a pointset without grid topology, naming what was published", () => {
    const result = renderSurfaceNode.compile(
      compileContext({
        nodeId: "surf",
        inputs: ["points"],
        pointsets: {
          points: {
            pairs: { position: { pair: "scratch:gen:position", half: "write" as const } },
            capacity: 256,
            topology: "points",
          },
        },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.surface.topology");
    expect(result.diagnostics?.[0]?.message).toContain('"points"');
  });

  it("refuses a topology that addresses more points than the edge carries", () => {
    const result = renderSurfaceNode.compile(
      compileContext({ nodeId: "surf", inputs: ["points"], pointsets: gridEdge(64, 64, 100) }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.surface.topology");
    expect(result.diagnostics?.[0]?.message).toContain("4096");
  });

  it("refuses an edge with no payload at all — topology is the producer's claim", () => {
    const result = renderSurfaceNode.compile(compileContext({ nodeId: "surf", inputs: ["points"] }));
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.surface.topology");
  });
});
