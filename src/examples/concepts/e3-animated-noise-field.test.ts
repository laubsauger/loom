import { describe, expect, it } from "vitest";
import { NOISE_TYPE_OPTIONS } from "../../nodes/shaders/noise.wgsl.ts";
import { effectFor, example, outputFor } from "./helpers.ts";

describe("E3 Animated Noise Field", () => {
  const { document, plan } = example("E3-Animated-Noise-Field.loom.json");

  /**
   * §V44: time reaches the shader through the shared frame block and nowhere else. The
   * pass binding it is the observable end of the `FrameEvaluationInput` contract — no node
   * can reach a clock (lint-enforced), so this binding IS how the field animates.
   *
   * §V436/T497: and it is the ABSOLUTE member. This example is the one whose entire point is
   * a field that scrolls, and on `frameU.time` it snapped back to its frame-zero slice at
   * every lap — invisible in a screenshot, invisible in a still render, visible the moment
   * anyone bounded the piece and let it play.
   */
  it("drives the fourth noise dimension from the frame block, not a clock", () => {
    const pass = effectFor(plan, "field");
    expect(pass.sharedBinding).toBe("frameU");
    expect(pass.shader).toContain("struct SharedFrame");
    expect(pass.shader).toContain("frameU.absTime");
    expect(pass.shader).not.toContain("frameU.time");

    const perlin4d = NOISE_TYPE_OPTIONS.findIndex((option) => option.value === "perlin4d");
    expect(pass.uniforms?.["ntype"]).toBe(perlin4d);
    // speed 0 is a still image (TD's default). An animated example must not ship one.
    expect(pass.uniforms?.["speed"]).not.toBe(0);
  });

  /** §V6: one output, two consumers, one pass — and both consumers read the same texture. */
  it("renders the fanned-out noise exactly once", () => {
    const noisePasses = plan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === "field");
    expect(noisePasses).toHaveLength(1);

    const consumers = Object.values(document.graph.edges).filter(
      (edge) => edge.source.nodeId === "field",
    );
    expect(consumers).toHaveLength(2);

    const fieldResource = outputFor(plan, "field").resourceId;
    const shape = effectFor(plan, "shape");
    const warp = effectFor(plan, "warp");
    expect(shape.textures?.some((binding) => binding.resourceId === fieldResource)).toBe(true);
    expect(warp.textures?.some((binding) => binding.resourceId === fieldResource)).toBe(true);
  });
});
