import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

describe("E10 Instanced Torus", () => {
  const { document, plan } = example("E10-Instanced-Torus.loom.json");

  /**
   * T296/T299's claim: the renderer binds the GENERATOR'S pair by edge payload — no
   * naming convention, no copy. The draw's position buffer must be the torus's own
   * scratch pair, and the primitive is real 3D (36 vertices, depth-attached target).
   */
  it("wears the generator's positions by payload, as depth-tested boxes", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      vertexCount?: number;
      buffers?: ReadonlyArray<{ resourceId: string }>;
      target: string;
    };
    expect(draw.vertexCount).toBe(36);
    expect(draw.buffers?.[0]?.resourceId).toBe("scratch:points:position");
    const target = plan.resources.find((resource) => resource.id === draw.target);
    expect((target as { depth?: boolean }).depth).toBe(true);
  });

  /**
   * E7's mechanism on one COMPONENT of a compound (§V113): rotate.y is driven while
   * its siblings stay static, so each box tumbles about its own centre with no recompile
   * anywhere. NOT the formation — §V198 composes `rotate` inside the translate to the
   * point, so the ring never moves (B43; the doc claimed otherwise until T366).
   *
   * This asserts the SLOT in the document, which is all a plan-level test can see: it
   * would still pass if the resolver silently ignored the drive and the boxes sat still.
   */
  it("drives rotate.y through a component slot", () => {
    const draw = document.graph.nodes["draw"] as GraphNode;
    const slot = draw.parameters["rotate.y"] as { mode?: string; bindings?: { driven?: { channel?: string } } };
    expect(slot.mode).toBe("driven");
    expect(slot.bindings?.driven?.channel).toBe("lfo1");
  });
});
