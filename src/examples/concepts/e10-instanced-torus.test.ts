import { describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

/** §T897: drivers are chan-expressions now; read the channel address back out of one. */
function channelOf(source: string | undefined): string | undefined {
  const m = /op\('([^']+)'\)\.chan\.([A-Za-z0-9_]+)/.exec(source ?? "");
  if (m === null) return undefined;
  return m[2] === "value" ? m[1] : `${m[1]}:${m[2]}`;
}


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
    expect(draw.buffers?.[0]?.resourceId).toBe(pointStorageId("points"));
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
    const slot = draw.parameters["rotate.y"] as { mode?: string; bindings?: { expression?: { source?: string } } };
    expect(slot.mode).toBe("expression");
    expect(channelOf(slot?.bindings?.expression?.source)).toBe("lfo1");
  });
});
