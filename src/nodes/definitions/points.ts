import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  ATTRIBUTE_STRIDES,
  validateAttributes,
  type PointAttributeSchema,
} from "../../points/attributes.ts";
import { POINT_KERNEL_CONTRACT_VERSION, generateKernelModule } from "../../points/codegen.ts";
import { drawArgsWgsl } from "../../points/lifecycle.ts";
import { DEFAULT_POINT_KERNEL, SPRITE_RENDER_WGSL, TEXTURE_TO_ATTRIBUTE_WGSL, spriteRenderWgsl } from "../shaders/points.wgsl.ts";
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
 * Chain-compiled for real: `compileGraph` accepts dispatch/draw emission, materializes
 * the bufferPair scratch entries, propagates pointset edges as markers and appends the
 * pair swaps after all consumers (T176). The fixture and Dawn tests cover everything
 * below the compiler; the chain test covers the seam.
 */

import { scratchResourceId } from "../../compiler/resources.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";

/**
 * The producer/consumer id contract for a pointset attribute's ping-pong pair. ONE
 * definition: the compiler materializes the producer's bufferPair scratch entries under
 * `scratchResourceId(nodeId, attribute)`, and consumers derive the identical id from
 * the edge's source identity — no second convention to drift.
 */

/**
 * The point schema a node's parameters resolve to (T293) — the `pointSetInfo` the
 * read_points port needs, derived from the DOCUMENT so the composition root can wire
 * the port without re-reading node internals. Undefined for a non-point node or an
 * attributes parameter the schema rejects (the compile diagnostic already said why).
 */
export function pointSetInfoFor(
  node: { type: string; parameters: Readonly<Record<string, unknown>> },
): { attributes: ReadonlyArray<PointAttributeSchema>; capacity: number } | undefined {
  const numberOf = (key: string, fallback: number): number => {
    const value = storedStaticValue(node.parameters[key] as never);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
  };
  if (node.type === "pointKernel") {
    const { attributes } = parseAttributes(storedStaticValue(node.parameters["attributes"] as never));
    if (attributes === undefined) return undefined;
    return { attributes, capacity: numberOf("capacity", 4096) };
  }
  if (node.type === "textureToAttribute") {
    return {
      attributes: [
        { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
        { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
      ],
      capacity: numberOf("count", 4096),
    };
  }
  return undefined;
}

export function pointPairId(nodeId: string, attribute: string): string {
  return scratchResourceId(nodeId, attribute);
}

export const DEFAULT_POINT_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

export function parseAttributes(raw: unknown): { attributes?: ReadonlyArray<PointAttributeSchema>; error?: string } {
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
  // The output PORT advertises `position: vec3f` (that is what makes it wirable into a
  // renderer under §V13's provides ⊇ requires rule), so every schema must honor it —
  // a port type is a static promise a dynamic parameter is not allowed to break.
  const position = attributes.find((attribute) => attribute.name === "position");
  if (position === undefined || position.type !== "vec3f") {
    return { error: 'the schema must include { name: "position", type: "vec3f" } — the output port promises it' };
  }
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
      // The producer's `requires` is its PROVIDES list (§V13): consumers may demand any
      // subset. Position is guaranteed by schema validation above; everything else in a
      // custom schema rides along without appearing here.
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "The simulated point set. position:vec3f is guaranteed; other attributes follow the schema.",
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
    group: {
      type: "string",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T300: WGSL predicate over (p, ctx) — e.g. p.position.y > 0.0. Only matching points run the kernel; the rest pass through unchanged. Empty = all.",
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
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"] : "";
    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      kernel: kernelSource,
      ...(groupSource.trim() === "" ? {} : { group: groupSource }),
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
        kind: "bufferPair" as const,
        stride: resource.stride,
        capacity: resource.capacity,
      })),
      // T296: the resolved edge payload. The kernel WRITES every declared attribute,
      // so every pair in the map is its own (§V197's "if you write it, you own it").
      pointsets: {
        out: {
          pairs: Object.fromEntries(
            attributes.map((attribute) => [
              attribute.name,
              // §V168 through §V231: the kernel writes every pair this frame, so the
              // payload names each write half. `type` rides along for mapped
              // parameters (T286) — a consumer swizzles from it, never from a guess.
              { pair: pointPairId(nodeId, attribute.name), half: "write" as const, type: attribute.type },
            ]),
          ),
          capacity,
          topology: "points",
        },
      },
    };
  },
};


/**
 * T322: everything a renderer needs to draw a COUNTED edge (a producer whose live
 * count is GPU-resident): one tiny dispatch converting the count into indirect draw
 * arguments with the renderer's own per-instance vertex count baked in, the argument
 * buffer, and the `instances: { indirect }` value. Undefined for a static edge — the
 * caller keeps its literal count and this feature costs nothing.
 */
export function countedDrawSupport(
  nodeId: string,
  pointset: { count?: { buffer: string } } | undefined,
  options: { vertexCount: number; maxInstances: number },
):
  | {
      instances: { indirect: string };
      argsPass: DispatchPassDescriptor;
      scratch: { kind: "buffer"; key: string; stride: number; capacity: number; usage: "indirect" };
    }
  | undefined {
  const count = pointset?.count;
  if (count === undefined) return undefined;
  const argsId = pointPairId(nodeId, "drawArgs");
  return {
    instances: { indirect: argsId },
    argsPass: {
      kind: "dispatch",
      id: `${nodeId}:drawArgs`,
      shader: drawArgsWgsl(),
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [
        { binding: "liveCount", resourceId: count.buffer },
        { binding: "drawArgs", resourceId: argsId },
      ],
      uniforms: { vertexCount: options.vertexCount, maxInstances: options.maxInstances },
      uniformBinding: "params",
      nodeId,
    },
    scratch: { kind: "buffer", key: "drawArgs", stride: 4, capacity: 4, usage: "indirect" },
  };
}

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
    const { nodeId, outputs, inputs, parameters, parameterMaps } = readCompileInputs(context);
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

    // T286 (§V288): sizePixels in map mode — pscale. The mapping either resolves
    // against the EDGE (attribute present, type coherent) or fails by name, saying
    // what the pointset does provide; it never silently falls back to the static.
    const sizeMap = parameterMaps["sizePixels"];
    let mappedSize: { entry: { pair: string; half: "read" | "write" }; type: string; channel?: string } | undefined;
    if (sizeMap !== undefined) {
      const refuse = (message: string, suggestion?: string): CompiledNodeDescription => ({
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.parameter.map",
            message: `Node "${nodeId}": ${message}`,
            nodeId,
            ...(suggestion === undefined ? {} : { suggestion }),
          },
        ],
      });
      // §V306: `port` names the pointset input when there are several; this node has
      // exactly one, so a port that is not it is a mistake said out loud.
      if (sizeMap.port !== undefined && sizeMap.port !== "points") {
        return refuse(`sizePixels maps port "${sizeMap.port}", but the only pointset input is "points".`);
      }
      const available = Object.keys(points.pointset?.pairs ?? {}).sort();
      const entry = points.pointset?.pairs[sizeMap.attribute];
      if (entry === undefined) {
        return refuse(
          `sizePixels maps attribute "${sizeMap.attribute}", which the incoming pointset does not carry.`,
          available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
        );
      }
      const attributeType = entry.type;
      if (attributeType === undefined) {
        return refuse(
          `sizePixels maps "${sizeMap.attribute}", but the edge does not declare its type; the producer predates typed pairs.`,
        );
      }
      const vectorChannels: Record<string, readonly string[]> = {
        vec2f: ["x", "y"],
        vec3f: ["x", "y", "z"],
        vec4f: ["x", "y", "z", "w"],
      };
      if (attributeType === "f32") {
        if (sizeMap.channel !== undefined) {
          return refuse(`sizePixels maps f32 attribute "${sizeMap.attribute}" with a channel; an f32 has none.`);
        }
        mappedSize = { entry, type: attributeType };
      } else if (vectorChannels[attributeType] !== undefined) {
        const channels = vectorChannels[attributeType] as readonly string[];
        if (sizeMap.channel === undefined || !channels.includes(sizeMap.channel)) {
          return refuse(
            `sizePixels maps ${attributeType} attribute "${sizeMap.attribute}" and needs a channel (${channels.join("/")}).`,
          );
        }
        mappedSize = { entry, type: attributeType, channel: sizeMap.channel };
      } else {
        return refuse(
          `sizePixels cannot map "${sizeMap.attribute}" of type "${attributeType}"; a size needs f32 or a float vector channel.`,
        );
      }
    }
    // T322: a counted edge draws INDIRECTLY — the live count is GPU-resident, so a
    // tiny pass converts it to draw arguments and the draw reads them. A static edge
    // keeps the literal count (edge capacity clamped by the param).
    const counted = countedDrawSupport(nodeId, points.pointset, {
      vertexCount: 6,
      maxInstances: Math.max(1, Math.round(readNumber(parameters, "count", 4096))),
    });
    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:sprites`,
      shader:
        mappedSize === undefined
          ? SPRITE_RENDER_WGSL
          : spriteRenderWgsl({ type: mappedSize.type, ...(mappedSize.channel === undefined ? {} : { channel: mappedSize.channel }) }),
      target,
      topology: "triangle-list",
      // T296: instances = the EDGE's capacity, clamped by the count param — the user
      // no longer keeps two numbers in sync by hand.
      instances:
        counted?.instances ??
        Math.max(
          1,
          Math.min(
            Math.round(readNumber(parameters, "count", 4096)),
            points.pointset?.capacity ?? Math.round(readNumber(parameters, "count", 4096)),
          ),
        ),
      vertexCount: 6,
      buffers: [
        // The producer's position pair via the edge map, WRITE half: THIS frame's
        // positions (§V168) — whoever owns the pair (§V197, by-reference reads).
        {
          binding: "positions",
          resourceId: points.pointset?.pairs["position"]?.pair ?? pointPairId(points.source.nodeId, "position"),
          half: points.pointset?.pairs["position"]?.half ?? "write",
        },
        ...(mappedSize === undefined
          ? []
          : [{ binding: "mapSizes", resourceId: mappedSize.entry.pair, half: mappedSize.entry.half }]),
      ],
      uniforms: {
        color: readColor(parameters, "color", [1, 1, 1, 1]),
        // Mapped, the size LEAVES the uniform block entirely — the struct and the
        // record must keep matching exactly (the catalogue sweep pins that).
        ...(mappedSize === undefined ? { sizePixels: readNumber(parameters, "sizePixels", 4) } : {}),
      },
      uniformBinding: "params",
      sharedBinding: "frameU",
      blend,
      clear: parameters["accumulate"] !== true,
      nodeId,
    };
    return counted === undefined
      ? { passes: [pass] }
      : { passes: [counted.argsPass, pass], scratch: [counted.scratch] };
  },
};

/**
 * TextureToAttribute (T124): the TOP→POP bridge — sample a texture per point, write the
 * result as a point attribute. The first pointset consumer outside the family itself,
 * and what makes the two graphs ONE instrument: a Noise TOP driving particle colour,
 * a displacement field steering a sim.
 *
 * Ownership rule for pointset transforms: this node owns FRESH pairs for everything it
 * outputs (position copied through, `sample` written from the texture), because
 * downstream consumers derive pair ids from THEIR source's node id — a pointset node
 * that modified upstream pairs in place would break that derivation and alias state
 * across nodes.
 */
export const textureToAttributeNode: NodeDefinition = {
  type: "textureToAttribute",
  version: 1,
  title: "Texture To Attribute",
  category: "points",
  description: "Samples a texture at each point's position and writes it as a point attribute.",
  tags: ["points", "bridge", "texture", "sample"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
    {
      id: "texture",
      label: "Texture",
      type: RGBA_TEXTURE,
      description: "Read with textureLoad — data fields (r32float displacement) work on baseline Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      // Provides position (copied) plus the sampled value.
      type: {
        kind: "pointset",
        requires: [
          { name: "position", type: "vec3f" },
          { name: "sample", type: "vec4f" },
        ],
      },
    },
  ],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Matches the producer's capacity until pointset edges carry it.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs } = readCompileInputs(context);
    const points = inputs["points"];
    const texture = inputs["texture"];
    if (points === undefined || texture === undefined) {
      const what = points === undefined ? 'input port "points"' : 'input port "texture"';
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

    // T296/§V197: capacity comes off the EDGE, and position passes BY REFERENCE — this
    // node writes only `sample`, so `sample` is the only pair it owns. The old
    // copy-everything shape existed purely for the id-derivation convention the edge
    // map replaces; its per-frame memcpy is simply gone.
    const upstream = points.pointset;
    const upstreamPosition = upstream?.pairs["position"];
    if (upstream === undefined || upstreamPosition === undefined) {
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
    const count = upstream.capacity;
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:bridge`,
      shader: TEXTURE_TO_ATTRIBUTE_WGSL,
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        // The producer's pair, WRITE half: this frame's positions, in plan order (§V168).
        { binding: "in_position", resourceId: upstreamPosition.pair, half: upstreamPosition.half },
        { binding: "out_sample", resourceId: pointPairId(nodeId, "sample"), half: "write" },
      ],
      textures: [{ binding: "sourceTexture", resourceId: texture.resource, sampled: "unfiltered" }],
      uniforms: { count },
      uniformBinding: "bridgeFrame",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: "sample", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec4f"], capacity: count },
      ],
      pointsets: {
        out: {
          pairs: { ...upstream.pairs, sample: { pair: pointPairId(nodeId, "sample"), half: "write" as const, type: "vec4f" } },
          capacity: count,
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        },
      },
    };
  },
};

/**
 * Exported separately from `coreNodeDefinitions` until the compiler accepts
 * dispatch/draw emission and bufferPair scratch (see module doc).
 */
export const pointNodeDefinitions: readonly NodeDefinition[] = [
  pointKernelNode,
  textureToAttributeNode,
  renderPointsNode,
];
