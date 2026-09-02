import { describe, expect, it } from "vitest";
import { srgbToLinear } from "../../domain/parameters/resolve.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { effectFor, example, outputFor } from "./helpers.ts";

describe("E11 Gradient Remap", () => {
  const { document, plan } = example("E11-Gradient-Remap.loom.json");

  const storedStops = (): ReadonlyArray<{ position: number; color: readonly number[] }> => {
    const palette = document.graph.nodes["palette"] as GraphNode;
    return palette.parameters["stops"] as ReadonlyArray<{ position: number; color: readonly number[] }>;
  };
  const rampUniforms = (): Record<string, unknown> =>
    effectFor(plan, "palette").uniforms as Record<string, unknown>;

  /**
   * The example's reason to exist. Ramp into Lookup is THE way to recolour an image, and
   * with two stops it is a tinted greyscale — the pairing is worth very little until the
   * gradient is a palette. A file that drifted back to two stops would still compile,
   * still render, and stop demonstrating the capability it was built for.
   */
  it("recolours through a MULTI-STOP palette, not the two-colour degenerate case", () => {
    const stops = storedStops();
    expect(stops.length).toBeGreaterThan(2);
    // The count reaching the shader is the same count the document holds: a stop dropped
    // between the two is a colour the image silently loses.
    expect(rampUniforms()["count"]).toBe(stops.length);
  });

  /**
   * §V196, and the reason this example doubles as multi-stop Ramp's regression test.
   *
   * The stops are stored in DISPLAY space because that is what a picker hands over, and
   * the resolver decodes EVERY ENTRY on the way to the shader. The loop is the point: a
   * decode applied to entry zero and skipped for the rest is the failure §V196 names,
   * and it is invisible to anyone who checks one swatch and assumes the rest.
   */
  it("decodes EVERY stop to linear, not just the first", () => {
    const uniforms = rampUniforms();
    storedStops().forEach((stop, index) => {
      const packed = uniforms[`c${index}`] as readonly number[];
      expect(packed, `stop ${index}`).toHaveLength(4);
      for (const channel of [0, 1, 2]) {
        expect(packed[channel], `stop ${index} channel ${channel}`).toBeCloseTo(
          srgbToLinear(stop.color[channel] as number),
          10,
        );
      }
      // Alpha is coverage, not light: decoding it would make a half-transparent stop
      // compose differently from the number the author typed.
      expect(packed[3], `stop ${index} alpha`).toBe(stop.color[3]);
    });
  });

  /**
   * The absence of the plausible wrong answer, which is the half a "does it decode"
   * assertion misses: a SKIPPED decode leaves a number that is still a colour, still in
   * range, and still renders a gradient — just a washed-out one. Checked on a MIDDLE
   * stop, because that is the entry a per-entry bug reaches and a first-entry check does
   * not.
   */
  it("does not ship a MIDDLE stop undecoded", () => {
    const index = 2;
    const stored = storedStops()[index]?.color as readonly number[];
    const packed = rampUniforms()[`c${index}`] as readonly number[];
    // Every colour channel of this stop moved. If any of them still equals the stored
    // display value, that entry went through raw.
    for (const channel of [0, 1, 2]) {
      expect(packed[channel], `channel ${channel} is still display-space`).not.toBeCloseTo(
        stored[channel] as number,
        6,
      );
    }
  });

  /**
   * The two inputs are NOT interchangeable (the Lookup manifest's most opinionated line):
   * the source is the image whose shape survives, the lookup is the palette whose space
   * the output inherits. Swapped, this renders a palette-shaped image — so which resource
   * lands on which binding is a claim worth pinning.
   */
  it("indexes the NOISE through the RAMP, and not the other way round", () => {
    const remap = effectFor(plan, "remap");
    const bindings = new Map(
      (remap.textures ?? []).map((texture) => [texture.binding, texture.resourceId]),
    );
    const noiseOut = outputFor(plan, "field").resourceId;
    const rampOut = outputFor(plan, "palette").resourceId;

    expect(bindings.get("inputTexture")).toBe(noiseOut);
    expect(bindings.get("lookupTexture")).toBe(rampOut);
  });

  /**
   * Brightness is the index. Reading a single primary instead would put the palette in
   * the wrong places on a coloured source, and the picture would still look deliberate.
   */
  it("reads the source's LUMINANCE as the position along the gradient", () => {
    expect(effectFor(plan, "remap").uniforms?.["channel"]).toBe(0);
    expect(document.graph.nodes["remap"]?.parameters["channel"]).toBe("luminance");
  });
});
