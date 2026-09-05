import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import {
  TRANSFORM_REDUCE_WORKGROUP_SIZE,
  pointCentroidFinalizeWgsl,
  pointCentroidPartialsWgsl,
  pointTransformWgsl,
} from "../shaders/points.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readEnumIndex, readVector } from "./parameter-readers.ts";
import { attributeBinding, packedPointStorage } from "./point-storage.ts";

/** The only attribute this node owns; named once so the layout and the pass agree (§V197). */
const POSITION_ATTRIBUTE: PointAttributeSchema = {
  name: "position",
  type: "vec3f",
  semantic: "position",
  default: [0, 0, 0],
};

const PIVOT_OPTIONS = [
  { value: "centroid", label: "Centroid" },
  { value: "origin", label: "Origin" },
  { value: "point", label: "Point" },
] as const;

type Pivot = (typeof PIVOT_OPTIONS)[number]["value"];

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Transform (T1205) — TRANSLATE, ROTATE AND SCALE A POINT CLOUD AS A WHOLE.
 *
 * ⚑ THE HOLE THIS FILLS, AND THE CODEBASE ALREADY SAID SO IN ITS OWN ERROR MESSAGES. The
 * owner asked how to make a cloud bigger without zooming the camera, reached for
 * `geometry.scale`, and got points that "freak out" — correctly, because that parameter is
 * PER-POINT SIZE (`scene.ts`: "a surface spans its grid and has no per-point size"). The
 * same file refuses a per-object orientation twice by name ("a geometry has no per-object
 * orientation to apply it to"), which is a stated design position rather than a gap. And
 * no node in the point family — gather, generators, kernels, proximity, range, storage,
 * topology, points-from-texture, pose-points — moved a cloud, so the only spelling was a
 * `pointKernel` multiplying `position`: a hand-written line for what every DCC ships as a
 * first-class operator.
 *
 * ⚑ THE SHAPE IS A NODE ON THE DATA, NOT A MATRIX ON THE RENDERER. This is the TD idiom
 * the catalogue follows: a Transform SOP acts on the geometry, so it composes with the
 * rest of the chain and serves EVERY downstream consumer — export, the laser path,
 * proximity, topology, a second render — where an object matrix on `geometry` would have
 * served exactly one and would have had to overturn a decision `scene.ts` had already
 * argued for.
 *
 * ⚑⚑ THE PIVOT IS WHAT MAKES IT ANSWER THE QUESTION. Scaling about the ORIGIN grows the
 * cloud AND flings it off frame; scaling about its own CENTROID grows it in place, and
 * "take up more of the screen" is the second one. Centroid is therefore the default.
 *
 * ⚑ WHAT THE CENTROID COSTS, MEASURED RATHER THAN ASSUMED. It is a genuine reduction, so
 * it is two extra dispatches ahead of the apply pass: a workgroup tree into one partial per
 * 256-slot block, then one thread serially over the partials — the same two-stage shape
 * `points/lifecycle.ts`'s compaction scan already uses, for the same determinism reason.
 * Measured on Dawn/Metal, best of 15 runs of 100 frames, isolated by rendering the same
 * graph at `pivot: "origin"` (which emits no reduction at all — see below):
 *
 *   25,600 points   apply pass 0.019 ms/frame   centroid reduction 0.042 ms/frame
 *   262,400 points  apply pass 0.726 ms/frame   centroid reduction 0.163 ms/frame
 *
 * ⚑ AND THE SHAPE OF THOSE NUMBERS IS THE INTERESTING PART: AT 25k THE ARITHMETIC IS FREE
 * AND THE PRICE IS TWO SUBMISSIONS. An empty extra `pointTransform` in the chain measures
 * 0.019 ms on the same cloud, so 0.042 is two of those and the reduction itself does not
 * show up. Ten times the points costs four times the reduction, not ten — the fixed cost
 * dominates until the cloud is large, and by the time it is (262k) the reduction is 22% of
 * the transform pass it feeds. At 25k it is 0.25% of a 60 fps frame.
 *
 * A RUNNING ESTIMATE WAS THE ALTERNATIVE AND IT IS REFUSED, AND THE MEASUREMENT IS WHY IT
 * IS NOT EVEN CLOSE. Its lag on a moving cloud is a pivot trailing the points it anchors —
 * the cloud SLIDES while it grows, which is precisely the artefact centroid scaling exists
 * to remove. And it would have bought nothing: the cost here is per-dispatch overhead, and
 * an estimate still needs a dispatch. Nothing here reads a clock (§V44): the reduction runs
 * in this frame's pass list, on the buffer upstream has already written, so the centroid is
 * never one frame old and there is no lag to trade against.
 *
 * The two passes are emitted ONLY for the centroid pivot: origin and point resolve at
 * compile time, so a graph that never asks for a centroid never pays for one — which is
 * also what made the cost measurable by difference.
 *
 * §V887 does not bite. The apply pass reads an INPUT buffer and a scratch value written by
 * an earlier pass of this same node; nothing reads what this node writes while it writes
 * it, so there is no before/after for an invocation to straddle.
 *
 * §V197 copy-on-write: this node owns `position` and republishes every other attribute by
 * reference. And unlike `pointRange` it DOES republish `count` — a transform moves points
 * without moving slots, so "the first N are live, contiguous" stays exactly as true as it
 * was.
 */
export const pointTransformNode: NodeDefinition = {
  type: "pointTransform",
  version: 1,
  title: "Transform",
  category: "points",
  description:
    "Moves, turns and scales a whole point cloud — the Transform SOP, on the data rather than on the camera. Scale about the Centroid to make a cloud take up more of the screen without moving it; about the Origin or an authored Point when the frame, not the cloud, is the anchor. This is not the geometry node's Scale, which sizes each individual point.",
  tags: ["points", "transform", "scale", "translate", "rotate", "move", "pivot", "resize"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The same point set with every position transformed. Capacity, topology, live count and every other attribute — including per-point size and colour — pass through untouched.",
    },
  ],
  parameters: {
    translate: {
      type: "vector",
      size: 3,
      label: "Translate",
      default: [0, 0, 0],
      description: "Moves the cloud, in scene units, after the scale and the turn. Drive it to fly the cloud through the shot.",
    },
    rotate: {
      type: "vector",
      size: 3,
      label: "Rotate",
      default: [0, 0, 0],
      description:
        "Turns the cloud about the pivot, in DEGREES, applied X then Y then Z. Two of these nodes compose by matrix multiply, which is composition — the thing scene.ts warns about is ADDING angles, and nothing here adds any.",
    },
    scale: {
      type: "vector",
      size: 3,
      label: "Scale",
      default: [1, 1, 1],
      description:
        "Grows or shrinks the cloud about the pivot. This is the one the geometry node's Scale is NOT: that sizes each point's billboard, this spreads the points apart and leaves their size alone. Unequal components flatten the cloud onto an axis.",
    },
    pivot: {
      type: "enum",
      label: "Pivot",
      default: "centroid",
      // §V62b: the pivot decides the PROGRAM — centroid binds a reduction result and the
      // other two fold to a constant — so it is compile-time and the two reduction passes
      // exist only when they are read.
      compileTime: true,
      options: [...PIVOT_OPTIONS],
      description:
        "What the scale and the turn happen ABOUT. Centroid is the cloud's own middle, measured this frame over its live, unparked points, so scaling grows it IN PLACE — that is the one that makes a cloud fill more of the screen. Origin is the world origin, so scaling pushes the cloud away from it. Point is an authored anchor.",
    },
    pivotPoint: {
      type: "vector",
      size: 3,
      label: "Pivot Point",
      default: [0, 0, 0],
      inactiveWhen: (values) => (values["pivot"] === "point" ? null : "Pivot is not set to Point."),
      description: "The anchor, when Pivot is Point. In the same scene units as the incoming positions.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const points = inputs["points"];
    if (points === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const upstream = points.pointset;
    const position = upstream?.pairs["position"];
    if (upstream === undefined || position === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position pair (producer predates T296?).`,
            nodeId,
          },
        ],
      };
    }

    const capacity = upstream.capacity;
    const pivot = PIVOT_OPTIONS[readEnumIndex(parameters, "pivot", [...PIVOT_OPTIONS], "centroid")]?.value ?? "centroid";

    // T1076/§V197: this node owns `position` alone; everything else passes by reference.
    const storage = packedPointStorage(nodeId, [POSITION_ATTRIBUTE], capacity, "write");
    if (!storage.ok) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.transform",
            message: `Node "${nodeId}": ${storage.errors.join(" ")}`,
            nodeId,
          },
        ],
      };
    }

    const scratchId = (key: string): string => scratchResourceId(nodeId, key);
    const blocks = Math.ceil(capacity / TRANSFORM_REDUCE_WORKGROUP_SIZE);
    const counted = upstream.count !== undefined;

    const reductionPasses: DispatchPassDescriptor[] =
      pivot !== "centroid"
        ? []
        : [
            {
              kind: "dispatch",
              // The counted flag changes the bindings, so it is part of the id (§V62b).
              id: `${nodeId}:transform:centroid${counted ? ":counted" : ""}`,
              shader: pointCentroidPartialsWgsl({ counted }),
              entryPoint: "main",
              workgroups: [blocks, 1, 1],
              buffers: [
                attributeBinding("in_position", position),
                { binding: "partials", resourceId: scratchId("partials") },
                ...(counted && upstream.count !== undefined
                  ? [{ binding: "in_count", resourceId: upstream.count.buffer, half: "read" as const }]
                  : []),
              ],
              uniforms: { count: capacity },
              uniformBinding: "params",
              nodeId,
            },
            {
              kind: "dispatch",
              id: `${nodeId}:transform:centroid:finalize`,
              shader: pointCentroidFinalizeWgsl(),
              entryPoint: "main",
              workgroups: [1, 1, 1],
              buffers: [
                { binding: "partials", resourceId: scratchId("partials") },
                { binding: "centroid", resourceId: scratchId("centroid") },
              ],
              uniforms: { blocks },
              uniformBinding: "params",
              nodeId,
            },
          ];

    const rotate = readVector(parameters, "rotate", [0, 0, 0]);
    const apply: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:transform:apply:${pivot}`,
      shader: pointTransformWgsl({ pivot: pivot as Pivot }),
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [
        attributeBinding("in_position", position),
        attributeBinding("out_position", storage.pairs["position"] as PointsetAttributeRef),
        ...(pivot === "centroid" ? [{ binding: "centroid", resourceId: scratchId("centroid") }] : []),
      ],
      uniforms: {
        // Every one of these is a VALUE, so the whole transform is drivable without a
        // recompile (§V5) — including the rotation, which is why the matrix is built in
        // WGSL from the angles rather than folded down here.
        translate: readVector(parameters, "translate", [0, 0, 0]),
        scale: readVector(parameters, "scale", [1, 1, 1]),
        // Authored in degrees because that is what a person types; radians is what `cos`
        // takes. The conversion happens once, here, rather than in each shader variant.
        rotate: rotate.map((degrees) => degrees * DEGREES_TO_RADIANS),
        pivotPoint: readVector(parameters, "pivotPoint", [0, 0, 0]),
        count: capacity,
      },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [...reductionPasses, apply],
      scratch: [
        storage.scratch,
        ...(pivot === "centroid"
          ? ([
              // vec4f: the position sum in xyz, the member count in w, so the divisor and
              // the numerator cannot come from two different reductions.
              { key: "partials", kind: "buffer" as const, stride: 16, capacity: blocks },
              { key: "centroid", kind: "buffer" as const, stride: 16, capacity: 1 },
            ] as const)
          : []),
      ],
      pointsets: {
        out: {
          // §V197: fresh position, everything else republished by reference.
          pairs: { ...upstream.pairs, ...storage.pairs },
          capacity,
          // Slots never move, so BOTH the topology claim and the live count survive — the
          // count is the difference from `pointRange`, which parks points and therefore
          // breaks the contiguity `count` promises.
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
          ...(upstream.count === undefined ? {} : { count: upstream.count }),
        },
      },
    };
  },
};
