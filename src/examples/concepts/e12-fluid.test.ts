import { describe, expect, it } from "vitest";
import { sourceReferenceName } from "../../domain/graph/source-references.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { sharedUniformsFromFrame } from "../../runtime/backend/shared-uniforms.ts";
import { messagesOf } from "../runner.ts";
import { effectFor, example, outputFor, valueGraphRun } from "./helpers.ts";
import type { Pointer } from "./helpers.ts";

describe("E12 Fluid", () => {
  const { document, plan } = example("E12-Fluid.loom.json");

  const ADVECT = "advect";
  const STIR = "stir";

  /**
   * The claim that separates this file from E2: a fluid has TWO states.
   *
   * E2's whole simulation lives in one ping-pong pair, because a chemistry generates its
   * pattern where the pattern is. A fluid CARRIES one — the velocity field is a state, the
   * dye is a state, and the only connection between them is that one is the coordinate the
   * other is sampled at. Collapse this to one loop and it stops being a fluid; it renders
   * fine and it is E2 with different constants.
   */
  it("keeps the velocity and the dye as two separate temporal states", () => {
    const pairs = plan.feedback.map((entry) => entry.nodeId).sort();
    expect(pairs).toEqual(["dye", "velocity"]);

    const advect = effectFor(plan, ADVECT);
    const bound = new Map((advect.textures ?? []).map((t) => [t.binding, t.resourceId]));
    // The DYE is the image being moved; the VELOCITY is the field moving it. Swapped, the
    // dye becomes a coordinate field and the picture is still a picture.
    expect(bound.get("inputTexture")).toBe(outputFor(plan, "dye").resourceId);
    expect(bound.get("displaceTexture")).toBe(outputFor(plan, STIR).resourceId);
  });

  /**
   * THE SIGN. Semi-Lagrangian advection samples UPSTREAM: the dye arriving here came from
   * `uv - v`. A positive weight samples downstream instead — the unstable forward scheme —
   * and the difference is not a crash or a black frame, it is a fluid that still flows and
   * blows itself apart over a minute. This is the parameter that dies first, so it is the
   * one that is pinned rather than the presence of the Displace node.
   *
   * `offset` is [0, 0] for the same reason: the field is SIGNED, so zero means "no motion".
   * At the 0.5 default the whole frame would slide diagonally for ever.
   */
  it("advects backward, against a signed velocity field", () => {
    const uniforms = effectFor(plan, ADVECT).uniforms as Record<string, readonly number[]>;
    const weight = uniforms["weight"] as readonly number[];

    expect(weight).toHaveLength(2);
    expect(weight[0]).toBeLessThan(0);
    expect(weight[1]).toBeLessThan(0);
    expect(uniforms["offset"]).toEqual([0, 0]);
  });

  /**
   * §V6, and the reason the velocity is not one frame stale: the kernel's output is the
   * texture that closes the velocity loop AND the field the dye is displaced by, rendered
   * once. Reading `vel1.out` instead would work and would put the dye a frame behind the
   * flow carrying it — invisible in a still, wrong in motion.
   */
  it("steers the dye with THIS frame's velocity, computed once", () => {
    const kernelPasses = plan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === STIR);
    expect(kernelPasses).toHaveLength(1);

    // T350 (§V285): the loop's back half is a NAME, so `edges` carries only the forward
    // consumer and the reference carries the other. Both halves are asserted, because it
    // is the PAIR of them that means "this frame's velocity, in both places".
    const wired = Object.values(document.graph.edges).filter((edge) => edge.source.nodeId === STIR);
    expect(wired.map((edge) => edge.target.nodeId).sort()).toEqual([ADVECT]);

    const velocity = document.graph.nodes["velocity"] as GraphNode;
    expect(sourceReferenceName(velocity.type, velocity.parameters)).toBe("stir1");
    expect(document.graph.nodes[STIR]?.label).toBe("stir1");
    // And the dye loop closes the same way, on the composite that injects the ink.
    const dye = document.graph.nodes["dye"] as GraphNode;
    expect(sourceReferenceName(dye.type, dye.parameters)).toBe("inject1");
  });

  /**
   * §V44/§V182: the stirring force reaches the shader through the shared frame block, which
   * is the only channel a kernel has to anything outside itself. The BINDING is the claim —
   * the node emits `sharedBinding` only because the source declares the block, so a kernel
   * that stopped reading the pointer would stop being handed one.
   */
  it("stirs from the shared frame block's pointer, not from a clock or a listener", () => {
    const stir = effectFor(plan, STIR);
    expect(stir.sharedBinding).toBe("frameU");
    expect(stir.shader).toContain("frameU.pointer");
    // The kernel has its own uniform too, so the stir strength is a live knob (§V5).
    expect(stir.uniformBinding).toBe("params");
  });

  /**
   * §V182 END TO END, and the assertion this example exists to make.
   *
   * The shader's vortex and the CPU's ink blob are two readers of ONE pointer. Here they
   * are compared at the same frame: the value the Mouse node published into `ink1.center`
   * and the value the shared uniform block carries into `frameU.pointer` must be the same
   * numbers, in the same order, with v the same way up.
   *
   * BEING EXACT ABOUT WHAT THIS CATCHES. Both halves are handed the same pointer struct
   * here, so this cannot prove the VIEWER publishes one — that is the publisher's own test.
   * What it proves is that neither reader transforms it on the way through: a Mouse node
   * that flipped v "for TD parity", or clamped, or reported pixels, would agree with
   * nothing and the ink would sit somewhere the vortex is not. That is the failure §V182
   * describes, and it is invisible in any test that looks at one half.
   */
  it("puts the ink in the eye of the vortex: one pointer, two readers", () => {
    const pointer: Pointer = { x: 0.32, y: 0.71, buttons: 1 };
    const { plan: live, frame } = valueGraphRun(document).hold(pointer, 3);

    expect(messagesOf(live.diagnostics)).toEqual([]);
    const centre = (effectFor(live, "ink").uniforms as Record<string, readonly number[]>)["center"];
    expect(centre).toEqual([pointer.x, pointer.y]);

    const shared = sharedUniformsFromFrame({
      frame,
      pointer,
      resolution: [document.settings.outputResolution.width, document.settings.outputResolution.height],
    });
    expect(shared.pointer.slice(0, 2)).toEqual([...(centre as readonly number[])]);
  });

  /**
   * The control case for the one above: with no pointer attached the blob is not merely
   * wrong, it is the retained centre (§V108). Without this, "the centre equals the pointer"
   * would also pass on a build where the centre happened to be 0.5 and the pointer was too.
   */
  it("falls back to the retained centre when nothing is driving it", () => {
    const centre = (effectFor(plan, "ink").uniforms as Record<string, readonly number[]>)["center"];
    expect(centre).toEqual([0.5, 0.5]);
    expect(centre).not.toEqual([0.32, 0.71]);
  });
});
