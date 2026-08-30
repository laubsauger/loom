import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { cameraPayloadMatrix, viewProjection } from "../../domain/geometry/camera.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { CameraPayload } from "../../domain/types/scene.ts";
import { INSTANCE_VERTEX_COUNT, RENDER_INSTANCES_WGSL, renderInstancesWgsl } from "../shaders/render-instances.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import { countedDrawSupport, pointPairId, resolveColorMap, resolveGroupPredicate } from "./points.ts";

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

/**
 * §V146 — a NAMED camera replaces these wholesale (T457), so while one is named the
 * inline eye/look/FOV cannot affect the output at all.
 *
 * B104/T500: the owner reported "any of the camera parameters are not really reflecting
 * in the output", and a renderer that shows a live-looking Camera Eye it is ignoring is
 * one honest way to see exactly that — the parameter is edited, the picture does not
 * move, and nothing says why. §V146 exists for this: the row dims and gives the reason,
 * and it stays editable, because setting the inline camera before clearing the name is a
 * normal way to work.
 */
const namedCameraWins = (values: Readonly<Record<string, ParameterValue>>): string | null => {
  const named = typeof values["camera"] === "string" ? values["camera"].trim() : "";
  return named === "" ? null : `Camera "${named}" frames this render; its parameters replace this one.`;
};

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
    // T457: reference-fed plumbing (V373/V387) — never rendered as a socket; the
    // `camera` PARAMETER names the node and the compiler synthesizes this edge.
    { id: "camera", label: "Camera", optional: true, type: { kind: "camera" } },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  depthOutputs: ["out"],
  sourceReferences: [{ parameter: "camera", input: "camera" }],
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
    color: {
      type: "color",
      label: "Color",
      default: [1, 1, 1, 1],
      space: "display",
      description:
        "T369: in Map mode a vec4f point attribute drives every instance's colour, LINEAR by declaration (§V313) — the lighting still applies.",
    },
    camera: {
      type: "string",
      label: "Camera",
      default: "",
      description: "Name of a camera node. When set, it replaces the inline eye/look/FOV below.",
    },
    eye: { type: "vector", size: 3, label: "Camera Eye", default: [0, 0, 3], inactiveWhen: namedCameraWins },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0], inactiveWhen: namedCameraWins },
    fov: { type: "number", label: "FOV", default: 60, min: 1, max: 179, unit: "degrees", inactiveWhen: namedCameraWins },
    near: { type: "number", label: "Near", default: 0.1, min: 0.001, inactiveWhen: namedCameraWins },
    far: { type: "number", label: "Far", default: 100, min: 0.01, inactiveWhen: namedCameraWins },
    group: {
      type: "string",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T333: draw only matching points — a WGSL predicate over p.<attribute>. Referenced attributes bind on demand from the edge. Empty = all.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, parameterMaps, resolution } = readCompileInputs(context);
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

    // T457 (V387): one camera model everywhere. A NAMED camera arrives as a scene
    // payload on the reference-fed edge and replaces the inline parameters wholesale;
    // unnamed keeps the inline eye/look/FOV exactly as before.
    const referenced = inputs["camera"]?.scene as CameraPayload | undefined;
    const eye = readVector(parameters, "eye", [0, 0, 3]);
    const center = readVector(parameters, "lookAt", [0, 0, 0]);
    const rotate = readVector(parameters, "rotate", [0, 0, 0]);
    const shapeParameter = parameters["shape"];
    const matrix =
      referenced?.kind === "camera"
        ? cameraPayloadMatrix(referenced, resolution[0] / resolution[1])
        : viewProjection([eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 3], [center[0] ?? 0, center[1] ?? 0, center[2] ?? 0], {
            fovY: readNumber(parameters, "fov", 60) * DEGREES_TO_RADIANS,
            aspect: resolution[0] / resolution[1],
            near: readNumber(parameters, "near", 0.1),
            far: readNumber(parameters, "far", 100),
          });

    // T369 (§V288): a map is STORABLE on any parameter, and a consumer that cannot honour
    // one says so by name rather than drawing the retained static. `color` is the one this
    // renderer honours; a map anywhere else here would otherwise be a parameter that looks
    // mapped and is not — the exact silence §V288 was written against.
    const unhonoured = Object.keys(parameterMaps).filter((key) => key !== "color").sort();
    if (unhonoured.length > 0) {
      return {
        passes: [],
        diagnostics: unhonoured.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} is in map mode, but renderInstances maps only "color".`,
          nodeId,
          suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
        })),
      };
    }

    // T369/T364 (§V195 as amended): a vec4f attribute drives the whole colour compound.
    const resolvedColor = resolveColorMap(nodeId, parameterMaps["color"], points.pointset, "points");
    if ("refusal" in resolvedColor) return resolvedColor.refusal;
    const mappedColor = resolvedColor.map;

    // T333: the draw-time group. Excluded instances collapse to zero-area primitives.
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"].trim() : "";
    let groupPredicate:
      | { expression: string; binds: ReadonlyArray<{ attribute: string; type: string; pair: string; half: "read" | "write" }> }
      | undefined;
    if (groupSource !== "") {
      const resolvedGroup = resolveGroupPredicate(nodeId, groupSource, points.pointset);
      if ("refusal" in resolvedGroup) return resolvedGroup.refusal;
      groupPredicate = resolvedGroup;
    }

    // T322: a counted edge draws indirectly off the GPU-resident live count.
    const counted = countedDrawSupport(nodeId, points.pointset, {
      vertexCount: INSTANCE_VERTEX_COUNT,
      maxInstances: Math.max(1, Math.round(readNumber(parameters, "count", 4096))),
    });
    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:instances`,
      shader:
        groupPredicate === undefined && mappedColor === undefined
          ? RENDER_INSTANCES_WGSL
          : renderInstancesWgsl({
              ...(mappedColor === undefined ? {} : { colorMap: true }),
              ...(groupPredicate === undefined
                ? {}
                : {
                    group: {
                      expression: groupPredicate.expression,
                      binds: groupPredicate.binds.map(({ attribute, type }) => ({ attribute, type })),
                    },
                  }),
            }),
      target,
      topology: "triangle-list",
      instances:
        counted?.instances ??
        Math.max(
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
          resourceId: points.pointset?.pairs["position"]?.pair ?? pointPairId(points.source.nodeId, "position"),
          half: points.pointset?.pairs["position"]?.half ?? "write",
        },
        ...(mappedColor === undefined
          ? []
          : [{ binding: "mapColors", resourceId: mappedColor.pair, half: mappedColor.half }]),
        ...(groupPredicate === undefined
          ? []
          : groupPredicate.binds.map((bind) => ({
              binding: `group_${bind.attribute}`,
              resourceId: bind.pair,
              half: bind.half,
            }))),
      ],
      // A mapped colour LEAVES the uniform block, and the record must follow the struct
      // exactly (the catalogue sweep pins that). The block itself never vanishes here —
      // the camera, rotation, scale and shape are not mappable — which is the one way
      // this differs from the sprite path.
      uniforms: {
        viewProjection: Array.from(matrix),
        ...(mappedColor === undefined ? { color: readColor(parameters, "color", [1, 1, 1, 1]) } : {}),
        rotate: rotate.map((degrees) => (degrees ?? 0) * DEGREES_TO_RADIANS),
        scale: readNumber(parameters, "scale", 0.05),
        shape: SHAPE_INDEX[typeof shapeParameter === "string" ? shapeParameter : "box"] ?? 1,
      },
      uniformBinding: "params",
      nodeId,
    };
    return counted === undefined
      ? { passes: [pass] }
      : { passes: [counted.argsPass, pass], scratch: [counted.scratch] };
  },
};
