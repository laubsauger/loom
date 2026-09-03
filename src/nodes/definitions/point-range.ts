import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { ATTRIBUTE_STRIDES, COMPONENT_COUNTS, type PointAttributeType } from "../../points/attributes.ts";
import { pointRangeWgsl } from "../shaders/points.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { pointPairId } from "./points.ts";

/**
 * Range (T983) — attribute-range selection on points: keep the points whose attribute
 * falls inside [from, to], or the complement.
 *
 * THE GENERAL FORM, on purpose: the motivating ask was a DEPTH ZONE on the unprojected
 * cloud (an in/out volume on `depthN`, which §T973 made a real per-point attribute), but
 * the operator is judged on the library (§T983's ruling, §T917/§T953's argument) — the
 * same node does velocity culling, id ranges, confidence gates, and a spatial slab when
 * pointed at a `position` component. It is §T982's Select one family over: §T982 picks
 * CHANNELS, this picks POINTS.
 *
 * WHY THIS IS NOT `DepthCut` (§T977): DepthCut thresholds the depth TEXTURE into a 2D
 * matte BEFORE unprojection — no download, works with no cloud. This operates ON the
 * cloud, where depth is already exact per point, and a zone (near AND far) is a slab of
 * space. Both stay; they are different tools.
 *
 * Dropped points are PARKED, not compacted — slots never move, so topology, capacity
 * and every carried attribute pass through by reference (§V197's copy-on-write: this
 * node owns a fresh `position` pair and republishes everything else untouched). The
 * full argument, including why the existing compaction machinery was declined and why
 * the boundary belongs to inside, lives on the shader (`pointRangeWgsl`).
 *
 * `from`/`to` are RUNTIME parameters — the zone is meant to be driven (an animated
 * slab, an audio-widened band). The attribute and component are compile-time: they
 * change the program's bindings (§V62b).
 */

const RANGE_COMPONENTS = ["x", "y", "z", "w"] as const;

export const pointRangeNode: NodeDefinition = {
  type: "pointRange",
  version: 1,
  title: "Range",
  category: "points",
  description:
    "Keeps the points whose attribute falls inside a range and parks the rest out of shot — or keeps the outside, which is the complement. A depth zone on a point cloud is this node pointed at depthN; a spatial slab is this node pointed at a position component. Two instances over the same range split a cloud exactly in two: subject inside, backdrop outside.",
  tags: ["points", "filter", "range", "zone", "slab", "threshold", "select", "delete"],
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
        "The same point set with out-of-range points parked out of shot. Capacity, topology and every other attribute pass through untouched.",
    },
  ],
  parameters: {
    attribute: {
      type: "string",
      label: "Attribute",
      /* T983 follow-up: "position" and not "depthN" — the ONE attribute every pointset
         carries, so the node is valid the moment it is wired (the catalogue-chain gate
         compiles every definition against a plain grid, and a default only a depth
         cloud satisfies shipped that gate red for a day). A spatial slice is also a
         sensible zone in its own right; the depth spelling is one parameter away. */
      default: "position",
      compileTime: true,
      description:
        "Which per-point attribute is tested, by name. The default is position (a spatial slice); a depth cloud's normalized depth is depthN (0 near, 1 far). Any attribute the incoming points carry works, and a name they do not carry says so and lists what they do.",
    },
    component: {
      type: "enum",
      label: "Component",
      default: "x",
      compileTime: true,
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
        { value: "z", label: "Z" },
        { value: "w", label: "W" },
      ],
      description:
        "For a vector attribute, which component is tested — position + Z is a depth slab in space. Scalar attributes ignore this.",
    },
    from: {
      type: "number",
      label: "From",
      default: 0,
      min: -10,
      max: 10,
      range: "soft",
      step: 0.01,
      description: "The zone's near edge, inclusive. Drive it: the zone is meant to move.",
    },
    to: {
      type: "number",
      label: "To",
      default: 1,
      min: -10,
      max: 10,
      range: "soft",
      step: 0.01,
      description: "The zone's far edge, inclusive. The defaults keep a normalized attribute untouched until you narrow them.",
    },
    mode: {
      type: "enum",
      label: "Keep",
      default: "inside",
      options: [
        { value: "inside", label: "Inside the range" },
        { value: "outside", label: "Outside the range" },
      ],
      description:
        "Inside keeps the zone; Outside keeps its complement. The boundary counts as inside on both, so an inside and an outside instance over one range partition the cloud exactly.",
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

    const refuse = (message: string, suggestion?: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.points.range",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    });

    const attribute = typeof parameters["attribute"] === "string" ? parameters["attribute"].trim() : "position";
    const entry = upstream.pairs[attribute];
    if (entry === undefined) {
      const available = Object.keys(upstream.pairs).sort();
      return refuse(
        `the range tests "${attribute}", which the incoming pointset does not carry.`,
        available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
      );
    }
    if (entry.type === undefined) {
      return refuse(`the range tests "${attribute}", but the edge does not declare its type; the producer predates typed pairs.`);
    }
    const attributeType = entry.type as PointAttributeType;
    const arity = COMPONENT_COUNTS[attributeType];
    if (arity === undefined) {
      return refuse(`the range tests "${attribute}" of type "${entry.type}", which is not a point attribute type.`);
    }
    const componentName = typeof parameters["component"] === "string" ? parameters["component"] : "x";
    const componentIndex = Math.max(0, RANGE_COMPONENTS.indexOf(componentName as (typeof RANGE_COMPONENTS)[number]));
    if (arity > 1 && componentIndex >= arity) {
      return refuse(
        `component "${componentName}" does not exist on "${attribute}" (${entry.type} has ${arity} components).`,
      );
    }
    const component = arity > 1 ? `.${RANGE_COMPONENTS[componentIndex] ?? "x"}` : "";
    const positionIsSource = attribute === "position";
    const counted = upstream.count !== undefined;
    const capacity = upstream.capacity;

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      // The attribute, its component and the counted flag are part of the program
      // (§V62b): each changes the bindings or the value expression.
      id: `${nodeId}:range:${attribute}${component}:${attributeType}${counted ? ":counted" : ""}`,
      shader: pointRangeWgsl({ attributeType, component, positionIsSource, counted }),
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [
        { binding: "in_position", resourceId: position.pair, half: position.half },
        ...(positionIsSource ? [] : [{ binding: "in_attr", resourceId: entry.pair, half: entry.half }]),
        ...(counted && upstream.count !== undefined
          ? [{ binding: "in_count", resourceId: upstream.count.buffer, half: "read" as const }]
          : []),
        { binding: "out_position", resourceId: pointPairId(nodeId, "position"), half: "write" },
      ],
      uniforms: {
        count: capacity,
        keepInside: parameters["mode"] === "outside" ? 0 : 1,
        // "from" is reserved in WGSL, so the uniforms travel as lo/hi.
        lo: readNumber(parameters, "from", 0),
        hi: readNumber(parameters, "to", 1),
      },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [{ key: "position", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity }],
      pointsets: {
        out: {
          // §V197 copy-on-write: fresh position, everything else republished by
          // reference — an unmodified attribute never gets a per-node copy.
          pairs: {
            ...upstream.pairs,
            position: { pair: pointPairId(nodeId, "position"), half: "write" as const, type: "vec3f" },
          },
          capacity,
          // Slots never move, so the upstream connectivity claim stays true — the same
          // trade pointsFromTexture's threshold already makes on a grid.
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
          // Deliberately NO count: count promises "the first N slots, contiguous", and
          // parked survivors are not contiguous. The dead tail of a counted input is
          // parked instead (see the shader).
        },
      },
    };
  },
};
