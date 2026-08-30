import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { cameraPayloadMatrix } from "../domain/geometry/camera.ts";
import { DEFAULT_MATERIAL } from "../domain/types/scene.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { DrawPassDescriptor, TargetResourceDescriptor } from "../runtime/backend/plan.ts";

/**
 * T462 (§V85): a scene payload previews as ITSELF in a stock scene — never a borrowed
 * downstream image. What these tests pin is the contract, not the picture (the picture
 * is the GPU test's and the look pass's job):
 *
 *  - §V309: no preview sink, no pass, no target, no bytes — the synthesis rides the
 *    same sink set as every other preview.
 *  - The payload reaches the pass as VALUES with the render's own field names, so the
 *    animate path drives an orbiting light's preview as a uniform write (§V5).
 *  - Keyed on the payload KIND (§V316/§V319): every camera/light/material — present
 *    and future — is covered by construction, and geometry deliberately is not.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

function node(id: string, type: string, parameters: Record<string, unknown> = {}, label?: string): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    ...(label === undefined ? {} : { label }),
  } as never;
}

function graphOf(nodes: GraphNode[], edges: Record<string, unknown> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges,
    groups: {},
  } as never;
}

const compile = (graph: GraphDocument, sinks: Array<{ nodeId: string; portId: string }>) =>
  compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: sinks.map((sink) => ({ ...sink, kind: "preview" as const })),
  } as never);

const previewPasses = (compiled: { passes: ReadonlyArray<unknown> }) =>
  compiled.passes.filter((pass) =>
    String((pass as { id: string }).id).includes("#scenePreview:"),
  ) as DrawPassDescriptor[];

describe("scene payload previews are sink-gated (T462, §V309)", () => {
  it("no sink means no pass, no target, no output row", () => {
    const compiled = compile(graphOf([node("cam", "camera", {}, "cam1")]), []);
    expect(previewPasses(compiled)).toEqual([]);
    expect(compiled.resources.some((resource) => resource.id.startsWith("preview:scene:"))).toBe(false);
    expect(compiled.outputs.some((output) => output.resourceId.startsWith("preview:scene:"))).toBe(false);
  });

  it("a watched camera renders the stock scene through ITS OWN matrix", () => {
    const compiled = compile(
      graphOf([node("cam", "camera", { eye: [4, 2, 7], fov: 30 }, "cam1")]),
      [{ nodeId: "cam", portId: "out" }],
    );
    const pass = previewPasses(compiled)[0];
    expect(pass).toBeDefined();
    // The payload's exact matrix, square aspect — a borrowed render would frame at the
    // project aspect and go blank with nothing connected (§V85, both refuted here).
    const expected = cameraPayloadMatrix(
      { eye: [4, 2, 7], lookAt: [0, 0, 0], fovDeg: 30, near: 0.1, far: 100, ortho: false, orthoHeight: 2 },
      1,
    );
    expect(pass?.uniforms?.["viewProjection"]).toEqual(Array.from(expected));
    const target = compiled.resources.find(
      (resource) => resource.id === "preview:scene:cam:out",
    ) as TargetResourceDescriptor;
    expect(target?.depth).toBe(true);
    expect(target?.size).toEqual([192, 192]);
    // The projection carries the row so the preview system can bind it.
    expect(compiled.outputs.some((output) => output.resourceId === "preview:scene:cam:out")).toBe(true);
  });

  it("a watched light lights the default ball with ONLY itself — zero ambient", () => {
    const compiled = compile(
      graphOf([node("sun", "light", { kind: "point", intensity: 2, position: [1, 2, 3] }, "sun1")]),
      [{ nodeId: "sun", portId: "out" }],
    );
    const pass = previewPasses(compiled)[0];
    expect(pass?.uniforms?.["ambientColor"]).toEqual([0, 0, 0, 0]);
    expect(pass?.uniforms?.["baseColor"]).toEqual([...DEFAULT_MATERIAL.baseColor]);
    expect(pass?.uniforms?.["light0Meta"]).toEqual([1, 2, 0, 0]);
    expect(pass?.uniforms?.["light0Vector"]).toEqual([1, 2, 3, 0]);
  });

  it("a watched material wears its own values and binds its own maps", () => {
    const graph = graphOf(
      [
        node("plate", "checker", {}, "plate1"),
        node("skin", "materialPhong", { color: [1, 0, 0, 1], shininess: 24 }, "skin1"),
      ],
      {
        m1: { id: "m1", source: { nodeId: "plate", portId: "out" }, target: { nodeId: "skin", portId: "albedo" } },
      },
    );
    const compiled = compile(graph, [{ nodeId: "skin", portId: "out" }]);
    const pass = previewPasses(compiled)[0];
    expect(pass).toBeDefined();
    // Display-space red decodes to linear red exactly (0/1 fixed points, §V56).
    expect(pass?.uniforms?.["baseColor"]).toEqual([1, 0, 0, 1]);
    expect((pass?.uniforms?.["specular"] as number[])[3]).toBe(24);
    // Two stock lights: warm key plus a fill whose z-lambert is zero at the centre.
    expect(pass?.uniforms?.["light1Meta"]).toBeDefined();
    // The map is the material's OWN wired texture, bound by its plan resource id.
    const albedo = pass?.textures?.find((texture) => texture.binding === "albedoMap");
    expect(albedo?.resourceId).toBe("target:plate:out");
  });

  it("geometry deliberately previews NOTHING — its picture lives elsewhere", () => {
    const graph = graphOf(
      [node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"), node("geo", "geometry", {}, "geo1")],
      {
        e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      },
    );
    const compiled = compile(graph, [{ nodeId: "geo", portId: "out" }]);
    expect(previewPasses(compiled)).toEqual([]);
  });
});
