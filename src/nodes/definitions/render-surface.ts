import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { attributeBinding } from "./point-storage.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { cameraPayloadMatrix, viewProjection } from "../../domain/geometry/camera.ts";
import type { CameraPayload } from "../../domain/types/scene.ts";
import { RENDER_SURFACE_WGSL } from "../shaders/render-surface.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import {
  DANGLING_CAMERA_SUGGESTION,
  danglingCameraRefusal,
  namedCameraWins,
} from "./camera-reference.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { gridCellCounts, gridPointCount, parseTopology } from "../../points/topology.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";

/**
 * RenderSurface (T301): grid → deform → shaded surface with NO mesh machinery. The
 * connectivity is the `grid:{cols}x{rows}` topology string the producer published on
 * the T296 edge — analytic, so the vertex count is arithmetic and the "index buffer"
 * is the vertex index itself. A pointset without grid topology is REFUSED with a named
 * diagnostic: a surface over unordered points would render garbage confidently, and
 * the topology claim belongs to the producer, not to a count the user retypes here.
 *
 * Wrap flags (T302's vocabulary, `points/topology.ts`): a wrapped axis contributes a
 * seam CELL — its far corner addresses column/row zero — so a tube closes its ring and
 * a torus closes both, with no duplicated points and no seam.
 */

const DEGREES_TO_RADIANS = Math.PI / 180;


export const renderSurfaceNode: NodeDefinition = {
  type: "renderSurface",
  version: 1,
  title: "Render Surface",
  category: "points",
  description:
    "Shades a point grid as a continuous surface through a perspective camera — topology comes from the edge, not a mesh.",
  tags: ["points", "surface", "render", "3d", "geometry", "grid"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Needs a vec3f position attribute AND analytic grid topology on the edge.",
    },
    // T457: reference-fed plumbing (V373/V387) — never rendered as a socket; the
    // `camera` PARAMETER names the node and the compiler synthesizes this edge.
    { id: "camera", label: "Camera", optional: true, type: { kind: "camera" } },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  depthOutputs: ["out"],
  sourceReferences: [{ parameter: "camera", input: "camera" }],
  parameters: {
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    camera: {
      type: "string",
      label: "Camera",
      default: "",
      description: "Name of a camera node. When set, it replaces the inline eye/look/FOV below.",
    },
    eye: { type: "vector", size: 3, label: "Camera Eye", default: [0, 0, 3], inactiveWhen: namedCameraWins },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0], inactiveWhen: namedCameraWins },
    fov: { type: "number", label: "FOV", default: 60, min: 1, max: 179, range: "bounded", unit: "degrees", inactiveWhen: namedCameraWins },
    near: { type: "number", label: "Near", default: 0.1, min: 0.001, range: "floor", inactiveWhen: namedCameraWins },
    far: { type: "number", label: "Far", default: 100, min: 0.01, range: "floor", inactiveWhen: namedCameraWins },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    const points = inputs["points"];
    if (target === undefined || points === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "points"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const refuse = (message: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.surface.topology",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          suggestion: "Feed a grid-topology producer (Grid, Tube or Torus points).",
        },
      ],
    });
    const pointset = points.pointset;
    if (pointset === undefined) {
      return refuse("the points input carries no edge payload; topology cannot be read.");
    }
    const parsed = parseTopology(pointset.topology);
    if (parsed === null || parsed.kind !== "grid") {
      return refuse(
        `a surface needs analytic grid topology; the upstream edge published "${pointset.topology ?? "none"}".`,
      );
    }
    const { cols, rows } = parsed;
    if (cols < 2 || rows < 2) {
      return refuse(`a ${cols}x${rows} grid has no cells to shade.`);
    }
    if (gridPointCount(parsed) > pointset.capacity) {
      return refuse(
        `topology "${pointset.topology}" addresses ${gridPointCount(parsed)} points but the edge carries ${pointset.capacity}.`,
      );
    }
    const { cellsU, cellsV } = gridCellCounts(parsed);

    // T457 (V387): one camera model everywhere. A NAMED camera arrives as a scene
    // payload on the reference-fed edge and replaces the inline parameters wholesale;
    // unnamed keeps the inline eye/look/FOV exactly as before.
    const referenced = inputs["camera"]?.scene as CameraPayload | undefined;
    // T528: a NAME that did not resolve is a REFUSAL, never a quiet fall back to the
    // inline camera — see `camera-reference.ts` for the rule and why all three renderers
    // obey it. Before this, `camera: "nope1"` drew a confident picture from a viewpoint
    // nobody asked for, beside a compiler error saying the name was missing.
    const dangling = danglingCameraRefusal(parameters, referenced?.kind === "camera");
    if (dangling !== null) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.camera.reference",
            message: `Node "${nodeId}": ${dangling}`,
            nodeId,
            suggestion: DANGLING_CAMERA_SUGGESTION,
          },
        ],
      };
    }
    const eye = readVector(parameters, "eye", [0, 0, 3]);
    const center = readVector(parameters, "lookAt", [0, 0, 0]);
    const matrix =
      referenced?.kind === "camera"
        ? cameraPayloadMatrix(referenced, resolution[0] / resolution[1])
        : viewProjection([eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 3], [center[0] ?? 0, center[1] ?? 0, center[2] ?? 0], {
            fovY: readNumber(parameters, "fov", 60) * DEGREES_TO_RADIANS,
            aspect: resolution[0] / resolution[1],
            near: readNumber(parameters, "near", 0.1),
            far: readNumber(parameters, "far", 100),
          });

    const positionPair = pointset.pairs["position"];
    if (positionPair === undefined) {
      return refuse("the edge map carries no position pair.");
    }
    if (pointset.count !== undefined) {
      // T322: static topology over a GPU-resident varying count is a lie — the claim
      // addresses points that may be dead. Refuse loudly (§V13).
      return refuse("a surface needs a static point count; this edge carries a GPU-resident live count.");
    }

    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:surface`,
      shader: RENDER_SURFACE_WGSL,
      target,
      topology: "triangle-list",
      instances: 1,
      // The analytic index buffer: six vertices per grid cell, cells from the edge —
      // a wrapped axis has a seam cell, so its cell count equals its point count.
      vertexCount: cellsU * cellsV * 6,
      buffers: [
        // The half the PAYLOAD names (§V231) — this frame's positions, whoever owns
        // the buffer (§V197) and whichever half compaction or convention left them in.
        attributeBinding("positions", positionPair),
      ],
      uniforms: {
        viewProjection: Array.from(matrix),
        color: readColor(parameters, "color", [1, 1, 1, 1]),
        cols,
        rows,
        wrapU: parsed.wrapU ? 1 : 0,
        wrapV: parsed.wrapV ? 1 : 0,
      },
      uniformBinding: "params",
      nodeId,
    };
    return { passes: [pass] };
  },
};
