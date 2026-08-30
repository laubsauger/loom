import { describe, expect, it } from "vitest";

import { pointTopologyNode } from "./point-topology.ts";
import { compileContext } from "./test-support.ts";

/** The topology half of the T302 split: pure edge-payload authorship. */
describe("pointTopology — the connectivity claim (T302)", () => {
  const edge = (capacity: number, topology: string) => ({
    points: { pairs: { position: "scratch:gen:position", color: "scratch:gen:color" }, capacity, topology },
  });

  it("republishes the upstream pairs BY REFERENCE with the authored claim (§V197)", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(4096, "points"),
        parameters: { connectivity: "grid", cols: 64, rows: 64, wrapU: true },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toEqual([]);
    expect(result.scratch ?? []).toEqual([]);
    expect(result.pointsets).toEqual({
      out: {
        pairs: { position: "scratch:gen:position", color: "scratch:gen:color" },
        capacity: 4096,
        topology: "grid:64x64:wrapU",
      },
    });
  });

  it("erases a claim too: connectivity=points strips a grid back to a cloud", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(4096, "grid:64x64:wrapUV"),
        parameters: { connectivity: "points" },
      }),
    );
    expect(result.pointsets?.["out"]?.topology).toBe("points");
  });

  it("refuses a claim the capacity cannot honour, at the point of authorship", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(100, "points"),
        parameters: { connectivity: "grid", cols: 64, rows: 64 },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.surface.topology");
    expect(result.diagnostics?.[0]?.message).toContain("4096");
    expect(result.diagnostics?.[0]?.message).toContain("100");
  });

  it("refuses an input with no edge payload", () => {
    const result = pointTopologyNode.compile(compileContext({ nodeId: "topo", inputs: ["points"] }));
    expect(result.diagnostics?.[0]?.code).toBe("node.points.edge");
  });
});
