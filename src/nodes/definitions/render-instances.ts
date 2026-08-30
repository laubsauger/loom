import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { viewProjection } from "../../domain/geometry/camera.ts";
import { INSTANCE_VERTEX_COUNT, RENDER_INSTANCES_WGSL } from "../shaders/render-instances.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import { pointPairId } from "./points.ts";

/**
 * RenderInstances (T299): a procedural primitive on every point — Houdini's copy-to-
 * points idiom without mesh machinery. No new resource kind and no new pass kind: the
 * same vertex-pulled instanced draw renderPoints uses, with a real camera (§V198,
 * T295's matrices), a depth attachment (`depthOutputs`), and 3D primitives generated
 * from the vertex index.
 *
 * Everything animatable is a uniform VALUE (§V5): shape switches by integer, the
 * camera is sixteen floats recomputed from parameters at resolution time, and the
 * whole node recompiles only when `count` (the instance count in the descriptor)
 * changes.
 */

export const INSTANCE_SHAPES = ["quad", "box", "octahedron"] as const;

const SHAPE_INDEX: Record<string, number> = { quad: 0, box: 1, octahedron: 2 };

const DEGREES_TO_RADIANS = Math.PI / 180;

export const renderInstancesNode: NodeDefinition = {
  type: "renderInstances",
  version: 1,
  title: "Render Instances",
  category: "points",
  description:
    "Draws a shaded 3D primitive at every point, depth-tested through a perspective camera. Houdini's copy-to-points, procedurally.",
  tags: ["points", "instances", "render", "3d", "geometry"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Needs a vec3f position attribute; everything else rides along.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  depthOutputs: ["out"],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Instances drawn, clamped by the edge's capacity.",
    },
    shape: {
      type: "enum",
      label: "Shape",
      default: "box",
      options: [
        { value: "quad", label: "Quad" },
        { value: "box", label: "Box" },
        { value: "octahedron", label: "Octahedron" },
      ],
    },
    scale: { type: "number", label: "Scale", default: 0.05, min: 0, description: "Primitive half-extent in world units." },
    rotate: {
      type: "vector",
      size: 3,
      label: "Rotate",
      default: [0, 0, 0],
      description: "Degrees; applied X, then Y, then Z — the published order (§V198).",
    },
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
    if (points.source === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.source",
            message: `Node "${nodeId}": the points input carries no producer identity; per-attribute buffers cannot be located.`,
            nodeId,
          },
        ],
      };
    }

    const eye = readVector(parameters, "eye", [0, 0, 3]);
    const center = readVector(parameters, "lookAt", [0, 0, 0]);
    const rotate = readVector(parameters, "rotate", [0, 0, 0]);
    const shapeParameter = parameters["shape"];
    const matrix = viewProjection([eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 3], [center[0] ?? 0, center[1] ?? 0, center[2] ?? 0], {
      fovY: readNumber(parameters, "fov", 60) * DEGREES_TO_RADIANS,
      aspect: resolution[0] / resolution[1],
      near: readNumber(parameters, "near", 0.1),
      far: readNumber(parameters, "far", 100),
    });

    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:instances`,
      shader: RENDER_INSTANCES_WGSL,
      target,
      topology: "triangle-list",
      instances: Math.max(
        1,
        Math.min(
          Math.round(readNumber(parameters, "count", 4096)),
          points.pointset?.capacity ?? Math.round(readNumber(parameters, "count", 4096)),
        ),
      ),
      vertexCount: INSTANCE_VERTEX_COUNT,
      buffers: [
        // The producer's position pair via the edge map, WRITE half: THIS frame's
        // positions (§V168) — whoever owns the pair (§V197, by-reference reads).
        {
          binding: "positions",
          resourceId: points.pointset?.pairs["position"] ?? pointPairId(points.source.nodeId, "position"),
          half: "write",
        },
      ],
      uniforms: {
        viewProjection: Array.from(matrix),
        color: readColor(parameters, "color", [1, 1, 1, 1]),
        rotate: rotate.map((degrees) => (degrees ?? 0) * DEGREES_TO_RADIANS),
        scale: readNumber(parameters, "scale", 0.05),
        shape: SHAPE_INDEX[typeof shapeParameter === "string" ? shapeParameter : "box"] ?? 1,
      },
      uniformBinding: "params",
      nodeId,
    };
    return { passes: [pass] };
  },
};
