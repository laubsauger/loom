import { describe, expect, it } from "vitest";
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
        buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
      };
    const bindingOf = (nodeId: string, name: string) =>
      dispatchFor(nodeId).buffers?.find((buffer) => buffer.binding === name);
    expect(bindingOf("flock", "in_position")?.resourceId).toBe("scratch:sphere:position");
    expect(bindingOf("flock", "out_position")?.resourceId).toBe("scratch:flock:position");
    expect(bindingOf("part", "in_position")?.resourceId).toBe("scratch:flock:position");
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      buffers?: ReadonlyArray<{ resourceId: string }>;
    };
    expect(draw.buffers?.[0]?.resourceId).toBe("scratch:part:position");
  });

  /**
   * The kernel's OWN state is what makes a processor still a simulation (§V197): offset
   * and velocity are not carried by the sphere, so they bind the flock's own pairs.
   */
  it("keeps offset and velocity as the flock's own persistent pairs", () => {
    const dispatch = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "flock") as {
      buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
    };
    for (const name of ["offset", "velocity"]) {
      expect(
        dispatch.buffers?.find((buffer) => buffer.binding === `in_${name}`)?.resourceId,
        name,
      ).toBe(`scratch:flock:${name}`);
    }
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
    expect(draw.buffers?.some((buffer) => buffer.resourceId === "scratch:flock:tint")).toBe(true);
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
