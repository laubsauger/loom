import { describe, expect, it } from "vitest";
import { listExamples } from "../catalogue.ts";
import { requireExample } from "../runner.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * E53 Two Cuts — the document half of T1037's claims. A COMPARISON is worthless the
 * moment its two lanes cross, and every crossing here compiles fine and renders a
 * plausible picture that lies — which is exactly the class these gates pin (§V655's
 * family, three pairs of it).
 */
describe("E53 Two Cuts", () => {
  const file = listExamples().find((entry) => entry.fileName === "E53-Two-Cuts.loom.json");
  if (file === undefined) throw new Error("E53-Two-Cuts.loom.json is not shipped");
  const { plan, document } = requireExample(file);

  const texturesOf = (nodeId: string) =>
    (
      plan.passes.find(
        (pass): pass is EffectPassDescriptor => pass.kind === "effect" && pass.nodeId === nodeId,
      )?.textures ?? []
    ).map((texture) => texture.resourceId);

  it("compiles clean with BOTH cut seams present, each a float measurement", () => {
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const ids = plan.passes.map((pass) => pass.id);
    for (const seam of ["matte:preprocess", "matte:result", "seg:preprocess", "seg:result"]) {
      expect(ids.some((id) => id.includes(seam)), seam).toBe(true);
    }
    for (const nodeId of ["matte", "seg"]) {
      const external = plan.resources.find(
        (resource) => resource.kind === "externalTexture" && resource.id.includes(nodeId),
      );
      expect((external as { format?: string } | undefined)?.format, nodeId).toBe("r32float");
    }
  });

  it("each key multiplies the source by ITS OWN cut — the lanes never cross", () => {
    const keyM = texturesOf("keyM");
    const keyV = texturesOf("keyV");
    expect(keyM).toContain("target:src:out");
    expect(keyM).toContain("target:matte:out");
    expect(keyM).not.toContain("target:seg:out");
    expect(keyV).toContain("target:src:out");
    expect(keyV).toContain("target:seg:out");
    expect(keyV).not.toContain("target:matte:out");
  });

  it("each half rides ITS OWN gate — the wipe pairing is the diptych", () => {
    // Crosswise gating compiles fine and puts the matte's composite on the
    // segmentation's side of the seam: the comparison would still LOOK like one.
    expect(texturesOf("halfL")).toContain("target:leftC:out");
    expect(texturesOf("halfL")).toContain("target:gateL:out");
    expect(texturesOf("halfR")).toContain("target:rightC:out");
    expect(texturesOf("halfR")).toContain("target:gateR:out");
  });

  it("each wash spends ITS OWN cut's coverage (§V856) — warm answers the matte, cool answers the segmentation", () => {
    const sourceOf = (nodeId: string): string => {
      const slot = document.graph.nodes[nodeId]?.parameters["brightness"] as
        | { bindings?: { expression?: { source?: string } } }
        | undefined;
      return slot?.bindings?.expression?.source ?? "";
    };
    expect(sourceOf("washW")).toContain("matte1");
    expect(sourceOf("washW")).not.toContain("seg1");
    expect(sourceOf("washC")).toContain("seg1");
    expect(sourceOf("washC")).not.toContain("matte1");
  });

  it("ships on the deterministic understudy (§T715) — the webcam is one flip away", () => {
    const stored = document.graph.nodes["src"]?.parameters["index"];
    const value = typeof stored === "number" ? stored : (stored as { value?: unknown } | undefined)?.value;
    expect(value ?? 0).toBe(0);
  });
});
