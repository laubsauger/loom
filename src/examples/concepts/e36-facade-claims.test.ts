import { describe, expect, it } from "vitest";
import type { CompiledGraph } from "../../compiler/index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { example, recompile as sharedRecompile } from "./helpers.ts";

describe("E36 Facade claims", () => {
  const { document, plan } = example("E36-Facade.loom.json");

  /* T1067: was a local compile against a BARE `exampleRegistry()` — the same trap helpers.ts
     carried, one file over. It goes through the shared `recompile` now, which uses this
     example's own component-aware pair and refuses a severed or diagnosing plan. */
  const recompile = (mutate: (graph: GraphDocument) => void): CompiledGraph => {
    const graph = structuredClone(document.graph) as GraphDocument;
    mutate(graph);
    return sharedRecompile(document, graph);
  };

  const litPass = (compiled: CompiledGraph, id: string): DrawPassDescriptor => {
    const pass = compiled.passes.find((entry) => entry.id === id);
    if (pass === undefined || pass.kind !== "draw") throw new Error(`no lit draw ${id}`);
    return pass;
  };

  /**
   * §V681 — THE OVERLAP IS A SUM, asserted as WIRING rather than as pixels.
   *
   * The blend zone's whole claim is superposition: two projectors landing on one wall
   * contribute independently and add. The Dawn gate (projector-render.gpu.test.ts)
   * already pins the ARITHMETIC exactly — 0.4 + 0.4 lands 0.8 to the byte — so what an
   * example claim must hold is the wiring above it: referencing BOTH projectors compiles
   * to exactly the union of referencing each alone. Slot 0 of the pair must carry
   * projL's matrix and brightness untouched by projR's presence, and slot 1 must carry
   * projR's exactly as it compiles solo. The failure this catches is structural — a
   * list-order bug, an index collision, one pose contaminating the other — which renders
   * a plausible blend zone that is not the sum of anything (§V712's family: a still
   * frame, and even the baseline, would read fine).
   */
  it("compiles the two-projector wall as the exact union of each projector alone", () => {
    const both = litPass(plan, "shot#shot:scene:0");
    const onlyLeft = litPass(
      recompile((graph) => {
        (graph.nodes["shot"]!.parameters as Record<string, unknown>)["projectors"] = "projL1";
      }),
      "shot#shot:scene:0",
    );
    const onlyRight = litPass(
      recompile((graph) => {
        (graph.nodes["shot"]!.parameters as Record<string, unknown>)["projectors"] = "projR1";
      }),
      "shot#shot:scene:0",
    );
    for (const field of ["Matrix", "Pos", "Color", "Meta"]) {
      expect(both.uniforms?.[`projector0${field}`], `projector0${field}`).toEqual(
        onlyLeft.uniforms?.[`projector0${field}`],
      );
      expect(both.uniforms?.[`projector1${field}`], `projector1${field}`).toEqual(
        onlyRight.uniforms?.[`projector0${field}`],
      );
    }
    // And each solo compile carries no phantom second slot.
    expect(litPass(recompile((graph) => {
      (graph.nodes["shot"]!.parameters as Record<string, unknown>)["projectors"] = "projL1";
    }), "shot#shot:scene:0").uniforms?.["projector1Matrix"]).toBeUndefined();
  });

  /**
   * §V681 — THE OCCLUSION TRACKS THE POSE, or it is a baked shadow.
   *
   * The cornice fingers are re-derived from the projector's pose every compile: the
   * depth sweep renders the scene from the projector's own frustum, and the lit read
   * compares through THE SAME matrix. Move the projector and both must move together —
   * a baked shadow (the depth matrix frozen while the lit matrix moves, or vice versa)
   * renders plausible fingers that stop corresponding to the throw, and no still frame
   * can tell (§V712/§V717: the baseline reads identically). So the claim is the
   * correspondence itself: after moving projL's eye in the DOCUMENT, the sweep's
   * lightViewProjection and the lit draw's projector0Matrix are equal to each other and
   * both differ from the shipped pose's matrix.
   */
  it("re-derives the occlusion sweep from the moved pose — depth and lit read one matrix", () => {
    const movedEye = [-1.1, 1.7, 6] as const;
    const moved = recompile((graph) => {
      (graph.nodes["projL"]!.parameters as Record<string, unknown>)["eye"] = [...movedEye];
    });
    const sweepOf = (compiled: CompiledGraph): ReadonlyArray<number> => {
      const pass = compiled.passes.find(
        (entry) => entry.kind === "draw" && entry.id.startsWith("shot#shot:projector:0:") && !entry.id.endsWith(":clear"),
      );
      if (pass === undefined || pass.kind !== "draw") throw new Error("no projector depth sweep");
      return pass.uniforms?.["lightViewProjection"] as ReadonlyArray<number>;
    };
    const shippedSweep = sweepOf(plan);
    const movedSweep = sweepOf(moved);
    const movedLit = litPass(moved, "shot#shot:scene:0").uniforms?.["projector0Matrix"] as ReadonlyArray<number>;

    // The pose moved, so the frustum moved — against the shipped matrix, not a constant.
    expect(movedSweep).not.toEqual(shippedSweep);
    // And the depth pass and the lit read share ONE derivation: element-for-element equal.
    expect(movedLit).toEqual(movedSweep);
    // The un-moved projector's slot is untouched by its neighbour's move.
    expect(litPass(moved, "shot#shot:scene:0").uniforms?.["projector1Matrix"]).toEqual(
      litPass(plan, "shot#shot:scene:0").uniforms?.["projector1Matrix"],
    );
  });
});
