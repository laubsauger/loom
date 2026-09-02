import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { effectFor, example, outputFor } from "./helpers.ts";

describe("E27 Relief", () => {
  const { document, plan } = example("E27-Relief.loom.json");

  /**
   * THE UNDERSTUDY PATTERN (§V411), and this is the assertion that matters most in the
   * file. §V363 says a demo must demonstrate itself; B39 says an unexampled node ships
   * dead. A Switch satisfies both at once — but ONLY if the synthetic branch is the one
   * the index selects, and a variadic port's order is a property of the EDGES (§V131).
   *
   * Left to the id tiebreak, "e-cam-pick" sorts before "e-sum-pick" and this file opens on
   * a black camera: the exact null state §V363 exists to prevent, chosen by spelling. It
   * did, while this example was being built.
   */
  it("opens on the synthetic performer, by declared edge order and not by alphabet", () => {
    expect(document.graph.nodes["pick"]?.parameters["index"]).toBe(0);
    const intoSwitch = Object.values(document.graph.edges).filter(
      (candidate) => candidate.target.nodeId === "pick",
    );
    expect(intoSwitch).toHaveLength(2);
    const bySource = new Map(intoSwitch.map((candidate) => [candidate.source.nodeId, candidate.order]));
    expect(bySource.get("sum")).toBe(0);
    expect(bySource.get("cam")).toBe(1);
    // ...and the ids really would have sorted the other way, so the order is load-bearing
    // rather than decorative.
    const byId = [...intoSwitch].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId[0]?.source.nodeId).toBe("cam");
  });

  /**
   * ...AND THE CAMERA IS STILL COMPILED. A Switch picks a RESOURCE; it does not prune the
   * branch it did not pick, so `webcam`'s pass is in the plan and its shader is built by
   * `examples.gpu.test.ts` on a real device. That is the integration gate §V362 names as
   * the only one we have, and it is the one B39 escaped for months.
   */
  it("keeps the webcam in the plan, bound to the switch, while the understudy plays", () => {
    expect(Object.values(document.graph.nodes).some((entry) => entry.type === "webcam")).toBe(true);
    const webcamResource = outputFor(plan, "cam").resourceId;
    const bound = (effectFor(plan, "pick").textures ?? []).map((entry) => entry.resourceId);
    expect(bound).toContain(webcamResource);
    expect(bound).toContain(outputFor(plan, "sum").resourceId);
  });

  /**
   * T478: per-point colour reaches the SCENE. The geometry's tint is in map mode on the
   * bridged `sample`, so the material's base colour is multiplied per point — which is how
   * a scene-pipeline draw gets thousands of colours without an albedo map and without a uv
   * mapping. Before T478 this example had to choose between lighting and per-point colour.
   */
  it("colours the instances per point through the geometry's tint map", () => {
    const stored = (document.graph.nodes["body"] as GraphNode).parameters["tint"] as {
      mode?: string;
      bindings?: { map?: { attribute?: string } };
    };
    expect(stored.mode).toBe("map");
    expect(stored.bindings?.map?.attribute).toBe("sample");
  });

  /**
   * UNLIT, and no lights at all. A phosphor has no diffuse response; the colour is the
   * sample and nothing shades it. A lit material here would multiply the palette by a
   * lambert term and the panel would go dark at its edges — plausible, and wrong.
   */
  it("draws an unlit phosphor with no light list", () => {
    expect(document.graph.nodes["phosphor"]?.type).toBe("materialUnlit");
    expect(document.graph.nodes["shot"]?.parameters["lights"]).toBe("");
  });

  /**
   * THE QUAD MUST BE SMALLER THAN THE GAP. The sheet is 2 x 1.7778 world units wide across
   * 480 columns, so the point spacing is ~0.0074; a quad half-extent at or above half of
   * that closes every gap and the scan lines fuse into one solid slab. The first build ran
   * 0.0075 and rendered exactly that — a flat sheet, every wire correct.
   */
  it("keeps the instance quad under half the point spacing", () => {
    const spacing = (2 * 1.7778) / 480;
    const scale = document.graph.nodes["body"]?.parameters["scale"] as number;
    expect(scale).toBeLessThan(spacing / 2);
    expect(scale).toBeGreaterThan(0);
  });
});
