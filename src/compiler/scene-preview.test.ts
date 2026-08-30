import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { cameraPayloadMatrix } from "../domain/geometry/camera.ts";
import { DEFAULT_MATERIAL, SCENE_PAYLOAD_KINDS } from "../domain/types/scene.ts";
import type { ScenePayloadKind } from "../domain/types/scene.ts";
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
 *  - Keyed on the payload KIND (§V316/§V319): every camera/light/geometry/material —
 *    present and future — is covered by construction.
 *
 * T532 replaced the last clause of that list. It used to read "and geometry deliberately
 * is not", and the reasoning was that a geometry's shape is its upstream splat and its
 * look is the material node's ball. True of the PARTS; false of the THING — the pairing,
 * the instance shape and scale, and the material overrides the node composes are visible
 * nowhere else, so the node showed nothing and read as broken. Absent, not broken, for as
 * long as three of four kinds looked like a finished feature.
 *
 * The kind sweep at the bottom is the part that matters: it iterates
 * `SCENE_PAYLOAD_KINDS`, which the type system keeps exhaustive, so kind N+1 fails HERE
 * until someone writes its variant (§V437).
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

/** A geometry wearing whatever the case under test wants to see reach the picture. */
function geometryGraph(parameters: Record<string, unknown>): GraphDocument {
  return graphOf(
    [
      node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
      node("geo", "geometry", parameters, "geo1"),
    ],
    {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
    },
  );
}

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
    // T502: the base tile (`previewLongEdge` × MAX_TILE_SCALE), not the raw setting —
    // the same rule the pointset splat takes, from the same helper.
    expect(target?.size).toEqual([384, 384]);
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

  it("a watched geometry draws its OWN object, backdrop first (T532, §V384)", () => {
    const compiled = compile(geometryGraph({ mode: "surface" }), [{ nodeId: "geo", portId: "out" }]);
    const passes = compiled.passes.filter((pass) =>
      String((pass as { id: string }).id).startsWith("geo#scenePreview"),
    ) as DrawPassDescriptor[];
    // Backdrop then object, and only the backdrop clears: an unlit object on unpainted
    // black is not a preview (§V384, E25's invisible screen).
    expect(passes.map((pass) => pass.id)).toEqual([
      "geo#scenePreviewBackdrop:out",
      "geo#scenePreview:out",
    ]);
    expect(passes.map((pass) => pass.clear)).toEqual([true, false]);
    // It binds the geometry's OWN points — a geometry with none is not a geometry.
    const object = passes[1];
    expect(object?.buffers?.[0]?.binding).toBe("positions");
    // The 8×8 grid the pointset declares: 7×7 cells, two triangles each.
    expect(object?.vertexCount).toBe(7 * 7 * 6);
    expect(object?.uniforms?.["grid"]).toEqual([8, 8, 0, 0]);
  });

  it("INSTANCING is visible: the worn primitive and its scale reach the picture (T532)", () => {
    const compiled = compile(
      geometryGraph({ mode: "instances", shape: "octahedron", scale: 0.25 }),
      [{ nodeId: "geo", portId: "out" }],
    );
    const object = compiled.passes.find(
      (pass) => (pass as { id: string }).id === "geo#scenePreview:out",
    ) as DrawPassDescriptor;
    // shape 2 = octahedron in the Render's own encoding, and the node's own scale — the
    // two things a geometry node uniquely decides, neither visible anywhere upstream.
    expect(object?.uniforms?.["instance"]).toEqual([0.25, 2, 0, 0]);
    expect(object?.vertexCount).toBe(36);
    // One instance per capacity slot, exactly as the Render draws it.
    expect(object?.instances).toBe(4096);
  });

  it("MATERIAL OVERRIDES are visible: the composed material, not the referenced one (T532)", () => {
    const compiled = compile(
      // 0/1 fixed points of the display decode (§V56): the tint arrives exactly.
      geometryGraph({ mode: "surface", tint: [1, 0, 0, 1] }),
      [{ nodeId: "geo", portId: "out" }],
    );
    const object = compiled.passes.find(
      (pass) => (pass as { id: string }).id === "geo#scenePreview:out",
    ) as DrawPassDescriptor;
    // The COMPOSED material: the default material's 0.8 grey multiplied by the node's own
    // red tint. The referenced material alone would read [0.8, 0.8, 0.8, 1] — which is
    // exactly the thing that was invisible before this preview existed.
    expect(object?.uniforms?.["baseColor"]).toEqual([0.8, 0, 0, 1]);
    // The material preview's own key and fill, so two geometries read against one rig.
    expect(object?.uniforms?.["light0Meta"]).toBeDefined();
    expect(object?.uniforms?.["light1Meta"]).toBeDefined();
  });
});

/**
 * THE GATE (T532, §V437).
 *
 * Three of four payload kinds had a preview and the fourth had none, for as long as
 * nobody counted. `SCENE_PAYLOAD_KINDS` is kept exhaustive by the type system (a fifth
 * kind added to the `ScenePayload` union does not compile until it is listed), and this
 * iterates it — so a kind that exists and has no variant fails HERE rather than shipping
 * as a node that quietly shows nothing.
 */
describe("every scene payload kind has a preview variant (T532, §V437)", () => {
  /** One graph per kind, watched at its own output. No list of "kinds that preview". */
  const fixtures: Readonly<Record<ScenePayloadKind, () => GraphDocument>> = {
    camera: () => graphOf([node("subject", "camera", {}, "subject1")]),
    light: () => graphOf([node("subject", "light", {}, "subject1")]),
    material: () => graphOf([node("subject", "materialPhong", {}, "subject1")]),
    geometry: () =>
      graphOf(
        [
          node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
          node("subject", "geometry", {}, "subject1"),
        ],
        {
          e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "subject", portId: "points" } },
        },
      ),
  };

  it.each(SCENE_PAYLOAD_KINDS)("%s synthesizes a preview target and a draw into it", (kind) => {
    const compiled = compile(fixtures[kind](), [{ nodeId: "subject", portId: "out" }]);
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const target = compiled.resources.find(
      (resource) => resource.id === "preview:scene:subject:out",
    ) as TargetResourceDescriptor | undefined;
    expect([kind, target?.size]).toEqual([kind, [384, 384]]);
    const draws = compiled.passes.filter(
      (pass) =>
        (pass as { kind: string }).kind === "draw" &&
        (pass as { target?: string }).target === "preview:scene:subject:out",
    );
    expect([kind, draws.length > 0]).toEqual([kind, true]);
    // And the row the preview system binds, or the tile has nothing to sample.
    expect([
      kind,
      compiled.outputs.some((output) => output.resourceId === "preview:scene:subject:out"),
    ]).toEqual([kind, true]);
  });
});
