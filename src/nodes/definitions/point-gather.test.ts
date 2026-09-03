import { describe, expect, it } from "vitest";

import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { pointGatherNode } from "./point-gather.ts";
import { compileContext } from "./test-support.ts";

/**
 * Gather (T1071) — the COMPILE CONTRACT: the edge payload every downstream node reads, and
 * the refusals that decide what is allowed to reach a device at all.
 *
 * The arithmetic — what a weighted mean of three neighbours actually IS — is pinned by
 * value on Dawn in `runtime/backend/vgpu/point-gather.gpu.test.ts`. What lives here is the
 * half a GPU cannot answer: that the aggregate is published TOGETHER WITH its source
 * (§V883), that the stride is DERIVED rather than asked for, and that each refusal fires on
 * the wrong thing WITHOUT swallowing the legitimate case beside it — the bar a guard is
 * held to here, because a refusal that also refuses the valid case is a bug with a message.
 */

const LINKS = (k: number, capacity = 8) => ({
  pairs: {
    position: { pair: "scratch:web:position", half: "write" as const, type: "vec3f" },
    tip: { pair: "scratch:web:tip", half: "write" as const, type: "vec3f" },
    tint: { pair: "scratch:web:tint", half: "write" as const, type: "vec4f" },
    neighbor: { pair: "scratch:web:neighbor", half: "write" as const, type: "u32" },
  },
  capacity: capacity * k,
});

const POINTS = {
  pairs: {
    position: { pair: "scratch:gen:position", half: "write" as const, type: "vec3f" },
    tint: { pair: "scratch:gen:tint", half: "read" as const, type: "vec4f" },
    id: { pair: "scratch:gen:id", half: "write" as const, type: "u32" },
  },
  capacity: 8,
  topology: "grid:4x2",
};

const compile = (parameters: Record<string, string | number>, links = LINKS(4), points: object = POINTS) =>
  pointGatherNode.compile(
    compileContext({
      nodeId: "gath",
      inputs: ["links", "points"],
      pointsets: { links, points } as never,
      parameters,
    }),
  );

/** Message AND suggestion: a refusal that names the fix in the suggestion still names it. */
const messages = (result: { diagnostics?: ReadonlyArray<{ message: string; suggestion?: string }> }): string =>
  (result.diagnostics ?? []).map((entry) => `${entry.message} ${entry.suggestion ?? ""}`).join(" | ");

describe("pointGather — a reduction over an adjacency (T1071)", () => {
  it("publishes the aggregate TOGETHER WITH its source (§V883) and owns exactly one pair (§V197)", () => {
    const result = compile({ attribute: "tint", reduce: "mean", output: "nbrTint" });
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.pointsets).toEqual({
      out: {
        pairs: {
          // Every incoming attribute BY REFERENCE — the aggregate cannot be lifted off the
          // population it was measured over, because they arrive on one edge.
          position: { pair: "scratch:gen:position", half: "write", type: "vec3f" },
          tint: { pair: "scratch:gen:tint", half: "read", type: "vec4f" },
          id: { pair: "scratch:gen:id", half: "write", type: "u32" },
          nbrTint: { pair: "scratch:gath:nbrTint", half: "write", type: "vec4f" },
        },
        capacity: 8,
        // Measuring a neighbourhood moves no slot, so the lattice claim survives.
        topology: "grid:4x2",
      },
    });
    expect(result.scratch).toEqual([{ key: "nbrTint", kind: "bufferPair", stride: 16, capacity: 8 }]);
  });

  it("DERIVES the stride from the two capacities — K is a fact about the link set, not a knob", () => {
    // 8 points, 32 links = 8 per point. Nothing asked, nothing to keep in step (T1053).
    const pass = compile({ attribute: "position", reduce: "sum" }, LINKS(8)).passes[0] as DispatchPassDescriptor;
    expect(pass.shader).toContain("const K: u32 = 8u;");
    expect(pass.id).toContain(":k8");
    const four = compile({ attribute: "position", reduce: "sum" }, LINKS(4)).passes[0] as DispatchPassDescriptor;
    expect(four.shader).toContain("const K: u32 = 4u;");
    // A different K is a different PROGRAM (§V62b) — the stride is baked, so two plans at
    // two strides can never share a pipeline.
    expect(four.id).not.toBe(pass.id);
  });

  it("refuses two edges that are not a link set and its source, and names both capacities", () => {
    const result = compile({ attribute: "position" }, LINKS(4, 5));
    expect(messages(result)).toContain("whole number of links per point");
    expect(messages(result)).toContain("20");
    expect(messages(result)).toContain("8");
    expect(result.passes).toEqual([]);
    // AND the legitimate case beside it still compiles: 8 points to 16 links is K = 2, and
    // a guard that refused this would have made the node unusable at every even stride.
    expect(compile({ attribute: "position" }, LINKS(2)).diagnostics ?? []).toEqual([]);
  });

  it("refuses a links edge with no neighbour SLOT — an adjacency that only says where is not one", () => {
    const noSlot = { pairs: { ...LINKS(4).pairs }, capacity: 32 } as { pairs: Record<string, unknown> };
    delete noSlot.pairs["neighbor"];
    const result = compile({ attribute: "position" }, noSlot as never);
    expect(messages(result)).toContain('carries no "neighbor" slot attribute');
    // It lists what the edge DOES carry, because the whole error class is a producer that
    // predates the slot (§V288: refuse by name, say what is there).
    expect(messages(result)).toContain("tint");
  });

  it("refuses a WEIGHTED reduction of an integer attribute, and still allows Min and Max over it", () => {
    const averaged = compile({ attribute: "id", reduce: "mean" });
    expect(messages(averaged)).toContain("weighted average of an integer attribute is not a value");
    expect(averaged.passes).toEqual([]);
    // THE LEGITIMATE CASE THE GUARD COULD HAVE SWALLOWED: min-of-neighbour-id is label
    // propagation, the standard connected-components step, and it is meaningful on exactly
    // the type the refusal above rejects. Refusing it too would have been the guard eating
    // the use case it exists beside.
    const smallest = compile({ attribute: "id", reduce: "min", output: "label" });
    expect(smallest.diagnostics ?? []).toEqual([]);
    expect(smallest.pointsets?.["out"]?.pairs["label"]).toMatchObject({ type: "u32" });
  });

  it("refuses an output name that would RETYPE an attribute the points already carry", () => {
    // Publishing a gathered f32 under "tint" would leave every downstream map swizzling a
    // vec4f that is now one float — silently, which is the failure §V288 exists to refuse.
    const retype = compile({ reduce: "degree", output: "tint" });
    expect(messages(retype)).toContain("would change the type");
    // But REPLACING an attribute with a gather OF THE SAME TYPE is the point of the node —
    // "smooth my colour over my neighbours" is spelled exactly this way.
    const smoothed = compile({ attribute: "tint", reduce: "mean", output: "tint" });
    expect(smoothed.diagnostics ?? []).toEqual([]);
    expect(smoothed.pointsets?.["out"]?.pairs["tint"]).toEqual({
      pair: "scratch:gath:tint",
      half: "write",
      type: "vec4f",
    });
  });

  it("names what the points DO carry when the gathered attribute is absent", () => {
    const result = compile({ attribute: "velocity" });
    expect(messages(result)).toContain('reads "velocity"');
    expect(messages(result)).toContain("id, position, tint");
  });

  it("binds the strength buffer only when a weight is read (§V309)", () => {
    const weighted = compile({ attribute: "position", reduce: "mean", weight: "strength" })
      .passes[0] as DispatchPassDescriptor;
    expect(weighted.buffers?.map((b) => b.binding)).toEqual([
      "in_link_neighbor",
      "in_link_strength",
      "in_attr",
      "out_value",
    ]);
    // An unweighted min never touches the strength, so it never binds it — the feature
    // costs nothing on the path that does not use it.
    const plain = compile({ attribute: "position", reduce: "min", weight: "uniform" })
      .passes[0] as DispatchPassDescriptor;
    expect(plain.buffers?.map((b) => b.binding)).toEqual(["in_link_neighbor", "in_attr", "out_value"]);
    // And Degree reads no attribute at all: it measures the links, not the points.
    const degree = compile({ reduce: "degree", output: "degree" }).passes[0] as DispatchPassDescriptor;
    expect(degree.buffers?.map((b) => b.binding)).toEqual(["in_link_neighbor", "in_link_strength", "out_value"]);
    expect(degree.shader).not.toContain("in_attr");
  });

  it("reads every input at the half its edge names — §V887 is free here, and this is why", () => {
    const pass = compile({ attribute: "tint", reduce: "sum" }).passes[0] as DispatchPassDescriptor;
    // `tint` arrives on the READ half of the producer's pair; the gather must bind THAT
    // half, not a half of its own choosing. Every read is from an input buffer and nothing
    // reads what this pass writes, so there is no before/after for a reader to straddle.
    expect(pass.buffers).toContainEqual({ binding: "in_attr", resourceId: "scratch:gen:tint", half: "read" });
    expect(pass.buffers).toContainEqual({
      binding: "in_link_neighbor",
      resourceId: "scratch:web:neighbor",
      half: "write",
    });
    expect(pass.buffers).toContainEqual({ binding: "out_value", resourceId: "scratch:gath:gathered", half: "write" });
  });
});
