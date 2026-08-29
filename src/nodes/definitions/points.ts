import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  ATTRIBUTE_STRIDES,
  validateAttributes,
  type PointAttributeSchema,
} from "../../points/attributes.ts";
import { POINT_KERNEL_CONTRACT_VERSION, generateKernelModule } from "../../points/codegen.ts";
import { DEFAULT_POINT_KERNEL, SPRITE_RENDER_WGSL } from "../shaders/points.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber } from "./parameter-readers.ts";

/**
 * The point family (T121, T122): Point Kernel simulates, Render Points draws.
 *
 * A pointset edge carries a FAMILY of buffers — one ping-pong pair per attribute —
 * not one resource. The id convention below is the contract between producer and
 * consumer: the kernel node's pair for attribute `a` is `points:{nodeId}:{a}`, and a
 * consumer derives the same ids from the input binding's `source.nodeId`. The pair
 * swaps as ONE identity, so T143 carry-over keeps simulation state across unrelated
 * edits exactly as texture feedback survives them (§V22).
 *
 * COMPILER ENABLEMENT PENDING: these two definitions emit `dispatch`/`draw` passes and
 * declare bufferPair scratch entries, which `compileGraph` does not accept yet (its
 * emittable-kinds gate and scratch handler are effect/target-only, and pointset outputs
 * do not propagate). They are exported as `pointNodeDefinitions` and deliberately NOT
 * folded into `coreNodeDefinitions` until those compiler deltas land — registering a
 * node whose chain-compile fails loudly would be honest but useless. The fixture-level
 * and Dawn tests exercise everything below the compiler for real.
 */

/** The producer/consumer id contract for a pointset attribute's ping-pong pair. */
export function pointPairId(nodeId: string, attribute: string): string {
  return `points:${nodeId}:${attribute}`;
}

export const DEFAULT_POINT_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

function parseAttributes(raw: unknown): { attributes?: ReadonlyArray<PointAttributeSchema>; error?: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { attributes: DEFAULT_POINT_ATTRIBUTES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `attributes is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(parsed)) return { error: "attributes must be a JSON array of { name, type, semantic?, default }" };
  const attributes = parsed as PointAttributeSchema[];
  const check = validateAttributes(attributes);
  if (!check.ok) return { error: check.errors.join("; ") };
  return { attributes };
}

/** Buffer-pair descriptors a plan needs for one kernel node. Tests and the (future) compiler share it. */
export function pointKernelResources(
  nodeId: string,
  attributes: ReadonlyArray<PointAttributeSchema>,
  capacity: number,
): ReadonlyArray<{ kind: "bufferPair"; id: string; stride: number; capacity: number }> {
  return attributes.map((attribute) => ({
    kind: "bufferPair" as const,
    id: pointPairId(nodeId, attribute.name),
    stride: ATTRIBUTE_STRIDES[attribute.type],
    capacity,
  }));
}

export const pointKernelNode: NodeDefinition = {
  type: "pointKernel",
  version: 1,
  title: "Point Kernel",
  category: "points",
  description:
    "Runs a per-point WGSL kernel over a GPU point set every frame. The POP-style custom operator.",
  tags: ["points", "particles", "compute", "simulation"],
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: { kind: "pointset", requires: [] },
      description: "The simulated point set. Attributes are whatever the schema declares.",
    },
  ],
  parameters: {
    capacity: {
      type: "number",
      label: "Capacity",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Allocated point slots. Changing it reallocates and resets the system.",
    },
    seed: {
      type: "number",
      label: "Seed",
      default: 7,
      step: 1,
      description: "Feeds pointRand(seed, pointId, frame) — same seed, same motion (§V74).",
    },
    attributes: {
      type: "string",
      label: "Attributes",
      default: "",
      multiline: true,
      compileTime: true,
      description: 'JSON schema, e.g. [{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]. Empty = position/velocity/id.',
    },
    kernel: {
      type: "string",
      label: "Kernel",
      default: DEFAULT_POINT_KERNEL,
      multiline: true,
      compileTime: true,
      description: "fn process(p: Point, ctx: PointCtx) -> Point. pointRand(pointId, salt) is available.",
    },
  },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  contractVersion: POINT_KERNEL_CONTRACT_VERSION,
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters } = readCompileInputs(context);

    const capacity = Math.max(1, Math.round(readNumber(parameters, "capacity", 4096)));
    const { attributes, error } = parseAttributes(parameters["attributes"]);
    if (attributes === undefined) {
      return {
        passes: [],
        diagnostics: [
          { severity: "error", code: "node.points.attributes", message: `Node "${nodeId}": ${error}`, nodeId },
        ],
      };
    }

    const kernelSource = typeof parameters["kernel"] === "string" ? parameters["kernel"] : DEFAULT_POINT_KERNEL;
    const names = attributes.map((attribute) => attribute.name);
    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      kernel: kernelSource,
    });
    if (!module.ok) {
      return {
        passes: [],
        diagnostics: module.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.kernel",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:kernel`,
      shader: module.wgsl,
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / module.workgroupSize), 1, 1],
      buffers: module.buffers.map((binding) => ({
        binding: binding.variable,
        resourceId: pointPairId(nodeId, binding.attribute),
        // The generated module reads pre-frame values from `in_*` and writes post-frame
        // values to `out_*`; the pair's swap (after all consumers, §V22) makes this
        // frame's writes next frame's reads.
        half: binding.role === "in" ? ("read" as const) : ("write" as const),
      })),
      uniforms: {
        timeSeconds: 0,
        deltaSeconds: 0,
        frameIndex: 0,
        seed: readNumber(parameters, "seed", 7),
        count: capacity,
      },
      uniformBinding: "kernelFrame",
      nodeId,
    };

    return {
      passes: [pass],
      // Structural declaration for the compiler's scratch handler once it learns
      // bufferPair entries (see module doc). Shape mirrors pointKernelResources().
      scratch: pointKernelResources(nodeId, attributes, capacity).map((resource) => ({
        key: resource.id.split(":").slice(2).join(":"),
        kind: "bufferPair",
        stride: resource.stride,
        capacity: resource.capacity,
      })),
    } as CompiledNodeDescription;
  },
};

export const renderPointsNode: NodeDefinition = {
  type: "renderPoints",
  version: 1,
  title: "Render Points",
  category: "points",
  description: "Draws a point set as soft billboarded sprites into a texture. TD-style POP render.",
  tags: ["points", "particles", "sprites", "render"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Needs a vec3f position attribute; everything else rides along.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Instances drawn. Matches the producer's capacity until pointset edges carry it.",
    },
    sizePixels: {
      type: "number",
      label: "Size",
      default: 4,
      min: 0.5,
      max: 256,
      unit: "px",
      description: "Sprite diameter in output pixels.",
    },
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    blend: {
      type: "enum",
      label: "Blend",
      default: "additive",
      options: [
        { value: "additive", label: "Additive" },
        { value: "alpha", label: "Alpha" },
      ],
      compileTime: true,
    },
    accumulate: {
      type: "boolean",
      label: "Accumulate",
      default: false,
      compileTime: true,
      description: "Skip the clear each frame — sprites pile up into trails (T180).",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
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

    const blend = parameters["blend"] === "alpha" ? ("alpha" as const) : ("additive" as const);
    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:sprites`,
      shader: SPRITE_RENDER_WGSL,
      target,
      topology: "triangle-list",
      instances: Math.max(1, Math.round(readNumber(parameters, "count", 4096))),
      vertexCount: 6,
      buffers: [
        // The producer's position pair, read half: last completed frame's positions.
        { binding: "positions", resourceId: pointPairId(points.source.nodeId, "position"), half: "read" },
      ],
      uniforms: {
        color: readColor(parameters, "color", [1, 1, 1, 1]),
        sizePixels: readNumber(parameters, "sizePixels", 4),
      },
      uniformBinding: "params",
      sharedBinding: "frameU",
      blend,
      clear: parameters["accumulate"] !== true,
      nodeId,
    };
    return { passes: [pass] };
  },
};

/**
 * Exported separately from `coreNodeDefinitions` until the compiler accepts
 * dispatch/draw emission and bufferPair scratch (see module doc).
 */
export const pointNodeDefinitions: readonly NodeDefinition[] = [pointKernelNode, renderPointsNode];
