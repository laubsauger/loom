import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

describe("E25 Stage", () => {
  const { document, plan } = example("E25-Stage.loom.json");

  /**
   * T444's whole claim, as one assertion: scene A's RENDER is scene B's MATERIAL — the
   * virtual screen is a texture edge into an albedo slot, and camera B films it.
   */
  it("puts render A's picture on scene B's screen: the virtual-screen wire", () => {
    const draws = plan.passes.filter((pass) => pass.kind === "draw") as ReadonlyArray<{
      nodeId?: string;
      textures?: ReadonlyArray<{ binding: string; resourceId: string }>;
    }>;
    const screenDraw = draws.find(
      (draw) => draw.nodeId === "shotB" && draw.textures?.some((t) => t.binding === "albedoMap"),
    );
    expect(screenDraw?.textures?.some((t) => t.resourceId === "target:shotA:out")).toBe(true);
  });

  it("renders A before B — the stage cannot film a picture that has not happened", () => {
    const order = plan.passes.map((pass) => (pass as { nodeId?: string }).nodeId ?? "");
    expect(order.indexOf("shotA")).toBeLessThan(order.indexOf("shotB"));
  });

  /** Everything driven: both camera orbits and the breathing key are VALUE slots. */
  it("drives both cameras and a light — the whole stage animates as uniforms (§V5)", () => {
    const drivenChannel = (nodeId: string, key: string): string | undefined => {
      const stored = (document.graph.nodes[nodeId] as GraphNode).parameters[key] as {
        bindings?: { driven?: { channel?: string } };
      };
      return stored?.bindings?.driven?.channel;
    };
    expect(drivenChannel("camA", "eye.x")).toBe("orbax1");
    expect(drivenChannel("camB", "eye.x")).toBe("orbbx1");
    expect(drivenChannel("keyB", "intensity")).toBe("breathe1");
  });

  /** Scene B is a MULTI-OBJECT scene: the screen and the floor, in list order. */
  it("draws two named geometries in scene B, screen first", () => {
    const scenes = (document.graph.nodes["shotB"] as GraphNode).parameters["scenes"];
    expect(scenes).toBe("screen1 floor1");
    const bDraws = plan.passes.filter(
      (pass) =>
        pass.kind === "draw" &&
        (pass as { nodeId?: string }).nodeId === "shotB" &&
        (pass as { id: string }).id.includes(":scene:"),
    );
    expect(bDraws).toHaveLength(2);
  });
});
