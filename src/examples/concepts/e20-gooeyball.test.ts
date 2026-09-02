import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

describe("E20 Gooeyball", () => {
  const { document, plan } = example("E20-Gooeyball.loom.json");

  /**
   * T417's crossing, link by link: grid positions into the ball kernel, ball positions
   * into the bridge, the bridge's sample INTO the goo kernel from upstream (T401), goo
   * positions into the surface. One buffer per attribute, zero copies.
   */
  it("chains grid -> ball -> bridge -> goo -> surface by pair bindings", () => {
    const buffersOf = (nodeId: string, kind: "dispatch" | "draw") =>
      (plan.passes.find((pass) => pass.kind === kind && (pass as { nodeId?: string }).nodeId === nodeId) as {
        buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
      }).buffers;
    const binding = (nodeId: string, kind: "dispatch" | "draw", name: string) =>
      buffersOf(nodeId, kind)?.find((buffer) => buffer.binding === name)?.resourceId;

    expect(binding("ball", "dispatch", "in_position")).toBe("scratch:sheet:position");
    expect(binding("bridge", "dispatch", "in_position")).toBe("scratch:ball:position");
    expect(binding("goo", "dispatch", "in_position")).toBe("scratch:ball:position");
    // The 2D->3D crossing itself: the goo kernel reads the BRIDGE's sample pair.
    expect(binding("goo", "dispatch", "in_sample")).toBe("scratch:bridge:sample");
    // And the surface draws the goo's positions.
    const draw = plan.passes.find(
      (pass) => pass.kind === "draw" && (pass as { id: string }).id.includes(":scene:"),
    ) as { buffers?: ReadonlyArray<{ resourceId: string }> };
    expect(draw.buffers?.some((buffer) => buffer.resourceId === "scratch:goo:position")).toBe(true);
  });

  /**
   * The seam is a CLAIM (T302): the topology node moves no point — it emits no pass at
   * all — and the surface's uniforms carry the wrap it authored.
   */
  it("closes the ring with a topology claim, not geometry", () => {
    expect(plan.passes.some((pass) => (pass as { nodeId?: string }).nodeId === "claim")).toBe(false);
    // T429: the surface now draws through the scene Render, whose grid uniform packs
    // cols/rows/wrapU/wrapV — the wrap still arrives from the claim, third slot.
    const draw = plan.passes.find(
      (pass) => pass.kind === "draw" && (pass as { id: string }).id.includes(":scene:"),
    ) as {
      uniforms?: Record<string, unknown>;
    };
    const grid = draw.uniforms?.["grid"] as number[];
    expect(grid[2]).toBe(1); // wrapU: the seam cell
    expect(grid[3]).toBe(0);
  });

  /**
   * T429, the owner's complaint answered where tests can see it: the SAME field that
   * displaces the ball paints it — the palette-looked-up noise is the material's albedo
   * map, the raw noise its roughness map, and both arrive on the render's draw as bound
   * textures. One field, three uses.
   */
  it("paints the ball with the displacement field: albedo and roughness maps bound", () => {
    const draw = plan.passes.find(
      (pass) => pass.kind === "draw" && (pass as { id: string }).id.includes(":scene:"),
    ) as {
      textures?: ReadonlyArray<{ binding: string; resourceId: string }>;
      shader: string;
    };
    expect(draw.textures?.some((t) => t.binding === "albedoMap" && t.resourceId === "target:paint:out")).toBe(true);
    expect(draw.textures?.some((t) => t.binding === "roughnessMap" && t.resourceId === "target:wobble:out")).toBe(true);
    expect(draw.shader).toContain("albedoMap");
    // TWO lights reached the shader, one of them the orbiting fill.
    expect(draw.shader).toContain("light1Meta");
    const fill = document.graph.nodes["fill"] as GraphNode;
    const slot = fill.parameters["position.x"] as { mode?: string; bindings?: { driven?: { channel?: string } } };
    expect(slot.mode).toBe("driven");
    expect(slot.bindings?.driven?.channel).toBe("orbitx1");
  });

  /** B14's lesson, pinned again: animated goo needs a 4D noise with speed set. */
  it("drives the goo from a noise that actually moves", () => {
    const noise = document.graph.nodes["wobble"] as GraphNode;
    expect(noise.parameters["type"]).toBe("perlin4d");
    expect(noise.parameters["speed"]).not.toBe(0);
  });

  /** The displacement is radial IN THE SHADER SOURCE the document ships. */
  it("displaces along the normal — normalize(position) — by the centred sample", () => {
    const goo = document.graph.nodes["goo"] as GraphNode;
    const kernel = goo.parameters["kernel"] as string;
    expect(kernel).toContain("normalize(p.position)");
    expect(kernel).toContain("p.sample.r - 0.5");
  });

  /**
   * B85 closed, in the shipped bytes: the ball kernel takes the grid off the EDGE.
   *
   * The bug was five copies of one number — `cols: 64` on the grid, `cols: 64` on the
   * topology claim, and `64u` twice inside the WGSL — so turning the visible knob left the
   * kernel parametrising a grid it was no longer running over. Silent, and still a
   * picture. The assertion is therefore about ABSENCE: no dimension may appear in the
   * kernel text at all, because a literal is what the knob cannot reach (§V349).
   */
  it("reads the grid from ctx.dim instead of retyping it (T472, B85)", () => {
    const ball = document.graph.nodes["ball"] as GraphNode;
    const kernel = ball.parameters["kernel"] as string;
    const body = kernel.replace(/\/\*[\s\S]*?\*\//g, ""); // the comment may say 64u; the CODE may not
    expect(body).toContain("ctx.dim.cols");
    expect(body).toContain("ctx.dim.rows");
    expect(body).toContain("ctx.dim.i");
    expect(body).toContain("ctx.dim.j");

    // The knob it now follows is the one the user can see, on the node upstream — and
    // ITS value is what may not appear in the shader, which is B85 stated exactly.
    const sheet = document.graph.nodes["sheet"] as GraphNode;
    expect(sheet.parameters["cols"]).toBe(64);
    expect(sheet.parameters["rows"]).toBe(64);
    expect(body, "a dimension typed into the kernel is B85 coming back").not.toContain(
      String(sheet.parameters["cols"]),
    );
    // The generated module is where the 64 lives now — written once, by the compiler,
    // from the topology string the grid published.
    const ballPass = plan.passes.find(
      (pass) => pass.kind === "dispatch" && (pass as { nodeId?: string }).nodeId === "ball",
    ) as { shader: string };
    expect(ballPass.shader).toContain("PointDim(64u, 64u, index % 64u, index / 64u)");
  });
});
