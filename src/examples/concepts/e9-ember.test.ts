import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

describe("E9 Ember", () => {
  const { document, plan } = example("E9-Ember.loom.json");

  /**
   * T322/T323's claim: the population CHANGES COUNT on the GPU. If the spawn tail or
   * the counted indirect draw regress, this graph still compiles — and the fire
   * freezes at frame zero's census. The pass roster and the indirect draw are the
   * structural halves of "it keeps burning".
   */
  it("compiles the full lifecycle: kernel, scans, scatter, spawn tail, hook", () => {
    const ids = plan.passes
      .filter((pass) => "nodeId" in pass && pass.nodeId === "sim")
      .map((pass) => (pass as { id: string }).id.split(":").pop());
    for (const stage of ["kernel", "scanLocal", "scanBlocks", "spawnScanLocal", "spawnScanBlocks", "spawnIdentity", "spawnFinalize", "spawnHook"]) {
      expect(ids, stage).toContain(stage);
    }
  });

  it("draws INDIRECTLY off the GPU-resident live count", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      instances: number | { indirect: string };
    };
    expect(typeof draw.instances).toBe("object");
  });

  /**
   * The document half of the claim: births come from the HOOK, so each child launches
   * on its own pointRand(id) draw — delete the hook and the fire becomes sixteen
   * columns of identical copies.
   */
  it("ships a spawn hook", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    expect(String(sim.parameters["spawn"])).toContain("fn spawn(");
  });

  /**
   * T579, and the reason this example exists in its current form. `ctx.frameIndex == 0`
   * means BOTH "my buffers were cleared" and "the timeline lapped", which is why the
   * file that used to live here re-seeded at every loop (§V495). `ctx.firstRun` means
   * only the first. A regression to the old sentinel would still compile, still render,
   * and quietly bring the owner's complaint back — so the guard is asserted by name.
   */
  it("seeds on ctx.firstRun, and names the wrapping clock nowhere", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    const kernel = String(sim.parameters["kernel"]);
    const code = kernel.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(code).toContain("ctx.firstRun == 1u");
    expect(code).not.toContain("ctx.frameIndex");
    expect(code).not.toContain("ctx.time");
  });

  /**
   * §V471.1 — ONE cloud, THREE readings, and the split is the LIFECYCLE. Three draws
   * that had drifted onto three different pointsets, or onto one predicate, would still
   * render a fire; what they would stop doing is giving every ember a black-body
   * gradient out of SELECTION. So this asserts both halves: one producer, three
   * distinct predicates.
   */
  it("reads ONE cloud THREE ways, split by group predicate on heat", () => {
    const draws = ["bed", "body", "spark"].map((id) => document.graph.nodes[id] as GraphNode);
    const sources = Object.values(document.graph.edges)
      .filter((edge) => ["bed", "body", "spark"].includes(edge.target.nodeId))
      .map((edge) => edge.source.nodeId);
    expect(new Set(sources)).toEqual(new Set(["sim"]));
    const groups = draws.map((node) => String(node.parameters["group"]));
    expect(new Set(groups).size).toBe(3);
    // §V471.2: every predicate reads the attribute the KERNEL wrote, not a position.
    for (const group of groups) expect(group).toContain("p.velocity.z");
    // Three different colours and three different sizes, or the split reads as one draw.
    expect(new Set(draws.map((node) => JSON.stringify(node.parameters["color"]))).size).toBe(3);
    expect(new Set(draws.map((node) => node.parameters["sizePixels"])).size).toBe(3);
  });

  /**
   * The BINDING BUDGET is the reason heat rides in a velocity component rather than in
   * an attribute of its own: a lifecycle kernel spends 2·(n−1)+2 storage buffers for n
   * attributes including flags, and baseline WebGPU guarantees 8. A future editor adding
   * `heat` as a fifth attribute would bust that limit SILENTLY, so the default schema is
   * asserted rather than assumed.
   */
  it("stays inside the 8-storage-buffer budget by carrying heat in velocity.z", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    expect(String(sim.parameters["attributes"] ?? "")).toBe("");
    const kernel = plan.passes.find(
      (pass) => "id" in pass && String((pass as { id: string }).id).endsWith(":kernel"),
    ) as { buffers?: ReadonlyArray<unknown> };
    expect((kernel.buffers ?? []).length).toBeLessThanOrEqual(8);
  });
});
