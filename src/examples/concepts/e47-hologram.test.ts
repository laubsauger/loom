import { describe, expect, it } from "vitest";
import { listExamples } from "../catalogue.ts";
import { requireExample } from "../runner.ts";
import type { DrawPassDescriptor, DispatchPassDescriptor } from "../../runtime/backend/plan.ts";

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

  it("feeds each carve its depth and each paint its source — never crossed, and the cut sits only on the zone's paint", () => {
    const dispatches = plan.passes.filter(
      (pass): pass is DispatchPassDescriptor => pass.kind === "dispatch",
    );
    const texturesOf = (prefix: string) =>
      dispatches.find((pass) => pass.id.startsWith(prefix))?.textures?.map((t) => t.resourceId);
    // T972: carve reads the switched DEPTH family, paint the SOURCE family; crossing
    // either pair compiles fine and renders nonsense (§V655's family). T977 threads the
    // zone's colour THROUGH the DepthCut component — the zone paints the background-cut
    // picture — while the wall deliberately paints the RAW source: the cut on the wall
    // would carve holes in the thing whose job is to be behind everything.
    expect(texturesOf("holo/carve")).toContain("target:pick:out");
    expect(texturesOf("holo/paint")).toContain("target:cut/cut:out");
    expect(texturesOf("holo2/carve")).toContain("target:soften2:out");
    expect(texturesOf("holo2/paint")).toContain("target:src:out");
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
    const zone = buffersOf(draws.find((d) => buffersOf(d).get("positions") === "scratch:zone:position"));
    const wall = buffersOf(draws.find((d) => buffersOf(d).get("positions") === "scratch:wall:position"));
    expect(zone.get("pointColors")).toBe("scratch:holo/paint:tint");
    expect(wall.get("pointColors")).toBe("scratch:holo2/paint:tint");
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
