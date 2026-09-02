import { describe, expect, it } from "vitest";
import { messagesOf } from "../runner.ts";
import { effectFor, example, outputFor, recompile, withFormat } from "./helpers.ts";

describe("E4 Bloom", () => {
  const { document, plan } = example("E4-Bloom.loom.json");

  /** Every node the file overrides to rgba16float, named once and used by both directions. */
  const HDR_NODES = ["hot", "floor", "bright", "glow", "tint", "combine"] as const;

  /**
   * §V51: the per-node override is what keeps over-range highlights alive. The project is
   * 8-bit on purpose — without the overrides the first target clips and the bloom flattens.
   */
  it("carries the bloom branch at rgba16float over an 8-bit project", () => {
    expect(document.settings.workingFormat).toBe("rgba8unorm");
    expect(outputFor(plan, "source").format).toBe("rgba8unorm");
    for (const nodeId of HDR_NODES) {
      expect(outputFor(plan, nodeId).format, nodeId).toBe("rgba16float");
    }
  });

  /**
   * The control case. Without it, the assertion above would also pass on a build where the
   * override was ignored and everything happened to be rgba16float for some other reason.
   *
   * T518 note: the list has to be EVERY overridden node, not a memorable subset. `combine`
   * inherits its format from `in1` — which is `tint` — so leaving one node's override in
   * place while stripping the others would let the format propagate back down the chain
   * and the control case would pass while proving nothing.
   */
  it("collapses to the project format when the overrides are removed", () => {
    let graph = document.graph;
    for (const nodeId of HDR_NODES) {
      graph = withFormat(graph, nodeId, undefined);
    }
    const plain = recompile(document, graph);

    expect(messagesOf(plain.diagnostics)).toEqual([]);
    for (const nodeId of HDR_NODES) {
      expect(plain.outputs.find((o) => o.nodeId === nodeId)?.format, nodeId).toBe("rgba8unorm");
    }
  });

  /**
   * T518 — THE CLAMP IS LOAD-BEARING, and this is the assertion that says so.
   *
   * A Level's black point is a subtraction, so everything under it becomes NEGATIVE. An
   * 8-bit target clamps those away for free; an rgba16float target — which §V51's override
   * is here to give us — keeps them. `add` is `front + back`, so without a clamp the
   * composite SUBTRACTS the glow wherever the base is dark, which is everywhere the glow
   * is visible. Measured on Dawn before the fix: the composite's 90th-percentile luma was
   * 0.004 while the glow layer feeding it measured 0.771 — an add that came out darker
   * than its own input, with every structural assertion green (§V361).
   */
  it("clamps the level's negative floor before the composite", () => {
    expect(document.graph.nodes["floor"]?.type).toBe("limit");
    expect(document.graph.nodes["floor"]?.parameters["mode"]).toBe("clamp");
    expect(document.graph.nodes["floor"]?.parameters["low"]).toBe(0);
    // ...and it sits BETWEEN the level and both consumers, not off to one side.
    const from = (id: string) =>
      Object.values(document.graph.edges)
        .filter((e) => e.source.nodeId === id)
        .map((e) => e.target.nodeId)
        .sort();
    expect(from("hot")).toEqual(["floor"]);
    expect(from("floor")).toEqual(["bright", "combine"]);
  });

  /**
   * The threshold sits ABOVE 1.0 — where an 8-bit target would have clipped — so what it
   * isolates is exactly what the format override bought. At the shipped-before 0.9 it was
   * isolating values an rgba8unorm target could have represented perfectly well, which is
   * why deleting the overrides used to dim the example rather than break it.
   */
  it("thresholds above the 8-bit ceiling, so only over-range values pass", () => {
    const bright = document.graph.nodes["bright"];
    const threshold = bright?.parameters["threshold"] as number;
    const softness = bright?.parameters["softness"] as number;
    expect(threshold).toBeGreaterThan(1);
    // The softness band must not reach down far enough to let a CLIPPED 1.0 through.
    expect(threshold - softness / 2).toBeGreaterThan(1 - 0.05);
  });

  /** Two branches converge on one Add, and the shared half is computed once (§V6). */
  it("converges two branches that share one computed source", () => {
    expect(plan.passes.filter((p) => p.kind === "effect" && p.nodeId === "hot")).toHaveLength(1);
    expect(plan.passes.filter((p) => p.kind === "effect" && p.nodeId === "floor")).toHaveLength(1);

    const combine = effectFor(plan, "combine");
    const bound = (combine.textures ?? []).map((binding) => binding.resourceId);
    expect(bound).toHaveLength(2);
    expect(new Set(bound).size).toBe(2);
    expect(bound).toContain(outputFor(plan, "tint").resourceId);
    expect(bound).toContain(outputFor(plan, "floor").resourceId);
  });

  /**
   * §V147/T402 — the source has a TIME AXIS. This is not a style note: `speed` advances
   * the field's FOURTH dimension, so on a 2D noise type there is no parameter anywhere in
   * the product that could make this file move, and it shipped that way (measured mean
   * |Δ| of exactly 0.00 between every pair of captured frames). A type check is the only
   * assertion that can distinguish "static because nobody set a speed" from "static
   * because it structurally cannot move".
   */
  it("animates on a noise type that HAS a fourth dimension", () => {
    const source = document.graph.nodes["source"];
    expect(source?.parameters["type"]).toBe("perlin4d");
    expect(source?.parameters["speed"]).not.toBe(0);
    // Off the 4D lattice plane, where the field's amplitude collapses and frame 0 would
    // be systematically flatter than every frame after it (a thumbnail is frame 0).
    expect(source?.parameters["t4d"]).not.toBe(0);
  });
});
