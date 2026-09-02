import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { CHANNEL_OPTIONS } from "../../nodes/definitions/parameter-readers.ts";
import { CENTRE, effectFor, example, outputFor, valueGraphRun } from "./helpers.ts";

/** §T897: drivers are chan-expressions now; read the channel address back out of one. */
function channelOf(source: string | undefined): string | undefined {
  const m = /op\('([^']+)'\)\.chan\.([A-Za-z0-9_]+)/.exec(source ?? "");
  if (m === null) return undefined;
  return m[2] === "value" ? m[1] : `${m[1]}:${m[2]}`;
}


describe("E26 Interference", () => {
  const { document, plan } = example("E26-Interference.loom.json");

  /**
   * §V6, and here it is not a footnote: the ring field is generated ONCE and read TWICE,
   * and the difference between those two readings IS the picture. If the fan-out were ever
   * compiled as two independent chains the image would be identical — and it would cost
   * twice as much and stop being a demonstration of anything.
   */
  it("generates the ring field once and consumes it twice", () => {
    const wrapPasses = plan.passes.filter((pass) => (pass as { nodeId?: string }).nodeId === "wrap");
    expect(wrapPasses).toHaveLength(1);

    const textures = (nodeId: string): ReadonlyArray<string> =>
      (effectFor(plan, nodeId).textures ?? []).map((entry) => entry.resourceId);

    const ringField = outputFor(plan, "wrap").resourceId;
    // One consumer reads it straight; the other reads it through the Transform.
    expect(textures("beat")).toContain(ringField);
    expect(textures("warp")).toContain(ringField);
    // ...and the Transform's own output is the OTHER half of the difference, so `beat`
    // is comparing the field against a moved copy of itself rather than against anything
    // new (which is the whole claim).
    expect(textures("beat")).toContain(outputFor(plan, "warp").resourceId);
  });

  /**
   * The value lives in RED all the way down — Circle's `distance` mode writes the signed
   * distance to red and leaves green and blue at zero. A Lookup left on its `luminance`
   * default would index the palette at 0.2126x the beat: a picture, dimmer, with the
   * contrast gone and every wire still correct.
   */
  it("indexes the palette on red, not on luminance", () => {
    const red = CHANNEL_OPTIONS.findIndex((option) => option.value === "red");
    expect(effectFor(plan, "tint").uniforms?.["channel"]).toBe(red);
    expect(red).not.toBe(CHANNEL_OPTIONS.findIndex((option) => option.value === "luminance"));
  });

  /**
   * ZIGZAG, not loop, and it is the anti-aliasing rather than a preference. A sawtooth has
   * a discontinuity on every ring; at an ~18px pitch those edges crawl under the drift.
   * The triangle wave is continuous, so the fine structure resolves instead of shimmering.
   * `clamp` — the parameter's own default — produces NO rings at all, which is the failure
   * this pins: a graph that compiles, renders, and shows a smooth gradient.
   */
  it("folds the distance field with a continuous triangle wave", () => {
    // LIMIT_MODE_OPTIONS is local to color.ts; the order is clamp, loop, zigzag, quantize.
    expect(effectFor(plan, "wrap").uniforms?.["mode"]).toBe(2);
    expect(effectFor(plan, "wrap").uniforms?.["low"]).toBe(0);
    expect(effectFor(plan, "wrap").uniforms?.["high"]).toBe(1);
  });

  /**
   * WHY THE SECOND COPY IS OFFSET AND SCALED AND NEVER ROTATED. Concentric rings are
   * rotationally symmetric about their own centre, so a rotation would leave the two
   * readings IDENTICAL and the difference exactly zero — a black frame with every wire
   * connected. What breaks the symmetry is the scale (concentric beats) and the drift
   * (hyperbolic fringes), so both are asserted present and the rotation is asserted absent.
   */
  it("breaks the ring symmetry by scale and offset, never by rotation", () => {
    const warp = document.graph.nodes["warp"] as GraphNode;
    expect(warp.parameters["r"]).toBe(0);
    expect(warp.parameters["s"]).toEqual([1.16, 1.16]);
    const channel = (key: string): string | undefined =>
      channelOf(
        (warp.parameters[key] as { bindings?: { expression?: { source?: string } } })?.bindings
          ?.expression?.source,
      );
    expect(channel("t.x")).toBe("driftx1");
    expect(channel("t.y")).toBe("drifty1");
  });

  /**
   * T402 at the value graph: the two drifts run at INCOMMENSURATE rates, so the offset
   * traces a Lissajous figure that does not close. Equal rates would draw a closed ellipse
   * and the piece would loop every twenty seconds — still animated, and much smaller.
   * (The pixel-level motion claim is in `examples.gpu.test.ts`; §V147 is explicit that this
   * one is not evidence for it.)
   */
  it("drifts on two rates that do not close", () => {
    const rate = (nodeId: string) => (document.graph.nodes[nodeId] as GraphNode).parameters["frequency"];
    expect(rate("driftx")).toBe(0.05);
    expect(rate("drifty")).toBe(0.031);
    expect(rate("driftx")).not.toBe(rate("drifty"));

    // ...and the values actually move, through the real session rather than the retained
    // half: a channel that stopped publishing resolves to 0 forever and every assertion
    // above still passes.
    const run = valueGraphRun(document);
    const seen = new Set<number>();
    for (let index = 0; index < 120; index += 1) {
      const { plan: framePlan } = run.step(CENTRE);
      const translate = effectFor(framePlan, "warp").uniforms?.["t"] as readonly number[] | undefined;
      seen.add(translate?.[1] ?? 0);
    }
    expect(seen.size).toBeGreaterThan(60);
  });
});
