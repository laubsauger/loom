import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T729 — E39 ROSETTE: the polar field is arithmetic, so it is asserted as arithmetic.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * §V688 says a polar warp is six existing nodes rather than a missing primitive, and the
 * three details that make it correct are all NUMBERS — an aspect divisor, a black level
 * derived from a radius, an extend mode. Every one of them can be wrong while the picture
 * stays a plausible mandala: an un-corrected aspect is an ellipse, a clamped radius is
 * dead corners, `repeat` instead of `mirror` is a stair-stepped seam. The look baseline
 * catches none of that at 192x108 (§V678), so it is claimed here or nowhere.
 */
describe("E39 Rosette claims", () => {
  const { document, plan } = example("E39-Rosette.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  const edges = Object.values(document.graph.edges);
  const ASPECT = 1280 / 720;

  /**
   * The whole point of §V688: no node in this graph knows the word "polar". Remap is fed a
   * FIELD, and the field is two generators packed by a Reorder. If `source` and `map` were
   * swapped the file would still compile and still render something round.
   */
  it("builds the uv field from two generators and hands it to Remap as the MAP, not the source", () => {
    expect(nodes["field"]?.type).toBe("reorder");
    // Red carries theta (input 1), green carries rho (input 2). Reversed, the rings and
    // the rays trade places and the figure turns inside out.
    expect(nodes["field"]?.parameters["outr"]).toBe("in1r");
    expect(nodes["field"]?.parameters["outg"]).toBe("in2r");
    const into = (target: string, port: string): string | undefined =>
      edges.find((e) => e.target.nodeId === target && e.target.portId === port)?.source.nodeId;
    expect(into("field", "in1")).toBe("angfix");
    expect(into("field", "in2")).toBe("depth");
    expect(into("warp", "map")).toBe("field");
    expect(into("warp", "source")).toBe("pick");
  });

  /**
   * §V688's first trap. `ramp(circular)` computes atan2 in UV space, so on 16:9 the rays
   * come out elliptically spaced; sampling the ramp through a transform scaled by 1/aspect
   * is exactly atan2(dv, du * aspect), the angle in PIXEL space. `aspectcorrect` must be
   * OFF or the transform re-introduces the very squash it is here to remove.
   */
  it("corrects the circular ramp's aspect by sampling it through a 1/aspect transform", () => {
    expect(nodes["ang"]?.parameters["type"]).toBe("circular");
    const scale = nodes["angfix"]?.parameters["s"] as readonly number[];
    expect(scale[0]).toBeCloseTo(1 / ASPECT, 10);
    expect(scale[1]).toBe(1);
    expect(nodes["angfix"]?.parameters["aspectcorrect"]).toBe(false);
    expect(nodes["angfix"]?.parameters["r"]).toBe(0);
  });

  /**
   * §V688's second trap, and the reason rho does not come from `ramp(radial)`: that node
   * is `clamp(length(uv - 0.5) * 2, 0, 1)`, so the corners pin flat. Circle's distance mode
   * emits `k * (rNorm - 1)` with `k = min(radius.x/aspect, radius.y)`, so the Level that
   * recovers normalised radius has EXACTLY one correct black level (§V147 — derived, not
   * toleranced). Any other value silently rescales the whole radial axis.
   */
  it("recovers unclamped radius with the black level Circle's own geometry implies", () => {
    expect(nodes["rad"]?.type).toBe("circle");
    expect(nodes["rad"]?.parameters["mode"]).toBe("distance");
    const radius = nodes["rad"]?.parameters["radius"] as readonly number[];
    const k = Math.min((radius[0] ?? 0) / ASPECT, radius[1] ?? 0);
    expect(nodes["depth"]?.parameters["blacklevel"]).toBeCloseTo(-k, 10);
    expect(nodes["depth"]?.parameters["whitelevel"]).toBe(0);
  });

  /**
   * §V688's third trap. Rho runs past 1 toward the corners; `repeat` FRACTS it, which is a
   * discontinuity and renders as a stair-stepped arc. Mirror folds, which is continuous.
   * That rho can exceed 1 at all needs the float working format.
   */
  it("folds the radial wrap instead of cutting it, in a format that can carry rho past 1", () => {
    expect(nodes["warp"]?.parameters["extend"]).toBe("mirror");
    expect(document.settings.workingFormat).toBe("rgba16float");
  });

  /**
   * §V694, as a gate rather than as a paragraph. A positive black level is a SUBTRACTION
   * and nothing clamps it in float, so the bloom that reads "keep only the highlights"
   * sends every darker pixel negative and the Add composite that consumes it comes out
   * DARKER than its other input. `haze1` must threshold with gamma, which cannot cross zero.
   */
  it("thresholds the bloom with gamma and never with a black level", () => {
    expect(nodes["haze"]?.parameters["blacklevel"]).toBe(0);
    expect(nodes["haze"]?.parameters["gamma1"] as number).toBeLessThan(1);
  });

  /**
   * §V411/§V363 and E27's exact argument: the Switch SELECTS a branch, it does not prune
   * the other, so `movieFileIn` is compiled while the understudy plays. The order is
   * load-bearing and it is asserted the way E27 asserts it — by also showing that the ids
   * would have sorted the OTHER way, so a dropped `order` would open on the video branch.
   */
  it("opens on the understudy by DECLARED order, not by how the ids happen to sort", () => {
    const inputs = edges
      .filter((e) => e.target.nodeId === "pick" && e.target.portId === "inputs")
      .map((e) => ({ from: e.source.nodeId, order: e.order }));
    expect(inputs.find((e) => e.from === "stand")?.order).toBe(0);
    expect(inputs.find((e) => e.from === "clip")?.order).toBe(1);
    expect(nodes["pick"]?.parameters["index"]).toBe(0);
    // "clip" sorts before "stand", so id order would have played the black video branch.
    expect(["stand", "clip"].slice().sort()[0]).toBe("clip");
    // And the node is genuinely in the plan, which is the gate B39 escaped.
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "clip")).toBe(true);
  });
});
