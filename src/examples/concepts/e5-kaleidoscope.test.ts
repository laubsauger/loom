import { describe, expect, it } from "vitest";
import { EXTEND_OPTIONS } from "../../nodes/definitions/parameter-readers.ts";
import { effectFor, example, outputFor } from "./helpers.ts";

describe("E5 Kaleidoscope", () => {
  const { document, plan } = example("E5-Kaleidoscope.loom.json");

  /** §V50: a per-node resolution override, inherited by the whole chain below it. */
  it("runs the chain at an overridden resolution, not the project's", () => {
    expect(document.settings.outputResolution).toEqual({ width: 1280, height: 720 });
    for (const nodeId of ["source", "fold", "facets", "spin"]) {
      expect(outputFor(plan, nodeId).size, nodeId).toEqual([2048, 2048]);
    }
  });

  /**
   * The extend modes are the example. They are invisible in the middle of the frame and
   * decide everything at the edges, which is where a kaleidoscope lives.
   */
  it("uses three different edge behaviours across the chain", () => {
    const index = (value: string) => EXTEND_OPTIONS.findIndex((option) => option.value === value);

    expect(effectFor(plan, "fold").uniforms?.["extend"]).toBe(index("mirror"));
    expect(effectFor(plan, "spin").uniforms?.["extend"]).toBe(index("repeat"));
    // Tile does its own mirroring rather than going through `extend`.
    expect(effectFor(plan, "facets").uniforms?.["mirror"]).toEqual([1, 1]);
    expect(index("mirror")).not.toBe(index("repeat"));
  });
});
