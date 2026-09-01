import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import { formatTopology } from "../../points/topology.ts";
import { POINTS_FROM_TEXTURE_WGSL } from "../shaders/points-from-texture.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { pointPairId } from "./points.ts";

/**
 * Points From Texture (T743) — the node the catalogue was missing.
 *
 * `textureToAttribute` samples a texture AT each point's position: the position is the
 * ADDRESS. This is the other direction — the texture decides the position, so the position
 * is the RESULT. That is why it is a separate node rather than a target parameter on the
 * existing one: overloading it would mean reading at the address it is about to overwrite,
 * and its own one-line description ("samples a texture at each point's position") would
 * stop being true.
 *
 * It exists for pose, but its best consumer is Depth: a depth map in Grid mode is a live
 * point cloud from a webcam, and that is several times more use than either node alone.
 * It also makes §T386's "keypoints feed the whole point and instancing catalogue"
 * literally true rather than aspirational.
 *
 * Colour is deliberately NOT its job. It writes `position` and nothing else, so the
 * existing `textureToAttribute` supplies per-point colour by composition — one texture
 * decides where the points are, another decides what they look like.
 */

const POINT_OUT = {
  id: "out",
  label: "Out",
  type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
};

export const pointsFromTextureNode: NodeDefinition = {
  type: "pointsFromTexture",
  version: 1,
  title: "Points From Texture",
  category: "points",
  description:
    "Builds a point set from a texture. In Grid mode the texel's position places the point and its brightness raises it — a depth map becomes a point cloud. In Value mode the texel's red and green ARE the position and blue is confidence, read one texel per point by index, which is how a Pose node's keypoints become points that geometry can follow. Points below the confidence threshold are parked out of shot rather than piled at the origin, so a frame with nothing in it draws nothing.",
  tags: ["points", "generator", "texture", "depth", "pose"],
  inputs: [{ id: "texture", label: "Texture", type: RGBA_TEXTURE }],
  outputs: [POINT_OUT],
  parameters: {
    mode: {
      type: "enum",
      label: "Mode",
      default: "grid",
      compileTime: true,
      options: [
        { value: "grid", label: "Grid — coordinate places, value raises" },
        { value: "value", label: "Value — the texel IS the position" },
      ],
      description:
        "Grid walks the texture on a cols x rows lattice and reads a height. Value reads texel i for point i, which is what keypoints need: the model says where the joint is, so the texture's layout is irrelevant.",
    },
    cols: { type: "number", label: "Columns", default: 128, min: 1, max: 4096, range: "bounded", step: 1, compileTime: true },
    rows: { type: "number", label: "Rows", default: 128, min: 1, max: 4096, range: "bounded", step: 1, compileTime: true },
    sizeX: { type: "number", label: "Size X", default: 2, min: 0, range: "floor" },
    sizeY: { type: "number", label: "Size Y", default: 2, min: 0, range: "floor" },
    depth: {
      type: "number",
      label: "Depth",
      default: 1,
      // SOFT with real bounds: §B111 — a range kind with no min/max describes nothing and
      // only reads as a considered decision. The span is where depth is useful; going
      // past it is allowed, which is what soft means.
      min: -4,
      max: 4,
      // §T648/§B80: without an explicit step the display rounds the default and a
      // click-and-blur COMMITS the rounded value, destroying it. The step is chosen to
      // hold 1 exactly rather than to look tidy.
      step: 0.01,
      range: "soft",
      description: "How far the texture's brightness pushes a point along z in Grid mode. Negative inverts near and far.",
    },
    threshold: {
      type: "number",
      label: "Threshold",
      default: 0.1,
      min: 0,
      max: 1,
      range: "bounded",
      description:
        "Below this, a point is parked out of shot instead of drawn. In Value mode it reads the texel's blue as confidence, so a joint the model is unsure of simply is not there.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const source = inputs["texture"];
    if (source === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, "texture")] };
    }

    const cols = Math.max(1, Math.round(readNumber(parameters, "cols", 128)));
    const rows = Math.max(1, Math.round(readNumber(parameters, "rows", 128)));
    const capacity = cols * rows;
    const mode = parameters["mode"] === "value" ? 1 : 0;

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:points`,
      shader: POINTS_FROM_TEXTURE_WGSL,
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [{ binding: "out_position", resourceId: pointPairId(nodeId, "position"), half: "write" }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: {
        count: capacity,
        mode,
        cols,
        rows,
        sizeX: readNumber(parameters, "sizeX", 2),
        sizeY: readNumber(parameters, "sizeY", 2),
        depth: readNumber(parameters, "depth", 1),
        threshold: readNumber(parameters, "threshold", 0.1),
      },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [{ key: "position", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity }],
      pointsets: {
        out: {
          pairs: { position: { pair: pointPairId(nodeId, "position"), half: "write" as const, type: "vec3f" } },
          capacity,
          // Grid mode really is a lattice, so the surface renderer can span it (T301).
          // Value mode is a bag of joints with no analytic connectivity — claiming a grid
          // there would let a mesh be drawn across unrelated keypoints.
          topology: formatTopology(
            mode === 0 ? { kind: "grid", cols, rows, wrapU: false, wrapV: false } : { kind: "points" },
          ),
        },
      },
    };
  },
};
