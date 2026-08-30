import { describe, expect, it } from "vitest";

import { formatTopology, gridCellCounts, gridPointCount, parseTopology } from "./topology.ts";

/** The T302 vocabulary: one grammar, parsed and formatted by the same module. */
describe("point topology grammar (T302)", () => {
  it("round-trips every form through parse ∘ format", () => {
    for (const value of ["points", "grid:64x64", "grid:48x24:wrapU", "grid:3x9:wrapV", "grid:48x24:wrapUV"]) {
      const parsed = parseTopology(value);
      expect(parsed, value).not.toBeNull();
      expect(formatTopology(parsed as NonNullable<typeof parsed>)).toBe(value);
    }
  });

  it("treats an absent claim as points, and an unknown one as null — never a guess", () => {
    expect(parseTopology(undefined)).toEqual({ kind: "points" });
    expect(parseTopology("grid:64")).toBeNull();
    expect(parseTopology("grid:64x64:wrapQ")).toBeNull();
    expect(parseTopology("mesh:whatever")).toBeNull();
  });

  it("counts cells per axis: a wrapped axis gains its seam cell", () => {
    const open = parseTopology("grid:48x24");
    const tube = parseTopology("grid:48x24:wrapU");
    const torus = parseTopology("grid:48x24:wrapUV");
    if (open?.kind !== "grid" || tube?.kind !== "grid" || torus?.kind !== "grid") throw new Error("parse failed");
    expect(gridCellCounts(open)).toEqual({ cellsU: 47, cellsV: 23 });
    expect(gridCellCounts(tube)).toEqual({ cellsU: 48, cellsV: 23 });
    expect(gridCellCounts(torus)).toEqual({ cellsU: 48, cellsV: 24 });
    expect(gridPointCount(torus)).toBe(48 * 24);
  });
});
