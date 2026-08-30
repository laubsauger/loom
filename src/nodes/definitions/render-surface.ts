import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { viewProjection } from "../../domain/geometry/camera.ts";
import { RENDER_SURFACE_WGSL } from "../shaders/render-surface.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
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
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  depthOutputs: ["out"],
  parameters: {
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    eye: { type: "vector", size: 3, label: "Camera Eye", default: [0, 0, 3] },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0] },
    fov: { type: "number", label: "FOV", default: 60, min: 1, max: 179, unit: "degrees" },
    near: { type: "number", label: "Near", default: 0.1, min: 0.001 },
    far: { type: "number", label: "Far", default: 100, min: 0.01 },
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

    const eye = readVector(parameters, "eye", [0, 0, 3]);
    const center = readVector(parameters, "lookAt", [0, 0, 0]);
    const matrix = viewProjection([eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 3], [center[0] ?? 0, center[1] ?? 0, center[2] ?? 0], {
      fovY: readNumber(parameters, "fov", 60) * DEGREES_TO_RADIANS,
      aspect: resolution[0] / resolution[1],
      near: readNumber(parameters, "near", 0.1),
      far: readNumber(parameters, "far", 100),
    });

    const positionPair = pointset.pairs["position"];
    if (positionPair === undefined) {
      return refuse("the edge map carries no position pair.");
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
        // WRITE half: THIS frame's positions (§V168), whoever owns the pair (§V197).
        { binding: "positions", resourceId: positionPair, half: "write" },
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
