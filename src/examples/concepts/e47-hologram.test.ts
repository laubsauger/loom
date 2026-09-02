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

  it("instances the DepthPoints component and flattens it into the plan", () => {
    // The document holds ONE component node; the plan holds its expansion and no
    // component types at all — the boundary is real, not a doc comment.
    const instances = Object.values(document.graph.nodes).filter((node) =>
      node.type.startsWith("component:depthPoints"),
    );
    expect(instances).toHaveLength(1);
    const flattened = [...plan.order].filter((id) => id.startsWith("holo/"));
    expect(flattened.sort()).toEqual(["holo/carve", "holo/grid", "holo/paint"]);
    expect([...plan.order].includes("holo")).toBe(false);
  });

  it("feeds the carve kernel the SWITCHED depth and the paint kernel the source — never crossed", () => {
    const dispatches = plan.passes.filter(
      (pass): pass is DispatchPassDescriptor => pass.kind === "dispatch",
    );
    const carve = dispatches.find((pass) => pass.id.startsWith("holo/carve"));
    const paint = dispatches.find((pass) => pass.id.startsWith("holo/paint"));
    expect(carve).toBeDefined();
    expect(paint).toBeDefined();
    // The depth map arrives through the switch (so the ML path is one index away); the
    // colour comes straight from the source. Swapping these compiles fine and renders
    // nonsense — which is exactly why it is pinned (§V655's family).
    expect(carve?.textures?.map((texture) => texture.resourceId)).toContain("target:pick:out");
    expect(paint?.textures?.map((texture) => texture.resourceId)).toContain("target:src:out");
  });

  it("draws the cloud with the component's per-point tint mapped", () => {
    const draw = plan.passes.find(
      (pass): pass is DrawPassDescriptor =>
        pass.kind === "draw" && pass.id.includes(":scene:"),
    );
    expect(draw).toBeDefined();
    const buffers = new Map((draw?.buffers ?? []).map((entry) => [entry.binding, entry.resourceId]));
    // The retexturing is visible only through this binding — without it every mote is
    // static white (measured: the first card was exactly that).
    expect(buffers.get("pointColors")).toBe("scratch:holo/paint:tint");
    expect(buffers.get("positions")).toBe("scratch:holo/paint:position");
  });

  it("keeps the ML depth path wired and stale-tolerant (§T715)", () => {
    // depth1 is in the plan (the switch keeps BOTH branches compiled), and its result
    // texture is the T959 float format — no 8-bit quantisation between model and cloud.
    expect([...plan.order]).toContain("depth");
    const external = plan.resources.find((resource) => resource.kind === "externalTexture");
    expect(external).toBeDefined();
    expect((external as { format?: string }).format).toBe("r32float");
  });
});
