import { describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

describe("E16 Murmuration", () => {
  const { document, plan } = example("E16-Murmuration.loom.json");

  /**
   * T401/B57's claim, in the shipped file: processors CHAIN. Each kernel binds its
   * immediate upstream's position pair; the renderer draws the LAST kernel's. Before
   * T401 the second link could not exist.
   */
  it("chains sphere -> flock -> part -> birds by pair bindings", () => {
    const dispatchFor = (nodeId: string) =>
      plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === nodeId) as {
        buffers?: ReadonlyArray<{ binding: string; resourceId: string; half?: "read" | "write" }>;
      };
    /* T1076: a kernel binds one PACKED buffer per producer it reads from, plus its own
       write half — so the chain shows as which BUFFERS a link touches, in binding order,
       rather than as one `in_<attribute>` per attribute. */
    const buffersFor = (nodeId: string) =>
      (dispatchFor(nodeId).buffers ?? []).map((buffer) => `${buffer.resourceId}:${buffer.half ?? "read"}`);
    expect(buffersFor("flock")).toContain(`${pointStorageId("sphere")}:write`);
    expect(buffersFor("flock")).toContain(`${pointStorageId("flock")}:write`);
    expect(buffersFor("part")).toContain(`${pointStorageId("flock")}:write`);
    // …and never two links back: `part` reads the flock, not the sphere.
    expect(buffersFor("part")).not.toContain(`${pointStorageId("sphere")}:write`);
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      buffers?: ReadonlyArray<{ resourceId: string }>;
    };
    expect(draw.buffers?.[0]?.resourceId).toBe(pointStorageId("part"));
  });

  /**
   * The kernel's OWN state is what makes a processor still a simulation (§V197): offset
   * and velocity are not carried by the sphere, so they bind the flock's own pairs.
   */
  it("keeps offset and velocity as the flock's own persistent pairs", () => {
    const dispatch = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "flock") as {
      buffers?: ReadonlyArray<{ binding: string; resourceId: string; half?: "read" | "write" }>;
    };
    /* T1076: `offset` and `velocity` are regions of the flock's OWN packed pair, so what
       shows in the plan is the flock binding its own READ half — the pre-frame state the
       sphere cannot supply. An upstream-only kernel would bind no read half of its own. */
    const halves = (dispatch.buffers ?? []).map((buffer) => `${buffer.resourceId}:${buffer.half ?? "read"}`);
    expect(halves).toContain(`${pointStorageId("flock")}:read`);
    expect(halves).toContain(`${pointStorageId("flock")}:write`);
  });

  /**
   * §V197's narrowing, live: `part` declares only position, so the colour the renderer
   * maps is the FLOCK's tint pair, two nodes upstream — one buffer, zero copies.
   */
  it("maps colour from the flock's tint ACROSS the part kernel, by reference", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
      uniforms?: Record<string, unknown>;
    };
    expect(draw.buffers?.some((buffer) => buffer.resourceId === pointStorageId("flock"))).toBe(true);
    // Mapped means OUT of the uniform block (T364).
    expect(draw.uniforms?.["color"]).toBeUndefined();
  });

  /** T333: the stray cull is a draw-time predicate over the typed edge, in the shader. */
  it("culls strays with the group predicate at draw time", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as { shader: string };
    expect(draw.shader).toContain("groupMatch");
    expect(draw.shader).toContain("length(p.position) < 1.7");
    const group = (document.graph.nodes["birds"] as GraphNode).parameters["group"];
    expect(group).toBe("length(p.position) < 1.7");
  });
});
