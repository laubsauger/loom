import { describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { listExamples } from "../catalogue.ts";
import { requireExample } from "../runner.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * E47 Hologram — the document half of T956's claims (the kernels' physics live in
 * depth-points.gpu.test.ts; the pictures in liveness/look gates).
 */
describe("E47 Hologram", () => {
  const file = listExamples().find((entry) => entry.fileName === "E47-Hologram.loom.json");
  if (file === undefined) throw new Error("E47-Hologram.loom.json is not shipped");
  const { plan, document } = requireExample(file);

  it("instances DepthPoints twice (zone + wall) plus the DepthCut, all flattened into the plan", () => {
    // T979/T983's v2: the ZONE cloud (`holo`) and the WALL cloud (`holo2`) are two
    // instances of ONE DepthPoints definition — the reuse claim §V79 makes — and the
    // background cut is a third component. The plan holds their expansions and no
    // component types at all: the boundary is real, not a doc comment.
    const clouds = Object.values(document.graph.nodes).filter((node) =>
      node.type.startsWith("component:depthPoints"),
    );
    expect(clouds).toHaveLength(2);
    const cuts = Object.values(document.graph.nodes).filter((node) =>
      node.type.startsWith("component:depthCut"),
    );
    expect(cuts).toHaveLength(1);
    const flattened = [...plan.order].filter(
      (id) => id.startsWith("holo/") || id.startsWith("holo2/") || id.startsWith("cut/"),
    );
    expect(flattened.sort()).toEqual([
      "cut/cut", "cut/matte",
      "holo/carve", "holo/grid", "holo/paint",
      "holo2/carve", "holo2/grid", "holo2/paint",
    ]);
    for (const instanceId of ["holo", "holo2", "cut"]) {
      expect([...plan.order].includes(instanceId), instanceId).toBe(false);
    }
  });

  it("feeds each carve its depth and each paint its heat map — never crossed, and the cut sits only on the zone's", () => {
    const texturesOf = (prefix: string): readonly string[] => {
      const pass = plan.passes.find((entry) => entry.id.startsWith(prefix));
      const textures = pass === undefined || !("textures" in pass) ? undefined : pass.textures;
      return (textures ?? []).map((binding) => binding.resourceId);
    };
    // T972: carve reads the switched DEPTH family; crossing the pair compiles fine and
    // renders nonsense (§V655's family).
    expect(texturesOf("holo/carve")).toContain("target:pick:out");
    expect(texturesOf("holo2/carve")).toContain("target:soften2:out");

    /* T1201 — THE COLOUR PORT CARRIES THE HEAT MAP, and the chain behind it is the claim.
       Each paint reads a `lookup` of the palette KEYED ON THE SAME DEPTH TEXTURE its own
       carve read, so a mote's colour is registered with its position by construction. The
       subject's arrives through `braid1`, which is what still carries the §T977 cut —
       rgb from the palette, ALPHA from the cut. Reading the palette straight into
       `holo/paint` would compile, look almost identical in a still, and silently restore
       every background mote to full coverage (B189's cohorts back to zero), so the BRAID
       is the thing this line is holding down. */
    expect(texturesOf("holo/paint")).toContain("target:braid:out");
    expect(texturesOf("braid")).toEqual(
      expect.arrayContaining(["target:coat:out", "target:cut/cut:out"]),
    );
    expect(texturesOf("coat")).toEqual(
      expect.arrayContaining(["target:pick:out", "target:palette:out"]),
    );

    /* The wall paints its own segment of the same palette off its OWN depth chain, and it
       is deliberately un-cut: a background cut on the thing whose job is to be behind
       everything would carve holes in it. So no `cut/` texture may appear anywhere on the
       wall's colour path — asserted, because the wall's own map and the subject's differ
       only when `srcpick1` moves, which is exactly when a crossed wire stops being
       invisible (§T979). */
    expect(texturesOf("holo2/paint")).toContain("target:wcoat:out");
    expect(texturesOf("wcoat")).toEqual(
      expect.arrayContaining(["target:soften2:out", "target:palette:out"]),
    );
    for (const id of [...texturesOf("holo2/paint"), ...texturesOf("wcoat")]) {
      expect(id.startsWith("target:cut/"), `wall colour reads ${id}`).toBe(false);
    }
  });

  it("draws both clouds, each pairing ITS range's positions with ITS paint's tints", () => {
    const draws = plan.passes.filter(
      (pass): pass is DrawPassDescriptor => pass.kind === "draw" && pass.id.includes(":scene:"),
    );
    expect(draws).toHaveLength(2);
    const buffersOf = (draw: DrawPassDescriptor | undefined) =>
      new Map((draw?.buffers ?? []).map((entry) => [entry.binding, entry.resourceId]));
    // T983: the pointRange nodes (`zone`, `wall`) sit BETWEEN paint and scene, so the
    // positions come from the range's scratch while the colours still come from the
    // matching paint. Pairing zone positions with holo2 tints (or vice versa) compiles
    // fine and puts the wall's colours on the person — which is why the PAIRING is the
    // claim, not the mere presence of two draws.
    const zone = buffersOf(draws.find((d) => buffersOf(d).get("positions") === pointStorageId("zone")));
    const wall = buffersOf(draws.find((d) => buffersOf(d).get("positions") === pointStorageId("wall")));
    expect(zone.get("pointColors")).toBe(pointStorageId("holo/paint"));
    expect(wall.get("pointColors")).toBe(pointStorageId("holo2/paint"));
  });

  it("keeps the ML depth path wired and stale-tolerant (§T715)", () => {
    // depth1 is in the plan (the switch keeps BOTH branches compiled), and its result
    // texture is the T959 float format — no 8-bit quantisation between model and cloud.
    expect([...plan.order]).toContain("depth");
    // T972 added the webcam's own external texture; the claim is about the DEPTH one.
    const external = plan.resources.find(
      (resource) => resource.kind === "externalTexture" && resource.id.includes("depth"),
    );
    expect(external).toBeDefined();
    expect((external as { format?: string }).format).toBe("r32float");
  });
});
