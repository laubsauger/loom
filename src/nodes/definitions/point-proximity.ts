import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import { formatTopology } from "../../points/topology.ts";
import { pointProximityWgsl } from "../shaders/points.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { pointPairId } from "./points.ts";

/**
 * Proximity (T819) — TD's Proximity POP: each point linked to its K nearest neighbours.
 *
 * The output is a LINK POINTSET, not a neighbour-index table, and that choice is the
 * whole design: each link is one point whose `position` is the source and whose `tip` is
 * the neighbour — exactly the pair the beam renderer already draws (geometry
 * `mode: "beam", endpoint: "tip"`, the path E13's prism rays and E34's pulses ride). A
 * neighbour-index attribute would make every consumer rebuild the same link pass in a
 * kernel; this shape is drawable the moment it exists (§V754: reuse the deciding path).
 *
 * CAPACITY IS FIXED at N × K. A link that does not exist — beyond radius, fewer than K
 * neighbours in range, a dead source on a counted set — collapses to zero length
 * (§V788: position == tip, zero area, free) with a zero tint. No live-count machinery,
 * no compaction; the dead links cost nothing to draw.
 *
 * `tint` carries the link's strength: white with alpha falling from 1 at contact to 0 at
 * the radius, shaped by `falloff`. Render's Map-mode tint draws it directly (T478), so
 * nearer links are brighter with zero downstream work — and `radius` is the performance
 * knob: drive it from an audio band and connection density IS the music made visible.
 *
 * T1071 — `neighbor: u32`, THE NEIGHBOUR'S SLOT, and it is why this is now an ADJACENCY
 * rather than a drawing of one. `tip` says WHERE the neighbour is; nothing downstream could
 * say WHO it is, so no consumer could look up that neighbour's colour, degree, or any other
 * attribute, and every operator that wanted the graph rebuilt the scan in its own kernel —
 * §V865's shape, two answers to one question. With the slot on the link, `pointGather`
 * follows it into the source pointset and the drawn filaments and the computed edges are
 * ONE set. §V73: a slot is ADDRESSING, never identity — a consumer must read the pointset
 * that produced these links, not one that merely has the same capacity.
 *
 * ⚠ THE ABSENT LINK ADDRESSES ITSELF (`neighbor == source slot`). The scan never selects
 * `j == index`, so that is an EXACT presence test with no float compare — and unlike a
 * sentinel it is in range by construction, so a consumer that forgets to test it reads a
 * real point rather than off the end of a buffer.
 *
 * The algorithm and its refused alternative are documented on the shader
 * (`pointProximityWgsl`): brute force to the supported envelope of 4096 points, spatial
 * hash declined by name until a measured need.
 */

const PROXIMITY_OUT = {
  id: "out",
  label: "Links",
  type: {
    kind: "pointset" as const,
    requires: [
      { name: "position", type: "vec3f" as const },
      { name: "tip", type: "vec3f" as const },
      { name: "tint", type: "vec4f" as const },
      { name: "neighbor", type: "u32" as const },
    ],
  },
  description:
    "One link per (point, neighbour) slot: position = the source, tip = the neighbour, tint.a = strength (1 at contact, 0 at the radius), neighbor = the neighbour's SLOT. Absent links are zero-length, invisible, and address themselves. Draw with geometry mode Beam, endpoint tip, and render tint in Map mode; gather over it with Gather.",
};

export const pointProximityNode: NodeDefinition = {
  type: "pointProximity",
  version: 1,
  title: "Proximity",
  category: "points",
  description:
    "Links each point to its nearest neighbours within a radius — the constellation look. Outputs a drawable link set: feed it to a Beam geometry and the lines are the picture. Radius is the live knob: drive it from an audio band and the web tightens on the beat.",
  tags: ["points", "proximity", "neighbours", "links", "constellation"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
    },
  ],
  outputs: [PROXIMITY_OUT],
  parameters: {
    neighbors: {
      type: "number",
      label: "Neighbors",
      default: 4,
      min: 1,
      max: 8,
      range: "bounded",
      step: 1,
      compileTime: true,
      description:
        "K nearest per point. Compile-time: it sizes the link capacity (points × K) and the shader's selection array.",
    },
    radius: {
      type: "number",
      label: "Radius",
      default: 1,
      min: 0,
      range: "floor",
      step: 0.01,
      description:
        "World-space reach. Links past it do not exist; links inside fade toward it. THE live knob — drive it and connection density follows.",
    },
    falloff: {
      type: "number",
      label: "Falloff",
      default: 1,
      min: 0,
      max: 8,
      range: "bounded",
      step: 0.1,
      description: "Shapes tint alpha over distance: 0 = hard links to the radius, higher = only near links visible.",
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

    const neighbors = Math.max(1, Math.min(8, Math.round(readNumber(parameters, "neighbors", 4))));
    const count = upstream.capacity;
    const capacity = count * neighbors;
    const counted = upstream.count !== undefined;

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      // K and the counted flag are part of the program (§V62b): a different K is a
      // different selection array, and a counted input binds one more buffer.
      id: `${nodeId}:proximity:${neighbors}${counted ? ":counted" : ""}`,
      shader: pointProximityWgsl({ neighbors, counted }),
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        { binding: "in_position", resourceId: position.pair, half: position.half },
        ...(counted && upstream.count !== undefined
          ? [{ binding: "in_count", resourceId: upstream.count.buffer, half: "read" as const }]
          : []),
        { binding: "out_position", resourceId: pointPairId(nodeId, "position"), half: "write" },
        { binding: "out_tip", resourceId: pointPairId(nodeId, "tip"), half: "write" },
        { binding: "out_tint", resourceId: pointPairId(nodeId, "tint"), half: "write" },
        { binding: "out_neighbor", resourceId: pointPairId(nodeId, "neighbor"), half: "write" },
      ],
      uniforms: {
        count,
        radius: Math.max(0, readNumber(parameters, "radius", 1)),
        falloff: Math.max(0, readNumber(parameters, "falloff", 1)),
      },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: "position", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity },
        { key: "tip", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity },
        { key: "tint", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec4f"], capacity },
        { key: "neighbor", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["u32"], capacity },
      ],
      pointsets: {
        out: {
          pairs: {
            position: { pair: pointPairId(nodeId, "position"), half: "write" as const, type: "vec3f" },
            tip: { pair: pointPairId(nodeId, "tip"), half: "write" as const, type: "vec3f" },
            tint: { pair: pointPairId(nodeId, "tint"), half: "write" as const, type: "vec4f" },
            neighbor: { pair: pointPairId(nodeId, "neighbor"), half: "write" as const, type: "u32" },
          },
          capacity,
          // Links are a bag of segments; claiming a grid would let a mesh span them.
          topology: formatTopology({ kind: "points" }),
        },
      },
    };
  },
};
