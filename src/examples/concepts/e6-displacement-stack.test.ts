import { describe, expect, it } from "vitest";
import { CompilerDiagnosticCode } from "../../compiler/index.ts";
import { example, outputFor, recompile, withFormat } from "./helpers.ts";

describe("E6 Displacement Stack", () => {
  const { document, plan } = example("E6-Displacement-Stack.loom.json");

  /**
   * §V56/§V57: the displacement branch is never colour-converted. Every node in it inherits
   * its format from its input, so the branch holds one space from Noise to Displace and the
   * numbers that arrive at `disp` are the numbers Noise produced.
   */
  it("keeps one space across the whole displacement stack", () => {
    for (const nodeId of ["field", "shape", "place"]) {
      expect(outputFor(plan, nodeId).space, nodeId).toBe("linear");
    }
    expect(outputFor(plan, "plate").space).toBe("linear");
    expect(outputFor(plan, "warp").space).toBe("linear");

    const mismatches = plan.diagnostics.filter(
      (d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch,
    );
    expect(mismatches).toEqual([]);
  });

  /**
   * T768/§V57c flipped this control's meaning, and the flip IS the claim now. `disp`
   * declares `space: "data"`, and a data input accepts ANY source space because reading
   * bytes as data converts nothing — so encoding the displacement branch is no longer a
   * mismatch AT ALL: the raw bytes are the offsets, whatever curve shaped them, and
   * that is the user's field to shape. The old "encoded disp gets caught" behaviour was
   * a symptom of `disp` being mistyped as colour.
   */
  it("accepts an encoded displacement branch without complaint — data reads raw (§V57c)", () => {
    const encoded = recompile(document, withFormat(document.graph, "place", "rgba8unorm-srgb"));
    const mismatches = encoded.diagnostics.filter(
      (d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch,
    );
    expect(mismatches).toEqual([]);
  });

  /**
   * Where the OLD control went: the mismatch is a MIXED-COLOUR-INPUTS warning, and with
   * `disp` honestly typed `data` (exempt from the mix by design), Displace has exactly
   * one colour input left — so no single-node format override in this document can
   * produce the warning any more. That is not lost coverage: the mix warning and the
   * data exemption are both pinned in `src/compiler/color-space.test.ts` ("warns on
   * mixed colour spaces", "exempts data inputs"), where a two-colour-input fixture
   * exists by construction. This document's claim is the two assertions above: one
   * space end to end, and an encoded field accepted raw.
   */

  /**
   * The `data` flag, which the shipped example deliberately does not use.
   *
   * §V56 says a texture carrying non-colour data is flagged `data` and bypasses every
   * conversion, and the compiler derives that flag from the format — `r32float` is the only
   * format in the catalogue that produces it. This is what that would look like, and it is
   * compile-only: the plan binds ONE shared LINEAR sampler to every texture, and r32float
   * is not filterable on a baseline Tier B device (it needs the optional
   * `float32-filterable` feature), so an example built this way would not render. The
   * shipped file takes the renderable path; the discipline is proven here instead.
   */
  it("flags an r32float displacement field as data, exempt from conversion", () => {
    /* T1067: this control is deliberately unrenderable — r32float through the plan's shared
       LINEAR sampler needs `float32-filterable`, which baseline Tier B does not have — so the
       expected code is declared. Every OTHER diagnostic still fails the recompile. */
    const asData = recompile(document, withFormat(document.graph, "field", "r32float"), [
      CompilerDiagnosticCode.bindingUnfilterable,
    ]);

    expect(asData.outputs.find((o) => o.nodeId === "field")?.space).toBe("data");
    // Inherited down the branch, so the whole stack stays data...
    expect(asData.outputs.find((o) => o.nodeId === "place")?.space).toBe("data");
    // ...and a data input beside a colour one is normal, not a mismatch.
    expect(
      asData.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch),
    ).toEqual([]);
    // The displaced image itself is still colour: Displace inherits from `source`.
    expect(asData.outputs.find((o) => o.nodeId === "warp")?.space).toBe("linear");
  });
});
